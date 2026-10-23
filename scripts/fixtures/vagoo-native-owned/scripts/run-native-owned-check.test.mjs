import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeNativePlan, verifyNativeOutput, validateInputManifest, requiredManifestPaths, hostRuntime, nodeRuntime } from './run-native-owned-check.mjs';
const invocationId = '11111111-2222-4333-8444-555555555555';

test('approved host File launch keeps normal authorization, fixed fixture, and no shell', () => {
  const plan = makeNativePlan({ machine: 'VAGOO', invocationId });
  assert.equal(plan.executable, hostRuntime); assert.equal(plan.shell, false); assert.equal(plan.windowsHide, true);
  assert.deepEqual(plan.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-File']);
  assert.ok(plan.args[3].endsWith('test-windows-owned-reader.ps1')); assert.ok(plan.args.includes(nodeRuntime));
  assert.equal(plan.args[plan.args.indexOf('-InvocationId') + 1], invocationId);
  assert.ok(plan.args.every((arg) => !/^-ExecutionPolicy$|^-EncodedCommand$|^-Command$|^Bypass$/i.test(arg)));
});
for (const [label, context, reason] of [
  ['5090', { machine: 'PANYA-HOME' }, 'VAGOO_ONLY'],
  ['legacy interpreter', { machine: 'VAGOO', runtime: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` }, 'APPROVED_HOST_RUNTIME_REQUIRED'],
  ['PATH alias', { machine: 'VAGOO', runtime: 'pwsh.exe' }, 'APPROVED_HOST_RUNTIME_REQUIRED'],
  ['alternate executable', { machine: 'VAGOO', node: String.raw`C:\other\node.exe` }, 'APPROVED_NODE_REQUIRED'],
  ['inherited policy', { machine: 'VAGOO', env: { PSExecutionPolicyPreference: 'RemoteSigned' } }, 'POLICY_OVERRIDE_NOT_ALLOWED'],
  ['case varied policy', { machine: 'VAGOO', env: { psexecutionpolicypreference: 'Bypass' } }, 'POLICY_OVERRIDE_NOT_ALLOWED'],
  ['lockdown override', { machine: 'VAGOO', env: { __PSLockdownPolicy: '0' } }, 'POLICY_OVERRIDE_NOT_ALLOWED'],
  ['missing invocation', { machine: 'VAGOO' }, 'LAUNCH_INVOCATION_REQUIRED'],
]) test(`refuses ${label} before any process launch`, () => assert.throws(() => makeNativePlan(context), new RegExp(reason)));

const policy = [{ scope: 'LocalMachine', policy: 'RemoteSigned' }];
function sample() {
  const frame = { schemaVersion: 1, scope: 'WINDOWS_LOCAL_READ_ONLY_OWNED_TEST', machine: 'VAGOO',
    source: 'SYSTEM_DIAGNOSTICS_RETAINED_PROCESS', taskId: 'mock-native-owned', invocationId, sessionNonce: 'mock-session',
    processId: 900002, creationFileTime: '134000000000000001', image: nodeRuntime, capturedAt: new Date().toISOString(),
    state: 'RUNNING_OBSERVED', descendantsVerified: false, taskOwnerVerified: false };
  return { status: 'NATIVE_OWNED_FIXTURE_PASS', scope: 'LOCAL_OWNED_INERT_TEST', machine: 'VAGOO', runtime: hostRuntime, policyBefore: policy, policyAfter: policy,
    policyUnchanged: true, taskWideCompletion: 'UNKNOWN', recoveryAuthorization: 'NONE', running: frame,
    exited: { ...frame, state: 'EXIT_BOUND_TO_RETAINED_HANDLE', exitCode: 23, exitFileTime: '134000000000100001' } };
}
test('fixture success remains a process component and grants no recovery', () => {
  const result = verifyNativeOutput(sample(), { hostRuntime: { policy } }, invocationId);
  assert.equal(result.exited.status, 'IDENTITY_BOUND_PROCESS_EXIT'); assert.equal(result.taskWideCompletion, 'UNKNOWN'); assert.equal(result.recoveryAuthorization, 'NONE');
});
for (const [label, change] of [
  ['policy changed', (r) => { r.policyAfter = [{ scope: 'LocalMachine', policy: 'Bypass' }]; }],
  ['wrong runtime', (r) => { r.runtime = 'powershell.exe'; }],
  ['reused PID', (r) => { r.exited.creationFileTime = '134000000000000002'; }],
  ['claim of task completion', (r) => { r.taskWideCompletion = 'COMPLETE'; }],
  ['claim of recovery permission', (r) => { r.recoveryAuthorization = 'ALLOW'; }],
  ['claim of descendant proof', (r) => { r.exited.descendantsVerified = true; }],
  ['wrong fixture scope', (r) => { r.scope = 'UNRELATED_DIAGNOSTIC'; }],
  ['different task in both frames', (r) => { r.running.taskId = r.exited.taskId = 'mock-unrelated-job'; }],
  ['different image in both frames', (r) => { r.running.image = r.exited.image = String.raw`C:\unrelated\other.exe`; }],
  ['different invocation in both frames', (r) => { r.running.invocationId = r.exited.invocationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'; }],
]) test(`does not accept ${label}`, () => { const result = sample(); change(result); assert.throws(() => verifyNativeOutput(result, { hostRuntime: { policy } }, invocationId)); });

const manifest = () => Object.fromEntries(requiredManifestPaths.map((file) => [file, 'a'.repeat(64)]));
test('accepts only the complete fixture manifest', () => assert.equal(Object.keys(validateInputManifest(manifest())).length, 8));
for (const [label, input] of [
  ['empty', () => ({})], ['null', () => null], ['array', () => []],
  ['missing harness', () => { const value = manifest(); delete value['scripts/test-windows-owned-reader.ps1']; return value; }],
  ['non-SHA256 value', () => ({ ...manifest(), 'scripts/test-windows-owned-reader.ps1': 'bad' })],
  ['parent path', () => ({ ...manifest(), '../outside.ps1': 'a'.repeat(64) })],
  ['absolute path', () => ({ ...manifest(), [String.raw`C:\outside.ps1`]: 'a'.repeat(64) })],
]) test(`rejects ${label} manifest`, () => assert.throws(() => validateInputManifest(input()), /INPUT_MANIFEST_INVALID_OR_INCOMPLETE/));
