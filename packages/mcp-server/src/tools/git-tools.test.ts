import { describe, expect, it } from 'vitest';
import { ok } from '@lnwjud/domain';
import { GitService } from '@lnwjud/application';
import { ContextEconomyRuntime } from '../context-economy.js';
import { ToolRegistry } from '../tool-registry.js';
import { GitAdapter } from '../../../git/src/git-adapter.js';
import type { GitRunResult, GitRunner } from '../../../git/src/git-runner.js';
import { gitTools } from './git-tools.js';
import type { McpToolContext } from './tool-types.js';

class FakeGitRunner implements GitRunner {
  public constructor(private readonly result: GitRunResult) {}

  public async run(): Promise<GitRunResult> {
    return this.result;
  }
}

describe('gitTools', () => {
  it('preserves a Git timeout through the ToolRegistry MCP envelope', async () => {
    const workspace = {
      id: 'workspace-1', displayName: 'Fixture', rootPath: 'C:\\workspace', realRootPath: 'C:\\workspace', createdAt: new Date(0).toISOString(),
    };
    const repository = {
      async list() { return [workspace]; },
      async get(id: string) { return id === workspace.id ? workspace : null; },
      async insert(): Promise<void> {},
      async delete(): Promise<void> {},
    } as ConstructorParameters<typeof GitService>[0];
    const registry = new ToolRegistry({
      git: new GitService(repository, undefined, new GitAdapter(new FakeGitRunner({ exitCode: -1, stdout: '', stderr: 'Git command timed out' }))),
    }, { clientId: 'test', clientName: 'test' });

    const response = await registry.invoke('git_status', { workspaceId: 'workspace-1' });

    expect(response).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'PROCESS_TIMEOUT', message: 'Git command timed out', recoverable: true } },
    });
  });

  it('forwards the invocation cancellation signal to every Git service call', async () => {
    const observedSignals: Array<AbortSignal | undefined> = [];
    const context = {
      actor: { clientId: 'test', clientName: 'test' },
      contextEconomy: new ContextEconomyRuntime(),
      services: {
        git: {
          async status(_actor: unknown, _workspaceId: string, signal?: AbortSignal) {
            observedSignals.push(signal);
            return ok({ entries: [] });
          },
          async diff(_actor: unknown, _workspaceId: string, _request: unknown, signal?: AbortSignal) {
            observedSignals.push(signal);
            return ok({ patch: '', truncated: false });
          },
          async log(_actor: unknown, _workspaceId: string, _request: unknown, signal?: AbortSignal) {
            observedSignals.push(signal);
            return ok({ entries: [], truncated: false });
          },
          async run(_actor: unknown, _request: unknown, signal?: AbortSignal) {
            observedSignals.push(signal);
            return ok({ exitCode: 0, stdout: '', stderr: '' });
          },
        },
      },
    } as unknown as McpToolContext;
    const tools = gitTools(context);
    const signal = new AbortController().signal;
    const calls: ReadonlyArray<readonly [string, unknown]> = [
      ['git_status', { workspaceId: 'workspace-1' }],
      ['git_diff', { workspaceId: 'workspace-1' }],
      ['git_log', { workspaceId: 'workspace-1' }],
      ['git', { args: ['status'], workspaceId: 'workspace-1', userConfirmed: true }],
    ];

    for (const [name, input] of calls) {
      const tool = tools.find((candidate) => candidate.name === name);
      if (tool === undefined) throw new Error(`Missing Git tool: ${name}`);
      await tool.execute(input, signal);
    }

    expect(observedSignals).toEqual([signal, signal, signal, signal]);
  });
});
