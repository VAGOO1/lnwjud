// Diagnostic bridge only: does not launch processes, run PowerShell, write files, or authorize recovery.
import path from 'node:path';
import { collectTaskCompletion, sha256 } from './task-completion-evidence.mjs';

const unknown = (reason) => ({ status: 'UNKNOWN', reason, recoveryAuthorization: 'NONE' });
const stableFrame = (frame) => { const copy = structuredClone(frame); if (copy) delete copy.capturedAt; return copy; };
const decimalTime = (value) => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const image = (value) => typeof value === 'string' ? path.win32.normalize(value).toLowerCase() : null;

export function classifyWindowsProcess(frame, expected) {
  if (!frame || frame.schemaVersion !== 1 || frame.scope !== 'WINDOWS_LOCAL_READ_ONLY_OWNED_TEST'
    || frame.machine !== 'VAGOO' || frame.source !== 'SYSTEM_DIAGNOSTICS_RETAINED_PROCESS') return unknown('NATIVE_CONTRACT_UNVERIFIED');
  if (frame.state === 'UNKNOWN') return unknown(['ACCESS_DENIED', 'HANDLE_CHANGED', 'IDENTITY_CHANGED', 'EXIT_NOT_SIGNALED'].includes(frame.reason) ? frame.reason : 'NATIVE_READ_FAILED');
  if (!expected || !/^mock-[a-z0-9-]{1,70}$/.test(expected.taskId)
    || frame.taskId !== expected.taskId || frame.invocationId !== expected.invocationId || frame.sessionNonce !== expected.sessionNonce
    || !expected.invocationId || !expected.sessionNonce || !Number.isSafeInteger(expected.processId) || expected.processId <= 0
    || frame.processId !== expected.processId || !decimalTime(frame.creationFileTime) || !decimalTime(expected.creationFileTime)
    || frame.creationFileTime !== expected.creationFileTime || !image(expected.image) || image(frame.image) !== image(expected.image)) return unknown('NATIVE_IDENTITY_UNBOUND');
  const age = Date.now() - Date.parse(frame.capturedAt);
  if (!Number.isFinite(age) || age < -1000 || age > 30000) return unknown('NATIVE_OBSERVATION_STALE');
  const common = { scope: 'NATIVE_LOCAL_PROCESS_COMPONENT', processId: frame.processId, creationFileTime: frame.creationFileTime,
    taskWideCompletion: 'UNKNOWN', descendantsVerified: false, taskOwnerVerified: false, recoveryAuthorization: 'NONE' };
  if (frame.state === 'RUNNING_OBSERVED') return { ...common, status: 'RUNNING_OBSERVED' };
  if (frame.state !== 'EXIT_BOUND_TO_RETAINED_HANDLE' || !decimalTime(frame.exitFileTime)
    || BigInt(frame.exitFileTime) < BigInt(frame.creationFileTime) || !Number.isInteger(frame.exitCode) || frame.exitCode === 259) return unknown('NATIVE_TERMINATION_UNVERIFIED');
  return { ...common, status: 'IDENTITY_BOUND_PROCESS_EXIT', exitCode: frame.exitCode, exitFileTime: frame.exitFileTime };
}

export async function collectWithWindowsObservation(root, id, expected, observe) {
  const frames = [];
  const base = await collectTaskCompletion(root, id, async () => {
    const frame = structuredClone(await observe());
    frames.push(frame);
    // Keep native data in its own envelope. Never relabel it as a synthetic retained-handle proof.
    return { scope: 'WINDOWS_DIAGNOSTIC_ENVELOPE', contentHash: sha256(JSON.stringify(stableFrame(frame))) };
  });
  let nativeProcess = unknown('NATIVE_OBSERVATION_INCOMPLETE');
  if (frames.length === 2 && id === expected?.taskId) {
    if (JSON.stringify(stableFrame(frames[0])) !== JSON.stringify(stableFrame(frames[1]))) nativeProcess = unknown('NATIVE_OBSERVATION_CHANGED');
    else {
      const first = classifyWindowsProcess(frames[0], expected), second = classifyWindowsProcess(frames[1], expected);
      nativeProcess = first.status === 'UNKNOWN' ? first : second;
    }
  }
  if (base.fileWindow !== 'STABLE_MOCK_SNAPSHOT') nativeProcess = unknown('FILE_COLLECTION_WINDOW_UNVERIFIED');
  return { ...base, status: 'UNKNOWN', reasons: base.reasons.map((r) => r === 'PROCESS_OBSERVATION_INCOMPLETE'
    ? 'TASK_WIDE_WINDOWS_EVIDENCE_UNAVAILABLE' : r), nativeProcess, observationAuthority: 'WINDOWS_READ_ONLY_DIAGNOSTIC', recoveryAuthorization: 'NONE' };
}
