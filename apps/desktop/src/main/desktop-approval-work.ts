import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HostApprovalStop, createHostApprovalInvocation, readHostApprovalInvocation, type HostMutationApprovalContext, type HostMutationApprovalRequest } from '@lnwjud/mcp-server';
import { ApprovalHostRuntime, snapshotPlan, type ApprovalHostJobHandle, type ApprovalHostPlan } from './approval-host-runtime.js';
import { SqliteApprovalHostStore, type ChromeWorkRegistration, type ChromeWorkConnection, type ApprovalContinuationRequest } from './approval-host-store.js';
import { readChromeWorkLaunch, type ChromeWorkLaunch } from './chrome-work-launch.js';
import type { ApprovalPromptDisplayGate } from './approval-prompt-display.js';
import type { DesktopApprovalWorkList, DesktopApprovalWorkSummary, PreparedDesktopApprovalWork } from '../../../../packages/ipc-contracts/src/approval-work-contracts.js';

export type DesktopApprovalPrompt = (request: HostMutationApprovalRequest, context: HostMutationApprovalContext, displayGate?: ApprovalPromptDisplayGate) => Promise<boolean> | boolean;
interface BoundWork { readonly plan: ApprovalHostPlan; readonly handle: ApprovalHostJobHandle; }

/** Lives above HTTP/stdio registries; start/resume are host APIs, never renderer/MCP inputs. */
export class DesktopApprovalWork {
  private store: SqliteApprovalHostStore | undefined;
  private runtime: ApprovalHostRuntime<HostMutationApprovalRequest> | undefined;
  private readonly works = new Map<string, BoundWork>();
  private readonly ready: Promise<void>;
  private fault: unknown;
  private closing = false;
  private readonly pending = new Map<Promise<boolean>, HostMutationApprovalContext>();
  private closeOperation: Promise<void> | undefined;
  private readonly reviews = new Map<string, { readonly plan: ApprovalHostPlan; readonly expiresAt: number; readonly revision?: number; readonly hostWorkId?: string; readonly connectionRevision?: number; readonly continuationRevision?: number }>();

  public constructor(private readonly directory: string, private readonly prompt: DesktopApprovalPrompt) {
    // Startup restores evidence only. A missing journal inside an existing registry is never recreated.
    this.ready = this.restore().catch((error: unknown) => { this.fault = error; });
  }

  public async start(plan: ApprovalHostPlan): Promise<ApprovalHostJobHandle> {
    const handle = await this.register(plan);
    this.assertReady(); this.store!.selectDesktopWork(handle.hostWorkId, true);
    return handle;
  }

  /** New work is enrolled once and remains inactive until the existing Desktop review flow selects it. */
  public async registerChromeWork(ticket: ChromeWorkLaunch): Promise<{ readonly primaryWorkId: string; readonly hostWorkId: string; readonly connectionRevision: number }> {
    const launch = readChromeWorkLaunch(ticket);
    const handle = await this.register(launch.plan, { credentialHash: launch.credentialHash, clientId: launch.plan.clientId, sessionId: launch.plan.sessionId });
    return { primaryWorkId: launch.plan.primaryWorkId, hostWorkId: handle.hostWorkId, connectionRevision: this.store!.readChromeConnection(handle.hostWorkId)!.revision };
  }

  /** Only the trusted work owner can present the opaque launch capability on a continuity event. */
  public async reconnectChromeWork(ticket: ChromeWorkLaunch, expectedRevision: number, sessionId: string): Promise<ChromeWorkConnection> {
    await this.ready; this.assertReady(); const launch = readChromeWorkLaunch(ticket);
    const work = await this.describe(launch.plan.primaryWorkId, launch.plan.workspaceId);
    this.assertReady();
    const connection = this.store!.reconnectChromeWork(work.hostWorkId, launch.credentialHash, expectedRevision, sessionId);
    for (const [token, review] of this.reviews) if (review.plan.primaryWorkId === work.primaryWorkId) this.reviews.delete(token);
    return connection;
  }

  public async extendChromeWork(ticket: ChromeWorkLaunch, input: ApprovalContinuationRequest): Promise<number> {
    await this.ready; this.assertReady();
    const launch = readChromeWorkLaunch(ticket);
    const work = await this.describe(launch.plan.primaryWorkId, launch.plan.workspaceId);
    this.assertReady();
    const revision = this.store!.appendPhaseBatch(work.hostWorkId, launch.credentialHash, input);
    for (const [token, review] of this.reviews) if (review.plan.primaryWorkId === work.primaryWorkId) this.reviews.delete(token);
    return revision;
  }

