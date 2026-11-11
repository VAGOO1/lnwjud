import { describe, expect, it } from 'vitest';
import {
  deriveAgentStatus,
  deriveGoalStatus,
  deriveTown,
  newCompletionEvents,
  TOWN_STATUSES,
  type TownGoalEvidence,
  type TownPolicy,
  type TownSnapshot,
} from '../src/renderer/features/town/town-state.js';

const NOW = '2026-11-11T05:00:00.000Z';
const secondsAgo = (seconds: number): string => new Date(Date.parse(NOW) - seconds * 1000).toISOString();

const policy: TownPolicy = {
  expectedScopeId: 'ws-1',
  expectedEnvironment: 'LIVE-READONLY',
  now: NOW,
  snapshotMaxAgeMs: 30_000,
  goalCheckpointMaxAgeMs: 15 * 60_000,
};

function snapshot(overrides: Partial<TownSnapshot> = {}): TownSnapshot {
  return {
    scopeId: 'ws-1',
    environment: 'LIVE-READONLY',
    sourceName: 'lnwjud-dashboard',
    observedAt: secondsAgo(2),
    fetchFailed: false,
    agent: { mcpRunning: true, agentState: 'idle', inFlight: [] },
    goals: [],
    guardStop: null,
    ownerAction: { state: 'unsupported' },
    ...overrides,
  };
}

function goal(overrides: Partial<TownGoalEvidence> = {}): TownGoalEvidence {
  return {
    goalId: 'goal-1',
    goalRevision: 3,
    title: 'ตัวอย่างเป้าหมาย',
    status: 'active',
    checkpointAt: secondsAgo(60),
    currentPhase: 'ขั้นตอนที่ 2',
    nextAction: 'ตรวจผล',
    blockers: [],
    checks: [],
    artifacts: [],
    evidenceCoverage: 'complete',
    terminalSummary: null,
    ...overrides,
  };
}

const runningCall = { callId: 'call-1', toolName: 'write_file', startedAt: secondsAgo(5) };
const verifiedGoal = (): TownGoalEvidence => goal({
  status: 'completed',
  checks: [{ name: 'tests', status: 'passed' }],
  artifacts: [{ verification: 'verified' }],
});

