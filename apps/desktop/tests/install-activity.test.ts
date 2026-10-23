import { describe, expect, it } from 'vitest';
import { InstallActivityCoordinator } from '../src/main/install-activity.js';

describe('InstallActivityCoordinator', () => {
  it('tracks concurrent machine installers, preserves start time, clamps progress, and clears independently', () => {
    const published: unknown[] = [];
    const times = [
      '2026-09-21T10:00:00.000Z',
      '2026-09-21T10:00:01.000Z',
      '2026-09-21T10:00:02.000Z',
      '2026-09-21T10:00:03.000Z',
    ];
    const coordinator = new InstallActivityCoordinator(
      (snapshot) => published.push(snapshot),
      () => times.shift() ?? '2026-09-21T10:00:09.000Z',
    );

    coordinator.set({ kind: 'ngrok', phase: 'installing', progressPercent: null, message: 'Installing ngrok' });
    coordinator.set({ kind: 'app_update', phase: 'downloading', progressPercent: 150, message: 'Downloading update' });
    coordinator.set({ kind: 'ngrok', phase: 'finalizing', progressPercent: 90, message: 'Checking ngrok' });

    expect(coordinator.snapshot()).toEqual({
      operations: [
        {
          kind: 'ngrok',
          phase: 'finalizing',
          progressPercent: 90,
          message: 'Checking ngrok',
          startedAt: '2026-09-21T10:00:00.000Z',
          updatedAt: '2026-09-21T10:00:02.000Z',
        },
        {
          kind: 'app_update',
          phase: 'downloading',
          progressPercent: 100,
          message: 'Downloading update',
          startedAt: '2026-09-21T10:00:01.000Z',
          updatedAt: '2026-09-21T10:00:01.000Z',
        },
      ],
    });

    coordinator.clear('ngrok');
    expect(coordinator.snapshot().operations.map((operation) => operation.kind)).toEqual(['app_update']);
    expect(published).toHaveLength(4);
  });
});
