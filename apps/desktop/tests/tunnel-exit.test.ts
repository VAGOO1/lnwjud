import { describe, expect, it } from 'vitest';
import { formatTunnelExitMessage, tunnelExitHintFromLog } from '../src/main/tunnel-exit.js';

describe('tunnel exit message', () => {
  it('decodes unsigned -1 instead of printing 4294967295', () => {
    expect(formatTunnelExitMessage(4294967295, 'stdio MCP command exited')).toBe(
      'tunnel-client exited abnormally — stdio MCP command exited',
    );
    expect(formatTunnelExitMessage(-1)).toBe('tunnel-client exited abnormally');
    expect(formatTunnelExitMessage(1)).toBe('tunnel-client exited with code 1');
  });

  it('reads the last shutdown reason from the tunnel log tail', () => {
    const log = [
      '{"msg":"stdio MCP command started"}',
      '{"msg":"stdio MCP command exited","error":"exit status 0xc000013a"}',
      '{"msg":"stdio MCP command failed; requesting tunnel-client shutdown"}',
    ].join('\n');
    expect(tunnelExitHintFromLog(log)).toBe('stdio MCP command failed; requesting tunnel-client shutdown');
  });
});
