// PANYA HOST UNBLOCK R1 — GitHub Windows runner fixture only.
// MIT. No installed Host, profile, real reservation registry, or protected app is touched.
// This is NOT proof that the existing PANYA-HOME reservations may be cleared.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SqliteWorkspaceWriterLease } from '../packages/capabilities/src/workspace-writer-lease.js';
import { SharedManagedWriterAdmission } from '../packages/capabilities/src/shared-managed-writer-admission.js';
import { DurableShellTaskIndex } from '../packages/capabilities/src/durable-shell-task-index.js';

const BRANCH = 'refs/heads/panya/host-unblock-r1-20261024';
const STAGE = 'PANYA_HOST_UNBLOCK_R1_20261024';
const admitted = process.platform === 'win32'
  && process.env.GITHUB_ACTIONS === 'true'
  && process.env.GITHUB_REPOSITORY === 'VAGOO1/lnwjud'
  && process.env.GITHUB_REF === BRANCH
  && process.env.PANYA_HOST_UNBLOCK_R1_GATE === 'WINDOWS_CI_STAGING_ONLY';
let stageRoot = '';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
async function freshFixture(): Promise<string> {
  const root = path.join(stageRoot, randomUUID());
  await mkdir(root, { recursive: false });
  return root;
}
function writerFixture(root: string) {
  const background = path.join(root, 'background-tasks');
  const gate = new SharedManagedWriterAdmission(background);
  const lease = new SqliteWorkspaceWriterLease(path.join(root, 'writer-leases.sqlite'), Date.now, gate);
  return { background, gate, lease };
}

describe.skipIf(!admitted)('PANYA R1 Writer/Reservation/Recovery isolated Windows contract', () => {
  beforeAll(async () => {
    const runnerTemp = process.env.RUNNER_TEMP;
    const candidate = process.env.PANYA_HOST_UNBLOCK_R1_ROOT;
    if (!runnerTemp || !candidate || !path.isAbsolute(candidate)
      || path.basename(path.normalize(candidate)) !== STAGE
      || path.resolve(candidate).toLowerCase() !== path.join(runnerTemp, STAGE).toLowerCase()) {
      throw new Error('UNAPPROVED_STAGING_PATH');
    }
    const stat = await lstat(candidate);
    const real = await realpath(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || real.toLowerCase() !== path.resolve(candidate).toLowerCase()) {
      throw new Error('STAGING_REPARSE_OR_IDENTITY_MISMATCH');
    }
    stageRoot = candidate;
  });

  it('writer lease: cross-client denial, exact-owner release and readback', async () => {
    const root = await freshFixture();
    const { lease } = writerFixture(root);
    const first = await lease.acquire('r1-writer-a', 'owner-a', 'session-a', 60);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(await lease.inspect('r1-writer-a')).toMatchObject({
      ok: true, value: { state: 'active', generation: 1 },
    });
    expect((await lease.release('r1-writer-a', 'foreign', 'session-b', first.value)).ok).toBe(false);
    expect((await lease.release('r1-writer-a', 'owner-a', 'session-a', first.value)).ok).toBe(true);
    expect(await lease.inspect('r1-writer-a')).toMatchObject({
      ok: true, value: { state: 'unleased', activeCalls: 0 },
    });
  });

  it('writer recovery: expired lease cannot displace an in-flight same-process call', async () => {
    const root = await freshFixture();
    const gate = new SharedManagedWriterAdmission(path.join(root, 'background-tasks'));
    let now = 100_000;
    const lease = new SqliteWorkspaceWriterLease(path.join(root, 'writer-leases.sqlite'), () => now, gate);
    const first = await lease.acquire('r1-writer-expiring', 'owner-a', 'session-a', 30);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const callId = randomUUID();
    expect((await lease.begin('r1-writer-expiring', 'owner-a', 'session-a', callId, first.value)).ok).toBe(true);
    now += 120_000;
    const premature = await lease.acquire('r1-writer-expiring', 'owner-b', 'session-b', 30);
    expect(premature.ok).toBe(false);
    expect(await lease.inspect('r1-writer-expiring')).toMatchObject({
      ok: true, value: { state: 'blocked', activeCalls: 1 },
    });
    await lease.end('r1-writer-expiring', callId, first.value.generation);
    const recovered = await lease.acquire('r1-writer-expiring', 'owner-b', 'session-b', 30);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.value.generation).toBeGreaterThan(first.value.generation);
    expect((await lease.release('r1-writer-expiring', 'owner-b', 'session-b', recovered.value)).ok).toBe(true);
  });

  it('global reservation: unverified native completion persists across index restart', async () => {
    const root = await freshFixture();
    const indexPath = path.join(root, 'background-tasks');
    const receiptPath = path.join(root, 'native', randomUUID(), 'containment.receipt.json');
    const taskId = 'r1-unknown-' + randomUUID();
    const requestDigest = digest(taskId);
    const first = new DurableShellTaskIndex(indexPath, {
      maxConcurrentTasks: 10000,
      inspectTask: async () => 'unknown' as const,
    });
    expect((await first.reserve({
      taskId, requestDigest, mutationKind: 'opaque_contained_process',
      nativeReceiptPath: receiptPath, ownerClientId: 'r1-fixture',
      ownerWorkspaceId: 'r1-fixture-project',
    })).ok).toBe(true);
    const restarted = new DurableShellTaskIndex(indexPath, {
      maxConcurrentTasks: 10000,
      inspectTask: async () => 'unknown' as const,
    });
    const probe = await restarted.reserve({
      taskId: 'r1-unrelated-repo-import', requestDigest: digest('r1-unrelated-repo-import'),
      mutationKind: 'repository_import', ownerClientId: 'other-fixture',
      ownerWorkspaceId: 'other-fixture-project',
    });
    expect(probe.ok).toBe(false);
    const marker = path.join(indexPath, '.index', 'v1', 'active', digest(taskId) + '.json');
    const retained = JSON.parse(await readFile(marker, 'utf8')) as { taskId: string };
    expect(retained.taskId).toBe(taskId);
  });

  it('rollback: restore exact bytes only inside an owned disposable fixture', async () => {
    const root = await freshFixture();
    const file = path.join(root, 'fixture-rule.txt');
    const original = Buffer.from('PANYA_BASELINE_NOT_LIVE', 'utf8');
    await writeFile(file, original, { flag: 'wx' });
    const originalDigest = digest(original.toString('utf8'));
    await writeFile(file, 'STAGING_CANDIDATE_CHANGE');
    expect(digest(await readFile(file, 'utf8'))).not.toBe(originalDigest);
    await writeFile(file, original);
    expect(await readFile(file)).toEqual(original);
    expect(digest(await readFile(file, 'utf8'))).toBe(originalDigest);
  });
});
