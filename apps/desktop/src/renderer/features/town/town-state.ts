/**
 * PANYA TOWN — evidence → status normalizer.
 *
 * Pure functions only: no I/O, no clock, no IPC, no animation input. The town
 * is a *view* of verified upstream facts (design contract R2_08); it never
 * decides that work is running or finished. Anything missing, stale, from the
 * wrong scope, or contradictory resolves to UNKNOWN.
 *
 * Seven canonical statuses are the only statuses. OWNER_ACTION_REQUIRED, STALE
 * and DEMO are badges, never extra statuses.
 */

export const TOWN_STATUSES = ['IDLE', 'WORKING', 'WAITING', 'COMPLETED', 'STOP_SAFE', 'FAILED', 'UNKNOWN'] as const;
export type TownStatus = (typeof TOWN_STATUSES)[number];

export type TownEnvironment = 'DEMO' | 'SANDBOX' | 'LIVE-READONLY';
export type TownBadge = 'DEMO' | 'STALE' | 'OWNER_ACTION_REQUIRED';

export type TownReason =
  | 'verified_idle'
  | 'running_call_evidence'
  | 'goal_checkpoint_fresh'
  | 'goal_checkpoint_stale'
  | 'goal_completed_verified'
  | 'goal_completed_unverified'
  | 'goal_failed_traced'
  | 'goal_failed_untraceable'
  | 'goal_blocked_unclassified'
  | 'goal_cancelled'
  | 'guard_stop_receipt'
  | 'receipt_unverified'
  | 'owner_action_pending'
  | 'mcp_not_running'
  | 'conflicting_evidence'
  | 'scope_mismatch'
  | 'source_unreachable'
  | 'source_stale'
  | 'clock_anomaly'
  | 'no_evidence';

export const TOWN_STATUS_LABEL_TH: Readonly<Record<TownStatus, string>> = {
  IDLE: 'ว่าง',
  WORKING: 'กำลังทำงาน',
  WAITING: 'รอ',
  COMPLETED: 'สำเร็จ',
  STOP_SAFE: 'หยุดอย่างปลอดภัย',
  FAILED: 'ล้มเหลว',
  UNKNOWN: 'ไม่ทราบ',
};

export const TOWN_REASON_LABEL_TH: Readonly<Record<TownReason, string>> = {
  verified_idle: 'ตรวจแล้วไม่มีงานรัน',
  running_call_evidence: 'มีการเรียกเครื่องมือที่กำลังรันจริง',
  goal_checkpoint_fresh: 'เป้าหมายมีบันทึกความคืบหน้าล่าสุด',
  goal_checkpoint_stale: 'บันทึกความคืบหน้าของเป้าหมายเก่าเกินไป',
  goal_completed_verified: 'เสร็จและมีผลตรวจ/ไฟล์ที่ยืนยันแล้ว',
  goal_completed_unverified: 'ยังไม่ยืนยัน (ไม่มีผลตรวจหรือไฟล์ยืนยัน)',
  goal_failed_traced: 'ล้มเหลวและสืบเหตุได้',
  goal_failed_untraceable: 'ล้มเหลวแต่ยังไม่พบเหตุผลที่สืบได้',
  goal_blocked_unclassified: 'ติดขัด แต่ยังไม่ทราบว่ารอใครหรือถูกหยุด',
  goal_cancelled: 'เป้าหมายถูกยกเลิก',
  guard_stop_receipt: 'ระบบป้องกันหยุดงานและมีใบรับรอง',
  receipt_unverified: 'ใบรับรองยังตรวจสอบความถูกต้องไม่ได้',
  owner_action_pending: 'รอเจ้าของดำเนินการ (มีหลักฐาน)',
  mcp_not_running: 'MCP ไม่ได้รัน',
  conflicting_evidence: 'หลักฐานขัดกัน',
  scope_mismatch: 'ข้อมูลมาจากขอบเขตอื่น',
  source_unreachable: 'อ่านข้อมูลไม่ได้',
  source_stale: 'ข้อมูลเก่าเกินไป',
  clock_anomaly: 'เวลาจากแหล่งข้อมูลผิดปกติ',
  no_evidence: 'ไม่มีหลักฐาน',
};

// ---------------------------------------------------------------- input types

export interface TownInFlightCall {
  readonly callId: string;
  readonly toolName: string;
  readonly startedAt: string;
  /** Name the connected AI gave at connect time; null when it never said (shown as unknown, never guessed). */
  readonly clientName: string | null;
}

