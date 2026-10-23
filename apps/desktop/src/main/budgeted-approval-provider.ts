import { MutationApprovalQueue } from './mutation-approval-queue.js';
import {
  ApprovalJobBudgetError,
  ApprovalJobHandle,
  type ApprovalBudgetTicket,
  type ApprovalJobBudgetJournal,
  type ApprovalJobBudgetSnapshot,
  type ApprovalJobBudgetState,
  type ApprovalJobIdentity,
  type ApprovalJobRecord,
  type ApprovalRequestContext,
  type ApprovalRequestIdentity,
  type ApprovalWindowFactory,
  MAX_APPROVAL_WINDOWS_PER_JOB,
  approvalJobBudgetSnapshot,
  assertApprovalJobIdentity,
  assertApprovalRequestIdentity,
  freshApprovalJobBudgetState,
  sameApprovalJobIdentity,
} from './approval-job-budget.js';

/** Host-only budget. It accepts a host-minted handle, never a session or caller job ID. */
export class BudgetedApprovalProvider {
  private readonly identities = new WeakMap<ApprovalJobHandle, ApprovalJobIdentity>();
  private readonly handles = new Map<string, ApprovalJobHandle>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly liveRequests = new Map<string, Set<string>>();
  private readonly journalFaults = new Set<string>();

  public constructor(private readonly journal: ApprovalJobBudgetJournal, private readonly queue = new MutationApprovalQueue()) {}

  public async beginJob(identity: ApprovalJobIdentity): Promise<ApprovalJobHandle> {
    return this.openJob(identity, true);
  }

  /** Reconnect/restart must use this path: missing prior evidence can never create a fresh budget. */
  public async resumeJob(identity: ApprovalJobIdentity): Promise<ApprovalJobHandle> {
    return this.openJob(identity, false);
  }

  private async openJob(input: ApprovalJobIdentity, allowNew: boolean): Promise<ApprovalJobHandle> {
    assertApprovalJobIdentity(input);
    const identity = { ...input };
    const known = this.handles.get(identity.hostWorkId);
    if (known !== undefined) {
      if (!sameApprovalJobIdentity(this.identityFor(known), identity)) throw error('IDENTITY_MISMATCH', 'Approval job identity changed for the same host work');
      await this.withLock(identity.hostWorkId, async () => { await this.loadExisting(identity); });
      return known;
    }
    await this.withLock(identity.hostWorkId, async () => {
      const prior = await this.read(identity);
      if (prior === undefined) {
        if (!allowNew) throw error('JOURNAL_UNAVAILABLE', 'Prior approval evidence is required to resume this work');
        await this.persistNew(identity);
      }
    });
    const handle = ApprovalJobHandle.createForBudget();
    this.identities.set(handle, { ...identity });
    this.handles.set(identity.hostWorkId, handle);
    return handle;
  }

  public async snapshot(handle: ApprovalJobHandle): Promise<ApprovalJobBudgetSnapshot> {
    const identity = this.identityFor(handle);
    return this.withLock(identity.hostWorkId, async () => approvalJobBudgetSnapshot(await this.loadExisting(identity)));
  }

  public async reviewSnapshot(handle: ApprovalJobHandle): Promise<ApprovalJobBudgetSnapshot & { readonly revision: number }> {
    const identity = this.identityFor(handle);
    return this.withLock(identity.hostWorkId, async () => {
      const state = await this.loadExisting(identity);
      return { ...approvalJobBudgetSnapshot(state), revision: state.revision };
    });
  }

  public async request(handle: ApprovalJobHandle, input: ApprovalRequestIdentity, context: ApprovalRequestContext, show: ApprovalWindowFactory): Promise<boolean> {
    const identity = this.identityFor(handle);
    assertApprovalRequestIdentity(input);
    const request = { ...input };
    if (context.signal.aborted) return false;
    const ticket = await this.withLock(identity.hostWorkId, async () => this.reserve(identity, request, context));
    const result = await this.queue.request(context, async () => {
      if (!await ticket.beforeShow()) return false;
      try { return await show(ticket); } catch { return false; }
    });
    return this.finish(identity, request.requestId, context, result);
  }

