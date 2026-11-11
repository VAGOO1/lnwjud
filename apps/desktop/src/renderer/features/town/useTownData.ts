import { useEffect, useRef, useState } from 'react';
import type { TownAdapterInput, TownTaskResultInput } from './town-adapter.js';

export const TOWN_POLL_MS = 15_000;
/** Whole-snapshot freshness: three missed polls and a margin. */
export const TOWN_SNAPSHOT_MAX_AGE_MS = 50_000;
/** AGENTS.md asks active goals to checkpoint at least every 10 minutes; 2 minutes of margin. */
export const TOWN_GOAL_CHECKPOINT_MAX_AGE_MS = 12 * 60_000;
const TOWN_MAX_GOALS = 12;
const CLOCK_TICK_MS = 5_000;

export interface TownData {
  readonly input: TownAdapterInput | null;
  /** ISO time used as "now" for the freshness policy. */
  readonly now: string;
}

/**
 * Reads lnwjud (read-only IPC calls: getDashboard, getDoctorGoals,
 * getTaskResult) and reports when the last fully successful read happened.
 * A failed or partial read sets fetchFailed; it never fabricates data.
 */
export function useTownData(workspaceId: string | null): TownData {
  const [input, setInput] = useState<TownAdapterInput | null>(null);
  const [now, setNow] = useState(() => new Date().toISOString());
  const lastGood = useRef<{ observedAt: string; goalOptions: TownAdapterInput['goalOptions']; taskResults: readonly TownTaskResultInput[]; dashboard: TownAdapterInput['dashboard'] } | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date().toISOString()), CLOCK_TICK_MS);
    return (): void => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    lastGood.current = null;
    setInput(null);
    if (workspaceId === null) return undefined;
    let active = true;
    let busy = false;

    async function poll(): Promise<void> {
      if (busy || document.visibilityState !== 'visible' || workspaceId === null) return;
      busy = true;
      try {
        const [dashboard, goals] = await Promise.all([
          window.lnwjud.getDashboard(),
          window.lnwjud.getDoctorGoals({ workspaceId, view: 'results' }),
        ]);
        const chosen = [...goals]
          .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, TOWN_MAX_GOALS);
        const settled = await Promise.allSettled(
          chosen.map((goal) => window.lnwjud.getTaskResult({ workspaceId, goalId: goal.goalId })),
        );
        const taskResults: TownTaskResultInput[] = [];
        let partial = false;
        for (const item of settled) {
          if (item.status === 'fulfilled') taskResults.push(item.value);
          else partial = true;
        }
        if (!active) return;
        if (partial) {
          setInput((previous) => ({
            workspaceId, observedAt: lastGood.current?.observedAt ?? null, fetchFailed: true,
            dashboard: previous?.dashboard ?? null, goalOptions: previous?.goalOptions ?? [], taskResults: previous?.taskResults ?? [],
          }));
          return;
        }
        const observedAt = new Date().toISOString();
        lastGood.current = { observedAt, goalOptions: chosen, taskResults, dashboard };
        setInput({ workspaceId, observedAt, fetchFailed: false, dashboard, goalOptions: chosen, taskResults });
      } catch {
        if (!active) return;
        setInput((previous) => ({
          workspaceId, observedAt: lastGood.current?.observedAt ?? null, fetchFailed: true,
          dashboard: previous?.dashboard ?? null, goalOptions: previous?.goalOptions ?? [], taskResults: previous?.taskResults ?? [],
        }));
      } finally {
        busy = false;
      }
    }

    void poll();
    const timer = window.setInterval(() => { void poll(); }, TOWN_POLL_MS);
    const onVisible = (): void => { void poll(); };
    document.addEventListener('visibilitychange', onVisible);
    return (): void => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [workspaceId]);

  return { input, now };
}
