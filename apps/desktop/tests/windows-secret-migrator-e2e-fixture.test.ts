import { describe, expect, it, vi } from 'vitest';
import {
  buildWindowsSecretMigratorFixture,
  windowsSecretMigratorBuildTimeoutMs,
  windowsSecretMigratorE2eTimeoutMs,
} from '../e2e/windows-secret-migrator-fixture.mjs';

describe('Windows secret migrator E2E fixture build policy', () => {
  it('uses the established longer CI build budget while keeping local runs bounded', () => {
    expect(windowsSecretMigratorBuildTimeoutMs(true)).toBe(300_000);
    expect(windowsSecretMigratorBuildTimeoutMs(false)).toBe(120_000);
    expect(windowsSecretMigratorE2eTimeoutMs(true)).toBeGreaterThan(windowsSecretMigratorBuildTimeoutMs(true));
    expect(windowsSecretMigratorE2eTimeoutMs(false)).toBeGreaterThan(windowsSecretMigratorBuildTimeoutMs(false));
  });

  it('preserves child stdout and stderr when the fixture build fails', async () => {
    const failure = Object.assign(new Error('Command failed'), {
      stdout: 'restore output from dotnet',
      stderr: 'transient feed failure',
      code: 1,
      killed: false,
      signal: null,
    });
    const execFile = vi.fn().mockRejectedValue(failure);

    await expect(buildWindowsSecretMigratorFixture({
      execFile,
      powershell: 'powershell.exe',
      scriptPath: 'build-windows-secret-migrator.ps1',
      env: { PATH: 'fixture' },
      ci: true,
    })).rejects.toThrow(/restore output from dotnet[\s\S]*transient feed failure/);

    expect(execFile).toHaveBeenCalledOnce();
    expect(execFile.mock.calls[0]?.[2]).toMatchObject({ timeout: 300_000, windowsHide: true });
  });
});