  private async reserve(identity: ApprovalJobIdentity, request: ApprovalRequestIdentity, context: ApprovalRequestContext): Promise<ApprovalBudgetTicket> {
    const state = await this.loadExisting(identity);
    if (state.records.some((record) => record.requestId === request.requestId)) throw error('DUPLICATE_REQUEST', 'Approval request identity was already used and cannot be replayed');
    const active = this.liveRequests.get(identity.hostWorkId) ?? new Set<string>();
    if (state.records.some((record) => activeStatus(record.status) && !active.has(record.requestId))) throw error('RECOVERY_REQUIRED', 'An earlier approval reservation is unresolved');
    if (state.shown + state.records.filter((record) => record.status === 'reserved').length >= MAX_APPROVAL_WINDOWS_PER_JOB) {
      await this.persist(identity, state, append(state, request, 'blocked', { requested: 1, blocked: 1 }), context.connectionRevision);
      throw error('BUDGET_EXHAUSTED', 'This work already reserved all three approval windows');
    }
    // This compare-and-swap persistence is complete before any BrowserWindow is constructed.
    await this.persist(identity, state, append(state, request, 'reserved', { requested: 1, inDoubt: 1 }), context.connectionRevision);
    active.add(request.requestId);
    this.liveRequests.set(identity.hostWorkId, active);
    return this.ticket(identity, request.requestId, context);
  }

  private ticket(identity: ApprovalJobIdentity, requestId: string, context: ApprovalRequestContext): ApprovalBudgetTicket {
    return {
      // This is deliberately idempotent while reserved: the queue and actual window gate both call it.
      beforeShow: async (): Promise<boolean> => this.withLock(identity.hostWorkId, async () => {
        const state = await this.loadExisting(identity);
        const record = find(state, requestId);
        if (record.status !== 'reserved') return false;
        if (context.signal.aborted) {
          await this.persist(identity, state, transition(state, requestId, 'cancelled', { cancelled: 1, inDoubt: -1 }), context.connectionRevision);
          this.completeLiveRequest(identity.hostWorkId, requestId);
          return false;
        }
        return this.isLive(identity.hostWorkId, requestId);
      }),
      onShown: async (): Promise<boolean> => this.withLock(identity.hostWorkId, async () => {
        try {
          const state = await this.loadExisting(identity);
          const record = find(state, requestId);
          if (record.status !== 'reserved' || !this.isLive(identity.hostWorkId, requestId)) return false;
          // The window already appeared. Cancellation can deny execution, never erase display evidence.
          await this.persist(identity, state, markShown(state, requestId), context.connectionRevision);
          return true;
        } catch (cause) {
          this.journalFaults.add(key(identity.hostWorkId, requestId));
          this.completeLiveRequest(identity.hostWorkId, requestId);
          throw cause;
        }
      }),
      snapshot: async (): Promise<ApprovalJobBudgetSnapshot> => this.snapshot(this.handles.get(identity.hostWorkId)!),
    };
  }

  private async finish(identity: ApprovalJobIdentity, requestId: string, context: ApprovalRequestContext, response: boolean): Promise<boolean> {
    return this.withLock(identity.hostWorkId, async () => {
      // A failed shown persistence remains in doubt: never turn it into an implicit denial/reset.
      if (this.journalFaults.has(key(identity.hostWorkId, requestId))) return false;
      const state = await this.loadExisting(identity);
      const record = find(state, requestId);
      if (!activeStatus(record.status)) return false;
      if (context.signal.aborted) {
        await this.persist(identity, state, transition(state, requestId, 'cancelled', { cancelled: 1, inDoubt: -1 }), context.connectionRevision);
        this.completeLiveRequest(identity.hostWorkId, requestId);
        return false;
      }
      // A true response without the actual show event is ambiguous: preserve the reservation.
      if (response && record.shown) {
        await this.persist(identity, state, transition(state, requestId, 'approved', { approved: 1, inDoubt: -1 }), context.connectionRevision);
        this.completeLiveRequest(identity.hostWorkId, requestId);
        return true;
      }
      if (response) {
        // The window may have appeared without an observed event. Leave the durable reservation for recovery.
        this.completeLiveRequest(identity.hostWorkId, requestId);
        return false;
      }
      await this.persist(identity, state, transition(state, requestId, 'denied', { denied: 1, inDoubt: -1 }), context.connectionRevision);
      this.completeLiveRequest(identity.hostWorkId, requestId);
      return false;
    });
  }

