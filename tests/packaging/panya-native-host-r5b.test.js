// PANYA R5B CI-only synthetic negative tests. Do not run installed Electron/Native Helper.
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { R5B, verifyR4Input, verifyUnpackedCandidate } from '../../scripts/panya-native-host-r5b.mjs';

const roots = [];
const sha = value => createHash('sha256').update(value).digest('hex');
async function tempRoot() {
  const r = await mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'panya-r5b-contract-'));
  roots.push(r);
  return r;
}
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop(), { recursive: true, force: true });
});
async function makeFixture() {
  const root = await tempRoot();
  const payload = path.join(root, 'r4');
  await mkdir(payload);
  const exe = Buffer.from('MZsynthetic-only-not-an-executable', 'ascii');
  const license = 'MIT License\nCopyright (c) 2026 Adisorn (lnwjud project)\n';
  const expected = {
    ...R5B, helperSha256: sha(exe), licenseSha256: sha(license), minHelperBytes: 2,
  };
  const manifest = {
    schema: 'panya-native-helper-ci-artifact-r4/v1',
    repository: R5B.repo, source_branch: R5B.r4Branch,
    source_commit_sha: R5B.r4Commit, run_id: R5B.r4Run,
    binary_filename: R5B.helperName, binary_sha256: expected.helperSha256,
    license: 'MIT', license_filename: 'LICENSE', license_sha256: expected.licenseSha256,
    permitted_use: 'STAGING_ONLY_NOT_FOR_LIVE_DEPLOY',
    release_signed: false, host_5090_verified: false,
  };
  await writeFile(path.join(payload, R5B.helperName), exe);
  await writeFile(path.join(payload, 'LICENSE'), license);
  const writeManifest = async () => {
    const prov = JSON.stringify(manifest);
    expected.provenanceSha256 = sha(prov);
    await writeFile(path.join(payload, 'provenance.json'), prov);
    await writeFile(path.join(payload, 'SHA256SUMS.txt'), [
      expected.helperSha256 + '  ' + R5B.helperName,
      expected.licenseSha256 + '  LICENSE',
      expected.provenanceSha256 + '  provenance.json',
      '',
    ].join('\n'));
  };
  await writeManifest();
  return { root, payload, expected, manifest, writeManifest, exe };
}
async function makeCandidate(fixture, withPin = true) {
  const unpacked = path.join(fixture.root, 'win-unpacked');
  const resources = path.join(unpacked, 'resources');
  const bundled = path.join(resources, 'windows-containment-helper');
  await mkdir(bundled, { recursive: true });
  await writeFile(path.join(unpacked, 'lnwjud.exe'), Buffer.from('MZsynthetic-host-only'));
  await writeFile(path.join(resources, 'app.asar'),
    Buffer.from('NOT_REAL_ASAR_' + (withPin ? fixture.expected.helperSha256 : 'no-verified-pin')));
  for (const name of ['LICENSE', 'SHA256SUMS.txt', 'provenance.json', R5B.helperName])
    await copyFile(path.join(fixture.payload, name), path.join(bundled, name));
  return { unpacked, bundled };
}

describe('R5B Stage-only payload and unpacked Host Candidate verification', () => {
  it('01 accepts a fully bound synthetic R4 fixture without running any process', async () => {
    const f = await makeFixture();
    const result = await verifyR4Input(f.payload, f.expected);
    expect(result).toMatchObject({ inputFiles: 4, helperSha256: f.expected.helperSha256 });
  });
  it('02 denies missing helper instead of falling back to PATH', async () => {
    const f = await makeFixture();
    await unlink(path.join(f.payload, R5B.helperName));
    await expect(verifyR4Input(f.payload, f.expected)).rejects.toThrow('R5B_INPUT_MEMBERS_NOT_EXACT');
  });
  it('03 denies binary hash tampering', async () => {
    const f = await makeFixture();
    await writeFile(path.join(f.payload, R5B.helperName), 'MZchanged bytes');
    await expect(verifyR4Input(f.payload, f.expected)).rejects.toThrow('R5B_HELPER_SHA_MISMATCH');
  });
  it('04 rejects forged source commit even if manifest hash and checksum were recomputed', async () => {
    const f = await makeFixture();
    f.manifest.source_commit_sha = 'f'.repeat(40);
    await f.writeManifest();
    await expect(verifyR4Input(f.payload, f.expected)).rejects.toThrow('R5B_PROVENANCE_IDENTITY_MISMATCH');
  });
  it('05 rejects falsely signed provenance despite internally consistent hashes', async () => {
    const f = await makeFixture();
    f.manifest.release_signed = true;
    await f.writeManifest();
    await expect(verifyR4Input(f.payload, f.expected)).rejects.toThrow('R5B_PROVENANCE_IDENTITY_MISMATCH');
  });
  it('06 rejects tampered checksum inventory', async () => {
    const f = await makeFixture();
    await writeFile(path.join(f.payload, 'SHA256SUMS.txt'),
      f.expected.helperSha256 + '  ' + R5B.helperName + '\n');
    await expect(verifyR4Input(f.payload, f.expected)).rejects.toThrow('R5B_SUMS_COUNT');
  });
  it('07 rejects extra zip members extracted into the staging payload', async () => {
    const f = await makeFixture();
    await writeFile(path.join(f.payload, 'extra.txt'), 'unexpected');
    await expect(verifyR4Input(f.payload, f.expected)).rejects.toThrow('R5B_INPUT_MEMBERS_NOT_EXACT');
  });
  it('08 accepts a synthetic unpacked Host candidate with the matching pinned SHA', async () => {
    const f = await makeFixture();
    const { unpacked } = await makeCandidate(f);
    const result = await verifyUnpackedCandidate(unpacked, f.expected);
    expect(result).toMatchObject({ packagedPinPresent: true, helperSha256: f.expected.helperSha256 });
  });
  it('09 rejects an unpacked Host whose app.asar lacks its immutable release pin', async () => {
    const f = await makeFixture();
    const { unpacked } = await makeCandidate(f, false);
    await expect(verifyUnpackedCandidate(unpacked, f.expected)).rejects.toThrow('R5B_PACKAGED_ASAR_PIN_MISSING');
  });
  it('10 rejects a mismatched packaged executable even if its input manifest was valid', async () => {
    const f = await makeFixture();
    const { unpacked, bundled } = await makeCandidate(f);
    await writeFile(path.join(bundled, R5B.helperName), 'MZtampered packaged helper');
    await expect(verifyUnpackedCandidate(unpacked, f.expected)).rejects.toThrow('R5B_PACKAGED_HELPER_SHA_MISMATCH');
  });
  it('11 rejects an unpacked candidate with a missing helper', async () => {
    const f = await makeFixture();
    const { unpacked, bundled } = await makeCandidate(f);
    await unlink(path.join(bundled, R5B.helperName));
    await expect(verifyUnpackedCandidate(unpacked, f.expected)).rejects.toThrow();
  });
  it('12 rejects a package where the helper license was replaced', async () => {
    const f = await makeFixture();
    const { unpacked, bundled } = await makeCandidate(f);
    await writeFile(path.join(bundled, 'LICENSE'), 'invalid fake license');
    await expect(verifyUnpackedCandidate(unpacked, f.expected)).rejects.toThrow('R5B_LICENSE_SHA_MISMATCH');
  });
});
