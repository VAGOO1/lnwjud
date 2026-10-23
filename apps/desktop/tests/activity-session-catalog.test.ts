import { describe, expect, it } from 'vitest';
import type { ActivitySessionSummary } from '@lnwjud/audit';
import { ActivitySessionCatalog } from '../src/main/activity-session-catalog.js';

describe('ActivitySessionCatalog', () => {
  it('loads persisted sessions once and updates new activity without rescanning audit history', async () => {
    let loads = 0;
    const persisted: ActivitySessionSummary[] = [{
      sessionId: 'session-old',
      workspaceId: 'workspace-a',
      startedAt: '2026-09-19T00:00:00.000Z',
      lastActivityAt: '2026-09-19T00:01:00.000Z',
    }];
    const catalog = new ActivitySessionCatalog({
      async listActivitySessions(): Promise<ActivitySessionSummary[]> {
        loads += 1;
        return persisted;
      },
    }, {
      isVisible: (): boolean => true,
    });

    expect(await catalog.list()).toHaveLength(1);
    expect(await catalog.list()).toHaveLength(1);
    expect(loads).toBe(1);

    catalog.record({
      sessionId: 'session-new',
      workspaceId: 'workspace-b',
      timestamp: '2026-09-20T01:00:00.000Z',
    });
    catalog.record({
      sessionId: 'session-new',
      workspaceId: 'workspace-b',
      timestamp: '2026-09-20T01:05:00.000Z',
    });

    expect(await catalog.list()).toEqual([
      {
        sessionId: 'session-new',
        workspaceId: 'workspace-b',
        startedAt: '2026-09-20T01:00:00.000Z',
        lastActivityAt: '2026-09-20T01:05:00.000Z',
      },
      {
        sessionId: 'session-old',
        workspaceId: 'workspace-a',
        startedAt: '2026-09-19T00:00:00.000Z',
        lastActivityAt: '2026-09-19T00:01:00.000Z',
      },
    ]);
    expect(loads).toBe(1);
  });

  it('applies the current work-log visibility state without reloading the catalog', async () => {
    let hiddenSession: string | null = null;
    const catalog = new ActivitySessionCatalog({
      async listActivitySessions(): Promise<ActivitySessionSummary[]> {
        return [{
          sessionId: 'session-a',
          startedAt: '2026-09-20T00:00:00.000Z',
          lastActivityAt: '2026-09-20T00:01:00.000Z',
        }];
      },
    }, {
      isVisible: (event): boolean => event.sessionId !== hiddenSession,
    });

    expect(await catalog.list()).toHaveLength(1);
    hiddenSession = 'session-a';
    expect(await catalog.list()).toEqual([]);
  });
});
