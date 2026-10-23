import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { CodexAdapter } from '@lnwjud/codex';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import type { ManagedProcess, ProcessLogResult } from '@lnwjud/process';

interface ProbeAdapter {
  startInstructionProbe(cwd: string, signal?: AbortSignal): Promise<Result<ManagedProcess>>;
  statusProcess(id: string): Result<ManagedProcess>;
  logs(id: string, query: { tailLines: number }): Result<ProcessLogResult>;
  stop(id: string, autoRetry?: boolean): Promise<Result<void>>;
}
interface RecordEntry { owner: string; process: ManagedProcess; home: string; cwd: string; target: string; content: string; hash: string; }
export interface RulesProbeEvidence {
  probeId: string; processId: string; status: 'RUNNING' | 'FAILED' | 'LOAD_UNKNOWN' | 'VERIFIED_LIVE';
  state: string; exitCode?: number; sessionId?: string; sourceSha256: string;
  instructionBodyMatched?: boolean; toolCalls?: number; message?: string;
  mode: 'fresh-read-only-user-config-ignored';
}

/** Only session files created by this owned process can become evidence. */
export class CodexRulesProbe {
  private readonly records = new Map<string, RecordEntry>();
  public constructor(private readonly adapter: ProbeAdapter = new CodexAdapter()) {}

