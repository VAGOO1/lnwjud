import { createHash } from 'node:crypto';
import { HostApprovalStop, readHostApprovalInvocation } from '@lnwjud/mcp-server';
import { ApprovalJobBudgetError, type ApprovalBudgetTicket, type ApprovalJobHandle, type ApprovalRequestContext } from './approval-job-budget.js';
import { BudgetedApprovalProvider } from './budgeted-approval-provider.js';
import { SqliteApprovalHostStore, type ApprovalHostJobRecord, type ChromeWorkRegistration } from './approval-host-store.js';

export interface ApprovalHostPlan {
  /** Stable primary host task/work ID, selected outside MCP input and retained across retries. */
  readonly primaryWorkId: string;
  readonly clientId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly tabId: string;
  /** Exact origin and pathname, as provided by the host's no-launch tab lookup. */
  readonly pageUrl: string;
  readonly requestDigests: readonly string[];
}
export interface ApprovalHostRequest {
  readonly toolName: string;
  readonly workspaceId?: string;
  readonly presentation?: { readonly browserTabId?: string; readonly browserTabLookup?: string; readonly browserTabUrl?: string };
}
export interface ApprovalHostContext extends ApprovalRequestContext { readonly invocationProof?: unknown; }
export interface ApprovalHostJobHandle { readonly hostWorkId: string; }
interface Binding { readonly record: ApprovalHostJobRecord; readonly plan: ApprovalHostPlan; readonly budget: ApprovalJobHandle; }

/** Composition for an explicitly selected host job; no global/current-session fallback. */
export class ApprovalHostRuntime<TRequest extends ApprovalHostRequest> {
  private readonly bindings = new WeakMap<ApprovalHostJobHandle, Binding>();
  private readonly budget: BudgetedApprovalProvider;

  public constructor(
    private readonly store: SqliteApprovalHostStore,
    private readonly show: (request: TRequest, context: ApprovalHostContext, ticket: ApprovalBudgetTicket) => Promise<boolean>,
  ) { this.budget = new BudgetedApprovalProvider(store); }

  /** Called by the trusted host after it has an explicit new-work intent. Never by a tool argument. */
  public async createJob(input: ApprovalHostPlan, persistDesktopPlan = false, chrome?: ChromeWorkRegistration): Promise<ApprovalHostJobHandle> {
    const plan = snapshotPlan(input);
    const record = this.store.createHostJob(plan.primaryWorkId, identityScope(plan), [...plan.requestDigests], persistDesktopPlan ? plan : undefined, chrome);
    return this.bind(record, plan);
  }

  public async resumeJob(hostWorkId: string, input: ApprovalHostPlan): Promise<ApprovalHostJobHandle> {
    const plan = snapshotPlan(input);
    const record = this.store.readHostJob(hostWorkId);
    if (record === undefined) throw stop('JOURNAL_UNAVAILABLE', 'The host parent job is missing; refusing to create a replacement');
    const scope = identityScope(plan);
    if (record.primaryWorkId !== plan.primaryWorkId || record.identity.ownerId !== scope.ownerId || record.identity.workspaceId !== scope.workspaceId
      || record.identity.targetId !== scope.targetId || record.identity.scopeDigest !== scope.scopeDigest
      || JSON.stringify(record.requestDigests) !== JSON.stringify(plan.requestDigests)) {
      throw stop('IDENTITY_MISMATCH', 'The resumed parent job does not match the original owner, target or plan');
    }
    return this.bind(record, plan);
  }

  /** The host selects the plan phase out of band; the caller cannot supply a phase/job ID. */
  public providerFor(handle: ApprovalHostJobHandle, phase: number): (request: TRequest, context: ApprovalHostContext) => Promise<boolean> {
    const binding = this.binding(handle);
    if (!Number.isSafeInteger(phase) || phase < 0 || phase >= binding.plan.requestDigests.length) throw stop('INVALID_IDENTITY', 'Unknown host plan phase');
    return this.exactProvider(binding, handle, binding.plan.requestDigests[phase]!, `phase-${phase}`);
  }

  /** Exact additional phases retain the original immutable budget identity. */
  public continuationProvider(handle: ApprovalHostJobHandle, inputDigest: string): (request: TRequest, context: ApprovalHostContext) => Promise<boolean> {
    const binding = this.binding(handle);
    const batch = this.store.readPhaseBatches(handle.hostWorkId).find((item) => item.requestDigests.includes(inputDigest));
    if (batch === undefined) throw stop('IDENTITY_MISMATCH', 'The exact continuation phase was not registered');
    return this.exactProvider(binding, handle, inputDigest, `continuation-${batch.revision}-${batch.requestDigests.indexOf(inputDigest)}`, batch);
  }

