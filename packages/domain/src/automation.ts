import { createHash } from 'node:crypto';
import { appError, err, ok, type Result } from './errors.js';
import type { GoalTrackedTaskRole } from './goal-continuation.js';

export const MAX_AUTOMATION_MILESTONES = 128;
export const MAX_AUTOMATION_ATTEMPTS_PER_MILESTONE = 3;
export const MAX_AUTOMATION_EVENTS_PER_RUN = 4096;

export type AutomationRunStatus = 'active' | 'paused' | 'blocked' | 'completing' | 'completed' | 'failed' | 'cancelled';
export type AutomationMilestoneStatus = 'pending' | 'ready' | 'dispatching' | 'running' | 'verifying' | 'completed' | 'blocked' | 'failed' | 'cancelled';
export type AutomationDispatchStatus = 'reserved' | 'launched' | 'dispatched_unresolved' | 'terminal';
export type AutomationProvider = 'shell';
export type AutomationVerificationKind = 'command_exit' | 'file_sha256' | 'git_diff_check';
export type AutomationVerificationStatus = 'pending' | 'verified' | 'failed' | 'unknown';

export interface AutomationShellDispatch {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly windowsVerbatimArguments?: boolean;
  readonly timeoutSeconds: number;
  readonly maxOutputBytes: number;
  readonly includeStdout: boolean;
  readonly includeStderr: boolean;
}

export interface AutomationShellRequestDigestInput {
  readonly taskId: string;
  readonly ownerClientId: string;
  readonly workspaceId: string;
  readonly dispatch: AutomationShellDispatch;
}

export type AutomationVerificationRequirement =
  | {
      readonly id: string;
      readonly kind: 'command_exit';
      readonly expectedExitCode: number;
    }
  | {
      readonly id: string;
      readonly kind: 'file_sha256';
      readonly path: string;
      readonly expectedSha256: string;
    }
  | {
      readonly id: string;
      readonly kind: 'git_diff_check';
    };

export interface AutomationMilestoneDefinition {
  readonly id: string;
  readonly title: string;
  readonly goalStepId: string;
  readonly dependsOn: readonly string[];
  readonly provider: AutomationProvider;
  readonly role: GoalTrackedTaskRole;
  readonly cancelWithGoal: boolean;
  readonly dispatch: AutomationShellDispatch;
  readonly verification: readonly AutomationVerificationRequirement[];
}

export interface AutomationPlan {
  readonly milestones: readonly AutomationMilestoneDefinition[];
}

