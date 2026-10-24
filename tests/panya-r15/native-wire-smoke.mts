// R15 GitHub Windows runner only. Validate the REAL native JSON wire, never Host.
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { reviewR15Observation } from './evidence-contract.mts';
const raw = readFileSync(0, 'utf8').trimEnd();
const observation = JSON.parse(raw);
assert.equal(typeof observation.observedAtUtc, 'string');
assert.match(observation.observedAtUtc, /Z$/);
assert.match(observation.kernelCreationUtc, /Z$/);
const verdict = reviewR15Observation(raw);
assert.equal(verdict.status, 'HOLD');
assert.equal(verdict.reason, 'CURRENT_OBJECT_ONLY_NO_ORIGINAL_BINDING');
assert.equal(verdict.canReleaseReservation, false);
assert.equal(verdict.canMutateHost, false);
assert.equal(verdict.nativeReceiptVerified, false);
console.log('R15_WINDOWS_NATIVE_TO_NODE_WIRE_PASS');
