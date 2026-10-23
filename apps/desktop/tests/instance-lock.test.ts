import { describe, expect, it } from 'vitest';
import { shouldHoldSingleInstanceLock, wantsMcpStdio } from '../src/main/instance-lock.js';

describe('instance lock', () => {
  it('skips the single-instance lock for --mcp-stdio so tunnel can launch beside the dashboard', () => {
    expect(wantsMcpStdio(['lnwjud.exe', '--mcp-stdio'])).toBe(true);
    expect(shouldHoldSingleInstanceLock(['lnwjud.exe', '--mcp-stdio'])).toBe(false);
  });

  it('keeps the lock for the dashboard and log viewer', () => {
    expect(shouldHoldSingleInstanceLock(['lnwjud.exe'])).toBe(true);
    expect(shouldHoldSingleInstanceLock(['lnwjud.exe', '--log-viewer'])).toBe(true);
  });
});
