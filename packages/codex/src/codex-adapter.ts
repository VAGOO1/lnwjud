import { err, ok, type Result } from '@lnwjud/domain';
import { ProcessManager, type LogQuery, type ManagedProcess, type ManagedProcessStart, type ProcessLogResult } from '@lnwjud/process';
import { CodexDiscovery } from './codex-discovery.js';
import { CodexInvocationBuilder, type CodexDiscoveryResult, type CodexInvocation, type CodexSandboxMode, type CodexStatus } from './codex-capabilities.js';

export interface CodexDiscoveryPort {
  discover(): Promise<Result<CodexDiscoveryResult>>;
  discoverInstructionProbe?(): Promise<Result<CodexDiscoveryResult>>;
}

export interface CodexProcessManagerPort {
  start(spec: ManagedProcessStart, signal?: AbortSignal, onCreated?: (process: ManagedProcess) => void): Promise<Result<ManagedProcess>>;
  status(processId: string): Result<ManagedProcess>;
  logs(processId: string, query: LogQuery): Result<ProcessLogResult>;
  stop(processId: string, autoRetry?: boolean): Promise<Result<void>>;
}

export interface CodexInvocationBuilderPort {
  build(executable: string, capabilities: CodexDiscoveryResult['capabilities'], instruction: string, sandboxMode?: CodexSandboxMode): Result<CodexInvocation>;
}

export class CodexAdapter {
  private readonly builder: CodexInvocationBuilderPort;

  public constructor(
    private readonly discovery: CodexDiscoveryPort = new CodexDiscovery(),
    private readonly processManager: CodexProcessManagerPort = new ProcessManager(),
    builder: CodexInvocationBuilderPort = new CodexInvocationBuilder(),
  ) {
    this.builder = builder;
  }

  public async status(): Promise<Result<CodexStatus>> {
    const discovered = await this.discovery.discover();
    return discovered.ok ? ok(discovered.value.status) : discovered;
  }

  public async start(
    cwd: string,
    instruction: string,
    signal?: AbortSignal,
    onCreated?: (process: ManagedProcess) => void,
    sandboxMode: CodexSandboxMode = 'workspace-write',
  ): Promise<Result<ManagedProcess>> {
    if (isAborted(signal)) return cancelledCodexStart();
    const discovered = await this.discovery.discover();
    if (isAborted(signal)) return cancelledCodexStart();
    if (!discovered.ok) return discovered;
    if (!discovered.value.status.installed || discovered.value.status.executablePath === undefined) {
      return err({ code: 'CODEX_NOT_AVAILABLE', message: 'Codex is not installed', recoverable: true });
    }
    const invocation = this.builder.build(discovered.value.status.executablePath, discovered.value.capabilities, instruction, sandboxMode);
    if (!invocation.ok) return invocation;
    if (isAborted(signal)) return cancelledCodexStart();
    return this.processManager.start({ executable: invocation.value.executable, args: invocation.value.args, cwd,
      ...(invocation.value.stdinText === undefined ? { stdinMode: 'ignore' as const } : { stdinText: invocation.value.stdinText }),
    }, signal, onCreated);
  }

  public statusProcess(processId: string): Result<ManagedProcess> {
    return this.processManager.status(processId);
  }

  /** Fixed, fresh instruction audit. No caller command, prompt, or privilege flags. */
  public async startInstructionProbe(cwd: string, signal?: AbortSignal): Promise<Result<ManagedProcess>> {
    if (isAborted(signal)) return cancelledCodexStart();
    if (!this.discovery.discoverInstructionProbe) return err({ code: 'CODEX_NOT_AVAILABLE', message: 'Instruction-probe discovery is unsupported', recoverable: false });
    const found = await this.discovery.discoverInstructionProbe();
    if (!found.ok) return found;
    const required = ['exec', 'sandbox', 'read-only', 'json', 'ignore-user-config', 'skip-git-repo-check', 'ask-for-approval'];
    const missing = required.filter(name => !found.value.capabilities.names.includes(name));
    if (!found.value.status.executablePath || missing.length) return err({ code: 'CODEX_NOT_AVAILABLE', message: `Instruction probe UNSUPPORTED; required CLI capabilities missing: ${missing.join(', ')}`, recoverable: false });
    if (isAborted(signal)) return cancelledCodexStart();
    return this.processManager.start({ executable: found.value.status.executablePath, cwd, stdinMode: 'ignore', timeoutMs: 90_000,
      args: ['--ask-for-approval', 'never', 'exec', '--sandbox', 'read-only', '--json', '--ignore-user-config', '--skip-git-repo-check',
        'From instructions already supplied before this prompt only, return JSON with policy_title, policy_version, workspace_permission and tool_approval_rules. Do not use any tool, read any file, delegate, or change anything. If instructions are absent, report unknown.'],
    }, signal);
  }

  public logs(processId: string, query: LogQuery): Result<ProcessLogResult> {
    return this.processManager.logs(processId, query);
  }

  public stop(processId: string, autoRetry = false): Promise<Result<void>> {
    return this.processManager.stop(processId, autoRetry);
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function cancelledCodexStart(): Result<never> {
  return err({ code: 'PROCESS_TIMEOUT', message: 'Codex start was cancelled before launch completed', recoverable: true });
}