export interface TownAgentEvidence {
  readonly mcpRunning: boolean;
  /** Dashboard-reported agent state; cross-checked against inFlight. */
  readonly agentState: 'stopped' | 'idle' | 'busy';
  readonly inFlight: readonly TownInFlightCall[];
}

export interface TownGoalEvidence {
  readonly goalId: string;
  readonly goalRevision: number;
  /** Caller-chosen display text. Must not contain secrets or raw chat. */
  readonly title: string;
  readonly status: 'active' | 'completed' | 'failed' | 'blocked' | 'cancelled';
  /** progress.updatedAt of the durable goal, i.e. its last checkpoint. */
  readonly checkpointAt: string | null;
  readonly currentPhase: string | null;
  readonly nextAction: string | null;
  readonly blockers: readonly string[];
  readonly checks: readonly { readonly name: string; readonly status: 'pending' | 'running' | 'passed' | 'failed' | 'blocked' | 'stale' | 'unknown' }[];
  readonly artifacts: readonly { readonly verification: 'verified' | 'unverified' | 'failed' }[];
  readonly evidenceCoverage: 'complete' | 'partial' | 'unknown';
  readonly terminalSummary: string | null;
}

/** A trusted guard stop. Only `integrity: 'verified'` receipts count. */
export interface TownGuardStopReceipt {
  readonly receiptId: string;
  readonly goalId: string | null;
  readonly integrity: 'verified' | 'failed' | 'unknown';
  readonly observedAt: string;
}

/**
 * Owner-action evidence. `unsupported` means the source has no such feed at
 * all (true for lnwjud today) — distinct from `none`, a verified empty queue.
 */
export type TownOwnerActionEvidence =
  | { readonly state: 'unsupported' }
  | { readonly state: 'none' }
  | { readonly state: 'pending'; readonly referenceId: string; readonly observedAt: string };

export interface TownSnapshot {
  readonly scopeId: string;
  readonly environment: TownEnvironment;
  readonly sourceName: string;
  /** Last successful read of the source; null if never read. */
  readonly observedAt: string | null;
  readonly fetchFailed: boolean;
  readonly agent: TownAgentEvidence | null;
  readonly goals: readonly TownGoalEvidence[];
  readonly guardStop: TownGuardStopReceipt | null;
  readonly ownerAction: TownOwnerActionEvidence;
}

/**
 * Source-specific freshness policy, supplied by the caller (never a universal
 * TTL). The clock is injected so the functions stay pure.
 */
export interface TownPolicy {
  readonly expectedScopeId: string;
  readonly expectedEnvironment: TownEnvironment;
  readonly now: string;
  /** Max age of the whole snapshot — set from the page's polling interval. */
  readonly snapshotMaxAgeMs: number;
  /** Max age of a goal checkpoint for an active goal to count as working. */
  readonly goalCheckpointMaxAgeMs: number;
}

// --------------------------------------------------------------- output types

export interface TownEvidence {
  readonly source: string;
  readonly observedAt: string | null;
  readonly ids: readonly string[];
  readonly note: string | null;
}

export interface TownStatusResult {
  readonly status: TownStatus;
  readonly reason: TownReason;
  readonly badges: readonly TownBadge[];
  readonly evidence: TownEvidence;
  /** Last known status, shown only as "previously reported" when stale. */
  readonly previouslyReported: TownStatus | null;
}

export interface TownGoalResult extends TownStatusResult {
  readonly goalId: string;
  readonly goalRevision: number;
  readonly title: string;
  readonly rawStatus: TownGoalEvidence['status'];
  readonly currentPhase: string | null;
  readonly nextAction: string | null;
  readonly blockers: readonly string[];
}

export interface TownBoardCard {
  readonly id: string;
  readonly title: string;
  readonly status: TownStatus;
  readonly reason: TownReason;
  readonly detail: string | null;
  /** Which AI made this call; only set on running-call cards. null = unknown. */
  readonly clientName?: string | null;
}

export interface TownActiveClient {
  readonly name: string | null;
  readonly calls: number;
}

export interface TownMissionBoard {
  readonly trust: 'current' | 'unknown';
  readonly working: readonly TownBoardCard[];
  readonly done: readonly TownBoardCard[];
  readonly stuck: readonly TownBoardCard[];
  /** Finished or active but not provable — never shown as done. */
  readonly unverified: readonly TownBoardCard[];
  readonly awaitingOwner: { readonly supported: boolean; readonly cards: readonly TownBoardCard[] };
}