  private identityFor(handle: ApprovalJobHandle): ApprovalJobIdentity {
    const identity = this.identities.get(handle);
    if (identity === undefined) throw error('UNKNOWN_HANDLE', 'Approval job handle was not created by this host provider');
    return identity;
  }

  private isLive(hostWorkId: string, requestId: string): boolean { return this.liveRequests.get(hostWorkId)?.has(requestId) === true; }
  private completeLiveRequest(hostWorkId: string, requestId: string): void {
    const active = this.liveRequests.get(hostWorkId);
    active?.delete(requestId);
    if (active?.size === 0) this.liveRequests.delete(hostWorkId);
  }

  private async read(identity: ApprovalJobIdentity): Promise<ApprovalJobBudgetState | undefined> {
    let raw: unknown;
    try { raw = await this.journal.load(identity.hostWorkId); } catch (cause) { throw unavailable('load', cause); }
    if (raw === undefined) return undefined;
    if (!isState(raw)) throw error('INVALID_JOURNAL', 'Approval budget journal is invalid');
    try { assertApprovalJobIdentity(raw.identity); } catch { throw error('INVALID_JOURNAL', 'Approval budget journal identity is invalid'); }
    if (!sameApprovalJobIdentity(raw.identity, identity)) throw error('IDENTITY_MISMATCH', 'Approval budget journal belongs to a different work');
    validateState(raw);
    return raw;
  }

  private async loadExisting(identity: ApprovalJobIdentity): Promise<ApprovalJobBudgetState> {
    const state = await this.read(identity);
    if (state === undefined) throw error('JOURNAL_UNAVAILABLE', 'Approval budget journal unexpectedly disappeared');
    return state;
  }

  private async persistNew(identity: ApprovalJobIdentity): Promise<void> {
    const initial = freshApprovalJobBudgetState(identity);
    try {
      if (!await this.journal.compareAndSwap(identity.hostWorkId, null, initial)) throw error('RECOVERY_REQUIRED', 'Approval budget journal changed while creating the host work');
    } catch (cause) { if (cause instanceof ApprovalJobBudgetError) throw cause; throw unavailable('create', cause); }
  }

  private async persist(identity: ApprovalJobIdentity, prior: ApprovalJobBudgetState, changed: ApprovalJobBudgetState, connectionRevision?: number): Promise<void> {
    const next = { ...changed, revision: prior.revision + 1 };
    if (!Number.isSafeInteger(next.revision)) throw error('RECOVERY_REQUIRED', 'Approval budget revision is exhausted');
    try {
      if (!await this.journal.compareAndSwap(identity.hostWorkId, prior.revision, next, connectionRevision)) throw error('RECOVERY_REQUIRED', 'Approval budget journal or Chrome connection changed concurrently');
    } catch (cause) { if (cause instanceof ApprovalJobBudgetError) throw cause; throw unavailable('save', cause); }
  }