describe('PANYA TOWN status contract (R2_08 fixtures F01–F12)', () => {
  it('F01: verified idle source → IDLE', () => {
    const result = deriveAgentStatus(snapshot(), policy);
    expect(result.status).toBe('IDLE');
    expect(result.reason).toBe('verified_idle');
    expect(result.evidence.source).toBe('lnwjud-dashboard');
  });

  it('F02: running call evidence with a fresh snapshot → WORKING with call ids', () => {
    const result = deriveAgentStatus(snapshot({ agent: { mcpRunning: true, agentState: 'busy', inFlight: [runningCall] } }), policy);
    expect(result.status).toBe('WORKING');
    expect(result.evidence.ids).toEqual(['call-1']);
    expect(result.evidence.note).toBe('write_file');
  });

  it('F03: heartbeat-style "busy" without any running call → UNKNOWN', () => {
    const result = deriveAgentStatus(snapshot({ agent: { mcpRunning: true, agentState: 'busy', inFlight: [] } }), policy);
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toBe('conflicting_evidence');
  });

  it('F04: verified completed goal → COMPLETED, celebrated exactly once', () => {
    const town = deriveTown(snapshot({ goals: [verifiedGoal()] }), policy);
    expect(town.goals[0]?.status).toBe('COMPLETED');
    expect(town.board.done).toHaveLength(1);
    const first = newCompletionEvents(new Set(), town);
    expect(first.fresh).toEqual(['goal-1#r3:completed']);
    expect(newCompletionEvents(first.seen, town).fresh).toEqual([]);
  });

  it('F05: verified guard stop receipt → STOP_SAFE; unverified receipt never counts', () => {
    const stop = deriveAgentStatus(snapshot({ guardStop: { receiptId: 'rcpt-1', goalId: null, integrity: 'verified', observedAt: secondsAgo(1) } }), policy);
    expect(stop.status).toBe('STOP_SAFE');
    expect(stop.reason).toBe('guard_stop_receipt');
    expect(stop.evidence.ids).toEqual(['rcpt-1']);
    for (const integrity of ['failed', 'unknown'] as const) {
      const unverified = deriveAgentStatus(snapshot({ guardStop: { receiptId: 'rcpt-2', goalId: null, integrity, observedAt: secondsAgo(1) } }), policy);
      expect(unverified.status).toBe('UNKNOWN');
      expect(unverified.reason).toBe('receipt_unverified');
    }
  });

  it('F05b: a goal-bound guard stop applies to that goal only', () => {
    const receipt = { receiptId: 'rcpt-3', goalId: 'goal-1', integrity: 'verified', observedAt: secondsAgo(1) } as const;
    const town = deriveTown(snapshot({ guardStop: receipt, goals: [goal(), goal({ goalId: 'goal-2' })] }), policy);
    expect(town.goals.map((item) => item.status)).toEqual(['STOP_SAFE', 'WORKING']);
  });

  it('F06: expired snapshot → UNKNOWN + STALE, old state only as "previously reported"', () => {
    const stale = snapshot({ observedAt: secondsAgo(120), agent: { mcpRunning: true, agentState: 'busy', inFlight: [runningCall] } });
    const result = deriveAgentStatus(stale, policy);
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toBe('source_stale');
    expect(result.badges).toContain('STALE');
    expect(result.previouslyReported).toBe('WORKING');
    const board = deriveTown(stale, policy).board;
    expect(board.trust).toBe('unknown');
    expect(board.working).toEqual([]);
  });

  it('F06b: an active goal whose checkpoint is older than the goal policy is not WORKING', () => {
    const result = deriveGoalStatus(goal({ checkpointAt: secondsAgo(30 * 60) }), snapshot(), policy);
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toBe('goal_checkpoint_stale');
    expect(result.badges).toContain('STALE');
  });

  it('F07: duplicate events never celebrate twice; a new revision is a new event', () => {
    const town = deriveTown(snapshot({ goals: [verifiedGoal()] }), policy);
    const replay = deriveTown(snapshot({ goals: [verifiedGoal()], observedAt: secondsAgo(1) }), policy);
    const once = newCompletionEvents(new Set(), town);
    expect(newCompletionEvents(once.seen, replay).fresh).toEqual([]);
    const nextRevision = deriveTown(snapshot({ goals: [{ ...verifiedGoal(), goalRevision: 4 }] }), policy);
    expect(newCompletionEvents(once.seen, nextRevision).fresh).toEqual(['goal-1#r4:completed']);
  });

  it('F08: a DEMO scope never leaks into a LIVE scene (and vice versa)', () => {
    const demo = snapshot({ scopeId: 'demo', environment: 'DEMO', agent: { mcpRunning: true, agentState: 'busy', inFlight: [runningCall] }, goals: [verifiedGoal()] });
    const intoLive = deriveTown(demo, policy);
    expect(intoLive.agent.status).toBe('UNKNOWN');
    expect(intoLive.agent.reason).toBe('scope_mismatch');
    expect(intoLive.agent.evidence.ids).toEqual([]);
    expect(intoLive.agent.previouslyReported).toBeNull();
    expect(intoLive.goals[0]?.title).toBe('');
    expect(intoLive.board.working).toEqual([]);
    expect(intoLive.board.done).toEqual([]);

    const demoPolicy: TownPolicy = { ...policy, expectedScopeId: 'demo', expectedEnvironment: 'DEMO' };
    const inDemo = deriveAgentStatus(demo, demoPolicy);
    expect(inDemo.status).toBe('WORKING');
    expect(inDemo.badges).toContain('DEMO');
    expect(deriveAgentStatus(snapshot(), policy).badges).not.toContain('DEMO');
  });

  it('F09: stale owner-action → UNKNOWN, last known reference kept but labelled', () => {
    const pending = { state: 'pending', referenceId: 'approval-9', observedAt: secondsAgo(1) } as const;
    const fresh = deriveTown(snapshot({ goals: [goal({ status: 'blocked' })], ownerAction: pending }), policy);
    expect(fresh.goals[0]?.status).toBe('WAITING');
    expect(fresh.goals[0]?.badges).toContain('OWNER_ACTION_REQUIRED');
    expect(fresh.board.awaitingOwner.cards).toHaveLength(1);

    const stale = deriveTown(snapshot({ observedAt: secondsAgo(300), goals: [goal({ status: 'blocked' })], ownerAction: pending }), policy);
    expect(stale.goals[0]?.status).toBe('UNKNOWN');
    expect(stale.goals[0]?.previouslyReported).toBe('WAITING');
    expect(stale.goals[0]?.evidence.ids).toEqual(['last-known-owner-action:approval-9']);
    expect(stale.board.awaitingOwner.cards).toEqual([]);
  });

  it('F10: failed read → UNKNOWN, nothing invented', () => {
    const town = deriveTown(snapshot({ fetchFailed: true, goals: [verifiedGoal()] }), policy);
    expect(town.agent.status).toBe('UNKNOWN');
    expect(town.agent.reason).toBe('source_unreachable');
    expect(town.goals[0]?.status).toBe('UNKNOWN');
    expect(town.board.trust).toBe('unknown');
  });

  it('F11: contradictory evidence → UNKNOWN, never guessed', () => {
    const idleButRunning = deriveAgentStatus(snapshot({ agent: { mcpRunning: true, agentState: 'idle', inFlight: [runningCall] } }), policy);
    expect(idleButRunning.status).toBe('UNKNOWN');
    expect(idleButRunning.reason).toBe('conflicting_evidence');
    const stoppedButRunning = deriveAgentStatus(snapshot({ agent: { mcpRunning: false, agentState: 'stopped', inFlight: [runningCall] } }), policy);
    expect(stoppedButRunning.reason).toBe('conflicting_evidence');
  });

  it('F12: status ignores presentation input and is deterministic', () => {
    const base = snapshot({ agent: { mcpRunning: true, agentState: 'idle', inFlight: [] } });
    const walking = { ...base, npcWalking: true, animation: 'run' } as unknown as TownSnapshot;
    expect(deriveTown(walking, policy)).toEqual(deriveTown(base, policy));
    expect(deriveTown(base, policy)).toEqual(deriveTown(base, policy));
  });
});