  private async register(plan: ApprovalHostPlan, chrome?: ChromeWorkRegistration): Promise<ApprovalHostJobHandle> {
    await this.ready; this.assertReady();
    if (this.store === undefined) {
      // mkdir is exclusive across Desktop/stdio processes. A competing or interrupted initializer fails closed.
      mkdirSync(this.directory);
      this.store = SqliteApprovalHostStore.createNew(path.join(this.directory, 'host.sqlite'));
      this.runtime = this.createRuntime(this.store);
    }
    const snapshot = snapshotPlan(plan);
    this.assertUnambiguous(snapshot);
    const handle = await this.runtime!.createJob(snapshot, true, chrome);
    this.assertReady();
    this.works.set(snapshot.primaryWorkId, { plan: snapshot, handle });
    return handle;
  }

  /** Only the main-process work owner prepares plans; renderer receives a one-use token, never plan authority. */
  public prepare(plan: ApprovalHostPlan): { readonly reviewToken: string } {
    this.assertReady(); const reviewToken = randomUUID();
    this.reviews.set(reviewToken, { plan: snapshotPlan(plan), expiresAt: Date.now() + 120_000 });
    return { reviewToken };
  }

  public async list(workspaceId: string | null): Promise<DesktopApprovalWorkList> {
    await this.ready; this.assertReady();
    if (workspaceId === null || this.store === undefined) return { workspaceId, works: [] };
    const works: DesktopApprovalWorkSummary[] = [];
    for (const { record } of this.store.loadDesktopPlans()) {
      if (record.identity.workspaceId === workspaceId) works.push(await this.describe(record.primaryWorkId, workspaceId));
    }
    return { workspaceId, works };
  }

  public async chromeConnection(primaryWorkId: string, workspaceId: string): Promise<ChromeWorkConnection> {
    await this.ready; this.assertReady();
    const summary = await this.describe(primaryWorkId, workspaceId);
    const connection = this.store!.readChromeConnection(summary.hostWorkId);
    if (connection === undefined) throw new HostApprovalStop(summary.hostWorkId, 'HOST_CONNECTION_REQUIRED');
    return connection;
  }

  /** Renderer chooses an existing ID; the immutable host registry supplies all plan authority. */
  public async prepareFromRegistry(primaryWorkId: string, workspaceId: string): Promise<PreparedDesktopApprovalWork> {
    await this.ready; this.assertReady();
    const work = await this.describe(primaryWorkId, workspaceId);
    if (work.inDoubt !== 0) throw new HostApprovalStop(work.hostWorkId, 'RECOVERY_REQUIRED');
    this.assertReady(); const bound = this.works.get(primaryWorkId);
    if (bound === undefined) throw new HostApprovalStop(primaryWorkId, 'HOST_WORK_NOT_FOUND');
    for (const [token, review] of this.reviews) {
      if (review.expiresAt <= Date.now() || review.plan.primaryWorkId === primaryWorkId) this.reviews.delete(token);
    }
    const reviewToken = randomUUID(); const expiresAt = Date.now() + 120_000;
    const connectionRevision = this.store!.readChromeConnection(work.hostWorkId)?.revision;
    this.reviews.set(reviewToken, { plan: bound.plan, expiresAt, revision: work.revision, hostWorkId: work.hostWorkId, continuationRevision: work.continuationRevision ?? 0, ...(connectionRevision === undefined ? {} : { connectionRevision }) });
    return { reviewToken, expiresAt, work };
  }

  public async startReviewed(reviewToken: string, workspaceId?: string): Promise<ApprovalHostJobHandle> {
    const review = this.reviews.get(reviewToken); this.reviews.delete(reviewToken);
    if (review === undefined || review.expiresAt <= Date.now()) throw new HostApprovalStop('unbound', 'HOST_REVIEW_REQUIRED');
    if (workspaceId !== undefined && review.plan.workspaceId !== workspaceId) throw new HostApprovalStop('unbound', 'HOST_WORKSPACE_MISMATCH');
    if (review.revision !== undefined) {
      const current = await this.describe(review.plan.primaryWorkId, workspaceId ?? review.plan.workspaceId);
      if (current.hostWorkId !== review.hostWorkId || current.revision !== review.revision || current.inDoubt !== 0 || (current.continuationRevision ?? 0) !== (review.continuationRevision ?? 0)) {
        throw new HostApprovalStop(current.hostWorkId, 'HOST_REVIEW_STALE');
      }
      return this.resume(review.plan.primaryWorkId, workspaceId, { revision: review.revision, expiresAt: review.expiresAt, continuationRevision: review.continuationRevision ?? 0, ...(review.connectionRevision === undefined ? {} : { connectionRevision: review.connectionRevision }) });
    }
    return this.start(review.plan);
  }

