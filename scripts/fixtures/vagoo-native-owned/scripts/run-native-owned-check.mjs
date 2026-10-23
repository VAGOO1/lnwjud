// VAGOO fixture acceptance only. No interpreter fallback or policy override.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyWindowsProcess } from './windows-observation-adapter.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const hostRuntime = String.raw`C:\Users\yanap\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe`;
export const nodeRuntime = String.raw`C:\Program Files\nodejs\node.exe`;
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const samePath = (left, right) => typeof left === 'string' && path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
const validInvocation = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const fixtureTask = 'mock-native-owned';
export const requiredManifestPaths = Object.freeze(['scripts/task-completion-evidence.mjs', 'scripts/windows-observation-adapter.mjs',
  'scripts/windows-owned-process-reader.psm1', 'scripts/test-windows-owned-reader.ps1', 'scripts/native-inert-worker.mjs',
  'scripts/run-native-owned-check.mjs', 'scripts/run-native-owned-check.test.mjs', 'audit/PREFLIGHT.json']);

export function validateInputManifest(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)
    || Object.keys(manifest).length !== requiredManifestPaths.length
    || !Object.keys(manifest).every((file) => requiredManifestPaths.includes(file))
    || !requiredManifestPaths.every((file) => Object.hasOwn(manifest, file) && typeof manifest[file] === 'string' && /^[a-f0-9]{64}$/.test(manifest[file]))) {
    throw new Error('INPUT_MANIFEST_INVALID_OR_INCOMPLETE');
  }
  return manifest;
}

export function makeNativePlan({ machine, runtime = hostRuntime, node = nodeRuntime, env = {}, invocationId }) {
  if (machine !== 'VAGOO') throw new Error('VAGOO_ONLY');
  if (!samePath(runtime, hostRuntime)) throw new Error('APPROVED_HOST_RUNTIME_REQUIRED');
  if (!samePath(node, nodeRuntime)) throw new Error('APPROVED_NODE_REQUIRED');
  const vars = Object.fromEntries(Object.entries(env).map(([key, value]) => [key.toLowerCase(), value]));
  if (vars.psexecutionpolicypreference != null || vars.__pslockdownpolicy != null) throw new Error('POLICY_OVERRIDE_NOT_ALLOWED');
  if (!validInvocation(invocationId)) throw new Error('LAUNCH_INVOCATION_REQUIRED');
  return { executable: hostRuntime, args: ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'scripts/test-windows-owned-reader.ps1'),
    '-NodePath', nodeRuntime, '-ExpectedRuntimePath', hostRuntime, '-InvocationId', invocationId], cwd: root, shell: false, windowsHide: true };
}

export function verifyNativeOutput(result, preflight, invocationId) {
  if (!validInvocation(invocationId) || result?.status !== 'NATIVE_OWNED_FIXTURE_PASS' || result.scope !== 'LOCAL_OWNED_INERT_TEST'
    || result.machine !== 'VAGOO' || !samePath(result.runtime, hostRuntime)
    || result.taskWideCompletion !== 'UNKNOWN' || result.recoveryAuthorization !== 'NONE'
    || JSON.stringify(result.policyBefore) !== JSON.stringify(preflight.hostRuntime.policy)
    || JSON.stringify(result.policyAfter) !== JSON.stringify(result.policyBefore) || result.policyUnchanged !== true) throw new Error('NATIVE_ACCEPTANCE_UNVERIFIED');
  const expected = { taskId: fixtureTask, invocationId, image: nodeRuntime, sessionNonce: result.running?.sessionNonce,
    processId: result.running?.processId, creationFileTime: result.running?.creationFileTime };
  const running = classifyWindowsProcess(result.running, expected), exited = classifyWindowsProcess(result.exited, expected);
  if (running.status !== 'RUNNING_OBSERVED' || exited.status !== 'IDENTITY_BOUND_PROCESS_EXIT' || exited.exitCode !== 23
    || result.running.descendantsVerified !== false || result.exited.descendantsVerified !== false
    || result.running.taskOwnerVerified !== false || result.exited.taskOwnerVerified !== false) throw new Error('NATIVE_COMPONENT_UNVERIFIED');
  return { running, exited, taskWideCompletion: 'UNKNOWN', recoveryAuthorization: 'NONE' };
}

function runOnce() {
  if (process.argv.length !== 2) throw new Error('NO_EXTRA_ARGUMENTS_ALLOWED');
  const invocationId = randomUUID();
  const plan = makeNativePlan({ machine: process.env.COMPUTERNAME, env: process.env, invocationId });
  const preflight = JSON.parse(readFileSync(path.join(root, 'audit/PREFLIGHT.json')));
  const manifest = validateInputManifest(JSON.parse(readFileSync(path.join(root, 'audit/INPUT_MANIFEST.json'))));
  for (const [file, expectedHash] of Object.entries(manifest)) {
    if (hash(path.join(root, file)) !== expectedHash) throw new Error(`INPUT_CHANGED: ${file}`);
  }
  if (hash(plan.executable) !== preflight.hostRuntime.executableSha256 || hash(nodeRuntime) !== preflight.nodeSha256
    || hash(path.join(path.dirname(plan.executable), 'powershell.config.json')) !== preflight.hostRuntime.configSha256) throw new Error('RUNTIME_OR_POLICY_CONFIG_CHANGED');
  const claim = openSync(path.join(root, 'audit/native-attempt.claim'), 'wx'); closeSync(claim);
  const attempt = { status: 'STARTING', attempts: 1, invocationId, startedAtUtc: new Date().toISOString(), executable: plan.executable, args: plan.args,
    policyOverride: false, fallbackAllowed: false, automaticReplayAllowed: false };
  const save = () => writeFileSync(path.join(root, 'audit/native-attempt.json'), `${JSON.stringify(attempt, null, 2)}\n`, { flag: 'w' });
  save();
  const outcome = spawnSync(plan.executable, plan.args, { cwd: plan.cwd, shell: plan.shell, windowsHide: plan.windowsHide, encoding: 'utf8' });
  Object.assign(attempt, { endedAtUtc: new Date().toISOString(), exitCode: outcome.status, signal: outcome.signal, stdout: outcome.stdout ?? '', stderr: outcome.stderr ?? '',
    launchError: outcome.error ? { code: outcome.error.code, message: outcome.error.message } : null, status: 'UNKNOWN_STOP_NO_REPLAY' });
  save();
  if (outcome.error || outcome.signal || outcome.status !== 0) { process.exitCode = 1; console.error('NATIVE_ATTEMPT_STOPPED_INSPECT_RECORDED_RESULT'); return; }
  const result = JSON.parse(outcome.stdout.trim());
  const acceptance = verifyNativeOutput(result, preflight, invocationId);
  Object.assign(attempt, { status: 'TESTED_NATIVE_LOCAL_OWNED_FIXTURE', result, acceptance }); save();
  console.log(JSON.stringify({ status: attempt.status, attempts: 1, running: acceptance.running.status, exited: acceptance.exited.status,
    exitCode: acceptance.exited.exitCode, policyUnchanged: result.policyUnchanged, taskWideCompletion: 'UNKNOWN', recoveryAuthorization: 'NONE' }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runOnce();
