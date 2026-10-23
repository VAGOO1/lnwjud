import { describe, expect, it } from 'vitest';
import {
  MAX_AUTOMATION_ATTEMPTS_PER_MILESTONE,
  MAX_AUTOMATION_EVENTS_PER_RUN,
  MAX_AUTOMATION_MILESTONES,
  automationAttemptIdentityEquals,
  automationShellRequestDigest,
  readyAutomationMilestones,
  transitionAutomationRun,
  validateAutomationPlan,
  type AutomationMilestoneDefinition,
} from './automation.js';

function milestone(id: string, dependsOn: readonly string[] = []): AutomationMilestoneDefinition {
  return {
    id,
    title: `Milestone ${id}`,
    goalStepId: `goal-${id}`,
    dependsOn,
    provider: 'shell',
    role: 'blocking_job',
    cancelWithGoal: true,
    dispatch: {
      executable: 'node',
      arguments: ['--version'],
      cwd: 'C:\\workspace',
      timeoutSeconds: 60,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
    },
    verification: [{ id: `${id}-exit`, kind: 'command_exit', expectedExitCode: 0 }],
  } as const;
}

describe('native automation domain', () => {
  it('validates an acyclic shell-only plan and preserves declared order, role, and cancellation policy', () => {
    const result = validateAutomationPlan({
      milestones: [
        { ...milestone('prepare'), role: 'supporting_service', cancelWithGoal: false },
        milestone('build', ['prepare']),
        milestone('test', ['prepare']),
        milestone('package', ['build', 'test']),
      ],
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value.milestones.map((entry) => entry.id)).toEqual(['prepare', 'build', 'test', 'package']);
    expect(result.value.milestones[0]).toMatchObject({ role: 'supporting_service', cancelWithGoal: false });
    expect(readyAutomationMilestones(result.value, {
      prepare: 'completed',
      build: 'pending',
      test: 'pending',
      package: 'pending',
    }).map((entry) => entry.id)).toEqual(['build', 'test']);
  });

  it.each([
    ['missing dependency', [milestone('build', ['missing'])]],
    ['self dependency', [milestone('build', ['build'])]],
    ['multi-node cycle', [milestone('a', ['c']), milestone('b', ['a']), milestone('c', ['b'])]],
    ['duplicate milestone id', [milestone('same'), milestone('same')]],
  ])('rejects %s', (_label, milestones) => {
    expect(validateAutomationPlan({ milestones })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
  });

  it('rejects unsupported providers and verification that cannot produce evidence', () => {
    const unsupported = { ...milestone('unsafe'), provider: 'process' };
    const emptyVerification = { ...milestone('empty'), verification: [] };
    const callerAssertion = {
      ...milestone('assertion'),
      verification: [{ id: 'caller-pass', kind: 'caller_assertion', pass: true }],
    };

    expect(validateAutomationPlan({ milestones: [unsupported] })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(validateAutomationPlan({ milestones: [emptyVerification] })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(validateAutomationPlan({ milestones: [callerAssertion] })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('enforces bounded milestones, attempts, and events', () => {
    const tooMany = Array.from({ length: MAX_AUTOMATION_MILESTONES + 1 }, (_, index) => milestone(`m-${index}`));
    expect(validateAutomationPlan({ milestones: tooMany })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(MAX_AUTOMATION_ATTEMPTS_PER_MILESTONE).toBe(3);
    expect(MAX_AUTOMATION_EVENTS_PER_RUN).toBe(4096);
    expect(MAX_AUTOMATION_MILESTONES * MAX_AUTOMATION_ATTEMPTS_PER_MILESTONE * 10)
      .toBeLessThan(MAX_AUTOMATION_EVENTS_PER_RUN);
  });

  it('allows only explicit run transitions and keeps attempt identity immutable', () => {
    expect(transitionAutomationRun('active', 'paused')).toEqual({ ok: true, value: 'paused' });
    expect(transitionAutomationRun('paused', 'completed')).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(transitionAutomationRun('completed', 'active')).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    const identity = { id: 'attempt-a', milestoneId: 'build', ordinal: 1 };
    expect(automationAttemptIdentityEquals(identity, { ...identity })).toBe(true);
    expect(automationAttemptIdentityEquals(identity, { ...identity, ordinal: 2 })).toBe(false);
  });

  it('derives a canonical shell request digest from the reserved task, command, output and owner scope', () => {
    const base = {
      taskId: 'automation-task-a',
      ownerClientId: 'client-a',
      workspaceId: 'workspace-a',
      dispatch: milestone('build').dispatch,
    };
    const first = automationShellRequestDigest(base);
    const repeated = automationShellRequestDigest({ ...base, dispatch: { ...base.dispatch, arguments: [...base.dispatch.arguments] } });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(repeated).toBe(first);
    expect(automationShellRequestDigest({ ...base, taskId: 'automation-task-b' })).not.toBe(first);
    expect(automationShellRequestDigest({ ...base, ownerClientId: 'client-b' })).not.toBe(first);
    expect(automationShellRequestDigest({
      ...base,
      dispatch: { ...base.dispatch, includeStderr: false },
    })).not.toBe(first);
    expect(automationShellRequestDigest({
      ...base,
      dispatch: { ...base.dispatch, windowsVerbatimArguments: false },
    })).not.toBe(first);
    expect(automationShellRequestDigest({
      ...base,
      dispatch: { ...base.dispatch, windowsVerbatimArguments: true },
    })).not.toBe(first);
  });
});
