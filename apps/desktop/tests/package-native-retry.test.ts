import { describe, expect, it, vi } from 'vitest';
import { isTransientElectronBuilderFailure, runElectronBuilderWithRetry } from '../scripts/package-native-retry.mjs';

describe('native package electron-builder retry policy', () => {
  it('retries a transient HTTP 504 failure before succeeding', async () => {
    const error = Object.assign(new Error('electron-builder exited with 1'), {
      output: '⨯ Response code 504 (Gateway Time-out) failedTask=build',
    });
    const operation = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
    const sleep = vi.fn(async () => undefined);

    await expect(runElectronBuilderWithRetry(operation, sleep)).resolves.toBeUndefined();

    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(isTransientElectronBuilderFailure(error)).toBe(true);
  });

  it('does not retry a deterministic configuration failure', async () => {
    const error = new Error('electron-builder invalid configuration');
    const operation = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn(async () => undefined);

    await expect(runElectronBuilderWithRetry(operation, sleep)).rejects.toBe(error);

    expect(operation).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(isTransientElectronBuilderFailure(error)).toBe(false);
  });
});
