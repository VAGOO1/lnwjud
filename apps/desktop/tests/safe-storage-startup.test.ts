import { describe, expect, it, vi } from 'vitest';
import { createUnavailableCheckpointCipher, shouldDegradeUnavailableSecureStorage, shouldUseMacos26E2eSecrets, waitForMacosAsyncSafeStorageStartup } from '../src/main/safe-storage-startup.js';

describe('shouldUseMacos26E2eSecrets', () => {
  it('enables only the packaged macOS 26 arm64 fixture path when explicitly requested', () => {
    expect(shouldUseMacos26E2eSecrets({
      platform: 'darwin',
      arch: 'arm64',
      release: '25.6.0',
      isPackaged: true,
      e2eFixture: true,
      ephemeralSecrets: true,
    })).toBe(true);
  });

  it.each([
    { platform: 'darwin', arch: 'x64', release: '25.6.0', isPackaged: true, e2eFixture: true, ephemeralSecrets: true },
    { platform: 'darwin', arch: 'arm64', release: '24.6.0', isPackaged: true, e2eFixture: true, ephemeralSecrets: true },
    { platform: 'darwin', arch: 'arm64', release: '25.6.0', isPackaged: false, e2eFixture: true, ephemeralSecrets: true },
    { platform: 'darwin', arch: 'arm64', release: '25.6.0', isPackaged: true, e2eFixture: false, ephemeralSecrets: true },
    { platform: 'darwin', arch: 'arm64', release: '25.6.0', isPackaged: true, e2eFixture: true, ephemeralSecrets: false },
  ] as const)('keeps the fixture path disabled for an unsafe or unrelated host %#', (host) => {
    expect(shouldUseMacos26E2eSecrets(host)).toBe(false);
  });
});

describe('shouldDegradeUnavailableSecureStorage', () => {
  it.each([
    ['basic_text', 'plaintext_backend'],
    ['unknown', 'temporarily_unavailable'],
  ] as const)('allows Linux desktop startup to degrade when %s secure storage is unavailable', (backend, reason) => {
    expect(shouldDegradeUnavailableSecureStorage('linux', { secure: false, backend, reason })).toBe(true);
  });

  it('keeps non-Linux hosts strict and never degrades a secure backend', () => {
    expect(shouldDegradeUnavailableSecureStorage('win32', { secure: false, backend: 'windows_dpapi', reason: 'temporarily_unavailable' })).toBe(false);
    expect(shouldDegradeUnavailableSecureStorage('darwin', { secure: false, backend: 'macos_keychain', reason: 'temporarily_unavailable' })).toBe(false);
    expect(shouldDegradeUnavailableSecureStorage('linux', { secure: true, backend: 'gnome_libsecret' })).toBe(false);
  });
});

describe('createUnavailableCheckpointCipher', () => {
  it('fails checkpoint reads and writes closed without rewriting existing payloads', () => {
    const cipher = createUnavailableCheckpointCipher('Linux secure storage is unavailable');
    expect(cipher.isEncrypted('legacy-or-encrypted-payload')).toBe(true);
    expect(() => cipher.encrypt('secret')).toThrow(/secure storage is unavailable/i);
    expect(() => cipher.decrypt('anything')).toThrow(/secure storage is unavailable/i);
  });
});

describe('waitForMacosAsyncSafeStorageStartup', () => {
  it('lets Electron finish async keychain initialization on packaged macOS 26+ arm64', async () => {
    const sleep = vi.fn(async () => undefined);
    await waitForMacosAsyncSafeStorageStartup({
      platform: 'darwin',
      arch: 'arm64',
      release: '25.6.0',
      isPackaged: true,
      sleep,
    });
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it.each([
    { platform: 'darwin', arch: 'x64', release: '25.6.0', isPackaged: true },
    { platform: 'darwin', arch: 'arm64', release: '24.6.0', isPackaged: true },
    { platform: 'darwin', arch: 'arm64', release: '25.6.0', isPackaged: false },
    { platform: 'win32', arch: 'arm64', release: '10.0.26100', isPackaged: true },
    { platform: 'linux', arch: 'arm64', release: '6.8.0', isPackaged: true },
  ] as const)('does not delay unaffected startup %#', async (host) => {
    const sleep = vi.fn(async () => undefined);
    await waitForMacosAsyncSafeStorageStartup({ ...host, sleep });
    expect(sleep).not.toHaveBeenCalled();
  });
});