  public async start(owner: string, home: string, root: string, target: string, content: string, hash: string, signal?: AbortSignal): Promise<Result<RulesProbeEvidence>> {
    if (signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Probe cancelled before launch'));
    const probeId = randomUUID();
    const cwd = path.join(root, 'probes', probeId);
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    await canonicalDirectory(cwd);
    if (digest(await readFile(target)) !== hash) return err(appError('CONFLICT', 'Rule changed before probe launch'));
    const process = await this.adapter.startInstructionProbe(cwd, signal);
    if (!process.ok) return process;
    this.records.set(probeId, { owner, process: process.value, home, cwd, target, content, hash });
    if (signal?.aborted) await this.adapter.stop(process.value.processId, true);
    return ok({ probeId, processId: process.value.processId, status: 'RUNNING', state: process.value.state, sourceSha256: hash, mode: 'fresh-read-only-user-config-ignored' });
  }

  public async status(owner: string, probeId: string, signal?: AbortSignal): Promise<Result<RulesProbeEvidence>> {
    const record = this.records.get(probeId);
    if (!record || record.owner !== owner) return err(appError('PERMISSION_DENIED', 'Probe is not owned by this client/session'));
    let current = this.adapter.statusProcess(record.process.processId);
    const deadline = Date.now() + 45_000;
    while (current.ok && ['starting', 'running'].includes(current.value.state) && Date.now() < deadline && !signal?.aborted) {
      await new Promise(resolve => setTimeout(resolve, 300));
      current = this.adapter.statusProcess(record.process.processId);
    }
    if (!current.ok) return current;
    const base: RulesProbeEvidence = { probeId, processId: record.process.processId, status: 'RUNNING', state: current.value.state,
      sourceSha256: record.hash, mode: 'fresh-read-only-user-config-ignored', ...(current.value.exitCode === undefined ? {} : { exitCode: current.value.exitCode }) };
    if (['starting', 'running'].includes(current.value.state)) return ok(base);
    if (current.value.state !== 'exited' || current.value.exitCode !== 0) return ok({ ...base, status: 'FAILED', message: 'Owned CLI did not exit successfully; no retry was sent' });
    const logs = this.adapter.logs(record.process.processId, { tailLines: 10_000 });
    if (!logs.ok) return logs;
    if (logs.value.truncated) return ok({ ...base, status: 'LOAD_UNKNOWN', message: 'Owned process evidence was truncated' });
    const events = logs.value.entries.filter(entry => entry.stream === 'stdout').map(entry => entry.text).join('').split('\n').map(parse).filter(isObject);
    const started = events.find(event => event.type === 'thread.started');
    const sessionId = typeof started?.thread_id === 'string' ? started.thread_id : undefined;
    if (!sessionId || !/^[a-f0-9-]{36}$/i.test(sessionId)) return ok({ ...base, status: 'LOAD_UNKNOWN', message: 'Fresh session identity was absent from owned JSON output' });
    try {
      if (digest(await readFile(record.target)) !== record.hash) return ok({ ...base, status: 'LOAD_UNKNOWN', sessionId, message: 'Rule changed during probe' });
      const trace = await ownTrace(record, sessionId);
      const rows = trace.split('\n').map(parse).filter(isObject);
      const meta = rows.find(row => row.type === 'session_meta');
      const metaTime = isObject(meta?.payload) ? Date.parse(String(meta.payload.timestamp)) : Number.NaN;
      if (!isObject(meta?.payload) || meta.payload.id !== sessionId || !samePath(meta.payload.cwd, record.cwd)
        || !Number.isFinite(metaTime) || Math.abs(metaTime - Date.parse(record.process.startedAt)) > 30_000) {
        return ok({ ...base, status: 'LOAD_UNKNOWN', sessionId, message: 'Session trace identity/cwd/start time did not match the owned launch' });
      }
      const instructions: string[] = [];
      let toolCalls = 0;
      for (const row of rows) {
        const payload = row.payload;
        if (!isObject(payload)) continue;
        if (row.type === 'turn_context' && typeof payload.user_instructions === 'string') instructions.push(payload.user_instructions);
        if (row.type === 'response_item' && payload.type === 'message' && payload.role === 'user' && Array.isArray(payload.content)) {
          for (const item of payload.content) if (isObject(item) && typeof item.text === 'string') instructions.push(item.text);
        }
        if (row.type === 'response_item' && typeof payload.type === 'string' && /(?:function_call|custom_tool_call|local_shell_call|mcp_tool_call|web_search_call)/.test(payload.type)) toolCalls++;
      }
      for (const event of events) if (isObject(event.item) && ['command_execution', 'mcp_tool_call', 'web_search'].includes(String(event.item.type))) toolCalls++;
      const expected = normalize(record.content);
      const matched = expected.length > 20 && instructions.some(text => normalize(text).includes(expected));
      const messageEvent = [...events].reverse().find(event => isObject(event.item) && event.item.type === 'agent_message');
      const message = isObject(messageEvent?.item) && typeof messageEvent.item.text === 'string' ? messageEvent.item.text.slice(0, 3000) : undefined;
      return ok({ ...base, sessionId, status: matched && toolCalls === 0 ? 'VERIFIED_LIVE' : 'LOAD_UNKNOWN',
        instructionBodyMatched: matched, toolCalls, ...(message === undefined ? {} : { message }) });
    } catch {
      return ok({ ...base, status: 'LOAD_UNKNOWN', sessionId, message: 'Owned instruction-chain evidence unavailable; model response alone is insufficient' });
    }
  }
}

async function ownTrace(record: RecordEntry, id: string): Promise<string> {
  const dates = new Set<string>();
  for (const offset of [-86_400_000, 0, 86_400_000]) dates.add(new Date(Date.parse(record.process.startedAt) + offset).toISOString().slice(0, 10));
  const found: string[] = [];
  for (const day of dates) {
    const folder = path.join(record.home, 'sessions', ...day.split('-'));
    try {
      await canonicalDirectory(folder);
      for (const name of await readdir(folder)) if (name.startsWith('rollout-') && name.endsWith(`-${id}.jsonl`)) found.push(path.join(folder, name));
    } catch { /* A date bucket may not exist. No other session is opened. */ }
  }
  if (found.length !== 1) throw Error('Owned trace is missing or ambiguous');
  const file = found[0]!;
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024 || stat.mtimeMs < Date.parse(record.process.startedAt) - 1000) throw Error('Invalid owned trace');
  return readFile(file, 'utf8');
}
async function canonicalDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(directory), path.resolve(directory))) throw Error('Directory must be canonical and non-link');
}
function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function parse(text: string): unknown { try { return JSON.parse(text); } catch { return undefined; } }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function samePath(a: unknown, b: string): boolean { return typeof a === 'string' && (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b)); }
function normalize(text: string): string { return text.replace(/\r\n/g, '\n').trim(); }
