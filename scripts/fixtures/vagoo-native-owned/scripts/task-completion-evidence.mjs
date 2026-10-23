// Read-only, fixture-bound diagnostic. Not a recovery authorization or a live lnwjud tool.
import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const fixtureHome = fileURLToPath(new URL('../audit/collector-fixtures/', import.meta.url));
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (reason) => { throw new Error(reason); };
const canonical = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const exact = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validPid = (value) => Number.isSafeInteger(value) && value > 0;
const fresh = (value) => stamp(value) && Date.now() - Date.parse(value) >= -1000 && Date.now() - Date.parse(value) <= 30000;
const text = (file) => file.state === 'READ' ? file.bytes.toString('utf8') : null;
const json = (file) => { try { return JSON.parse(text(file)); } catch { return null; } };
const safeReason = (error) => ['ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? error.code
  : /^[A-Z][A-Z0-9_]{1,120}$/.test(error.message) ? error.message : 'EVIDENCE_READ_FAILED';

export function checkReadOnlyFile(info) {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 262144) fail('UNSAFE_OR_OVERSIZED_FILE');
}

async function checkedPath(root, relative) {
  if (canonical(await realpath(root)) !== canonical(root) || (await lstat(root)).isSymbolicLink()) fail('REPARSE_PATH');
  const resolved = path.resolve(root, relative), rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) fail('OUTSIDE_FIXTURE');
  let current = root;
  for (const part of path.dirname(rel).split(path.sep).filter((p) => p && p !== '.')) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('REPARSE_PATH');
  }
  return resolved;
}

async function readOnly(root, relative) {
  let handle;
  try {
    const filename = await checkedPath(root, relative), before = await lstat(filename);
    checkReadOnlyFile(before);
    handle = await open(filename, 'r');
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev) fail('FILE_IDENTITY_CHANGED');
    const bytes = await handle.readFile(), after = await handle.stat();
    if (bytes.length > 262144) fail('UNSAFE_OR_OVERSIZED_FILE');
    if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs) fail('FILE_CHANGED_WHILE_READING');
    return { state: 'READ', bytes, hash: sha256(bytes) };
  } catch (error) {
    return { state: error.code === 'ENOENT' ? 'MISSING' : ['EACCES', 'EPERM'].includes(error.code) ? 'DENIED' : 'UNKNOWN',
      reason: safeReason(error) };
  } finally { if (handle) await handle.close(); }
}

async function checkFixture(root, id) {
  if (!/^mock-[a-z0-9-]{1,70}$/.test(id)) fail('SYNTHETIC_ID_REQUIRED');
  const rel = path.relative(fixtureHome, path.resolve(root));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) fail('OUTSIDE_FIXTURE');
  if (canonical(await realpath(fixtureHome)) !== canonical(fixtureHome) || canonical(await realpath(root)) !== canonical(root)) fail('REPARSE_PATH');
  const seal = json(await readOnly(root, 'MOCK_ONLY.json'));
  if (seal?.scope !== 'SYNTHETIC_ONLY' || seal.machine !== 'MOCK') fail('MOCK_SEAL_REQUIRED');
}

async function readInputs(root, id) {
  const names = { marker: `.index/v1/active/${sha256(id)}.json`, metadata: `${id}/task.json`,
    stderr: `${id}/stderr.log`, stdout: `${id}/stdout.log`, launcher: `${id}/containment.ps1`,
    spec: `${id}/containment.json`, launchBinding: `${id}/mock-launch-binding.json`, receipt: `${id}/containment.receipt.json` };
  return Object.fromEntries(await Promise.all(Object.entries(names).map(async ([name, relative]) => [name, await readOnly(root, relative)])));
}

const summary = (files) => Object.fromEntries(Object.entries(files).map(([name, file]) => [name,
  { state: file.state, ...(file.hash ? { sha256: file.hash, bytes: file.bytes.length } : { reason: file.reason }) }]));

function identityMatches(observed, expected) {
  return !!observed && observed.pid === expected.pid && observed.startedAt === expected.startedAt
    && observed.image === expected.image && observed.parentPid === expected.parentPid
    && observed.parentStartedAt === expected.parentStartedAt;
}

