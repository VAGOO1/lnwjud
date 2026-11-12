import { describe, expect, it } from 'vitest';
import {
  buildTownSnapshot,
  townGoalTitle,
  TOWN_TITLE_MAX,
  type TownAdapterInput,
  type TownTaskResultInput,
} from '../src/renderer/features/town/town-adapter.js';
import { deriveTown, type TownPolicy } from '../src/renderer/features/town/town-state.js';

const NOW = '2026-11-11T05:00:00.000Z';
const ago = (seconds: number): string => new Date(Date.parse(NOW) - seconds * 1000).toISOString();

const policy: TownPolicy = {
  expectedScopeId: 'ws-1',
  expectedEnvironment: 'LIVE-READONLY',
  now: NOW,
  snapshotMaxAgeMs: 30_000,
  goalCheckpointMaxAgeMs: 15 * 60_000,
};

function result(overrides: Partial<TownTaskResultInput> = {}): TownTaskResultInput {
  return {
    goalId: 'goal-1',
    goalRevision: 2,
    status: 'active',
    progress: { currentPhase: 'ขั้นที่ 1', nextAction: 'ตรวจ', updatedAt: ago(30) },
    artifacts: [],
    checks: [],
    blockers: [],
    evidenceCoverage: 'complete',
    ...overrides,
  };
}

function input(overrides: Partial<TownAdapterInput> = {}): TownAdapterInput {
  return {
    workspaceId: 'ws-1',
    observedAt: ago(2),
    fetchFailed: false,
    dashboard: { mcp: { running: true, url: null, workspaceId: 'ws-1' }, agentState: 'idle', codex: { installed: true, version: null }, inFlight: [], workLog: [] },
    goalOptions: [{ goalId: 'goal-1', goalKey: 'repair-import' }],
    taskResults: [], pendingApprovals: 0,
    ...overrides,
  };
}

describe('town adapter', () => {
  it('marks the source as read-only with no owner-action feed and no guard receipt', () => {
    const snap = buildTownSnapshot(input());
    expect(snap.environment).toBe('LIVE-READONLY');
    expect(snap.ownerAction).toEqual({ state: 'unsupported' });
    expect(snap.guardStop).toBeNull();
    expect(snap.scopeId).toBe('ws-1');
  });

  it('maps in-flight calls without target details', () => {
    const snap = buildTownSnapshot(input({
      dashboard: {
        mcp: { running: true, url: null, workspaceId: 'ws-1' },
        agentState: 'busy',
        inFlight: [{
          callId: 'c1', toolName: 'write_file', startedAt: ago(4), targetSummary: 'C:\\secret\\file.txt', clientName: 'Claude Desktop',
          targetDetail: {} as never, workspaceId: 'ws-1', sessionId: 's1',
        }],
      },
    }));
    expect(snap.agent?.inFlight).toEqual([{ callId: 'c1', toolName: 'write_file', startedAt: ago(4), clientName: 'Claude Desktop' }]);
    expect(JSON.stringify(snap)).not.toContain('secret');
  });

  it('uses the goal key as the title and never the free-text objective', () => {
    const snap = buildTownSnapshot(input({ taskResults: [result()] }));
    expect(snap.goals[0]?.title).toBe('repair-import');
  });

  it('falls back to a short id and truncates long keys', () => {
    expect(townGoalTitle('', 'abcdef123456')).toBe('abcdef12');
    expect(townGoalTitle('x'.repeat(200), 'g')).toHaveLength(TOWN_TITLE_MAX);
  });

  it('keeps a missing dashboard as null evidence (never invents idle)', () => {
    const snap = buildTownSnapshot(input({ dashboard: null }));
    expect(snap.agent).toBeNull();
    expect(deriveTown(snap, policy).agent.status).toBe('UNKNOWN');
  });

  it('end to end: idle agent + fresh active goal + completed-without-evidence goal', () => {
    const snap = buildTownSnapshot(input({
      taskResults: [
        result(),
        result({ goalId: 'goal-2', status: 'completed', progress: { currentPhase: '', nextAction: '', updatedAt: ago(100), terminalSummary: 'เสร็จ' } }),
      ],
      goalOptions: [{ goalId: 'goal-1', goalKey: 'a' }, { goalId: 'goal-2', goalKey: 'b' }],
    }));
    const town = deriveTown(snap, policy);
    expect(town.agent.status).toBe('IDLE');
    expect(town.board.working.map((card) => card.id)).toContain('goal-1#r2');
    expect(town.board.done).toHaveLength(0);
    expect(town.board.unverified.map((card) => card.id)).toContain('goal-2#r2');
    expect(town.board.awaitingOwner.supported).toBe(false);
  });

  it('a failed read yields UNKNOWN even when old evidence says working', () => {
    const snap = buildTownSnapshot(input({ fetchFailed: true, taskResults: [result()] }));
    const town = deriveTown(snap, policy);
    expect(town.agent.status).toBe('UNKNOWN');
    expect(town.board.trust).toBe('unknown');
  });
});

describe('town AI labels', () => {
  const call = (id: string, clientName: string | null | undefined): NonNullable<TownAdapterInput['dashboard']>['inFlight'][number] => ({
    callId: id, toolName: 'read_file', startedAt: ago(3), ...(clientName === undefined ? {} : { clientName }),
  } as never);
  const busy = (calls: ReturnType<typeof call>[], over: Partial<TownAdapterInput> = {}): TownAdapterInput => input({
    dashboard: { mcp: { running: true, url: null, workspaceId: 'ws-1' }, agentState: 'busy', inFlight: calls },
    ...over,
  });

  it('counts which AI is working, with unnamed callers kept as unknown (null)', () => {
    const data = busy([call('1', 'Claude Desktop'), call('2', 'Claude Desktop'), call('3', 'openai-mcp'), call('4', undefined)]);
    const town = deriveTown(buildTownSnapshot(data), policy);
    expect(town.activeClients).toEqual([
      { name: 'Claude Desktop', calls: 2 },
      { name: 'openai-mcp', calls: 1 },
      { name: null, calls: 1 },
    ]);
    const card = town.board.working.find((item) => item.id === '3');
    expect(card?.clientName).toBe('openai-mcp');
    expect(town.board.working.find((item) => item.id === '4')?.clientName).toBeNull();
  });

  it('shows no AI list when the agent is not verified WORKING (idle, failed read, stale)', () => {
    expect(deriveTown(buildTownSnapshot(input()), policy).activeClients).toEqual([]);
    expect(deriveTown(buildTownSnapshot(busy([call('1', 'Claude Desktop')], { fetchFailed: true })), policy).activeClients).toEqual([]);
    expect(deriveTown(buildTownSnapshot(busy([call('1', 'Claude Desktop')], { observedAt: ago(600) })), policy).activeClients).toEqual([]);
  });

  it('does not show an AI as working when busy contradicts the running calls', () => {
    const data = busy([]);
    expect(deriveTown(buildTownSnapshot(data), policy).activeClients).toEqual([]);
  });
});