export interface AutomationRunRecord {
  readonly id: string;
  readonly goalId: string;
  readonly workspaceId: string;
  readonly ownerClientId: string;
  readonly status: AutomationRunStatus;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AutomationMilestoneRecord extends AutomationMilestoneDefinition {
  readonly runId: string;
  readonly position: number;
  readonly status: AutomationMilestoneStatus;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AutomationAttemptIdentity {
  readonly id: string;
  readonly milestoneId: string;
  readonly ordinal: number;
}

export interface AutomationAttemptRecord extends AutomationAttemptIdentity {
  readonly runId: string;
  readonly provider: AutomationProvider;
  readonly dispatchStatus: AutomationDispatchStatus;
  readonly taskId: string;
  readonly requestDigest: string;
  readonly evidence: readonly AutomationVerificationEvidence[];
  readonly terminalState?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AutomationVerificationEvidence {
  readonly requirementId: string;
  readonly kind: AutomationVerificationKind;
  readonly status: AutomationVerificationStatus;
  readonly observedAt: string;
  readonly observedDigest?: string;
  readonly observedTaskId?: string;
  readonly observedExitCode?: number;
  readonly detail?: string;
}

export interface AutomationEventRecord {
  readonly sequence: number;
  readonly runId: string;
  readonly kind: string;
  readonly milestoneId?: string;
  readonly attemptId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface StoredAutomationRun {
  readonly run: AutomationRunRecord;
  readonly milestones: readonly AutomationMilestoneRecord[];
  readonly attempts: readonly AutomationAttemptRecord[];
}

export interface CreateAutomationRunRequest {
  readonly id: string;
  readonly goalId: string;
  readonly workspaceId: string;
  readonly ownerClientId: string;
  readonly plan: AutomationPlan;
  readonly createdAt: string;
}

export interface AutomationEventInput {
  readonly kind: string;
  readonly milestoneId?: string;
  readonly attemptId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

interface AutomationMutationScope {
  readonly runId: string;
  readonly ownerClientId: string;
  readonly workspaceId: string;
  readonly expectedRevision: number;
  readonly updatedAt: string;
  readonly event: AutomationEventInput;
}

export interface TransitionAutomationRunRequest extends AutomationMutationScope {
  readonly status: AutomationRunStatus;
}

export interface TransitionAutomationMilestoneRequest extends AutomationMutationScope {
  readonly milestoneId: string;
  readonly status: AutomationMilestoneStatus;
}

export interface ReserveAutomationAttemptRequest extends AutomationMutationScope {
  readonly milestoneId: string;
  readonly attemptId: string;
  readonly ordinal: number;
  readonly taskId: string;
  readonly requestDigest: string;
}

export interface UpdateAutomationAttemptRequest extends AutomationMutationScope {
  readonly attemptId: string;
  readonly dispatchStatus: AutomationDispatchStatus;
  readonly milestoneStatus?: AutomationMilestoneStatus;
  readonly evidence?: readonly AutomationVerificationEvidence[];
  readonly terminalState?: string | null;
}

export interface RecordAutomationVerificationRequest extends AutomationMutationScope {
  readonly attemptId: string;
  readonly evidence: readonly AutomationVerificationEvidence[];
  readonly milestoneStatus?: Extract<AutomationMilestoneStatus, 'completed' | 'blocked' | 'failed'>;
}

const RUN_TRANSITIONS: Readonly<Record<AutomationRunStatus, readonly AutomationRunStatus[]>> = {
  active: ['paused', 'blocked', 'completing', 'failed', 'cancelled'],
  paused: ['active', 'cancelled'],
  blocked: ['active', 'failed', 'cancelled'],
  completing: ['completed', 'blocked', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

const MILESTONE_TRANSITIONS: Readonly<Record<AutomationMilestoneStatus, readonly AutomationMilestoneStatus[]>> = {
  pending: ['ready', 'cancelled'],
  ready: ['dispatching', 'blocked', 'cancelled'],
  dispatching: ['running', 'blocked', 'failed', 'cancelled'],
  running: ['verifying', 'blocked', 'failed', 'cancelled'],
  verifying: ['completed', 'blocked', 'failed', 'cancelled'],
  completed: [],
  blocked: ['ready', 'failed', 'cancelled'],
  failed: ['ready', 'cancelled'],
  cancelled: [],
};

export function validateAutomationPlan(value: unknown): Result<AutomationPlan> {
  if (!isRecord(value) || !Array.isArray(value.milestones)) {
    return err(appError('INVALID_INPUT', 'Automation plan must contain milestones'));
  }
  if (value.milestones.length < 1 || value.milestones.length > MAX_AUTOMATION_MILESTONES) {
    return err(appError('INVALID_INPUT', `Automation plan must contain between 1 and ${MAX_AUTOMATION_MILESTONES} milestones`));
  }

  const milestones: AutomationMilestoneDefinition[] = [];
  const milestoneIds = new Set<string>();
  for (const rawMilestone of value.milestones) {
    const parsed = parseMilestone(rawMilestone);
    if (!parsed.ok) return parsed;
    if (milestoneIds.has(parsed.value.id)) return err(appError('INVALID_INPUT', `Duplicate automation milestone ID: ${parsed.value.id}`));
    milestoneIds.add(parsed.value.id);
    milestones.push(parsed.value);
  }

  for (const milestone of milestones) {
    for (const dependencyId of milestone.dependsOn) {
      if (dependencyId === milestone.id) return err(appError('INVALID_INPUT', `Automation milestone ${milestone.id} cannot depend on itself`));
      if (!milestoneIds.has(dependencyId)) return err(appError('INVALID_INPUT', `Automation milestone ${milestone.id} has missing dependency ${dependencyId}`));
    }
  }
  if (containsCycle(milestones)) return err(appError('INVALID_INPUT', 'Automation milestone graph must be acyclic'));
  return ok({ milestones });
}

export function readyAutomationMilestones(
  plan: AutomationPlan,
  statusByMilestoneId: Readonly<Record<string, AutomationMilestoneStatus>>,
): readonly AutomationMilestoneDefinition[] {
  return plan.milestones.filter((milestone) => (
    statusByMilestoneId[milestone.id] === 'pending'
      && milestone.dependsOn.every((dependencyId) => statusByMilestoneId[dependencyId] === 'completed')
  ));
}

export function transitionAutomationRun(from: AutomationRunStatus, to: AutomationRunStatus): Result<AutomationRunStatus> {
  return RUN_TRANSITIONS[from].includes(to)
    ? ok(to)
    : err(appError('CONFLICT', `Automation run cannot transition from ${from} to ${to}`, true));
}

export function transitionAutomationMilestone(
  from: AutomationMilestoneStatus,
  to: AutomationMilestoneStatus,
): Result<AutomationMilestoneStatus> {
  return MILESTONE_TRANSITIONS[from].includes(to)
    ? ok(to)
    : err(appError('CONFLICT', `Automation milestone cannot transition from ${from} to ${to}`, true));
}

export function automationAttemptIdentityEquals(
  left: AutomationAttemptIdentity,
  right: AutomationAttemptIdentity,
): boolean {
  return left.id === right.id && left.milestoneId === right.milestoneId && left.ordinal === right.ordinal;
}

export function validAutomationAttemptOrdinal(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_AUTOMATION_ATTEMPTS_PER_MILESTONE;
}

export function automationShellRequestDigest(input: AutomationShellRequestDigestInput): string {
  const canonical = canonicalJson({
    version: 1,
    task_id: input.taskId,
    executable: input.dispatch.executable,
    arguments: [...input.dispatch.arguments],
    cwd: input.dispatch.cwd,
    timeout_seconds: input.dispatch.timeoutSeconds,
    max_output_bytes: input.dispatch.maxOutputBytes,
    include_stdout: input.dispatch.includeStdout,
    include_stderr: input.dispatch.includeStderr,
    ...(input.dispatch.windowsVerbatimArguments === undefined
      ? {}
      : { windows_verbatim_arguments: input.dispatch.windowsVerbatimArguments }),
    owner_client_id: input.ownerClientId,
    owner_workspace_id: input.workspaceId,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function parseMilestone(value: unknown): Result<AutomationMilestoneDefinition> {
  if (!isRecord(value)) return err(appError('INVALID_INPUT', 'Automation milestone must be an object'));
  const id = boundedIdentifier(value.id);
  const title = boundedText(value.title, 512);
  const goalStepId = boundedIdentifier(value.goalStepId);
  if (id === undefined || title === undefined || goalStepId === undefined) {
    return err(appError('INVALID_INPUT', 'Automation milestone identity is invalid'));
  }
  if (!Array.isArray(value.dependsOn) || !value.dependsOn.every((entry) => boundedIdentifier(entry) !== undefined)) {
    return err(appError('INVALID_INPUT', `Automation milestone ${id} dependencies are invalid`));
  }
  const dependsOn = value.dependsOn.map((entry) => String(entry));
  if (new Set(dependsOn).size !== dependsOn.length) return err(appError('INVALID_INPUT', `Automation milestone ${id} has duplicate dependencies`));
  if (value.provider !== 'shell') return err(appError('INVALID_INPUT', `Automation milestone ${id} uses unsupported provider`));
  if (value.role !== 'blocking_job' && value.role !== 'supporting_service') {
    return err(appError('INVALID_INPUT', `Automation milestone ${id} role is invalid`));
  }
  if (typeof value.cancelWithGoal !== 'boolean') return err(appError('INVALID_INPUT', `Automation milestone ${id} cancellation policy is invalid`));
  const dispatch = parseShellDispatch(value.dispatch);
  if (!dispatch.ok) return dispatch;
  if (!Array.isArray(value.verification) || value.verification.length < 1 || value.verification.length > 16) {
    return err(appError('INVALID_INPUT', `Automation milestone ${id} must have evidence-producing verification requirements`));
  }
  const verification: AutomationVerificationRequirement[] = [];
  const requirementIds = new Set<string>();
  for (const rawRequirement of value.verification) {
    const requirement = parseVerification(rawRequirement);
    if (!requirement.ok) return requirement;
    if (requirementIds.has(requirement.value.id)) return err(appError('INVALID_INPUT', `Duplicate verification requirement ID: ${requirement.value.id}`));
    requirementIds.add(requirement.value.id);
    verification.push(requirement.value);
  }
  return ok({
    id,
    title,
    goalStepId,
    dependsOn,
    provider: 'shell',
    role: value.role,
    cancelWithGoal: value.cancelWithGoal,
    dispatch: dispatch.value,
    verification,
  });
}

function parseShellDispatch(value: unknown): Result<AutomationShellDispatch> {
  if (!isRecord(value)) return err(appError('INVALID_INPUT', 'Automation shell dispatch is invalid'));
  const executable = boundedText(value.executable, 1_024);
  const cwd = boundedText(value.cwd, 32_768);
  if (executable === undefined || cwd === undefined) return err(appError('INVALID_INPUT', 'Automation shell executable or cwd is invalid'));
  if (!Array.isArray(value.arguments)
    || value.arguments.length > 128
    || !value.arguments.every((entry) => typeof entry === 'string' && entry.length <= 32_768)) {
    return err(appError('INVALID_INPUT', 'Automation shell arguments are invalid'));
  }
  if (!isFiniteNumber(value.timeoutSeconds) || value.timeoutSeconds < 0.1 || value.timeoutSeconds > 604_800) {
    return err(appError('INVALID_INPUT', 'Automation shell timeout is invalid'));
  }
  if (!Number.isInteger(value.maxOutputBytes) || Number(value.maxOutputBytes) < 1 || Number(value.maxOutputBytes) > 8 * 1024 * 1024) {
    return err(appError('INVALID_INPUT', 'Automation shell output limit is invalid'));
  }
  if (typeof value.includeStdout !== 'boolean' || typeof value.includeStderr !== 'boolean') {
    return err(appError('INVALID_INPUT', 'Automation shell output flags are invalid'));
  }
  if (value.windowsVerbatimArguments !== undefined && typeof value.windowsVerbatimArguments !== 'boolean') {
    return err(appError('INVALID_INPUT', 'Automation shell Windows argument mode is invalid'));
  }
  return ok({
    executable,
    arguments: value.arguments as string[],
    cwd,
    ...(value.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: value.windowsVerbatimArguments }),
    timeoutSeconds: value.timeoutSeconds,
    maxOutputBytes: Number(value.maxOutputBytes),
    includeStdout: value.includeStdout,
    includeStderr: value.includeStderr,
  });
}

function parseVerification(value: unknown): Result<AutomationVerificationRequirement> {
  if (!isRecord(value)) return err(appError('INVALID_INPUT', 'Automation verification requirement is invalid'));
  const id = boundedIdentifier(value.id);
  if (id === undefined) return err(appError('INVALID_INPUT', 'Automation verification requirement ID is invalid'));
  if (value.kind === 'command_exit') {
    if (!Number.isInteger(value.expectedExitCode)) return err(appError('INVALID_INPUT', `Verification ${id} exit code is invalid`));
    return ok({ id, kind: 'command_exit', expectedExitCode: Number(value.expectedExitCode) });
  }
  if (value.kind === 'file_sha256') {
    const filePath = boundedText(value.path, 32_768);
    if (filePath === undefined || typeof value.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.expectedSha256)) {
      return err(appError('INVALID_INPUT', `Verification ${id} file digest is invalid`));
    }
    return ok({ id, kind: 'file_sha256', path: filePath, expectedSha256: value.expectedSha256.toLowerCase() });
  }
  if (value.kind === 'git_diff_check') return ok({ id, kind: 'git_diff_check' });
  return err(appError('INVALID_INPUT', `Verification ${id} kind is unsupported`));
}

function containsCycle(milestones: readonly AutomationMilestoneDefinition[]): boolean {
  const inDegree = new Map(milestones.map((milestone) => [milestone.id, milestone.dependsOn.length]));
  const dependents = new Map<string, string[]>();
  for (const milestone of milestones) {
    for (const dependencyId of milestone.dependsOn) {
      const entries = dependents.get(dependencyId) ?? [];
      entries.push(milestone.id);
      dependents.set(dependencyId, entries);
    }
  }
  const ready = milestones.filter((milestone) => inDegree.get(milestone.id) === 0).map((milestone) => milestone.id);
  let visited = 0;
  for (let cursor = 0; cursor < ready.length; cursor += 1) {
    const current = ready[cursor]!;
    visited += 1;
    for (const dependentId of dependents.get(current) ?? []) {
      const remaining = (inDegree.get(dependentId) ?? 0) - 1;
      inDegree.set(dependentId, remaining);
      if (remaining === 0) ready.push(dependentId);
    }
  }
  return visited !== milestones.length;
}

function boundedIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(normalized) ? normalized : undefined;
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= maximum && !normalized.includes('\0') ? normalized : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