  private exactProvider(binding: Binding, handle: ApprovalHostJobHandle, inputDigest: string, requestId: string, target: Pick<ApprovalHostPlan, 'tabId' | 'pageUrl'> = binding.plan): (request: TRequest, context: ApprovalHostContext) => Promise<boolean> {
    return async (input, context): Promise<boolean> => {
      if (context.signal.aborted) return false;
      const request = structuredClone(input);
      const invocation = readHostApprovalInvocation(context.invocationProof);
      const plan = binding.plan;
      if (invocation === undefined || invocation.clientId !== plan.clientId || invocation.sessionId !== plan.sessionId
        || invocation.workspaceId !== plan.workspaceId || invocation.tabId !== target.tabId
        || invocation.inputDigest !== inputDigest
        || request.toolName !== 'dom_cdp' || request.workspaceId !== plan.workspaceId
        || request.presentation?.browserTabId !== target.tabId || request.presentation.browserTabLookup !== 'resolved'
        || request.presentation.browserTabUrl !== target.pageUrl) {
        throw stop('IDENTITY_MISMATCH', 'Missing or mismatched host invocation proof, exact tab lookup or approved phase');
      }
      // A new call ID/reconnect cannot replay a previously consumed host phase.
      try {
        return await this.budget.request(binding.budget, { requestId, actionDigest: invocation.inputDigest }, context,
          (ticket) => this.show(request, context, ticket));
      } catch (error) {
        if (error instanceof ApprovalJobBudgetError) throw new HostApprovalStop(handle.hostWorkId, error.code);
        throw error;
      }
    };
  }

  public async snapshot(handle: ApprovalHostJobHandle): ReturnType<BudgetedApprovalProvider['snapshot']> {
    return this.budget.snapshot(this.binding(handle).budget);
  }

  private async bind(record: ApprovalHostJobRecord, plan: ApprovalHostPlan): Promise<ApprovalHostJobHandle> {
    const budget = await this.budget.resumeJob(record.identity);
    const handle = Object.freeze({ hostWorkId: record.identity.hostWorkId });
    this.bindings.set(handle, { record, plan, budget });
    return handle;
  }

  public reviewSnapshot(handle: ApprovalHostJobHandle): ReturnType<BudgetedApprovalProvider['reviewSnapshot']> {
    return this.budget.reviewSnapshot(this.binding(handle).budget);
  }
  private binding(handle: ApprovalHostJobHandle): Binding {
    const binding = this.bindings.get(handle);
    if (binding === undefined) throw stop('UNKNOWN_HANDLE', 'The host did not bind this job handle');
    return binding;
  }
}

export function snapshotPlan(value: ApprovalHostPlan): ApprovalHostPlan {
  const plan = structuredClone(value);
  if (typeof plan !== 'object' || plan === null || ![plan.primaryWorkId, plan.clientId, plan.sessionId, plan.workspaceId, plan.tabId, plan.pageUrl].every((part) =>
    typeof part === 'string' && part.length > 0 && part.length <= 512 && part === part.trim() && !/\p{Cc}/u.test(part))) throw stop('INVALID_IDENTITY', 'Invalid host plan identity');
  const url = new URL(plan.pageUrl);
  if (!['https:', 'http:'].includes(url.protocol) || plan.pageUrl !== `${url.origin}${url.pathname}`) throw stop('INVALID_IDENTITY', 'Host plan requires an exact origin/path without credentials, query or fragment');
  if (!Array.isArray(plan.requestDigests) || plan.requestDigests.length < 1 || plan.requestDigests.length > 1000
    || !plan.requestDigests.every((digest) => typeof digest === 'string' && /^[a-f0-9]{64}$/u.test(digest))) throw stop('INVALID_IDENTITY', 'Invalid exact host phase digests');
  return Object.freeze({ primaryWorkId: plan.primaryWorkId, clientId: plan.clientId, sessionId: plan.sessionId,
    workspaceId: plan.workspaceId, tabId: plan.tabId, pageUrl: plan.pageUrl, requestDigests: Object.freeze([...plan.requestDigests]) });
}
function identityScope(plan: ApprovalHostPlan): Omit<ApprovalHostJobRecord['identity'], 'hostWorkId'> {
  return {
    ownerId: digest([plan.clientId, plan.sessionId]), workspaceId: plan.workspaceId, targetId: plan.tabId,
    scopeDigest: digest([plan.workspaceId, plan.tabId, plan.pageUrl, plan.requestDigests]),
  };
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function stop(code: ConstructorParameters<typeof ApprovalJobBudgetError>[0], message: string): ApprovalJobBudgetError { return new ApprovalJobBudgetError(code, message); }
