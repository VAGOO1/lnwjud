// PANYA P1 staging-only TypeScript contract tests (NOT executed).
// MIT License — Copyright (c) 2026 Adisorn (lnwjud project).
// A Host-approved isolated Test gate is REQUIRED before running this file.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DurableShellTaskIndex } from '../packages/capabilities/src/durable-shell-task-index.js';

const ROOT_BASENAME = 'P1_20261017';
const GATE = 'HOST_ADMITTED_P1_SOURCE_TEST'; // not itself an execution authority
const skip = process.env.PANYA_P1_TEST_GATE !== GATE;
let stageRoot = '';

async function storeFixture() {
  const temp = path.join(stageRoot, 'tests', 'fixtures', randomUUID());
  await mkdir(temp, { recursive: true });
  const index = new DurableShellTaskIndex(temp, {
    maxConcurrentTasks: 10000,
    inspectTask: async () => 'unknown',
  });
  return { root: temp, index };
}
function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
function nativeProof(taskRoot: string) {
  const jobId = randomUUID(), specSha256 = digest('staged-spec:' + jobId);
  const requestDigest = digest('host-task:' + jobId);
  return {
    path: path.join(taskRoot, 'native', jobId, 'containment.receipt.json'),
    expected: { jobId, specSha256, requestDigest },
  };
}
describe.skipIf(skip)('P1 Native writer index binding (source-only test cases)', () => {
  beforeAll(async () => {
    const candidate = process.env.PANYA_NATIVE_STAGE_TEST_ROOT;
    if (!candidate || !path.isAbsolute(candidate) || path.basename(path.normalize(candidate)) !== ROOT_BASENAME)
      throw new Error('HOST_APPROVED_P1_TEST_ROOT_REQUIRED');
    if ((await realpath(candidate)).toLowerCase() !== path.resolve(candidate).toLowerCase()
        || (await lstat(candidate)).isSymbolicLink())
      throw new Error('P1_STAGE_REALPATH_UNVERIFIED');
    stageRoot = candidate;
  });

  it('01 binds exact native expectation to a Host-owned non-UUID durable Task ID', async () => {
    const f = await storeFixture(), taskId = 'billing:subtask-alpha';
    const idDigest = digest(taskId), proof = nativeProof(f.root);
    const reserved = await f.index.reserve({ taskId, requestDigest: idDigest, mutationKind: 'opaque',
      ownerClientId: 'p1-test-client', ownerWorkspaceId: 'p1-isolated' });
    expect(reserved.ok).toBe(true);
    const bound = await f.index.bindNativeReceipt(taskId, idDigest, proof.path, proof.expected);
    expect(bound.ok).toBe(true);
    const marker = path.join(f.root, '.index', 'v1', 'active', digest(taskId) + '.json');
    const data = JSON.parse(await readFile(marker, 'utf8')) as Record<string, unknown>;
    expect(data.nativeReceiptPath).toBe(proof.path);
    expect(data.nativeReceiptExpected).toMatchObject(proof.expected);
  });

  it('02 rejects binding the same native identity twice (no second writer)', async () => {
    const f = await storeFixture(), taskId = 'p1-bind-once', requestDigest = digest(taskId);
    const proof = nativeProof(f.root);
    const reserved = await f.index.reserve({ taskId, requestDigest, mutationKind: 'opaque',
      ownerClientId: 'owned-p1' });
    expect(reserved.ok).toBe(true);
    expect((await f.index.bindNativeReceipt(taskId, requestDigest, proof.path, proof.expected)).ok).toBe(true);
    expect((await f.index.bindNativeReceipt(taskId, requestDigest, proof.path, proof.expected)).ok).toBe(false);
  });

  it('03 refuses an expectation for a different Job ID/path', async () => {
    const f = await storeFixture(), taskId = 'p1-wrong-job', requestDigest = digest(taskId);
    const proof = nativeProof(f.root);
    expect((await f.index.reserve({ taskId, requestDigest, mutationKind: 'opaque',
      ownerClientId: 'owned-p1' })).ok).toBe(true);
    const wrong = { ...proof.expected, jobId: randomUUID() };
    expect((await f.index.bindNativeReceipt(taskId, requestDigest, proof.path, wrong)).ok).toBe(false);
  });

  it('04 keeps an unbound/legacy contained marker on the index and blocks writer import', async () => {
    const f = await storeFixture(), taskId = 'old-legacy-native-marker', requestDigest = digest(taskId);
    const proof = nativeProof(f.root);
    expect((await f.index.reserve({ taskId, requestDigest, mutationKind: 'opaque_contained_process',
      ownerClientId: 'legacy-client', nativeReceiptPath: proof.path })).ok).toBe(true);
    await mkdir(path.dirname(proof.path), { recursive: true });
    await writeFile(proof.path, JSON.stringify({
      kind: 'windows_job_v1', activeProcesses: 0, outcome: 'completed', exitCode: 0,
    }), { flag: 'wx' });
    // A four-field v1 receipt without immutable Host expectation is not proof.
    const admission = await f.index.reserve({ taskId: 'another-import', requestDigest: digest('another-import'),
      ownerClientId: 'new-owner', mutationKind: 'repository_import' });
    expect(admission.ok).toBe(false);
  });

  it('05 rejects mismatching Host reservation digest and does not create a binding', async () => {
    const f = await storeFixture(), taskId = 'p1-digest', requestDigest = digest(taskId);
    const proof = nativeProof(f.root);
    expect((await f.index.reserve({ taskId, requestDigest, mutationKind: 'opaque',
      ownerClientId: 'p1-owner' })).ok).toBe(true);
    expect((await f.index.bindNativeReceipt(taskId, digest('unauthorized'), proof.path, proof.expected)).ok).toBe(false);
  });

  it('06 does not treat unverified native marker as free for repository import', async () => {
    const f = await storeFixture(), taskId = 'p1-still-running', requestDigest = digest(taskId), proof = nativeProof(f.root);
    expect((await f.index.reserve({ taskId, requestDigest, mutationKind: 'opaque_contained_process',
      nativeReceiptPath: proof.path, ownerClientId: 'p1-running' })).ok).toBe(true);
    const result = await f.index.reserve({ taskId: 'incoming-import', requestDigest: digest('incoming-import'),
      mutationKind: 'repository_import', ownerClientId: 'p1-other' });
    expect(result.ok).toBe(false);
  });
});