export interface TownResult {
  readonly environment: TownEnvironment;
  readonly agent: TownStatusResult;
  readonly goals: readonly TownGoalResult[];
  readonly board: TownMissionBoard;
  /**
   * AIs with a call running through lnwjud right now. Empty unless the agent is
   * verified WORKING. A null name means "connected but did not identify itself".
   * AIs that do not pass through lnwjud are invisible here, not "idle".
   */
  readonly activeClients: readonly TownActiveClient[];
}

// ------------------------------------------------------------------- the gate

/** Tolerance for a source clock slightly ahead of ours; not a freshness TTL. */
export const CLOCK_SKEW_TOLERANCE_MS = 5_000;

type GateFailure = 'scope_mismatch' | 'source_unreachable' | 'no_evidence' | 'clock_anomaly' | 'source_stale';

function gateSnapshot(snapshot: TownSnapshot, policy: TownPolicy): GateFailure | null {
  if (snapshot.scopeId !== policy.expectedScopeId || snapshot.environment !== policy.expectedEnvironment) return 'scope_mismatch';
  if (snapshot.fetchFailed) return 'source_unreachable';
  if (snapshot.observedAt === null) return 'no_evidence';
  const observed = Date.parse(snapshot.observedAt);
  const now = Date.parse(policy.now);
  if (!Number.isFinite(observed) || !Number.isFinite(now)) return 'clock_anomaly';
  if (observed - now > CLOCK_SKEW_TOLERANCE_MS) return 'clock_anomaly';
  if (now - observed > policy.snapshotMaxAgeMs) return 'source_stale';
  return null;
}

function badgesFor(snapshot: TownSnapshot, extra: readonly TownBadge[] = []): readonly TownBadge[] {
  const badges = new Set<TownBadge>(extra);
  if (snapshot.environment === 'DEMO') badges.add('DEMO');
  return [...badges];
}

function evidenceFor(snapshot: TownSnapshot, ids: readonly string[] = [], note: string | null = null): TownEvidence {
  return { source: snapshot.sourceName, observedAt: snapshot.observedAt, ids, note };
}

function blocked(snapshot: TownSnapshot, reason: GateFailure, previouslyReported: TownStatus | null): TownStatusResult {
  // Never carry another scope's facts into this scene (F08).
  const crossScope = reason === 'scope_mismatch';
  return {
    status: 'UNKNOWN',
    reason,
    badges: badgesFor(snapshot, reason === 'source_stale' ? ['STALE'] : []),
    evidence: crossScope ? { source: snapshot.sourceName, observedAt: null, ids: [], note: null } : evidenceFor(snapshot),
    previouslyReported: reason === 'source_stale' ? previouslyReported : null,
  };
}

// ------------------------------------------------------------ agent (PN-01)

function agentStatus(snapshot: TownSnapshot): TownStatusResult {
  const base = (status: TownStatus, reason: TownReason, ids: readonly string[] = [], note: string | null = null, extra: readonly TownBadge[] = []): TownStatusResult => ({
    status, reason, badges: badgesFor(snapshot, extra), evidence: evidenceFor(snapshot, ids, note), previouslyReported: null,
  });
  const agent = snapshot.agent;
  if (agent === null) return base('UNKNOWN', 'no_evidence');

  const receipt = snapshot.guardStop;
  if (receipt !== null) {
    if (receipt.integrity === 'verified') return base('STOP_SAFE', 'guard_stop_receipt', [receipt.receiptId]);
    return base('UNKNOWN', 'receipt_unverified', [receipt.receiptId]);
  }

  const running = agent.inFlight.length > 0;
  // Contradictions are never reconciled by guessing (F03, F11).
  if (agent.agentState === 'busy' && !running) return base('UNKNOWN', 'conflicting_evidence', [], 'agentState=busy but no running call');
  if (agent.agentState === 'idle' && running) return base('UNKNOWN', 'conflicting_evidence', [], 'agentState=idle but a call is running');
  if (!agent.mcpRunning || agent.agentState === 'stopped') {
    return running
      ? base('UNKNOWN', 'conflicting_evidence', [], 'MCP not running but a call is reported running')
      : base('UNKNOWN', 'mcp_not_running');
  }
  if (running) {
    const tools = [...new Set(agent.inFlight.map((call) => call.toolName))].join(', ');
    return base('WORKING', 'running_call_evidence', agent.inFlight.map((call) => call.callId), tools);
  }
  return base('IDLE', 'verified_idle');
}