  public async resume(primaryWorkId: string, workspaceId?: string, review?: { readonly revision: number; readonly expiresAt: number; readonly connectionRevision?: number; readonly continuationRevision?: number }): Promise<ApprovalHostJobHandle> {
    await this.ready; this.assertReady();
    if (workspaceId !== undefined) await this.describe(primaryWorkId, workspaceId);
    const work = this.works.get(primaryWorkId);
    if (work === undefined || this.runtime === undefined) throw new HostApprovalStop(primaryWorkId, 'HOST_WORK_NOT_FOUND');
    // Revalidate the stored identity and budget; do not infer a current work from a session or active project.
    const handle = await this.runtime.resumeJob(work.handle.hostWorkId, work.plan);
    this.assertReady();
    try { this.store!.selectDesktopWork(handle.hostWorkId, true, review); }
    catch (cause) {
      if (review !== undefined) throw new HostApprovalStop(handle.hostWorkId, 'HOST_REVIEW_STALE');
      throw cause;
    }
    return handle;
  }

  public async deactivate(primaryWorkId: string, workspaceId?: string): Promise<void> {
    await this.ready; this.assertReady();
    if (workspaceId !== undefined) await this.describe(primaryWorkId, workspaceId);
    const work = this.works.get(primaryWorkId);
    if (work === undefined) throw new HostApprovalStop(primaryWorkId, 'HOST_WORK_NOT_FOUND');
    this.store!.selectDesktopWork(work.handle.hostWorkId, false);
  }

  public async snapshot(primaryWorkId: string): ReturnType<ApprovalHostRuntime<HostMutationApprovalRequest>['snapshot']> {
    await this.ready; this.assertReady();
    const work = this.works.get(primaryWorkId);
    if (work === undefined) throw new HostApprovalStop(primaryWorkId, 'HOST_WORK_NOT_FOUND');
    return this.runtime!.snapshot(work.handle);
  }

  public request(request: HostMutationApprovalRequest, context: HostMutationApprovalContext): Promise<boolean> {
    const operation = this.requestInternal(request, context);
    this.pending.set(operation, context);
    void operation.finally(() => { this.pending.delete(operation); }).catch(() => undefined);
    return operation;
  }

  public close(): Promise<void> {
    if (this.closeOperation !== undefined) return this.closeOperation;
    this.closing = true;
    for (const context of this.pending.values()) context.cancel();
    this.closeOperation = (async (): Promise<void> => {
      await this.ready;
      await Promise.allSettled([...this.pending.keys()]);
      this.store?.close();
      this.works.clear();
      this.reviews.clear();
    })();
    return this.closeOperation;
  }

  private async restore(): Promise<void> {
    if (!existsSync(this.directory)) return;
    this.store = SqliteApprovalHostStore.openExisting(path.join(this.directory, 'host.sqlite'));
    this.runtime = this.createRuntime(this.store);
    const restored = new Map<string, BoundWork>();
    for (const { record, plan } of this.store.loadDesktopPlans()) {
      const typed = snapshotPlan(plan as ApprovalHostPlan);
      this.assertUnambiguous(typed);
      const handle = await this.runtime.resumeJob(record.identity.hostWorkId, typed);
      restored.set(record.primaryWorkId, { plan: structuredClone(typed), handle });
    }
    for (const [id, work] of restored) this.works.set(id, work);
  }

  private createRuntime(store: SqliteApprovalHostStore): ApprovalHostRuntime<HostMutationApprovalRequest> {
    return new ApprovalHostRuntime(store, (request, context, ticket) => Promise.resolve(this.prompt(request, context as HostMutationApprovalContext, ticket)));
  }

