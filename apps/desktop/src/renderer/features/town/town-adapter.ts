/**
 * PANYA TOWN — lnwjud data → TownSnapshot adapter.
 *
 * Pure: takes already-fetched lnwjud values and shapes them into the evidence
 * the normalizer expects. It adds no judgement of its own: it never turns a
 * missing value into a "good" one. Fetching (IPC, polling, clock) lives in the
 * page; this file only maps.
 */
import type { DashboardSnapshot, DoctorGoalOption } from '@lnwjud/ipc-contracts';
import type {
  TownAgentEvidence,
  TownGoalEvidence,
  TownSnapshot,
} from './town-state.js';

/** Shape of getTaskResult we rely on (subset of TaskResultSummary). */
export interface TownTaskResultInput {
  readonly goalId: string;
  readonly goalRevision: number;
  readonly status: TownGoalEvidence['status'];
  readonly progress?: {
    readonly currentPhase: string;
    readonly nextAction: string;
    readonly updatedAt: string;
    readonly terminalSummary?: string;
  };
  readonly artifacts: readonly { readonly verification: 'verified' | 'unverified' | 'failed' }[];
  readonly checks: TownGoalEvidence['checks'];
  readonly blockers: readonly string[];
  readonly evidenceCoverage: 'complete' | 'partial' | 'unknown';
}

export interface TownAdapterInput {
  readonly workspaceId: string;
  /** Time of the last read in which every source answered; null if never. */
  readonly observedAt: string | null;
  /** True if the latest read of any source failed. */
  readonly fetchFailed: boolean;
  readonly dashboard: Pick<DashboardSnapshot, 'mcp' | 'agentState' | 'inFlight'> | null;
  readonly goalOptions: readonly Pick<DoctorGoalOption, 'goalId' | 'goalKey'>[];
  readonly taskResults: readonly TownTaskResultInput[];
}

export const TOWN_TITLE_MAX = 60;

/** Display text only: the goal key, never the free-text objective. */
export function townGoalTitle(goalKey: string, goalId: string): string {
  const cleaned = goalKey.replace(/\s+/gu, ' ').trim();
  const base = cleaned === '' ? goalId.slice(0, 8) : cleaned;
  return base.length > TOWN_TITLE_MAX ? `${base.slice(0, TOWN_TITLE_MAX - 1)}…` : base;
}

export function buildTownSnapshot(input: TownAdapterInput): TownSnapshot {
  const agent: TownAgentEvidence | null = input.dashboard === null
    ? null
    : {
        mcpRunning: input.dashboard.mcp.running,
        agentState: input.dashboard.agentState,
        inFlight: input.dashboard.inFlight.map((item) => ({
          callId: item.callId,
          toolName: item.toolName,
          startedAt: item.startedAt,
        })),
      };
  const keyById = new Map(input.goalOptions.map((goal) => [goal.goalId, goal.goalKey] as const));
  const goals: TownGoalEvidence[] = input.taskResults.map((result) => ({
    goalId: result.goalId,
    goalRevision: result.goalRevision,
    title: townGoalTitle(keyById.get(result.goalId) ?? '', result.goalId),
    status: result.status,
    checkpointAt: result.progress?.updatedAt ?? null,
    currentPhase: result.progress?.currentPhase ?? null,
    nextAction: result.progress?.nextAction ?? null,
    blockers: result.blockers,
    checks: result.checks,
    artifacts: result.artifacts.map((file) => ({ verification: file.verification })),
    evidenceCoverage: result.evidenceCoverage,
    terminalSummary: result.progress?.terminalSummary ?? null,
  }));
  return {
    scopeId: input.workspaceId,
    environment: 'LIVE-READONLY',
    sourceName: 'lnwjud-desktop',
    observedAt: input.observedAt,
    fetchFailed: input.fetchFailed,
    agent,
    goals,
    guardStop: null, // lnwjud issues no verified guard-stop receipts today.
    ownerAction: { state: 'unsupported' }, // approval queue is not exposed to the renderer yet.
  };
}
