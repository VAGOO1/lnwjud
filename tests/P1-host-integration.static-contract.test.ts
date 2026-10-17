// PANYA P1 source-only contract suite. NOT EXECUTED.
// MIT License — Copyright (c) 2026 Adisorn (lnwjud project).
// A separate Host-gated, isolated Test admission is required before running.
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const gate = process.env.PANYA_P1_TEST_GATE === 'HOST_ADMITTED_P1_SOURCE_TEST';
const name = 'P1_20261017';
let root = '';
async function source(filename: string) {
  const candidate = path.join(root, ...filename.split('/'));
  return readFile(candidate, 'utf8');
}
describe.skipIf(!gate)('P1 Host integration source contract — static only', () => {
  beforeAll(async () => {
    const approved = process.env.PANYA_NATIVE_STAGE_TEST_ROOT;
    if (!approved || !path.isAbsolute(approved) ||
        path.basename(path.normalize(approved)) !== name ||
        (await realpath(approved)).toLowerCase() !== path.resolve(approved).toLowerCase() ||
        (await lstat(approved)).isSymbolicLink()) {
      throw new Error('EXPLICIT_HOST_STAGE_ADMISSION_REQUIRED');
    }
    root = approved;
  });

  it('01 Host release identity is unavailable until a verified official build supplies the SHA', async () => {
    const s = await source('packages/process/src/native-helper-release.ts');
    expect(s).toContain('WINDOWS_NATIVE_HELPER_RELEASE_SHA256: string | undefined = undefined');
    expect(s).toContain('return undefined');
    expect(s).not.toContain('ExecutionPolicy Bypass');
  });

  it('02 ProcessManager binds Host receipt identity before process spawn', async () => {
    const s = await source('packages/process/src/process-manager.ts');
    const bind = s.indexOf('await onPreparedNative(contained)');
    const spawn = s.indexOf('const child = spawn(');
    expect(bind).toBeGreaterThan(0);
    expect(spawn).toBeGreaterThan(bind);
    expect(s).toContain('readWindowsContainmentReceipt(record.nativeReceiptPath, record.nativeExpectation)');
  });

  it('03 Secure Writer Admission creates an index-bound native expectation', async () => {
    const s = await source('packages/capabilities/src/shared-managed-writer-admission.ts');
    const index = await source('packages/capabilities/src/durable-shell-task-index.ts');
    expect(s).toContain('this.index.bindNativeReceipt(');
    expect(index).toContain('public async bindNativeReceipt(');
    expect(index).toContain('nativeReceiptExpected');
    expect(index).toContain('readWindowsContainmentReceipt(marker.record.nativeReceiptPath, marker.record.nativeReceiptExpected)');
  });

  it('04 Durable Shell keeps non-UUID Task IDs and creates UUID native Job directories', async () => {
    const s = await source('packages/capabilities/src/durable-shell-task-store.ts');
    expect(s).toContain("path.join(taskDirectory, 'native', randomUUID())");
    expect(s).toContain('requestDigest,');
    expect(s).toContain('this.activeIndex.bindNativeReceipt(');
    expect(s).toContain('current.native_receipt.receiptPath');
    expect(s).toContain('current.native_receipt.expected');
  });

  it('05 Unverified durable worker spawn preserves UNKNOWN and reservation', async () => {
    const s = await source('packages/capabilities/src/durable-shell-task-store.ts');
    expect(s).toContain("workerLaunchAttempted ? 'termination_unverified' : 'failed'");
    expect(s).toContain('!workerOwnsReservation && !workerLaunchAttempted');
    expect(s).toContain('if (confirmed) await releaseReservation()');
  });

  it('06 Desktop and CLI both have source-only helper injection with no staging binary path', async () => {
    const desktop = await source('apps/desktop/src/main/desktop-services.ts');
    const cli = await source('apps/cli/src/runtime/stdio-mcp-runtime.ts');
    const capability = await source('packages/capabilities/src/platform-capability-set.ts');
    for (const s of [desktop, cli]) {
      expect(s).toContain('hostTrustedWindowsHelper(');
      expect(s).toContain('nativeHelper: hostNativeHelper');
      expect(s).not.toContain('PANYA_LNWJUD_NATIVE_LAUNCHER_REPAIR_R1_20261017');
    }
    expect(capability).toContain('new ShellCapabilityBackend(');
    expect(capability).toContain('options.nativeHelper');
  });

  it('07 Native Helper remains create-only and preserves Windows Job cleanup source', async () => {
    const helper = await source('native/windows-containment-helper/Program.cs');
    const job = await source('native/windows-containment-helper/ContainedProcess.cs');
    expect(helper).toContain('FileMode.CreateNew');
    expect(helper).toContain('File.Move(tempPath, receiptPath)');
    expect(helper).toContain('using var job = ContainedProcess.Start(');
    expect(job).toContain('AssignProcessToJobObject');
    expect(job).toContain('CreateSuspended|CreateNoWindow');
    expect(job).toContain('KillOnJobClose');
  });

  it('08 Source-only P1 cannot use Exec Policy bypass or uncontained shell fallback', async () => {
    const launcher = await source('packages/process/src/windows-contained-launch.ts');
    expect(launcher).toContain('NATIVE_HELPER_TRUST_NOT_ADMITTED');
    expect(launcher).not.toContain('powershell.exe');
    expect(launcher).not.toContain('containment.ps1');
    expect(launcher).not.toContain('ExecutionPolicy Bypass');
    const pin = await source('packages/process/src/native-helper-release.ts');
    expect(pin).not.toContain('execFile(');
    expect(pin).not.toContain("spawn(");
  });
});