export function deriveAgentStatus(snapshot: TownSnapshot, policy: TownPolicy): TownStatusResult {
  const failure = gateSnapshot(snapshot, policy);
  if (failure !== null) return blocked(snapshot, failure, failure === 'source_stale' ? agentStatus(snapshot).status : null);
  return agentStatus(snapshot);
}

// ------------------------------------------------------------------- goals

function isVerifiedComplete(goal: TownGoalEvidence): boolean {
  if (goal.evidenceCoverage !== 'complete') return false;
  if (goal.checks.some((check) => check.status === 'failed' || check.status === 'blocked')) return false;
  if (goal.artifacts.some((artifact) => artifact.verification === 'failed')) return false;
  return goal.artifacts.some((artifact) => artifact.verification === 'verified') || goal.checks.some((check) => check.status === 'passed');
}

function isFailureTraceable(goal: TownGoalEvidence): boolean {
  return goal.blockers.length > 0
    || goal.checks.some((check) => check.status === 'failed')
    || (goal.terminalSummary !== null && goal.terminalSummary.trim().length > 0);
}

function goalStatus(goal: TownGoalEvidence, snapshot: TownSnapshot, policy: TownPolicy): { status: TownStatus; reason: TownReason; badges: readonly TownBadge[] } {
  const guard = snapshot.guardStop;
  if (guard !== null && guard.goalId === goal.goalId) {
    return guard.integrity === 'verified'
      ? { status: 'STOP_SAFE', reason: 'guard_stop_receipt', badges: [] }
      : { status: 'UNKNOWN', reason: 'receipt_unverified', badges: [] };
  }
  switch (goal.status) {
    case 'completed':
      return isVerifiedComplete(goal)
        ? { status: 'COMPLETED', reason: 'goal_completed_verified', badges: [] }
        : { status: 'UNKNOWN', reason: 'goal_completed_unverified', badges: [] };
    case 'failed':
      return isFailureTraceable(goal)
        ? { status: 'FAILED', reason: 'goal_failed_traced', badges: [] }
        : { status: 'UNKNOWN', reason: 'goal_failed_untraceable', badges: [] };
    case 'cancelled':
      // The contract has no "cancelled" state; we do not relabel it as FAILED.
      return { status: 'UNKNOWN', reason: 'goal_cancelled', badges: [] };
    case 'blocked': {
      const owner = snapshot.ownerAction;
      if (owner.state === 'pending') return { status: 'WAITING', reason: 'owner_action_pending', badges: ['OWNER_ACTION_REQUIRED'] };
      return { status: 'UNKNOWN', reason: 'goal_blocked_unclassified', badges: [] };
    }
    case 'active': {
      const checkpoint = goal.checkpointAt === null ? Number.NaN : Date.parse(goal.checkpointAt);
      const now = Date.parse(policy.now);
      if (!Number.isFinite(checkpoint) || !Number.isFinite(now)) return { status: 'UNKNOWN', reason: 'no_evidence', badges: [] };
      if (checkpoint - now > CLOCK_SKEW_TOLERANCE_MS) return { status: 'UNKNOWN', reason: 'clock_anomaly', badges: [] };
      return now - checkpoint <= policy.goalCheckpointMaxAgeMs
        ? { status: 'WORKING', reason: 'goal_checkpoint_fresh', badges: [] }
        : { status: 'UNKNOWN', reason: 'goal_checkpoint_stale', badges: ['STALE'] };
    }
  }
}

function goalResult(goal: TownGoalEvidence, snapshot: TownSnapshot, policy: TownPolicy): TownGoalResult {
  const failure = gateSnapshot(snapshot, policy);
  const detail = { goalId: goal.goalId, goalRevision: goal.goalRevision, title: goal.title, rawStatus: goal.status, currentPhase: goal.currentPhase, nextAction: goal.nextAction, blockers: goal.blockers };
  if (failure === 'scope_mismatch') {
    // Do not leak another scope's goal text either.
    return { ...blocked(snapshot, failure, null), goalId: goal.goalId, goalRevision: goal.goalRevision, title: '', rawStatus: goal.status, currentPhase: null, nextAction: null, blockers: [] };
  }
  if (failure !== null) {
    const previous = failure === 'source_stale' ? goalStatus(goal, snapshot, policy).status : null;
    const result = blocked(snapshot, failure, previous);
    // Keep the last known owner-action reference visible while stale (F09),
    // labelled so it cannot be mistaken for a current approval.
    const owner = snapshot.ownerAction;
    if (failure === 'source_stale' && owner.state === 'pending') {
      return { ...result, evidence: { ...result.evidence, ids: [`last-known-owner-action:${owner.referenceId}`] }, ...detail };
    }
    return { ...result, ...detail };
  }
  const derived = goalStatus(goal, snapshot, policy);
  return {
    status: derived.status,
    reason: derived.reason,
    badges: badgesFor(snapshot, derived.badges),
    evidence: evidenceFor(snapshot, [goalEventId(goal)]),
    previouslyReported: null,
    ...detail,
  };
}

