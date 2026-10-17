// MIT License — Copyright (c) 2026 Adisorn (lnwjud project).
// Source-only negative/synthetic contract tests. NOT executed.
// Require explicit Host Build/Execute admission and an isolated, approved
// PANYA_NATIVE_STAGE_TEST_ROOT before running. This file opens NO sockets.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  prepareWindowsContainedLaunch, readWindowsContainmentReceipt,
  type TrustedWindowsHelper,
} from '../packages/process/src/windows-contained-launch.js';

const STAGE_BASENAME = 'PANYA_LNWJUD_NATIVE_LAUNCHER_REPAIR_R1_20261017';
const FIXTURE_EXE = 'lnwjud-windows-containment-helper.exe';
const canUseWindows = process.platform === 'win32';
let fixtureRoot = '';

function sha(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
async function caseFixture() {
  const id = randomUUID();
  const caseRoot = path.join(fixtureRoot, id);
  const helperRoot = path.join(caseRoot, 'trusted-package');
  const jobDir = path.join(caseRoot, randomUUID());
  await mkdir(helperRoot, { recursive: true, mode: 0o700 });
  const helperPath = path.join(helperRoot, FIXTURE_EXE);
  // FAKE hash-test bytes: NOT a runnable PE or trusted signed release.
  const bytes = 'STAGING_FAKE_HELPER_BYTES_ONLY';
  await writeFile(helperPath, bytes, { flag: 'wx' });
  const helper: TrustedWindowsHelper = {
    executablePath: helperPath,
    trustedRoot: helperRoot,
    expectedSha256: sha(bytes),
  };
  const request = {
    directory: jobDir,
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'] as readonly string[],
    cwd: caseRoot,
    timeoutMs: 2000,
    nativeHelper: helper,
  };
  return { caseRoot, jobDir, helperPath, helper, request };
}

describe.skipIf(!canUseWindows)('PANYA Windows Native Launcher — source contract (synthetic only)', () => {
  beforeAll(async () => {
    const root = process.env.PANYA_NATIVE_STAGE_TEST_ROOT;
    if (!root || !path.isAbsolute(root) || path.basename(path.normalize(root)) !== STAGE_BASENAME)
      throw new Error('HOST_APPROVED_STAGE_ROOT_REQUIRED');
    const resolved = await realpath(root);
    if (resolved.toLowerCase() !== path.resolve(root).toLowerCase())
      throw new Error('STAGE_REALPATH_MISMATCH');
    if ((await lstat(root)).isSymbolicLink())
      throw new Error('STAGE_REPARSE_REJECTED');
    fixtureRoot = path.join(root, 'tests', 'fixtures');
    await mkdir(fixtureRoot, { recursive: true, mode: 0o700 });
  });

  it('01 rejects missing Host-owned helper before creating a Job directory', async () => {
    const f = await caseFixture();
    await expect(prepareWindowsContainedLaunch({ ...f.request, nativeHelper: undefined }))
      .rejects.toThrow('NATIVE_HELPER_TRUST_NOT_ADMITTED');
    expect(existsSync(f.jobDir)).toBe(false);
  });
  it('02 rejects tampered helper hash before creating a Job directory', async () => {
    const f = await caseFixture();
    await expect(prepareWindowsContainedLaunch({
      ...f.request, nativeHelper: { ...f.helper, expectedSha256: '1'.repeat(64) },
    })).rejects.toThrow('NATIVE_HELPER_SHA256_MISMATCH');
    expect(existsSync(f.jobDir)).toBe(false);
  });
  it('03 rejects a helper outside its declared package root', async () => {
    const f = await caseFixture();
    const unrelatedRoot = path.join(f.caseRoot, 'unrelated-package');
    await mkdir(unrelatedRoot, { recursive: true, mode: 0o700 });
    await expect(prepareWindowsContainedLaunch({
      ...f.request, nativeHelper: { ...f.helper, trustedRoot: unrelatedRoot },
    })).rejects.toThrow('NATIVE_HELPER_OUTSIDE_PACKAGE');
    // The true package root still must be pinned by Host; a caller able to
    // widen trustedRoot can otherwise defeat a mere pathname check.
  });
  it('04 rejects unrecognized helper executable name', async () => {
    const f = await caseFixture();
    await expect(prepareWindowsContainedLaunch({
      ...f.request,
      nativeHelper: { ...f.helper, executablePath: path.join(f.caseRoot, 'other-helper.exe') },
    })).rejects.toThrow('NATIVE_HELPER_IDENTITY_MISMATCH');
  });
  it('05 stages a single Host-bound JSON spec and no PowerShell script', async () => {
    const f = await caseFixture();
    const out = await prepareWindowsContainedLaunch(f.request);
    expect(out.executable).toBe(f.helperPath);
    expect(out.args).toEqual(['--job-dir', f.jobDir]);
    expect(out.jobId).toBe(path.basename(f.jobDir));
    expect(existsSync(path.join(f.jobDir, 'containment.ps1'))).toBe(false);
    expect(existsSync(path.join(f.jobDir, 'containment.cs'))).toBe(false);
    expect(existsSync(out.receiptPath)).toBe(false);
    const bytes = await readFile(path.join(f.jobDir, 'containment.json'));
    expect(sha(bytes)).toBe(out.specSha256);
    const spec = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    expect(spec.requestDigest).toBe(out.requestDigest);
    expect(spec.jobId).toBe(out.jobId);
  });
  it('06 fails closed on a reused Host Job ID, preserving original spec bytes', async () => {
    const f = await caseFixture();
    const first = await prepareWindowsContainedLaunch(f.request);
    const before = await readFile(path.join(f.jobDir, 'containment.json'));
    await expect(prepareWindowsContainedLaunch(f.request)).rejects.toThrow();
    const after = await readFile(path.join(f.jobDir, 'containment.json'));
    expect(after.equals(before)).toBe(true);
    expect(first.jobId).toBe(path.basename(f.jobDir));
  });
  it('07 rejects non-UUID Job identity', async () => {
    const f = await caseFixture();
    await expect(prepareWindowsContainedLaunch({
      ...f.request, directory: path.join(f.caseRoot, 'user-chosen'),
    })).rejects.toThrow('WINDOWS_CONTAINMENT_BAD_JOB_ID');
  });
  it('08 rejects malformed Host request digest', async () => {
    const f = await caseFixture();
    await expect(prepareWindowsContainedLaunch({ ...f.request, requestDigest: 'fake-token' }))
      .rejects.toThrow('WINDOWS_CONTAINMENT_INVALID_REQUEST_DIGEST');
  });
  it('09 rejects invalid timeout and unsafe arguments', async () => {
    const f = await caseFixture();
    await expect(prepareWindowsContainedLaunch({ ...f.request, timeoutMs: 0 }))
      .rejects.toThrow('WINDOWS_CONTAINMENT_INVALID_SPEC');
    await expect(prepareWindowsContainedLaunch({ ...f.request, args: ['x\0y'] }))
      .rejects.toThrow('WINDOWS_CONTAINMENT_INVALID_SPEC');
  });

  it('10 parses bound synthetic receipt only after spec readback matches', async () => {
    const f = await caseFixture();
    const out = await prepareWindowsContainedLaunch(f.request);
    await writeFile(out.receiptPath, JSON.stringify({
      kind: 'windows_job_v1', outcome: 'completed', exitCode: 0, activeProcesses: 0,
      jobId: out.jobId, requestDigest: out.requestDigest, specSha256: out.specSha256,
    }), { flag: 'wx' });
    const parsed = await readWindowsContainmentReceipt(out.receiptPath, { jobId: out.jobId, requestDigest: out.requestDigest, specSha256: out.specSha256 });
    expect(parsed).toMatchObject({ kind: 'windows_job_v1', jobId: out.jobId, activeProcesses: 0 });
    // This is a synthetic parser fixture and NOT evidence of a real Windows
    // Job Object, descendant cleanup, or Host writer release.
  });
  it('11 rejects an absent receipt instead of assuming the child did not run', async () => {
    const f = await caseFixture();
    const out = await prepareWindowsContainedLaunch(f.request);
    expect(await readWindowsContainmentReceipt(out.receiptPath, { jobId: out.jobId, requestDigest: out.requestDigest, specSha256: out.specSha256 })).toBeUndefined();
  });
  it('12 rejects corrupt, stale, or unbound receipt identity', async () => {
    const f = await caseFixture();
    const out = await prepareWindowsContainedLaunch(f.request);
    await writeFile(out.receiptPath, JSON.stringify({
      kind: 'windows_job_v1', outcome: 'completed', exitCode: 0, activeProcesses: 0,
      jobId: randomUUID(), requestDigest: out.requestDigest, specSha256: out.specSha256,
    }), { flag: 'wx' });
    expect(await readWindowsContainmentReceipt(out.receiptPath, { jobId: out.jobId, requestDigest: out.requestDigest, specSha256: out.specSha256 })).toBeUndefined();
  });
  it('13 rejects a forged zero-active value in a legacy unbound v1 receipt', async () => {
    const f = await caseFixture();
    const out = await prepareWindowsContainedLaunch(f.request);
    await writeFile(out.receiptPath, JSON.stringify({
      kind: 'windows_job_v1', outcome: 'completed', exitCode: 0, activeProcesses: 0,
    }), { flag: 'wx' });
    expect(await readWindowsContainmentReceipt(out.receiptPath)).toBeUndefined();
  });
  it('14 concurrent same-ID staging has at most one successful create-only spec', async () => {
    const f = await caseFixture();
    const results = await Promise.allSettled([
      prepareWindowsContainedLaunch(f.request),
      prepareWindowsContainedLaunch(f.request),
    ]);
    expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect(existsSync(path.join(f.jobDir, 'containment.json'))).toBe(true);
  });
});