function processObservation(expected, snapshot, binding) {
  if (!expected || !validPid(expected.pid) || !stamp(expected.startedAt) || !expected.image
    || !validPid(expected.parentPid) || !stamp(expected.parentStartedAt)) return { status: 'UNKNOWN', reason: 'EXPECTED_IDENTITY_INCOMPLETE' };
  const matchingPid = snapshot.processes.filter((p) => p.pid === expected.pid);
  if (matchingPid.length > 1) return { status: 'UNKNOWN', reason: 'AMBIGUOUS_PROCESS_TABLE' };
  const running = matchingPid[0];
  const exit = snapshot.exits.filter((e) => e.source === 'MOCK_RETAINED_HANDLE_EXIT'
    && e.invocationId === binding.invocationId && e.taskId === binding.taskId && e.requestDigest === binding.requestDigest
    && e.ownerSessionId === binding.owner.sessionId && identityMatches(e, expected));
  if (running && identityMatches(running, expected)) return { status: exit.length ? 'CONFLICT' : 'RUNNING_OBSERVED', reason: exit.length ? 'EXIT_AND_RUNNING_CONTRADICT' : 'EXACT_IDENTITY_LIVE' };
  if (exit.length !== 1 || !stamp(exit[0].exitedAt) || Date.parse(exit[0].exitedAt) < Date.parse(expected.startedAt)
    || Date.parse(exit[0].exitedAt) > Date.parse(snapshot.capturedAt) || !Number.isInteger(exit[0].exitCode) || exit[0].exitCode === 259) {
    return { status: 'UNKNOWN', reason: running ? 'PID_REUSED_WITHOUT_BOUND_EXIT' : 'PID_ABSENCE_IS_NOT_TERMINATION_PROOF' };
  }
  return { status: 'EXACT_EXIT_MOCK', reason: running ? 'BOUND_EXIT_DESPITE_PID_REUSE' : 'RETAINED_HANDLE_EXIT', exitCode: exit[0].exitCode };
}

