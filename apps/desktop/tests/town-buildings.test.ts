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
    dashboard: { mcp: { running: true, url: null, workspaceId: 'ws-1' }, agentState: 'idle', codex: { installed: true, version: '1.2.3' }, inFlight: [], workLog: [] },
    goalOptions: [{ goalId: 'g1', goalKey: 'one' }],
    taskResults: [{
      goalId: 'g1', goalRevision: 1, status: 'active',
      progress: { currentPhase: 'p', nextAction: 'n', updatedAt: ago(20) },
      artifacts: [{ verification: 'verified' }, { verification: 'failed' }, { verification: 'unverified' }],
      checks: [{ name: 'a', status: 'passed' }, { name: 'b', status: 'failed' }, { name: 'c', status: 'pending' }],
      blockers: [], evidenceCoverage: 'complete',
    }],
    pendingApprovals: 2,
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
    expect(deriveBuildingFacts(data, board)).toEqual({ gate: { mcpRunning: null }, hall: null, review: null, archive: null, forge: null, peak: null, plaza: null, approval: null });
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
    expect(facts.forge).toEqual({ installed: true, version: '1.2.3', running: 1, recent: { finished: 0, failed: 0 } });
    expect(facts.peak).toEqual({ running: 2, recent: { finished: 0, failed: 0 } });
    expect(facts.plaza).toEqual({ runningCalls: 4, aiCount: 3, recent: { finished: 0, failed: 0 } });
  });

  it('reports Codex as not installed, never as working', () => {
    const base = input();
    const data = input({ dashboard: { ...base.dashboard!, codex: { installed: false, version: null } } });
    const facts = deriveBuildingFacts(data, deriveTown(buildTownSnapshot(data), policy).board);
    expect(facts.forge).toEqual({ installed: false, version: null, running: 0, recent: { finished: 0, failed: 0 } });
  });

  it('has no dashboard data → Forge, Peak, Plaza unknown', () => {
    const data = input({ dashboard: null });
    const facts = deriveBuildingFacts(data, deriveTown(buildTownSnapshot(data), policy).board);
    expect([facts.forge, facts.peak, facts.plaza]).toEqual([null, null, null]);
  });

  it('shows the waiting-approval count only, and unknown when it could not be read', () => {
    const ok = input();
    expect(deriveBuildingFacts(ok, deriveTown(buildTownSnapshot(ok), policy).board).approval).toEqual({ pending: 2 });
    const unread = input({ pendingApprovals: null });
    expect(deriveBuildingFacts(unread, deriveTown(buildTownSnapshot(unread), policy).board).approval).toBeNull();
    const stale = input({ observedAt: ago(600) });
    expect(deriveBuildingFacts(stale, deriveTown(buildTownSnapshot(stale), policy).board).approval).toBeNull();
  });

  it('counts only finished calls of this project inside the last 15 minutes', () => {
    const log = (id: string, toolName: string, kind: 'task' | 'result' | 'error', secondsAgo: number, workspaceId: string | null = 'ws-1'): never => ({
      id, timestamp: ago(secondsAgo), kind, toolName, resultCode: 'x', errorMessage: null, targetSummary: null,
      targetDetail: { kind: 'none' }, durationMs: 1, workspaceId, sessionId: null,
    } as never);
    const base = input();
    const data = input({
      dashboard: {
        ...base.dashboard!,
        workLog: [
          log('1', 'codex_run', 'result', 60), log('2', 'search_text', 'error', 120), log('3', 'read_file', 'result', 30),
          log('4', 'read_file', 'task', 10), log('5', 'read_file', 'result', 16 * 60), log('6', 'read_file', 'result', 20, 'ws-other'),
          log('7', 'read_file', 'result', -30), log('8', 'read_file', 'result', 40, null),
        ],
      },
    });
    const facts = deriveBuildingFacts(data, deriveTown(buildTownSnapshot(data), policy).board);
    expect(facts.plaza?.recent).toEqual({ finished: 4, failed: 1 });
    expect(facts.forge?.recent).toEqual({ finished: 1, failed: 0 });
    expect(facts.peak?.recent).toEqual({ finished: 1, failed: 1 });
  });
});