export function deriveGoalStatus(goal: TownGoalEvidence, snapshot: TownSnapshot, policy: TownPolicy): TownGoalResult {
  return goalResult(goal, snapshot, policy);
}

// ------------------------------------------------------------------ the board

function emptyBoard(snapshot: TownSnapshot): TownMissionBoard {
  return { trust: 'unknown', working: [], done: [], stuck: [], unverified: [], awaitingOwner: { supported: snapshot.ownerAction.state !== 'unsupported', cards: [] } };
}

function deriveBoard(snapshot: TownSnapshot, policy: TownPolicy, goals: readonly TownGoalResult[]): TownMissionBoard {
  if (gateSnapshot(snapshot, policy) !== null) return emptyBoard(snapshot);

  const working: TownBoardCard[] = [];
  const done: TownBoardCard[] = [];
  const stuck: TownBoardCard[] = [];
  const unverified: TownBoardCard[] = [];
  const awaiting: TownBoardCard[] = [];

  for (const goal of goals) {
    const card: TownBoardCard = { id: goalEventId(goal), title: goal.title, status: goal.status, reason: goal.reason, detail: goal.currentPhase };
    if (goal.status === 'WORKING') working.push(card);
    else if (goal.status === 'COMPLETED') done.push(card);
    else if (goal.status === 'WAITING') awaiting.push({ ...card, detail: goal.nextAction ?? goal.currentPhase });
    else if (goal.status === 'FAILED' || goal.status === 'STOP_SAFE' || goal.rawStatus === 'blocked' || goal.rawStatus === 'failed') {
      stuck.push({ ...card, detail: goal.blockers[0] ?? goal.currentPhase });
    } else unverified.push(card);
  }
  for (const call of snapshot.agent?.inFlight ?? []) {
    // Individual running calls are evidence of work; they are not goals.
    if (snapshot.agent !== null && snapshot.agent.mcpRunning && snapshot.agent.agentState === 'busy') {
      working.push({ id: call.callId, title: call.toolName, status: 'WORKING', reason: 'running_call_evidence', detail: call.startedAt, clientName: call.clientName });
    }
  }
  return { trust: 'current', working, done, stuck, unverified, awaitingOwner: { supported: snapshot.ownerAction.state !== 'unsupported', cards: awaiting } };
}

// ------------------------------------------------------------- top-level API

export function deriveTown(snapshot: TownSnapshot, policy: TownPolicy): TownResult {
  const goals = snapshot.goals.map((goal) => goalResult(goal, snapshot, policy));
  const agent = deriveAgentStatus(snapshot, policy);
  return {
    environment: snapshot.environment,
    agent,
    goals,
    board: deriveBoard(snapshot, policy, goals),
    activeClients: agent.status === 'WORKING' ? countActiveClients(snapshot.agent?.inFlight ?? []) : [],
  };
}

function countActiveClients(calls: readonly TownInFlightCall[]): readonly TownActiveClient[] {
  const counts = new Map<string | null, number>();
  for (const call of calls) counts.set(call.clientName, (counts.get(call.clientName) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => ({ name, calls: count }))
    .sort((a, b) => b.calls - a.calls || (a.name ?? '\uffff').localeCompare(b.name ?? '\uffff'));
}

// ---------------------------------------------------------- one-shot events

export function goalEventId(goal: { readonly goalId: string; readonly goalRevision: number }): string {
  return `${goal.goalId}#r${goal.goalRevision}`;
}

/**
 * Completion celebrations are keyed by goal id + revision, so a duplicate
 * snapshot or a replayed event can never celebrate twice (F07). Only verified
 * COMPLETED goals qualify.
 */
export function newCompletionEvents(seen: ReadonlySet<string>, result: TownResult): { readonly fresh: readonly string[]; readonly seen: ReadonlySet<string> } {
  const fresh: string[] = [];
  const next = new Set(seen);
  for (const goal of result.goals) {
    if (goal.status !== 'COMPLETED') continue;
    const id = `${goalEventId(goal)}:completed`;
    if (next.has(id)) continue;
    next.add(id);
    fresh.push(id);
  }
  return { fresh, seen: next };
}
