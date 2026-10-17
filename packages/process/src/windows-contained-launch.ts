// MIT License — Copyright (c) 2026 Adisorn (lnwjud project).
// PANYA candidate adapted from pinned lnwjud v5.8.7, commit 1a0453ed0ef1de4cdf9ce1ba9edee8da0de8426b.
// STAGING_SOURCE_ONLY. Not typechecked, built, executed, packaged, or deployed.
// A trusted Host must supply nativeHelper from *packaged* integrity metadata,
// never from untrusted MCP request fields, tools, environment or web content.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SHA256_RE = /^[a-f0-9]{64}$/i;
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HELPER_FILENAME = 'lnwjud-windows-containment-helper.exe';
const MAX_TIMEOUT_MS = 604_800 * 1000; // Preserve existing durable shell maximum (7 days).

export interface TrustedWindowsHelper {
  /** This object MUST be constructed by a trusted Host packaging resolver. */
  readonly executablePath: string;
  /** SHA-256 produced by the official native-helper release build. */
  readonly expectedSha256: string;
  /** Canonical, trusted package-resource parent, not an arbitrary workspace. */
  readonly trustedRoot: string;
}

export interface WindowsContainedLaunch {
  readonly executable: string;
  readonly args: readonly string[];
  readonly receiptPath: string;
  readonly cancelPath: string;
  readonly jobId: string;
  readonly requestDigest: string;
  readonly specSha256: string;
}

export interface WindowsContainmentReceipt {
  readonly kind: 'windows_job_v1';
  readonly outcome: 'completed' | 'cancelled' | 'timed_out';
  readonly exitCode: number;
  readonly activeProcesses: 0;
  readonly jobId: string;
  readonly requestDigest: string;
  readonly specSha256: string;
}

/** Must originate from immutable Host launch metadata, NOT from receipt/spec. */
export interface NativeReceiptExpectation {
  readonly jobId: string;
  readonly requestDigest: string;
  readonly specSha256: string;
}

function isContainedPath(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

async function fileSha256(filename: string): Promise<string> {
  const hash = createHash('sha256');
  const input = createReadStream(filename);
  for await (const chunk of input) hash.update(chunk);
  return hash.digest('hex');
}

async function verifiedPackagedHelper(helper: TrustedWindowsHelper | undefined): Promise<string> {
  if (helper === undefined || !path.isAbsolute(helper.executablePath) ||
      !path.isAbsolute(helper.trustedRoot) || !SHA256_RE.test(helper.expectedSha256)) {
    throw new Error('NATIVE_HELPER_TRUST_NOT_ADMITTED');
  }
  // No wildcard executable names, symlink/junction direct executable or implicit PATH lookup.
  if (path.basename(helper.executablePath).toLowerCase() !== HELPER_FILENAME) {
    throw new Error('NATIVE_HELPER_IDENTITY_MISMATCH');
  }
  const [rootStat, binaryStat] = await Promise.all([
    lstat(helper.trustedRoot), lstat(helper.executablePath),
  ]);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
      !binaryStat.isFile() || binaryStat.isSymbolicLink()) {
    throw new Error('NATIVE_HELPER_PATH_UNTRUSTED');
  }
  const trustedRoot = await realpath(helper.trustedRoot);
  const executable = await realpath(helper.executablePath);
  if (!isContainedPath(trustedRoot, executable)) {
    throw new Error('NATIVE_HELPER_OUTSIDE_PACKAGE');
  }
  if ((await fileSha256(executable)).toLowerCase() !== helper.expectedSha256.toLowerCase()) {
    throw new Error('NATIVE_HELPER_SHA256_MISMATCH');
  }
  return executable;
}

