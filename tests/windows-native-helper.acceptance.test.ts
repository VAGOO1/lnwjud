// MIT License — Copyright (c) 2026 Adisorn (lnwjud project).
// FUTURE Native acceptance tests. NEVER executed by source creation.
// This suite is SKIPPED unless the ordinary Host authorizes and verifies
// real Process/Job containment, writer ownership and fully isolated Staging.
// Setting environment variables alone IS NOT approval and must never be used
// as a shortcut around the Host's native execution guard.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  prepareWindowsContainedLaunch, readWindowsContainmentReceipt,
  type NativeReceiptExpectation, type TrustedWindowsHelper,
} from '../packages/process/src/windows-contained-launch.js';

const SKIP = process.platform !== 'win32' ||
  process.env.PANYA_NATIVE_HELPER_TEST_GATE !== 'HOST_ADMITTED_NATIVE_EXECUTION';
const STAGE_NAME = 'PANYA_LNWJUD_NATIVE_LAUNCHER_REPAIR_R1_20261017';
const SHA_RE = /^[a-f0-9]{64}$/i;
let testRoot = '';
let trusted: TrustedWindowsHelper;

async function prepare(executable: string, args: string[], timeoutMs: number) {
  const dir = path.join(testRoot, randomUUID());
  const launch = await prepareWindowsContainedLaunch({
    directory: dir, executable, args, cwd: testRoot, timeoutMs, nativeHelper: trusted,
  });
  const expected: NativeReceiptExpectation = {
    jobId: launch.jobId,
    requestDigest: launch.requestDigest,
    specSha256: launch.specSha256,
  };
  return { launch, expected };
}

async function runHelper(
  launch: Awaited<ReturnType<typeof prepareWindowsContainedLaunch>>,
  afterSpawn?: () => Promise<void>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  // Run only through independently authorized Host managed execution.
  // This wrapper is NOT itself an alternative execution authority.
  const child = spawn(launch.executable, [...launch.args], {
    cwd: testRoot, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
  child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (afterSpawn) await afterSpawn();
  return { code: await exit, stdout, stderr };
}

describe.skipIf(SKIP)('Native Windows Job Object (authorized Stage E2E only)', () => {
  beforeAll(async () => {
    const stage = process.env.PANYA_NATIVE_STAGE_TEST_ROOT;
    const sha = process.env.PANYA_NATIVE_RELEASE_SHA256;
    if (!stage || !path.isAbsolute(stage) ||
        path.basename(path.normalize(stage)) !== STAGE_NAME ||
        !sha || !SHA_RE.test(sha)) throw new Error('HOST_STAGE_ADMISSION_REQUIRED');

    // All test fixtures, data, stdout and receipts stay in this Staging.
    testRoot = path.join(stage, 'tests', 'native-run-fixtures');
    await mkdir(testRoot, { recursive: true });
    const binRoot = path.join(stage, 'build', 'win-x64');
    trusted = {
      executablePath: path.join(binRoot, 'lnwjud-windows-containment-helper.exe'),
      trustedRoot: binRoot, expectedSha256: sha,
    };
    if (!existsSync(trusted.executablePath))
      throw new Error('HOST_BUILT_HELPER_NOT_PRESENT');
  });

  it('01 real successful exit: native zero-active receipt + exact Host binding', async () => {
    const { launch, expected } = await prepare(process.execPath, ['-e', 'process.stdout.write("ACCEPTED_NATIVE_TEST")'], 7000);
    const result = await runHelper(launch);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ACCEPTED_NATIVE_TEST');
    expect(await readWindowsContainmentReceipt(launch.receiptPath, expected))
      .toMatchObject({ outcome: 'completed', exitCode: 0, activeProcesses: 0, ...expected });
  }, 18000);

  it('02 failed native child creation: fail-closed, no terminal receipt', async () => {
    const badExe = path.join(testRoot, 'never-existing-unapproved-child.exe');
    const { launch, expected } = await prepare(badExe, [], 3000);
    const result = await runHelper(launch);
    expect(result.code).toBe(125);
    expect(await readWindowsContainmentReceipt(launch.receiptPath, expected)).toBeUndefined();
  }, 15000);

  it('03 native deadline: stop entire Job, zero-active receipt required', async () => {
    const { launch, expected } = await prepare(process.execPath, ['-e', 'setInterval(()=>{},100)'], 400);
    const result = await runHelper(launch);
    expect(result.code).not.toBe(0);
    expect(await readWindowsContainmentReceipt(launch.receiptPath, expected))
      .toMatchObject({ outcome: 'timed_out', activeProcesses: 0, ...expected });
  }, 16000);

  it('04 native cancellation marker: no premature writer release', async () => {
    const { launch, expected } = await prepare(process.execPath, ['-e', 'setInterval(()=>{},100)'], 9000);
    const result = await runHelper(launch, async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      await writeFile(launch.cancelPath, 'cancel', { flag: 'wx' });
    });
    expect(result.code).not.toBe(0);
    expect(await readWindowsContainmentReceipt(launch.receiptPath, expected))
      .toMatchObject({ outcome: 'cancelled', activeProcesses: 0, ...expected });
  }, 18000);

  it('05 detached descendant must remain contained and time out with native zero-active', async () => {
    const childScript = [
      "const {spawn}=require('node:child_process');",
      "spawn(process.execPath,['-e','setInterval(()=>{},100)'],",
      "{detached:true,stdio:'ignore'}).unref();",
    ].join('');
    const { launch, expected } = await prepare(process.execPath, ['-e', childScript], 550);
    const result = await runHelper(launch);
    expect(result.code).not.toBe(0);
    expect(await readWindowsContainmentReceipt(launch.receiptPath, expected))
      .toMatchObject({ outcome: 'timed_out', activeProcesses: 0, ...expected });
  }, 17000);
});
