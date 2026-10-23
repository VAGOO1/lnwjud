// Run only the launch controller's JavaScript with in-memory capability stubs.
// No PowerShell, native fixture, real claim, or child process is started.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { makeNativePlan, validateInputManifest, requiredManifestPaths, nodeRuntime } from '../scripts/run-native-owned-check.mjs';

const source = readFileSync(new URL('../scripts/run-native-owned-check.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function runOnce() {'), end = source.indexOf('\nif (process.argv[1]', start);
assert.ok(start >= 0 && end > start);
const controller = source.slice(start, end);
const sha = 'a'.repeat(64), invocation = '11111111-2222-4333-8444-555555555555';
const complete = () => Object.fromEntries(requiredManifestPaths.map((file) => [file, sha]));
const observations = [];
function simulate(manifest) {
  const counts = { mockClaims: 0, mockSpawns: 0, realClaims: 0, realNativeLaunches: 0 };
  const preflight = { hostRuntime: { executableSha256: sha, configSha256: sha }, nodeSha256: sha };
  const context = { root: 'MEMORY_ONLY', nodeRuntime, path, makeNativePlan, validateInputManifest,
    randomUUID: () => invocation,
    process: { argv: ['node', 'mock-review'], env: { COMPUTERNAME: 'VAGOO' }, exitCode: 0 },
    console: { log() {}, error() {} },
    readFileSync: (file) => JSON.stringify(String(file).endsWith('PREFLIGHT.json') ? preflight : manifest),
    hash: () => sha, openSync: () => { counts.mockClaims++; return 1; }, closeSync() {}, writeFileSync() {},
    spawnSync: () => { counts.mockSpawns++; return { status: 1, stdout: '', stderr: 'MOCK_START_FAILED' }; },
    verifyNativeOutput: () => { throw new Error('UNREACHABLE'); } };
  let error;
  try { vm.runInNewContext(`${controller}\nrunOnce();`, context, { timeout: 1000 }); } catch (e) { error = e.message; }
  return { ...counts, error: error ?? null };
}
for (const [name, manifest] of [
  ['empty manifest', {}],
  ['manifest missing harness', (() => { const value = complete(); delete value['scripts/test-windows-owned-reader.ps1']; return value; })()],
]) test(`R2 rejects ${name} before claim and spawn`, () => {
  const actual = simulate(manifest);
  assert.match(actual.error, /INPUT_MANIFEST_INVALID_OR_INCOMPLETE/);
  assert.equal(actual.mockClaims, 0); assert.equal(actual.mockSpawns, 0);
  observations.push({ case: name, rejectedBeforeClaimAndSpawn: true, ...actual });
});
test('control: complete valid manifest reaches only mocked spawn once', () => {
  const actual = simulate(complete()); assert.equal(actual.error, null);
  assert.equal(actual.mockClaims, 1); assert.equal(actual.mockSpawns, 1); assert.equal(actual.realNativeLaunches, 0);
});
test('R2 hash mismatch remains rejected before claim and spawn', () => {
  const value = complete(); value['scripts/test-windows-owned-reader.ps1'] = 'b'.repeat(64);
  const actual = simulate(value); assert.match(actual.error, /INPUT_CHANGED/);
  assert.equal(actual.mockClaims, 0); assert.equal(actual.mockSpawns, 0);
});
after(() => writeFileSync(path.join(fileURLToPath(new URL('./', import.meta.url)), 'negative-case-results.json'), `${JSON.stringify({
  revision: 'fixture-r2', scope: 'IN_MEMORY_MOCK_ONLY', realNativeLaunches: 0, observations }, null, 2)}\n`));
