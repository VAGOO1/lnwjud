/**
 * PANYA TOWN — plain facts shown on the four Phase-1 buildings.
 *
 * Counts only, taken straight from fetched evidence. Every value is `null`
 * ("unknown") unless the caller says the snapshot is currently trustworthy, so
 * a stale or failed read can never leave old numbers on screen as if live.
 */
import type { TownAdapterInput } from './town-adapter.js';
import type { TownMissionBoard } from './town-state.js';

export interface TownBuildingFacts {
  readonly gate: { readonly mcpRunning: boolean | null };
  readonly hall: { readonly working: number; readonly done: number; readonly stuck: number; readonly unverified: number } | null;
  readonly review: {
    readonly checksPassed: number; readonly checksFailed: number; readonly checksTotal: number;
    readonly filesVerified: number; readonly filesFailed: number; readonly filesTotal: number;
  } | null;
  readonly archive: { readonly checkpointedGoals: number; readonly latestCheckpointAt: string | null } | null;
}

const UNKNOWN_FACTS: TownBuildingFacts = { gate: { mcpRunning: null }, hall: null, review: null, archive: null };

export function deriveBuildingFacts(input: TownAdapterInput, board: TownMissionBoard): TownBuildingFacts {
  if (board.trust !== 'current') return UNKNOWN_FACTS;
  const results = input.taskResults;
  let checksPassed = 0; let checksFailed = 0; let checksTotal = 0;
  let filesVerified = 0; let filesFailed = 0; let filesTotal = 0;
  let checkpointedGoals = 0; let latest: string | null = null;
  for (const result of results) {
    for (const check of result.checks) {
      checksTotal += 1;
      if (check.status === 'passed') checksPassed += 1;
      if (check.status === 'failed' || check.status === 'blocked') checksFailed += 1;
    }
    for (const file of result.artifacts) {
      filesTotal += 1;
      if (file.verification === 'verified') filesVerified += 1;
      if (file.verification === 'failed') filesFailed += 1;
    }
    const at = result.progress?.updatedAt ?? null;
    if (at !== null && Number.isFinite(Date.parse(at))) {
      checkpointedGoals += 1;
      if (latest === null || Date.parse(at) > Date.parse(latest)) latest = at;
    }
  }
  return {
    gate: { mcpRunning: input.dashboard === null ? null : input.dashboard.mcp.running },
    hall: {
      working: board.working.length, done: board.done.length,
      stuck: board.stuck.length, unverified: board.unverified.length,
    },
    review: { checksPassed, checksFailed, checksTotal, filesVerified, filesFailed, filesTotal },
    archive: { checkpointedGoals, latestCheckpointAt: latest },
  };
}
