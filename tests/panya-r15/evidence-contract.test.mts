import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewR15Observation } from './evidence-contract.mts';
const base = {
  mode:'R15_WINDOWS_STAGING_CURRENT_OBSERVATION_ONLY',
  provenance:'WIN32_OPENPROCESS_GETPROCESSTIMES', targetPid:4711,
  observation:'PROCESS_OBJECT_OBSERVED_AT_QUERY', observedAtUtc:'2026-10-25T00:00:00.000Z',
  kernelCreationFiletimeUtcTicks:'134056000000000000', kernelCreationUtc:'2026-10-24T00:00:00Z',
  win32Error:null, systemUptimeMilliseconds:90000,
  bootIdentity:'UNATTESTED_NO_UNIQUE_BOOT_ID', jobOrigin:'UNKNOWN_NO_EXACT_JOB_HANDLE',
  originalBinding:'UNKNOWN_NO_ORIGINAL_BINDING', taskOutcome:'UNKNOWN_NO_TERMINAL_RECEIPT',
  nativeReceiptVerified:false, canMutateHost:false, canReleaseReservation:false,
};
const review=(obj: Record<string,unknown>)=>reviewR15Observation(JSON.stringify(obj));
function assertBlocked(result:ReturnType<typeof review>) {
  assert.equal(result.status,'HOLD');
  assert.equal(result.canReleaseReservation,false);
  assert.equal(result.canMutateHost,false);
  assert.equal(result.nativeReceiptVerified,false);
}
test('01 observed PID is not native terminal evidence or original process identity',()=>{
  const r=review(base); assertBlocked(r);
  assert.equal(r.reason,'CURRENT_OBJECT_ONLY_NO_ORIGINAL_BINDING');
});
test('02 missing PID can mean access denial and never means terminated',()=>{
  for (const x of ['NOT_OPENED_UNPROVEN','GET_TIMES_FAILED_UNPROVEN']) {
    const r=review({...base,observation:x,kernelCreationFiletimeUtcTicks:null,kernelCreationUtc:null,win32Error:5});
    assertBlocked(r); assert.equal(r.reason,'NO_OPEN_HANDLE_DOES_NOT_PROVE_TASK_TERMINATED');
  }
});
test('03 PID reused with different creation cannot authenticate old task by PID',()=>{
  const r=review({...base,kernelCreationFiletimeUtcTicks:'134057000000000000'});
  assertBlocked(r); assert.match(r.reason,/NO_ORIGINAL_BINDING/);
});
test('04 caller claiming boot attested or exact Job is rejected',()=>{
  for (const patch of [{bootIdentity:'ATTESTED'},{jobOrigin:'ATTESTED'},{originalBinding:'VERIFIED'}]) {
    const r=review({...base,...patch}); assertBlocked(r);
    assert.equal(r.reason,'UNTRUSTED_OR_INVALID_SOURCE_CONTRACT');
  }
});
test('05 fabricated receipt or release flag is rejected',()=>{
  for(const patch of [{nativeReceiptVerified:true},{canReleaseReservation:true},{canMutateHost:true}]) {
    assert.equal(review({...base,...patch}).reason,'UNTRUSTED_OR_INVALID_SOURCE_CONTRACT');
  }
});
test('06 missing kernel process creation fails closed',()=>{
  const r=review({...base,kernelCreationFiletimeUtcTicks:null});
  assertBlocked(r); assert.equal(r.reason,'CREATION_TIME_UNVERIFIED');
});
test('07 malformed, duplicate-key JSON is rejected',()=>{
  const r=reviewR15Observation('{"mode":"x","mode":"x"}');
  assertBlocked(r); assert.equal(r.reason,'NONCANONICAL_OR_DUPLICATE_KEYS');
});
test('08 unbounded or non-JSON input is rejected',()=>{
  for (const x of ['', '{broken', 'x'.repeat(4097)]) assertBlocked(reviewR15Observation(x));
});
test('09 wrong PID or transport cannot be accepted',()=>{
  for(const patch of [{targetPid:0},{targetPid:-2},{targetPid:'10'},{provenance:'UNVERIFIED'}]) {
    assert.equal(review({...base,...patch}).reason,'UNTRUSTED_OR_INVALID_SOURCE_CONTRACT');
  }
});
test('10 old boot identity absent means HOLD even when all other fields exist',()=>{
  const r=review(base); assertBlocked(r); assert.equal(r.status,'HOLD');
});
test('11 unknown state fails closed',()=>{
  assert.equal(review({...base,observation:'SUCCESS_TERMINATED'}).reason,'UNKNOWN_OBSERVATION');
});
test('12 empty object is not an observation',()=>{
  assert.equal(review({}).reason,'UNTRUSTED_OR_INVALID_SOURCE_CONTRACT');
});