  private async describe(primaryWorkId: string, workspaceId: string): Promise<DesktopApprovalWorkSummary> {
    this.assertReady();
    const saved = this.store?.loadDesktopPlans().find(({ record }) => record.primaryWorkId === primaryWorkId);
    if (saved === undefined || this.runtime === undefined) throw new HostApprovalStop(primaryWorkId, 'HOST_WORK_NOT_FOUND');
    if (saved.record.identity.workspaceId !== workspaceId) throw new HostApprovalStop(primaryWorkId, 'HOST_WORKSPACE_MISMATCH');
    const plan = snapshotPlan(saved.plan as ApprovalHostPlan); this.assertUnambiguous(plan);
    const handle = await this.runtime.resumeJob(saved.record.identity.hostWorkId, plan);
    const snapshot = await this.runtime.reviewSnapshot(handle);
    this.assertReady();
    this.works.set(primaryWorkId, { plan, handle });
    return { primaryWorkId, hostWorkId: handle.hostWorkId, workspaceId, tabId: plan.tabId, pageUrl: plan.pageUrl,
      selected: this.store!.isDesktopWorkSelected(handle.hostWorkId), shown: snapshot.shown, remaining: snapshot.remaining,
      limit: snapshot.limit, blocked: snapshot.blocked, inDoubt: snapshot.inDoubt, revision: snapshot.revision,
      continuationRevision: this.store!.readPhaseBatches(handle.hostWorkId).length,
      targets: [{ tabId: plan.tabId, pageUrl: plan.pageUrl }, ...this.store!.readPhaseBatches(handle.hostWorkId).map(({ tabId, pageUrl }) => ({ tabId, pageUrl }))] };
  }

  private async requestInternal(request: HostMutationApprovalRequest, context: HostMutationApprovalContext): Promise<boolean> {
    await this.ready;
    if (context.signal.aborted) return false;
    if (this.closing) throw new HostApprovalStop('desktop', 'HOST_SHUTTING_DOWN');
    if (request.toolName !== 'dom_cdp') return this.prompt(request, context);
    this.assertReady();
    const proof = readHostApprovalInvocation(context.invocationProof);
    if (proof === undefined) throw new HostApprovalStop('unbound', 'HOST_WORK_REQUIRED');
    const matches = [...this.works.values()].filter(({ plan, handle }) => {
      const connection = this.store!.readChromeConnection(handle.hostWorkId);
      return this.store!.isDesktopWorkSelected(handle.hostWorkId) && proof.clientId === plan.clientId && proof.clientId === (connection?.clientId ?? plan.clientId)
        && proof.sessionId === (connection?.sessionId ?? plan.sessionId) && proof.workspaceId === plan.workspaceId && ((proof.tabId === plan.tabId && plan.requestDigests.includes(proof.inputDigest)) || this.store!.readPhaseBatches(handle.hostWorkId).some((batch) => batch.tabId === proof.tabId && batch.requestDigests.includes(proof.inputDigest)));
    });
    if (matches.length !== 1 || this.runtime === undefined) throw new HostApprovalStop('unbound', matches.length > 1 ? 'HOST_WORK_AMBIGUOUS' : 'HOST_WORK_REQUIRED');
    const work = matches[0]!;
    const connection = this.store!.readChromeConnection(work.handle.hostWorkId);
    // A host-authenticated session alias cannot change the original action, owner, target or budget identity.
    const boundContext = connection === undefined ? context : { ...context, connectionRevision: connection.revision,
      invocationProof: createHostApprovalInvocation({ ...proof, sessionId: work.plan.sessionId }) };
    if (connection !== undefined && (connection.clientId !== proof.clientId || connection.sessionId !== proof.sessionId)) throw new HostApprovalStop(work.handle.hostWorkId, 'HOST_CONNECTION_CHANGED');
    const phase = work.plan.requestDigests.indexOf(proof.inputDigest);
    return (phase >= 0 ? this.runtime.providerFor(work.handle, phase) : this.runtime.continuationProvider(work.handle, proof.inputDigest))(request, boundContext);
  }

  private assertReady(): void {
    if (this.closing) throw new HostApprovalStop('desktop', 'HOST_SHUTTING_DOWN');
    if (this.fault !== undefined) throw new HostApprovalStop('desktop', 'HOST_REGISTRY_UNAVAILABLE');
  }
  private assertUnambiguous(plan: ApprovalHostPlan): void {
    if (!Array.isArray(plan.requestDigests) || new Set(plan.requestDigests).size !== plan.requestDigests.length) throw new HostApprovalStop(plan.primaryWorkId, 'HOST_PHASE_AMBIGUOUS');
  }
}
