// PANYA R5B: CI-only verifier. Never executes candidate processes or touches host policy.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath, readdir, readFile, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const R5B = Object.freeze({
  repo: 'VAGOO1/lnwjud',
  r4Branch: 'panya/native-runner-r4-20261018',
  r4Commit: '98fee9ccb6a6c93c6c7e8edf7f11c7770eebd5f2',
  r4Run: '39091191154',
  r4ArtifactId: '12122657241',
  r4ZipSha256: '8429233d1de90b80d44ad3ae87dd1810d4c7c67ba221ae062887acc4d67f47ec',
  helperSha256: 'c07f4c28c0d2e409c8b1d01c8368ab8d1b713e76250dea9a059337e3d083557d',
  licenseSha256: 'a9f9c262154ae8eed956d11f42054658080c35688f53d7bfb65b557024a6ebc6',
  provenanceSha256: '0271e4e13c23ed806d43675f8269dd2442e897c9ed0dc6b632eee08d23f46639',
  helperName: 'lnwjud-windows-containment-helper.exe',
  sourcePin: 'packages/process/src/native-helper-release.ts',
  minHelperBytes: 1024,
});
const FILES = Object.freeze(['LICENSE', 'SHA256SUMS.txt', 'provenance.json', R5B.helperName].sort());
const SHA_RE = /^[0-9a-f]{64}$/i;
function need(ok, what) { if (!ok) throw new Error('R5B_' + what); }
function canon(p) { const v = path.normalize(p); return process.platform === 'win32' ? v.toLowerCase() : v; }
async function safeDir(dir) {
  need(path.isAbsolute(dir), 'RELATIVE_ROOT');
  const item = await lstat(dir);
  need(item.isDirectory() && !item.isSymbolicLink(), 'ROOT_NOT_DIRECTORY');
  need(canon(await realpath(dir)) === canon(path.resolve(dir)), 'ROOT_REALPATH');
  return path.resolve(dir);
}
async function safeFile(root, relative) {
  need(path.basename(relative) === relative && relative !== '.' && relative !== '..', 'UNSAFE_FILE_NAME');
  const full = path.join(root, relative);
  const stat = await lstat(full);
  need(stat.isFile() && !stat.isSymbolicLink(), 'UNSAFE_FILE_TYPE');
  need(canon(await realpath(full)) === canon(full), 'FILE_REALPATH');
  return { full, stat };
}
export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function checkPe(file) {
  const handle = await open(file, 'r');
  try {
    const b = Buffer.alloc(2);
    const read = await handle.read(b, 0, 2, 0);
    need(read.bytesRead === 2 && b.toString('ascii') === 'MZ', 'NOT_WINDOWS_PE');
  } finally { await handle.close(); }
}
export async function verifyR4Input(directory, expected = R5B) {
  const root = await safeDir(directory);
  const names = (await readdir(root)).sort();
  need(JSON.stringify(names) === JSON.stringify(FILES), 'INPUT_MEMBERS_NOT_EXACT');
  for (const name of FILES) await safeFile(root, name);
  for (const field of ['helperSha256', 'licenseSha256', 'provenanceSha256'])
    need(typeof expected[field] === 'string' && SHA_RE.test(expected[field]), 'EXPECTED_SHA_INVALID');
  const helper = path.join(root, R5B.helperName);
  need((await lstat(helper)).size >= (expected.minHelperBytes || 1), 'HELPER_TOO_SMALL');
  await checkPe(helper);
  const h = await hashFile(helper);
  const licenseSha = await hashFile(path.join(root, 'LICENSE'));
  const provenanceSha = await hashFile(path.join(root, 'provenance.json'));
  need(h === expected.helperSha256, 'HELPER_SHA_MISMATCH');
  need(licenseSha === expected.licenseSha256, 'LICENSE_SHA_MISMATCH');
  need(provenanceSha === expected.provenanceSha256, 'PROVENANCE_SHA_MISMATCH');
  const license = await readFile(path.join(root, 'LICENSE'), 'utf8');
  need(license.includes('MIT License') && license.includes('Copyright'), 'LICENSE_NOTICE_INVALID');
  const sums = (await readFile(path.join(root, 'SHA256SUMS.txt'), 'utf8')).trim().split(/\r?\n/);
  need(sums.length === 3, 'SUMS_COUNT');
  const seen = new Map();
  for (const row of sums) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/i.exec(row);
    need(match !== null && !seen.has(match[2]), 'SUMS_INVALID');
    seen.set(match[2], match[1].toLowerCase());
  }
  need(seen.size === 3 && seen.get(R5B.helperName) === h &&
    seen.get('LICENSE') === licenseSha && seen.get('provenance.json') === provenanceSha, 'SUMS_HASH_MISMATCH');
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(root, 'provenance.json'), 'utf8')); }
  catch { throw new Error('R5B_PROVENANCE_NOT_JSON'); }
  need(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'PROVENANCE_INVALID');
  need(manifest.schema === 'panya-native-helper-ci-artifact-r4/v1' &&
    manifest.repository === expected.repo && manifest.source_branch === expected.r4Branch &&
    manifest.source_commit_sha === expected.r4Commit && String(manifest.run_id) === expected.r4Run &&
    manifest.binary_filename === R5B.helperName && manifest.binary_sha256 === h &&
    manifest.license === 'MIT' && manifest.license_filename === 'LICENSE' &&
    manifest.license_sha256 === licenseSha &&
    manifest.permitted_use === 'STAGING_ONLY_NOT_FOR_LIVE_DEPLOY' &&
    manifest.release_signed === false && manifest.host_5090_verified === false,
    'PROVENANCE_IDENTITY_MISMATCH');
  return { inputFiles: FILES.length, helperSha256: h, licenseSha256: licenseSha,
    provenanceSha256: provenanceSha, r4SourceCommit: manifest.source_commit_sha,
    r4Run: String(manifest.run_id), sourceScope: manifest.permitted_use };
}
export async function verifyUnpackedCandidate(directory, expected = R5B) {
  const root = await safeDir(directory);
  need(SHA_RE.test(expected.helperSha256), 'EXPECTED_PACKAGED_SHA_INVALID');
  const resources = await safeDir(path.join(root, 'resources'));
  const nativeRoot = await safeDir(path.join(resources, 'windows-containment-helper'));
  const exe = (await safeFile(root, 'lnwjud.exe')).full;
  const asar = (await safeFile(resources, 'app.asar')).full;
  const helper = (await safeFile(nativeRoot, R5B.helperName)).full;
  await checkPe(exe);
  await checkPe(helper);
  const actual = await hashFile(helper);
  need(actual === expected.helperSha256, 'PACKAGED_HELPER_SHA_MISMATCH');
  const contents = await readFile(asar);
  need(contents.includes(Buffer.from(expected.helperSha256, 'ascii')), 'PACKAGED_ASAR_PIN_MISSING');
  const payload = await verifyR4Input(nativeRoot, expected);
  return { hostExeSha256: await hashFile(exe), asarSha256: await hashFile(asar),
    helperSha256: actual, packagedPinPresent: true, packagedR4Input: payload,
    stage: 'GITHUB_WINDOWS_UNPACKED_ONLY' };
}
function requireCi() {
  need(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'Windows' &&
    process.env.GITHUB_REPOSITORY === R5B.repo &&
    process.env.GITHUB_REF === 'refs/heads/panya/native-host-candidate-r5d-20261018' &&
    /^[a-f0-9]{40}$/i.test(process.env.GITHUB_SHA || ''), 'NOT_APPROVED_CI_CONTEXT');
}
async function main(args) {
  requireCi();
  const [mode, dir, evidenceDir] = args;
  need((mode === 'verify-input' && args.length === 2) ||
    (mode === 'verify-package' && args.length === 3), 'INVALID_CLI_ARGS');
  if (mode === 'verify-input') {
    const v = await verifyR4Input(path.resolve(dir));
    process.stdout.write('R5B_TRUSTED_INPUT=' + JSON.stringify(v) + '\n');
    return;
  }
  const candidate = await verifyUnpackedCandidate(path.resolve(dir));
  const parent = await safeDir(path.resolve(evidenceDir));
  const evidence = {
    schema: 'panya-r5b-unpacked-verification/v1',
    repository: R5B.repo, commit: process.env.GITHUB_SHA,
    sourceR4Commit: R5B.r4Commit, sourceR4Run: R5B.r4Run,
    sourceArtifactId: R5B.r4ArtifactId, sourceZipSha256: R5B.r4ZipSha256,
    githubRunId: process.env.GITHUB_RUN_ID, githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
    verdict: 'CI_UNPACKED_PACKAGED_VERIFIED_ONLY',
    host5090Admission: false, liveDeploy: false, releaseSigned: false,
    candidate,
  };
  const dest = path.join(parent, 'PANYA_R5B_PACKAGE_EVIDENCE.json');
  await writeFile(dest, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  const readback = JSON.parse(await readFile(dest, 'utf8'));
  need(JSON.stringify(readback) === JSON.stringify(evidence), 'EVIDENCE_READBACK_MISMATCH');
  process.stdout.write('R5B_PACKAGED_EVIDENCE=' + JSON.stringify({
    helperSha256: candidate.helperSha256, pinPresent: candidate.packagedPinPresent,
    asarSha256: candidate.asarSha256, evidence: dest }) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { process.stderr.write(String(e.message || e) + '\n'); process.exitCode = 1; });
}