  private async withLock<T>(hostWorkId: string, work: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(hostWorkId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const chain = prior.then(() => next);
    this.locks.set(hostWorkId, chain);
    await prior;
    try { return await work(); } finally {
      release();
      if (this.locks.get(hostWorkId) === chain) this.locks.delete(hostWorkId);
    }
  }
}

function append(state: ApprovalJobBudgetState, request: ApprovalRequestIdentity, status: ApprovalJobRecord['status'], increment: Partial<Pick<ApprovalJobBudgetState, 'requested' | 'blocked' | 'inDoubt'>>): ApprovalJobBudgetState {
  return { ...state, records: [...state.records, { ...request, status, shown: false }], requested: state.requested + (increment.requested ?? 0), blocked: state.blocked + (increment.blocked ?? 0), inDoubt: state.inDoubt + (increment.inDoubt ?? 0) };
}

function markShown(state: ApprovalJobBudgetState, requestId: string): ApprovalJobBudgetState {
  return { ...state, records: state.records.map((record) => record.requestId === requestId ? { ...record, status: 'shown', shown: true } : record), shown: state.shown + 1 };
}

function transition(state: ApprovalJobBudgetState, requestId: string, status: ApprovalJobRecord['status'], increment: Partial<Pick<ApprovalJobBudgetState, 'approved' | 'denied' | 'cancelled' | 'inDoubt'>>): ApprovalJobBudgetState {
  return { ...state, records: state.records.map((record) => record.requestId === requestId ? { ...record, status } : record), approved: state.approved + (increment.approved ?? 0), denied: state.denied + (increment.denied ?? 0), cancelled: state.cancelled + (increment.cancelled ?? 0), inDoubt: state.inDoubt + (increment.inDoubt ?? 0) };
}

function find(state: ApprovalJobBudgetState, requestId: string): ApprovalJobRecord {
  const record = state.records.find((entry) => entry.requestId === requestId);
  if (record === undefined) throw error('INVALID_JOURNAL', 'Approval reservation is missing from the durable journal');
  return record;
}
function activeStatus(status: ApprovalJobRecord['status']): boolean { return status === 'reserved' || status === 'shown'; }
function key(hostWorkId: string, requestId: string): string { return `${hostWorkId}\u0000${requestId}`; }
function error(code: ConstructorParameters<typeof ApprovalJobBudgetError>[0], message: string): ApprovalJobBudgetError { return new ApprovalJobBudgetError(code, message); }
function unavailable(step: string, cause: unknown): ApprovalJobBudgetError { return error('JOURNAL_UNAVAILABLE', `Unable to ${step} approval budget journal: ${cause instanceof Error ? cause.message : 'unknown error'}`); }
function isState(value: unknown): value is ApprovalJobBudgetState { return typeof value === 'object' && value !== null && (value as { version?: unknown }).version === 1 && typeof (value as { identity?: unknown }).identity === 'object' && Array.isArray((value as { records?: unknown }).records); }
function validateState(state: ApprovalJobBudgetState): void {
  try {
    assertApprovalJobIdentity(state.identity);
    if (!Number.isSafeInteger(state.revision) || state.revision < 1
      || !state.records.every((record) => typeof record.requestId === 'string' && record.requestId.length > 0 && typeof record.actionDigest === 'string' && record.actionDigest.length > 0 && typeof record.shown === 'boolean' && ['reserved', 'shown', 'approved', 'denied', 'cancelled', 'blocked'].includes(record.status)
        && (!['shown', 'approved'].includes(record.status) || record.shown)
        && (!['reserved', 'blocked'].includes(record.status) || !record.shown))
      || new Set(state.records.map((record) => record.requestId)).size !== state.records.length
      || ![state.requested, state.shown, state.blocked, state.approved, state.denied, state.cancelled, state.inDoubt].every((count) => Number.isSafeInteger(count) && count >= 0)
      || state.shown + state.records.filter((record) => record.status === 'reserved').length > MAX_APPROVAL_WINDOWS_PER_JOB || state.requested !== state.records.length
      || state.shown !== state.records.filter((record) => record.shown).length
      || state.blocked !== state.records.filter((record) => record.status === 'blocked').length
      || state.approved !== state.records.filter((record) => record.status === 'approved').length
      || state.denied !== state.records.filter((record) => record.status === 'denied').length
      || state.cancelled !== state.records.filter((record) => record.status === 'cancelled').length
      || state.inDoubt !== state.records.filter((record) => activeStatus(record.status)).length) throw new Error('invalid counters');
  } catch { throw error('INVALID_JOURNAL', 'Approval budget journal failed validation'); }
}
