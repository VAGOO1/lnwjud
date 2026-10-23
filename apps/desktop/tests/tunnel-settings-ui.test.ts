import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const settingsSource = readFileSync(new URL('../src/renderer/features/settings/SettingsPage.tsx', import.meta.url), 'utf8');
const preloadSource = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8');

describe('Secure Tunnel client selection UI', () => {
  it('binds the override field to the configured path rather than the effective bundled path', () => {
    expect(settingsSource).toContain("setClientPath(props.dashboard.tunnel.configuredClientPath ?? '');");
    expect(settingsSource).toContain('[props.dashboard.tunnel.configuredClientPath]');
  });

  it('surfaces a failed client-path save instead of silently leaving the stale override persisted', () => {
    expect(settingsSource).toContain('async function saveTunnelClientPath(): Promise<void>');
    expect(settingsSource).toContain("setTunnelMessage(cause instanceof Error ? cause.message : 'Could not save tunnel-client');");
    expect(settingsSource).toContain('void saveTunnelClientPath();');
  });

  it('preserves the configured override across the preload IPC validation boundary', () => {
    expect(preloadSource).toContain('const configuredClientPath = value.configuredClientPath === undefined ? undefined : nullableString(value.configuredClientPath);');
    expect(preloadSource).toContain('...(configuredClientPath === undefined ? {} : { configuredClientPath }),');
  });
});
