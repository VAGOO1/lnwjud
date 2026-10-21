import { describe, expect, it } from 'vitest';
import { ok, type Result } from '@lnwjud/domain';
import type { ManagedProcess, ManagedProcessStart, ProcessLogResult } from '@lnwjud/process';
import { CodexAdapter, type CodexDiscoveryPort, type CodexProcessManagerPort } from './codex-adapter.js';
import type { CodexDiscoveryResult } from './codex-capabilities.js';

describe('CodexAdapter', () => {
  it('starts an instruction probe only with verified isolation/output flags and a fixed blind prompt', async () => {
    const calls: ManagedProcessStart[] = [];
    let names = ['exec', 'sandbox', 'read-only', 'json', 'ignore-user-config', 'skip-git-repo-check', 'ask-for-approval'];
    const manager: CodexProcessManagerPort = {
      async start(spec) { calls.push(spec); return ok(processHandle()); },
      status() { return ok(processHandle()); },
      logs() { return ok({ entries: [], truncated: false, nextSequence: 0 }); },
      async stop() { return ok(undefined); },
    };
    const discovery: CodexDiscoveryPort = {
      async discover() { return ok(discovered()); },
      async discoverInstructionProbe() { return ok({ ...discovered(), capabilities: { instructionMode: 'exec-argument', names } }); },
    };
    const adapter = new CodexAdapter(discovery, manager);
    expect(await adapter.startInstructionProbe('C:\\sterile')).toMatchObject({ ok: true });
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['--ask-for-approval', 'never', 'exec', '--sandbox', 'read-only', '--ignore-user-config', '--json', '--skip-git-repo-check']));
    expect(calls[0]!.args).not.toContain('resume');
    expect(calls[0]!.args).not.toContain('--ephemeral');
    expect(calls[0]!.args.join(' ')).not.toMatch(/V3\.1|PANYA|dangerously|full-auto/);
    names = names.filter(name => name !== 'ignore-user-config');
    expect(await adapter.startInstructionProbe('C:\\sterile')).toMatchObject({ ok: false, error: { code: 'CODEX_NOT_AVAILABLE' } });
    expect(calls).toHaveLength(1);
  });
  it('builds direct sandboxed executable arguments and delegates the task to ProcessManager', async () => {
    const calls: ManagedProcessStart[] = [];
    const manager: CodexProcessManagerPort = {
      async start(spec): Promise<Result<ManagedProcess>> { calls.push(spec); return ok(processHandle()); },
      status(): Result<ManagedProcess> { return ok(processHandle()); },
      logs(): Result<ProcessLogResult> { return ok({ entries: [], truncated: false, nextSequence: 0 }); },
      async stop(): Promise<Result<void>> { return ok(undefined); },
    };
    const discovery: CodexDiscoveryPort = { async discover(): Promise<Result<CodexDiscoveryResult>> { return ok(discovered()); } };

    const result = await new CodexAdapter(discovery, manager).start('C:\\workspace', 'review "quoted" input');

    expect(result).toMatchObject({ ok: true, value: { processId: 'process-1' } });
    expect(calls).toEqual([{
      executable: 'C:\\tools\\codex.exe',
      args: ['exec', '--sandbox', 'workspace-write', '-'],
      cwd: 'C:\\workspace',
      stdinText: 'review "quoted" input',
    }]);
  });

  it('does not start a process after cancellation wins during Codex discovery', async () => {
    let releaseDiscovery!: () => void;
    const discoveryGate = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
    let starts = 0;
    const manager: CodexProcessManagerPort = {
      async start(): Promise<Result<ManagedProcess>> { starts += 1; return ok(processHandle()); },
      status(): Result<ManagedProcess> { return ok(processHandle()); },
      logs(): Result<ProcessLogResult> { return ok({ entries: [], truncated: false, nextSequence: 0 }); },
      async stop(): Promise<Result<void>> { return ok(undefined); },
    };
    const discovery: CodexDiscoveryPort = {
      async discover(): Promise<Result<CodexDiscoveryResult>> {
        await discoveryGate;
        return ok(discovered());
      },
    };
    const controller = new AbortController();

    const starting = new CodexAdapter(discovery, manager).start('C:\\workspace', 'review', controller.signal);
    controller.abort();
    releaseDiscovery();

    await expect(starting).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(starts).toBe(0);
  });
});

function discovered(): CodexDiscoveryResult {
  return {
    status: {
      installed: true,
      executablePath: 'C:\\tools\\codex.exe',
      version: '0.42.1',
      capabilities: ['exec', 'sandbox', 'workspace-write'],
    },
    capabilities: { instructionMode: 'exec-argument', names: ['exec', 'sandbox', 'workspace-write'] },
  };
}

function processHandle(): ManagedProcess {
  return {
    processId: 'process-1',
    executable: 'C:\\tools\\codex.exe',
    args: ['exec', '--sandbox', 'workspace-write', 'review'],
    cwd: 'C:\\workspace',
    state: 'running',
    startedAt: new Date(0).toISOString(),
  };
}
