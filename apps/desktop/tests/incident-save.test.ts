import { describe, expect, it, vi } from 'vitest';
import { IncidentSaveCoordinator } from '../src/main/incident-save.js';
import type { IncidentReport } from '../src/main/incident-report.js';

const report = { classification: 'healthy_or_inconclusive', capturedAt: '2026-08-20T00:00:00.000Z' } as IncidentReport;

describe('production incident save coordinator', () => {
  it('returns cancel without writing and propagates collection/save errors', async () => {
    const write = vi.fn(async (): Promise<void> => undefined);
    const cancelled = new IncidentSaveCoordinator({ capture: async (): Promise<IncidentReport> => report, choosePath: async (): Promise<null> => null, write });
    await expect(cancelled.captureAndSave()).resolves.toEqual({ exported: false, cancelled: true, classification: report.classification, capturedAt: null });
    expect(write).not.toHaveBeenCalled();

    const failed = new IncidentSaveCoordinator({ capture: async (): Promise<IncidentReport> => report, choosePath: async (): Promise<string> => 'incident.json', write: async (): Promise<void> => { throw new Error('disk full'); } });
    await expect(failed.captureAndSave()).rejects.toThrow('disk full');
  });

  it('writes once and coalesces concurrent renderer requests through one collection/dialog', async () => {
    const capture = vi.fn(async (): Promise<IncidentReport> => report);
    const choosePath = vi.fn(async (): Promise<string> => 'incident.json');
    const write = vi.fn(async (): Promise<void> => undefined);
    const coordinator = new IncidentSaveCoordinator({ capture, choosePath, write });
    await expect(Promise.all([coordinator.captureAndSave(), coordinator.captureAndSave()])).resolves.toEqual([
      { exported: true, cancelled: false, classification: report.classification, capturedAt: report.capturedAt },
      { exported: true, cancelled: false, classification: report.classification, capturedAt: report.capturedAt },
    ]);
    expect(capture).toHaveBeenCalledOnce();
    expect(choosePath).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
  });
});
