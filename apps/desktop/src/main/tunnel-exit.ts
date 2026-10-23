const HINT_PATTERN = /TTL reached|stdio MCP command exited|requesting tunnel-client shutdown/i;
const ABNORMAL_CODES = new Set([4294967295, -1]);

export function formatTunnelExitMessage(code: number | null | undefined, hint = ''): string {
  const abnormal = code !== null && code !== undefined && ABNORMAL_CODES.has(code);
  const base = abnormal
    ? 'tunnel-client exited abnormally'
    : `tunnel-client exited with code ${code ?? 'unknown'}`;
  const trimmed = hint.trim();
  return trimmed.length === 0 ? base : `${base} — ${trimmed}`;
}

export function tunnelExitHintFromLog(logText: string): string {
  const lines = logText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const hit = [...lines].reverse().find((line) => HINT_PATTERN.test(line));
  if (hit === undefined) return '';
  const json = tryParseJson(hit);
  const message = json !== null && typeof json === 'object' && 'msg' in json && typeof json.msg === 'string'
    ? json.msg
    : hit;
  const compact = message.replace(/\s+/g, ' ').trim();
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}

function tryParseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
