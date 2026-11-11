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
  /** Codex Forge: is the Codex helper installed, and how many codex_* calls are running right now. */
  readonly forge: { readonly installed: boolean; readonly version: string | null; readonly running: number } | null;
  /** Research Peak: look-up calls running right now (conservative name prefixes only). */
  readonly peak: { readonly running: number } | null;
  /** Central Plaza: all calls running right now and how many distinct AI names sit behind them. */
  readonly plaza: { readonly runningCalls: number; readonly aiCount: number } | null;
  /** Approval Gate: owner approvals waiting in the whole app (count only, never the request). */
  readonly approval: { readonly pending: number } | null;
}

/** Conservative on purpose: a tool that does not match is simply not counted, never mis-counted. */
const FORGE_TOOL = /^codex_/u;
const PEAK_TOOL = /^(?:search_|symbol_|find_)/u;

const UNKNOWN_FACTS: TownBuildingFacts = { gate: { mcpRunning: null }, hall: null, review: null, archive: null, forge: null, peak: null, plaza: null, approval: null };

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
  const inFlight = input.dashboard?.inFlight ?? [];
  const codex = input.dashboard?.codex ?? null;
  return {
    approval: input.pendingApprovals === null ? null : { pending: input.pendingApprovals },
    forge: codex === null ? null : {
      installed: codex.installed, version: codex.version,
      running: inFlight.filter((call) => FORGE_TOOL.test(call.toolName)).length,
    },
    peak: input.dashboard === null ? null : { running: inFlight.filter((call) => PEAK_TOOL.test(call.toolName)).length },
    plaza: input.dashboard === null ? null : {
      runningCalls: inFlight.length,
      aiCount: new Set(inFlight.map((call) => call.clientName ?? null)).size,
    },
    gate: { mcpRunning: input.dashboard === null ? null : input.dashboard.mcp.running },
    hall: {
      working: board.working.length, done: board.done.length,
      stuck: board.stuck.length, unverified: board.unverified.length,
    },
    review: { checksPassed, checksFailed, checksTotal, filesVerified, filesFailed, filesTotal },
    archive: { checkpointedGoals, latestCheckpointAt: latest },
  };
}
