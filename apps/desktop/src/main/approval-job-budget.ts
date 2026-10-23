/** Durable approval-budget contracts. Host code creates identities; callers only receive handles. */
export const MAX_APPROVAL_WINDOWS_PER_JOB = 3;

export interface ApprovalJobIdentity {
  readonly hostWorkId: string;
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly targetId: string;
  readonly scopeDigest: string;
}

export interface ApprovalRequestIdentity {
  readonly requestId: string;
  readonly actionDigest: string;
}

export interface ApprovalRequestContext {
  /** Set only by the host after verifying the current Chrome connection binding. */
  readonly connectionRevision?: number;
  readonly signal: AbortSignal;
  cancel(): void;
}

export type ApprovalJobRecordStatus = 'reserved' | 'shown' | 'approved' | 'denied' | 'cancelled' | 'blocked';

export interface ApprovalJobRecord {
  readonly requestId: string;
  readonly actionDigest: string;
  readonly status: ApprovalJobRecordStatus;
  /** Set only after the host observed the actual native window show event. */
  readonly shown: boolean;
}

export interface ApprovalJobBudgetState {
  readonly version: 1;
  /** Monotonic durable-journal revision used for compare-and-swap writes. */
  readonly revision: number;
  readonly identity: ApprovalJobIdentity;
  readonly records: readonly ApprovalJobRecord[];
  readonly requested: number;
  readonly shown: number;
  readonly blocked: number;
  readonly approved: number;
  readonly denied: number;
  readonly cancelled: number;
  readonly inDoubt: number;
}

/** The desktop host must supply durable storage. There is deliberately no in-memory default. */
export interface ApprovalJobBudgetJournal {
  load(hostWorkId: string): Promise<unknown | undefined>;
  /** Atomically save only if the durable revision still matches; null means no record exists. */
  compareAndSwap(hostWorkId: string, expectedRevision: number | null, state: ApprovalJobBudgetState, connectionRevision?: number): Promise<boolean>;
}

export interface ApprovalJobBudgetSnapshot {
  readonly hostWorkId: string;
  readonly requested: number;
  readonly shown: number;
  readonly blocked: number;
  readonly approved: number;
  readonly denied: number;
  readonly cancelled: number;
  readonly inDoubt: number;
  readonly limit: typeof MAX_APPROVAL_WINDOWS_PER_JOB;
  readonly remaining: number;
}

export type ApprovalJobBudgetErrorCode =
  | 'BUDGET_EXHAUSTED'
  | 'DUPLICATE_REQUEST'
  | 'IDENTITY_MISMATCH'
  | 'INVALID_IDENTITY'
  | 'INVALID_JOURNAL'
  | 'JOURNAL_UNAVAILABLE'
  | 'RECOVERY_REQUIRED'
  | 'UNKNOWN_HANDLE';

export class ApprovalJobBudgetError extends Error {
  public constructor(readonly code: ApprovalJobBudgetErrorCode, message: string) {
    super(message);
    this.name = 'ApprovalJobBudgetError';
  }
}

/** Opaque capability: only ApprovalJobBudget can mint a usable instance. */
export class ApprovalJobHandle {
  private constructor() {}
  static createForBudget(): ApprovalJobHandle { return new ApprovalJobHandle(); }
}

export interface ApprovalBudgetTicket {
  /** Call immediately before creating/showing the approval window. */
  beforeShow(): Promise<boolean>;
  /** Call only from the actual BrowserWindow shown event; consumes one window once. */
  onShown(): Promise<boolean>;
  snapshot(): Promise<ApprovalJobBudgetSnapshot>;
}

export type ApprovalWindowFactory = (ticket: ApprovalBudgetTicket) => Promise<boolean>;

export function approvalJobBudgetSnapshot(state: ApprovalJobBudgetState): ApprovalJobBudgetSnapshot {
  return {
    hostWorkId: state.identity.hostWorkId,
    requested: state.requested,
    shown: state.shown,
    blocked: state.blocked,
    approved: state.approved,
    denied: state.denied,
    cancelled: state.cancelled,
    inDoubt: state.inDoubt,
    limit: MAX_APPROVAL_WINDOWS_PER_JOB,
    remaining: Math.max(0, MAX_APPROVAL_WINDOWS_PER_JOB - state.shown - state.records.filter((record) => record.status === 'reserved').length),
  };
}

export function freshApprovalJobBudgetState(identity: ApprovalJobIdentity): ApprovalJobBudgetState {
  return { version: 1, revision: 1, identity: { ...identity }, records: [], requested: 0, shown: 0, blocked: 0, approved: 0, denied: 0, cancelled: 0, inDoubt: 0 };
}

export function assertApprovalJobIdentity(value: ApprovalJobIdentity): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).length !== 5
    || !['hostWorkId', 'ownerId', 'workspaceId', 'targetId', 'scopeDigest'].every((key) => Object.hasOwn(value, key))) {
    throw new ApprovalJobBudgetError('INVALID_IDENTITY', 'Approval job identity is invalid');
  }
  for (const [name, part] of Object.entries(value)) {
    if (typeof part !== 'string' || part.trim().length === 0 || part.trim() !== part || hasControlCharacters(part) || part.length > 512) {
      throw new ApprovalJobBudgetError('INVALID_IDENTITY', `Approval job ${name} is invalid`);
    }
  }
}

export function assertApprovalRequestIdentity(value: ApprovalRequestIdentity): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'requestId') || !Object.hasOwn(value, 'actionDigest')) {
    throw new ApprovalJobBudgetError('INVALID_IDENTITY', 'Approval request identity is invalid');
  }
  for (const [name, part] of Object.entries(value)) {
    if (typeof part !== 'string' || part.trim().length === 0 || part.trim() !== part || hasControlCharacters(part) || part.length > 512) {
      throw new ApprovalJobBudgetError('INVALID_IDENTITY', `Approval request ${name} is invalid`);
    }
  }
}

export function sameApprovalJobIdentity(a: ApprovalJobIdentity, b: ApprovalJobIdentity): boolean {
  return a.hostWorkId === b.hostWorkId && a.ownerId === b.ownerId && a.workspaceId === b.workspaceId
    && a.targetId === b.targetId && a.scopeDigest === b.scopeDigest;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
