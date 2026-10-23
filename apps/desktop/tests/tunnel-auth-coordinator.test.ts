import { describe, expect, it, vi } from 'vitest';
import { TunnelAuthCoordinator } from '../src/main/tunnel-auth-coordinator.js';
import type { TunnelAuthProvider, TunnelRuntimeCredential } from '../src/main/tunnel-auth.js';

function provider(mode: 'legacy_api_key' | 'oauth', credential: TunnelRuntimeCredential | null): TunnelAuthProvider {
  return {
    status: vi.fn(async () => ({
      mode,
      authReady: credential !== null,
      runtimeCredentialAvailable: credential !== null,
      hasLegacyApiKey: mode === 'legacy_api_key' && credential !== null,
      accountLabel: mode === 'oauth' ? 'user@example.test' : null,
      organizationId: mode === 'oauth' ? 'org-1' : null,
      workspaceId: mode === 'oauth' ? 'ws-1' : null,
      expiresAt: credential?.expiresAt ?? null,
      requiresUserAction: credential === null,
      message: credential === null ? 'missing' : null,
    })),
    getRuntimeCredential: vi.fn(async () => credential),
    saveLegacyApiKey: vi.fn(async () => undefined),
  };
}

describe('TunnelAuthCoordinator', () => {
  it('defaults existing installs to legacy and retains hasLegacyApiKey while OAuth is active', async () => {
    const legacyCredential = { value: 'legacy', authMode: 'legacy_api_key' as const, expiresAt: null };
    const oauthCredential = { value: 'oauth', authMode: 'oauth' as const, expiresAt: '2026-09-02T00:00:00.000Z' };
    let mode: 'legacy_api_key' | 'oauth' | null = null;
    const oauth = { ...provider('oauth', oauthCredential), logout: vi.fn(async () => undefined) };
    const coordinator = new TunnelAuthCoordinator(provider('legacy_api_key', legacyCredential), oauth, { get: (): 'legacy_api_key' | 'oauth' | null => mode, set: (next: 'legacy_api_key' | 'oauth'): void => { mode = next; } });

    expect(coordinator.mode()).toBe('legacy_api_key');
    await expect(coordinator.getRuntimeCredential()).resolves.toEqual(legacyCredential);
    await coordinator.switchToOAuth();
    expect(mode).toBe('oauth');
    await expect(coordinator.status()).resolves.toMatchObject({ mode: 'oauth', authReady: true, hasLegacyApiKey: true });
  });

  it('does not commit OAuth mode until a runtime credential is available', async () => {
    let mode: 'legacy_api_key' | 'oauth' | null = 'legacy_api_key';
    const oauth = { ...provider('oauth', null), logout: vi.fn(async () => undefined) };
    const coordinator = new TunnelAuthCoordinator(provider('legacy_api_key', { value: 'legacy', authMode: 'legacy_api_key', expiresAt: null }), oauth, { get: (): 'legacy_api_key' | 'oauth' | null => mode, set: (next: 'legacy_api_key' | 'oauth'): void => { mode = next; } });
    await expect(coordinator.switchToOAuth()).rejects.toThrow('not ready');
    expect(mode).toBe('legacy_api_key');
  });

  it('refuses rollback after the old API key has been removed', async () => {
    let mode: 'legacy_api_key' | 'oauth' | null = 'oauth';
    const oauth = { ...provider('oauth', { value: 'oauth', authMode: 'oauth', expiresAt: null }), logout: vi.fn(async () => undefined) };
    const coordinator = new TunnelAuthCoordinator(provider('legacy_api_key', null), oauth, { get: (): 'legacy_api_key' | 'oauth' | null => mode, set: (next: 'legacy_api_key' | 'oauth'): void => { mode = next; } });
    await expect(coordinator.switchToLegacy()).rejects.toThrow('rollback cannot be completed');
    expect(mode).toBe('oauth');
  });

  it('logs out OAuth and falls back to retained legacy credentials', async () => {
    let mode: 'legacy_api_key' | 'oauth' | null = 'oauth';
    const oauth = { ...provider('oauth', { value: 'oauth', authMode: 'oauth', expiresAt: null }), logout: vi.fn(async () => undefined) };
    const coordinator = new TunnelAuthCoordinator(provider('legacy_api_key', { value: 'legacy', authMode: 'legacy_api_key', expiresAt: null }), oauth, { get: (): 'legacy_api_key' | 'oauth' | null => mode, set: (next: 'legacy_api_key' | 'oauth'): void => { mode = next; } });
    await coordinator.logoutOAuth();
    expect(oauth.logout).toHaveBeenCalledTimes(1);
    expect(mode).toBe('legacy_api_key');
  });
});