/** Trusted Host preparation ONLY; never a substitute for the existing MCP permission gates. */
export async function prepareWindowsContainedLaunch(input: {
  readonly directory: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly windowsVerbatimArguments?: boolean;
  /** Must be injected through Host packaging; absence fails closed. */
  readonly nativeHelper?: TrustedWindowsHelper;
  /** Optional Host-owned durable task request digest; NEVER a client-supplied approval. */
  readonly requestDigest?: string;
}): Promise<WindowsContainedLaunch> {
  if (process.platform !== 'win32') throw new Error('WINDOWS_CONTAINMENT_UNSUPPORTED');
  if (![input.directory, input.executable, input.cwd].every(value => path.isAbsolute(value))) {
    throw new Error('WINDOWS_CONTAINMENT_ABSOLUTE_PATH_REQUIRED');
  }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > MAX_TIMEOUT_MS ||
      input.args.length > 128 || input.args.some(arg => typeof arg !== 'string' || arg.length > 32768 || arg.includes('\0'))) {
    throw new Error('WINDOWS_CONTAINMENT_INVALID_SPEC');
  }
  const jobId = path.basename(path.normalize(input.directory));
  if (!JOB_ID_RE.test(jobId)) throw new Error('WINDOWS_CONTAINMENT_BAD_JOB_ID');
  // Before allocating a Job directory or a Writer process, resolve only Host-owned
  // fixed release metadata. Missing/untrusted helper is never an uncontained fallback.
  const helperExecutable = await verifiedPackagedHelper(input.nativeHelper);

  const requestDigest = input.requestDigest === undefined
    ? createHash('sha256').update(JSON.stringify([
        'host-generated-launch-binding/v1', jobId, input.executable,
        input.args, input.cwd, input.timeoutMs, input.windowsVerbatimArguments === true,
      ])).digest('hex')
    : input.requestDigest.toLowerCase();
  if (!SHA256_RE.test(requestDigest)) throw new Error('WINDOWS_CONTAINMENT_INVALID_REQUEST_DIGEST');

  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  const jobStat = await lstat(input.directory);
  if (!jobStat.isDirectory() || jobStat.isSymbolicLink()) {
    throw new Error('WINDOWS_CONTAINMENT_JOB_DIRECTORY_UNTRUSTED');
  }

  const specPath = path.join(input.directory, 'containment.json');
  const receiptPath = path.join(input.directory, 'containment.receipt.json');
  const cancelPath = path.join(input.directory, 'containment.cancel');
  const payload = JSON.stringify({
    jobId, requestDigest, executable: input.executable, arguments: [...input.args],
    cwd: input.cwd, timeoutMs: input.timeoutMs,
    windowsVerbatimArguments: input.windowsVerbatimArguments === true,
  });
  const specSha256 = createHash('sha256').update(Buffer.from(payload, 'utf8')).digest('hex');
  // Publish ONLY a new request. Reusing any old directory/file requires a
  // separate owner-approved reconciliation; 'wx' must not be silently relaxed.
  await writeFile(specPath, payload, { flag: 'wx', mode: 0o600 });
  return {
    executable: helperExecutable,
    args: ['--job-dir', input.directory],
    receiptPath, cancelPath, jobId, requestDigest, specSha256,
  };
}

/**
 * Stronger receipt readback for NEW native helper only. The original upstream
 * v1 four-field historical receipts must be reconciled by a separate compatible
 * reader, never modified or retroactively promoted as v2 proof.
 */
export async function readWindowsContainmentReceipt(
  filename: string, expected?: NativeReceiptExpectation,
): Promise<WindowsContainmentReceipt | undefined> {
  try {
    if (expected === undefined || !JOB_ID_RE.test(expected.jobId) ||
        !SHA256_RE.test(expected.requestDigest) || !SHA256_RE.test(expected.specSha256)) return undefined;
    const jobDir = path.dirname(filename);
    const data: unknown = JSON.parse(await readFile(filename, 'utf8'));
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
    const r = data as Record<string, unknown>;
    if (r.kind !== 'windows_job_v1' || r.activeProcesses !== 0 ||
        (r.outcome !== 'completed' && r.outcome !== 'cancelled' && r.outcome !== 'timed_out') ||
        typeof r.exitCode !== 'number' || !Number.isInteger(r.exitCode) ||
        typeof r.jobId !== 'string' || !JOB_ID_RE.test(r.jobId) ||
        r.jobId.toLowerCase() !== path.basename(jobDir).toLowerCase() ||
        typeof r.requestDigest !== 'string' || !SHA256_RE.test(r.requestDigest) ||
        typeof r.specSha256 !== 'string' || !SHA256_RE.test(r.specSha256)) return undefined;
    if (r.jobId.toLowerCase() !== expected.jobId.toLowerCase() ||
        r.requestDigest.toLowerCase() !== expected.requestDigest.toLowerCase() ||
        r.specSha256.toLowerCase() !== expected.specSha256.toLowerCase()) return undefined;
    const [receiptStat, specStat] = await Promise.all([
      lstat(filename), lstat(path.join(jobDir, 'containment.json')),
    ]);
    if (!receiptStat.isFile() || receiptStat.isSymbolicLink() ||
        !specStat.isFile() || specStat.isSymbolicLink()) return undefined;
    const rawSpec = await readFile(path.join(jobDir, 'containment.json'));
    if (createHash('sha256').update(rawSpec).digest('hex') !== r.specSha256.toLowerCase()) return undefined;
    const spec: unknown = JSON.parse(rawSpec.toString('utf8'));
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) return undefined;
    const s = spec as Record<string, unknown>;
    if (s.jobId !== r.jobId || s.requestDigest !== r.requestDigest) return undefined;
    return {
      kind: 'windows_job_v1', activeProcesses: 0,
      outcome: r.outcome, exitCode: r.exitCode,
      jobId: r.jobId, requestDigest: r.requestDigest,
      specSha256: r.specSha256,
    } as WindowsContainmentReceipt;
  } catch {
    // Failed, missing, corrupt or stale receipts remain UNKNOWN: no retry,
    // no writer release, no fabricated terminal state.
    return undefined;
  }
}
