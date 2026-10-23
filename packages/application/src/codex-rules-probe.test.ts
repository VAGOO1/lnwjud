import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ok, type Result } from '@lnwjud/domain';
import type { ManagedProcess, ProcessLogResult } from '@lnwjud/process';
import { CodexRulesProbe } from './codex-rules-probe.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('lnwjud-rules-probe-')) throw Error('Unsafe cleanup'); await rm(root, { recursive: true, force: true }); } });

describe('fresh rule-load evidence', () => {
  it.each(['valid', 'model-echo-only', 'wrong-session', 'invalid-timestamp', 'tool-call'] as const)('%s cannot confuse model output with injected instructions', async mode => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-rules-probe-')); roots.push(root);
    const home = path.join(root, 'home'); await mkdir(home);
    const target = path.join(home, 'AGENTS.md'), content = '# Synthetic rule policy\nWorkspace work needs no repeated confirmation.\n';
    await writeFile(target, content);
    const hash = createHash('sha256').update(content).digest('hex'), id = randomUUID(), startedAt = new Date().toISOString();
    let process: ManagedProcess;
    const probe = new CodexRulesProbe({
      async startInstructionProbe(cwd): Promise<Result<ManagedProcess>> {
        process = { processId: 'owned', executable: 'codex', args: [], cwd, state: 'exited', startedAt, exitCode: 0 };
        const folder = path.join(home, 'sessions', ...startedAt.slice(0, 10).split('-')); await mkdir(folder, { recursive: true });
        const rows = [
          { type: 'session_meta', payload: { id: mode === 'wrong-session' ? randomUUID() : id, cwd, timestamp: mode === 'invalid-timestamp' ? 'invalid' : startedAt } },
          { type: 'response_item', payload: { type: 'message', role: mode === 'model-echo-only' ? 'assistant' : 'user', content: [{ type: 'input_text', text: content }] } },
          ...(mode === 'tool-call' ? [{ type: 'response_item', payload: { type: 'function_call', name: 'shell' } }] : []),
        ];
        await writeFile(path.join(folder, `rollout-test-${id}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n'));
        return ok(process);
      },
      statusProcess(): Result<ManagedProcess> { return ok(process!); },
      logs(): Result<ProcessLogResult> { return ok({ entries: [{ sequence: 0, stream: 'stdout' as const, text: JSON.stringify({ type: 'thread.started', thread_id: id }) + '\n' },
        { sequence: 1, stream: 'stdout' as const, text: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: content } }) + '\n' }], truncated: false, nextSequence: 2 }); },
      async stop(): Promise<Result<void>> { return ok(undefined); },
    });
    const started = await probe.start('client:session', home, root, target, content, hash); if (!started.ok) throw Error(started.error.message);
    expect(await probe.status('different', started.value.probeId)).toMatchObject({ ok: false });
    const evidence = await probe.status('client:session', started.value.probeId);
    expect(evidence).toMatchObject({ ok: true, value: { status: mode === 'valid' ? 'VERIFIED_LIVE' : 'LOAD_UNKNOWN', sessionId: id } });
  });
});