export async function collectTaskCompletion(root, id, observe) {
  const result = { scope: 'SYNTHETIC_ONLY', purpose: 'READ_ONLY_DIAGNOSTIC', taskId: id,
    status: 'UNKNOWN', recoveryAuthorization: 'NONE', reasons: [] };
  try {
    await checkFixture(root, id);
    const before = await readInputs(root, id);
    result.files = summary(before);
    result.fileWindow = 'UNVERIFIED';
    result.receipt = { state: before.receipt.state };
    const readObservation = observe ?? (async () => json(await readOnly(root, 'mock-process-observation.json')));
    // Snapshot the returned value immediately: a provider may reuse its mutable object.
    const first = structuredClone(await readObservation());
    const second = structuredClone(await readObservation());
    const after = await readInputs(root, id);
    if (!exact(summary(before), summary(after))) fail('FILES_CHANGED_DURING_COLLECTION');
    result.fileWindow = 'STABLE_MOCK_SNAPSHOT';
    if (!exact(first, second)) fail('PROCESS_OBSERVATION_CHANGED');
    if (first?.scope !== 'SYNTHETIC_ONLY' || first.machine !== 'MOCK' || first.coverage !== 'machine-wide-complete'
      || !first.generation || !fresh(first.capturedAt) || !Array.isArray(first.processes) || !Array.isArray(first.exits)
      || !Array.isArray(first.jobs) || !Array.isArray(first.writers)) fail('PROCESS_OBSERVATION_INCOMPLETE');
    result.observation = { generation: first.generation, capturedAt: first.capturedAt, authority: 'MOCK_ONLY' };
    const marker = json(before.marker), task = json(before.metadata), binding = json(before.launchBinding);
    for (const name of ['marker', 'metadata', 'stderr', 'stdout', 'launcher', 'spec', 'launchBinding']) {
      if (before[name].state !== 'READ') fail(`${name.toUpperCase()}_${before[name].state}`);
    }
    if (marker?.version !== 1 || task?.version !== 1 || marker.taskId !== id || task.task_id !== id
      || !/^[a-f0-9]{64}$/.test(marker.requestDigest) || marker.requestDigest !== task.request_digest) fail('TASK_DIGEST_UNBOUND');
    if (marker.mutationKind !== 'opaque' || marker.legacy || task.containment !== 'windows_job_v1') fail('NOT_DURABLE_GROUP_A');
    const owner = { clientId: task.owner_client_id, sessionId: task.owner_session_id, workspaceId: task.owner_workspace_id };
    if (!Object.values(owner).every((value) => typeof value === 'string' && /^[a-z0-9_-]{1,128}$/i.test(value)) || marker.ownerClientId !== owner.clientId
      || marker.ownerWorkspaceId !== owner.workspaceId) fail('OWNER_UNKNOWN_OR_MISMATCH');
    if (binding?.scope !== 'SYNTHETIC_ONLY' || binding.version !== 1 || !binding.invocationId
      || binding.taskId !== id || binding.requestDigest !== marker.requestDigest || !exact(binding.owner, owner)
      || binding.launcherHash !== before.launcher.hash || binding.specHash !== before.spec.hash
      || binding.receiptRelativePath !== `${id}/containment.receipt.json`) fail('LAUNCH_BINDING_UNVERIFIED');
    if (binding.worker?.pid !== task.worker_pid || binding.worker?.startedAt !== task.worker_started_at
      || binding.helper?.pid !== task.child_pid || binding.helper?.startedAt !== task.child_started_at
      || binding.worker?.parentPid !== marker.launcherPid || binding.worker?.parentStartedAt !== marker.launcherStartedAt
      || binding.helper?.parentPid !== binding.worker?.pid || binding.helper?.parentStartedAt !== binding.worker?.startedAt) fail('PROCESS_IDENTITY_BINDING_MISMATCH');
    result.ownerBound = true;
    result.identity = { requestDigest: marker.requestDigest, owner, invocationId: binding.invocationId };
    result.worker = processObservation(binding.worker, first, binding);
    result.helper = processObservation(binding.helper, first, binding);
    const writerScope = first.writerScope;
    result.ownerWriter = writerScope?.coverage === 'machine-wide-complete' && exact(writerScope.owner, owner)
      ? first.writers.some((w) => w.workspaceId === owner.workspaceId) ? 'LIVE_OR_UNRESOLVED' : 'QUIESCENT_MOCK' : 'UNKNOWN';
    // A lease count (including zero) is deliberately not used to prove quiescence.
    if ([result.worker.status, result.helper.status].includes('CONFLICT')) fail('PROCESS_EVIDENCE_CONFLICT');
    if ([result.worker.status, result.helper.status].includes('RUNNING_OBSERVED')) { result.status = 'RUNNING_OBSERVED'; return result; }
    if (result.worker.status !== 'EXACT_EXIT_MOCK' || result.helper.status !== 'EXACT_EXIT_MOCK') fail('EXACT_TERMINATION_NOT_PROVEN');
    if (result.ownerWriter !== 'QUIESCENT_MOCK') fail('OWNER_WRITER_NOT_PROVEN_QUIESCENT');
    const jobs = first.jobs.filter((j) => j.source === 'MOCK_RETAINED_JOB_HANDLE' && j.taskId === id
      && j.invocationId === binding.invocationId && j.requestDigest === marker.requestDigest && j.ownerSessionId === owner.sessionId);
    if (jobs.length !== 1 || jobs[0].helperClosed !== true || jobs[0].activeProcesses !== 0 || jobs[0].targetCreated !== false
      || jobs[0].scriptLoadRejected !== true) fail('DESCENDANTS_OR_TARGET_START_UNKNOWN');
    if (before.receipt.state === 'READ') {
      const receipt = json(before.receipt);
      if (receipt?.kind !== 'windows_job_v1' || receipt.activeProcesses !== 0 || !Number.isInteger(receipt.exitCode)
        || receipt.exitCode === 259 || !['completed', 'cancelled', 'timed_out'].includes(receipt.outcome)) fail('NATIVE_RECEIPT_INVALID');
      // Receipt presence routes to the normal terminal path; never infer a startup failure from it.
      fail('NATIVE_RECEIPT_PRESENT_REQUIRES_NORMAL_TERMINAL_REVIEW');
    }
    if (before.receipt.state !== 'MISSING') fail('NATIVE_RECEIPT_UNREADABLE');
    const rejection = text(before.stderr);
    if (!rejection.includes(`${id}\\containment.ps1`) || !rejection.includes('cannot be loaded because running scripts is disabled')
      || !rejection.includes('UnauthorizedAccess') || before.stdout.bytes.length !== 0 || task.exit_code !== 1
      || result.helper.exitCode !== 1 || result.worker.exitCode !== task.exit_code
      || task.state !== 'termination_unverified') fail('STARTUP_FAILURE_NOT_CORROBORATED');
    result.status = 'EXACT_STARTUP_FAILURE_MOCK';
    result.reasons.push('Bound mock handle exits and zero-descendant job evidence corroborate the startup rejection.');
  } catch (error) {
    result.status = 'UNKNOWN';
    result.reasons.push(safeReason(error));
  }
  return result;
}
