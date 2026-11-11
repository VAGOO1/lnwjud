import { describe, expect, it } from 'vitest';
import type { TownAdapterInput } from '../src/renderer/features/town/town-adapter.js';
import { buildTownSnapshot } from '../src/renderer/features/town/town-adapter.js';
import { deriveBuildingFacts } from '../src/renderer/features/town/town-buildings.js';
import { deriveTown, type TownPolicy } from '../src/renderer/features/town/town-state.js';

const NOW = '2026-11-11T05:00:00.000Z';
const ago = (seconds: number): string => new Date(Date.parse(NOW) - seconds * 1000).toISOString();
const policy: TownPolicy = {
  expectedScopeId: 'ws-1', expectedEnvironment: 'LIVE-READONLY', now: NOW,
  snapshotMaxAgeMs: 45_000, goalCheckpointMaxAgeMs: 12 * 60_000,
};

function input(overrides: Partial<TownAdapterInput> = {}): TownAdapterInput {
  return {
    workspaceId: 'ws-1', observedAt: ago(3), fetchFailed: false,
    dashboard: { mcp: { running: true, url: null, workspaceId: 'ws-1' }, agentState: 'idle', codex: { installed: true, version: '1.2.3' }, inFlight: [] },
    goalOptions: [{ goalId: 'g1', goalKey: 'one' }],
    taskResults: [{
      goalId: 'g1', goalRevision: 1, status: 'active',
      progress: { currentPhase: 'p', nextAction: 'n', updatedAt: ago(20) },
      artifacts: [{ verification: 'verified' }, { verification: 'failed' }, { verification: 'unverified' }],
      checks: [{ name: 'a', status: 'passed' }, { name: 'b', status: 'failed' }, { name: 'c', status: 'pending' }],
      blockers: [], evidenceCoverage: 'complete',
    }],
    ...overrides,
  };
}

describe('town building facts', () => {
  it('counts checks, files and checkpoints from real evidence', () => {
    const data = input();
    const facts = deriveBuildingFacts(data, deriveTown(buildTownSnapshot(data), policy).board);
    expect(facts.review).toEqual({ checksPassed: 1, checksFailed: 1, checksTotal: 3, filesVerified: 1, filesFailed: 1, filesTotal: 3 });
    expect(facts.archive).toEqual({ checkpointedGoals: 1, latestCheckpointAt: ago(20) });
    expect(facts.hall?.working).toBe(1);
    expect(facts.gate.mcpRunning).toBe(true);
  });

  it('shows nothing (unknown) when the snapshot is stale', () => {
    const data = input({ observedAt: ago(600) });
    const board = deriveTown(buildTownSnapshot(data), policy).board;
    expect(board.trust).toBe('unknown');
    expect(deriveBuildingFacts(data, board)).toEqual({ gate: { mcpRunning: null }, hall: null, review: null, archive: null, forge: null, peak: null, plaza: null });
  });

  it('shows nothing when the last read failed', () => {
    const data = input({ fetchFailed: true });
    const facts = deriveBuildingFacts(data, deriveTown(buildTownSnapshot(data), policy).board);
    expect(facts.hall).toBeNull();
    expect(facts.gate.mcpRunning).toBeNull();
  });

  it('counts only calls really running for Forge, Peak and Plaza', () => {
    const call = (callId: string, toolName: string, clientName: string | null): { callId: string; toolName: string; startedAt: string; clientName: string | null } => ({ callId, toolName, startedAt: ago(5), clientName });
    const base = input();
    const data = input({
      dashboard: {
        ...base.dashboard!, agentState: 'working',
        inFlight: [call('1', 'codex_run', 'A'), call('2', 'search_text', 'A'), call('3', 'find_files', null), call('4', 'read_file', 'B')],
      },
    });
    const facts = deriveBuildingFacts(data, deriveTown(buildTownSnapshot(data), policy).board);
    expect(facts.forge).toEqual({ installed: true, version: '1.2.3', running: 1 });
    expect(facts.peak).toEqual({ running: 2 });
    expect(facts.plaza).toEqual({ runningCalls: 4, aiCount: 3 });
  });

  it('reports Codex as not installed, never as working', () => {
    const base = input();
    const data = input({ dashboard: { ...base.dashboard!, codex: { installed: false, version: null } } });
    const facts = deriveBuildingFacts(data, deriveTown(buildTownSnapshot(data), policy).board);
    expect(facts.forge).toEqual({ installed: false, version: null, running: 0 });
  });

  it('has no dashboard data → Forge, Peak, Plaza unknown', () => {
    const data = input({ dashboard: null });
    const facts = deriveBuildingFacts(data, deriveTown(buildTownSnapshot(data), policy).board);
    expect([facts.forge, facts.peak, facts.plaza]).toEqual([null, null, null]);
  });
});