describe('PANYA TOWN status rules beyond the fixtures', () => {
  it('uses only the seven canonical statuses', () => {
    expect([...TOWN_STATUSES]).toEqual(['IDLE', 'WORKING', 'WAITING', 'COMPLETED', 'STOP_SAFE', 'FAILED', 'UNKNOWN']);
  });

  it('MCP not running → UNKNOWN (not STOP_SAFE)', () => {
    const result = deriveAgentStatus(snapshot({ agent: { mcpRunning: false, agentState: 'stopped', inFlight: [] } }), policy);
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toBe('mcp_not_running');
  });

  it('no agent evidence → UNKNOWN', () => {
    expect(deriveAgentStatus(snapshot({ agent: null }), policy).reason).toBe('no_evidence');
    expect(deriveAgentStatus(snapshot({ observedAt: null }), policy).reason).toBe('no_evidence');
  });

  it('a snapshot dated in the future, or an unparsable one, is a clock anomaly', () => {
    expect(deriveAgentStatus(snapshot({ observedAt: new Date(Date.parse(NOW) + 60_000).toISOString() }), policy).reason).toBe('clock_anomaly');
    expect(deriveAgentStatus(snapshot({ observedAt: 'not-a-date' }), policy).reason).toBe('clock_anomaly');
  });

  it('completed without verified evidence is "unverified", never done', () => {
    for (const unproven of [
      goal({ status: 'completed' }),
      goal({ status: 'completed', evidenceCoverage: 'partial', checks: [{ name: 't', status: 'passed' }] }),
      goal({ status: 'completed', checks: [{ name: 't', status: 'passed' }, { name: 'u', status: 'failed' }] }),
      goal({ status: 'completed', artifacts: [{ verification: 'verified' }, { verification: 'failed' }] }),
      goal({ status: 'completed', artifacts: [{ verification: 'unverified' }] }),
    ]) {
      const town = deriveTown(snapshot({ goals: [unproven] }), policy);
      expect(town.goals[0]?.status).toBe('UNKNOWN');
      expect(town.goals[0]?.reason).toBe('goal_completed_unverified');
      expect(town.board.done).toEqual([]);
      expect(town.board.unverified).toHaveLength(1);
      expect(newCompletionEvents(new Set(), town).fresh).toEqual([]);
    }
  });

  it('failed needs a traceable reason; otherwise UNKNOWN but still on the stuck lane', () => {
    const traced = deriveTown(snapshot({ goals: [goal({ status: 'failed', blockers: ['เขียนไฟล์ไม่ได้'] })] }), policy);
    expect(traced.goals[0]?.status).toBe('FAILED');
    expect(traced.board.stuck[0]?.detail).toBe('เขียนไฟล์ไม่ได้');
    const untraced = deriveTown(snapshot({ goals: [goal({ status: 'failed' })] }), policy);
    expect(untraced.goals[0]?.status).toBe('UNKNOWN');
    expect(untraced.goals[0]?.reason).toBe('goal_failed_untraceable');
    expect(untraced.board.stuck).toHaveLength(1);
  });

  it('blocked without owner evidence stays UNKNOWN on the stuck lane; awaiting-owner is "unsupported"', () => {
    const town = deriveTown(snapshot({ goals: [goal({ status: 'blocked', blockers: ['รอตรวจศิลป์'] })] }), policy);
    expect(town.goals[0]?.status).toBe('UNKNOWN');
    expect(town.goals[0]?.reason).toBe('goal_blocked_unclassified');
    expect(town.board.stuck).toHaveLength(1);
    expect(town.board.awaitingOwner.supported).toBe(false);
    expect(deriveTown(snapshot({ ownerAction: { state: 'none' } }), policy).board.awaitingOwner.supported).toBe(true);
  });

  it('cancelled is not relabelled as FAILED', () => {
    const result = deriveGoalStatus(goal({ status: 'cancelled' }), snapshot(), policy);
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toBe('goal_cancelled');
  });

  it('active goal: fresh checkpoint → WORKING; no checkpoint → UNKNOWN', () => {
    const working = deriveTown(snapshot({ goals: [goal()] }), policy);
    expect(working.goals[0]?.status).toBe('WORKING');
    expect(working.board.working).toHaveLength(1);
    expect(deriveGoalStatus(goal({ checkpointAt: null }), snapshot(), policy).reason).toBe('no_evidence');
    expect(deriveGoalStatus(goal({ checkpointAt: new Date(Date.parse(NOW) + 60_000).toISOString() }), snapshot(), policy).reason).toBe('clock_anomaly');
  });

  it('running calls appear on the board only with consistent agent evidence', () => {
    const consistent = deriveTown(snapshot({ agent: { mcpRunning: true, agentState: 'busy', inFlight: [runningCall] } }), policy);
    expect(consistent.board.working.map((card) => card.id)).toEqual(['call-1']);
    const conflicting = deriveTown(snapshot({ agent: { mcpRunning: true, agentState: 'idle', inFlight: [runningCall] } }), policy);
    expect(conflicting.board.working).toEqual([]);
  });
});
