import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appError, err, ok, type InvocationAuthorization } from '@lnwjud/domain';
import type { Workspace, WorkspaceRepository } from '@lnwjud/workspace';
import type { ManagedWriterAdmissionPort } from './writer-admission.js';
import { ArtifactTransferProviderR1, type PinnedArtifact, type TrustedSource } from './artifact-transfer-provider-r1.js';

const dirs: string[] = [];
const AUTH: InvocationAuthorization = {
  mode: 'standard', applicationApproved: true, bypassApplicationAuthorization: false, source: 'host_approval',
};
const actor = { clientId: 'synthetic', clientName: 'CI', sessionId: 'synthetic-session' };
const payload = Buffer.from('PK\x03\x04synthetic-panya-r1');
const sha = (x: Uint8Array) => createHash('sha256').update(x).digest('hex');
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { force: true, recursive: true }))); });

async function fixture() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'panya-r1-'));
  dirs.push(temp);
  const root = await realpath(temp);
  await mkdir(path.join(root, 'staging', 'ci'), { recursive: true });
  const ws: Workspace = { id: 'ci-fixture', displayName: 'CI only',
    rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
  const workspaces: Pick<WorkspaceRepository, 'get'> = { async get(id) { return id === ws.id ? ws : null; } };
  const pinned: PinnedArtifact = { repository: 'VAGOO1/lnwjud',
    runId: 39105715503, commit: '6e88fe45c03cd50d251eaf9a4a7459becfb6a396',
    artifactId: 12128073768, name: 'panya-r5c-win-unpacked-39105715503-1',
    size: payload.length, sha256: sha(payload) };
  let released = 0, started = 0, streams = 0, block = false;
  const writer: ManagedWriterAdmissionPort = { async enter() {
    started++;
    if (block) return err(appError('CONFLICT', 'Synthetic writer collision'));
    return ok({ id: 'ci-lease', async releaseAfterVerifiedTermination() { released++; } });
  } };
  let describe = async () => ({ ...pinned, expired: false });
  let chunks: TrustedSource['chunks'] = async function* () { streams++; yield payload; };
  const source: TrustedSource = { describe: () => describe(), chunks: signal => chunks(signal) };
  const newProvider = () => new ArtifactTransferProviderR1({ workspaces, writer, source, pinned });
  const input = { workspaceId: ws.id, stagingDirectory: 'staging/ci' };
  const file = (ext: string) => path.join(root, 'staging', 'ci', 'artifact-' + pinned.artifactId + '.' + ext);
  return { root, ws, pinned, workspaces, writer, source, newProvider, input, file,
    setMetadata(fn: typeof describe) { describe = fn; },
    setChunks(fn: TrustedSource['chunks']) { chunks = fn; },
    collide() { block = true; },
    tally() { return { started, released, streams }; } };
}
describe('PANYA R1 CI-only guarded artifact streaming', () => {
  it('admits only pinned verified bytes with readback and both receipts', async () => {
    const f = await fixture();
    const r = await f.newProvider().receive(actor, f.input, AUTH);
    expect(r).toMatchObject({ ok: true, value: { verdict: 'VERIFIED_ARTIFACT_SOURCE_ONLY', sha256: sha(payload) } });
    expect(await readFile(f.file('zip'))).toEqual(payload);
    expect(await readFile(f.file('intent.json'), 'utf8')).toContain('PENDING_NO_REPLAY');
    expect(await readFile(f.file('verified.json'), 'utf8')).toContain('VERIFIED_ARTIFACT_SOURCE_ONLY');
    expect(f.tally()).toEqual({ started: 1, released: 1, streams: 1 });
  });
  it('streams 32 MiB in bounded 64 KiB chunks (larger than old web_fetch limit)', async () => {
    const f = await fixture();
    const chunk = Buffer.alloc(64 * 1024, 0x5a), count = 512, hash = createHash('sha256');
    for (let i = 0; i < count; i++) hash.update(chunk);
    const large = { ...f.pinned, size: count * chunk.length, sha256: hash.digest('hex') };
    const source: TrustedSource = { describe: async () => ({ ...large, expired: false }),
      chunks: async function* () { for (let i = 0; i < count; i++) yield chunk; } };
    const r = await new ArtifactTransferProviderR1({
      workspaces: f.workspaces, writer: f.writer, source, pinned: large,
    }).receive(actor, f.input, AUTH);
    expect(r).toMatchObject({ ok: true, value: { bytes: 32 * 1024 * 1024, sha256: large.sha256 } });
    expect((await lstat(f.file('zip'))).size).toBe(32 * 1024 * 1024);
  });
  it('rejects missing host approval before writing or writer admission', async () => {
    const f = await fixture();
    expect(await f.newProvider().receive(actor, f.input)).toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(f.tally().started).toBe(0);
  });
  it('rejects altered commit and expired metadata', async () => {
    const f = await fixture();
    f.setMetadata(async () => ({ ...f.pinned, commit: 'f'.repeat(40), expired: false }));
    expect(await f.newProvider().receive(actor, f.input, AUTH)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    f.setMetadata(async () => ({ ...f.pinned, expired: true }));
    expect(await f.newProvider().receive(actor, f.input, AUTH)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(f.tally().started).toBe(0);
  });
  it('rejects traversal, non-staging, and Windows-device path inputs', async () => {
    const f = await fixture();
    for (const p of ['../escape', 'logs/sneak', 'staging/../live', 'staging\\ci', 'staging/CON', 'staging/ci/.git']) {
      expect(await f.newProvider().receive(actor, { ...f.input, stagingDirectory: p }, AUTH))
        .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    }
    expect(f.tally().started).toBe(0);
  });
  it('rejects writer collision before network or file writes', async () => {
    const f = await fixture(); f.collide();
    expect(await f.newProvider().receive(actor, f.input, AUTH))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(f.tally()).toEqual({ started: 1, released: 0, streams: 0 });
  });
  it('never replays when an intent receipt is present', async () => {
    const f = await fixture();
    await writeFile(f.file('intent.json'), 'existing', { flag: 'wx' });
    expect(await f.newProvider().receive(actor, f.input, AUTH))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await readFile(f.file('intent.json'), 'utf8')).toBe('existing');
    expect(f.tally().streams).toBe(0);
  });
  it('detects hash mismatch and preserves partial evidence without publishing', async () => {
    const f = await fixture();
    f.setChunks(async function* () { yield Buffer.from('PK\x03\x04invalid-artifact!'); });
    expect(await f.newProvider().receive(actor, f.input, AUTH))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await lstat(f.file('zip')).catch(() => null)).toBeNull();
    expect(await readFile(f.file('stop-safe.json'), 'utf8')).toContain('STOP_SAFE_NO_REPLAY');
  });
  it('stops at the pinned byte limit', async () => {
    const f = await fixture();
    f.setChunks(async function* () { yield payload; yield Buffer.from('extra'); });
    expect(await f.newProvider().receive(actor, f.input, AUTH))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await lstat(f.file('zip')).catch(() => null)).toBeNull();
  });
  it('records network interruption and refuses a second transfer', async () => {
    const f = await fixture();
    let networkStreamStarts = 0;
    f.setChunks(async function* () {
      networkStreamStarts += 1;
      yield payload.subarray(0, 6);
      throw new Error('CI synthetic network drop');
    });
    expect(await f.newProvider().receive(actor, f.input, AUTH))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await f.newProvider().receive(actor, f.input, AUTH))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(networkStreamStarts).toBe(1);
    expect(await readFile(f.file('stop-safe.json'), 'utf8')).toContain('STOP_SAFE_NO_REPLAY');
  });
  it('stops on cancellation and does not publish a ZIP', async () => {
    const f = await fixture();
    const ac = new AbortController();
    f.setChunks(async function* () { yield payload.subarray(0, 4); ac.abort(); yield payload.subarray(4); });
    expect(await f.newProvider().receive(actor, f.input, AUTH, ac.signal))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await lstat(f.file('zip')).catch(() => null)).toBeNull();
  });
  it('does not overwrite an existing ZIP or run source stream', async () => {
    const f = await fixture();
    await writeFile(f.file('zip'), 'existing', 'utf8');
    expect(await f.newProvider().receive(actor, f.input, AUTH))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await readFile(f.file('zip'), 'utf8')).toBe('existing');
    expect(f.tally().streams).toBe(0);
  });
  it('rejects symlink staging directories on POSIX CI', async () => {
    if (process.platform === 'win32') return;
    const f = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'panya-outside-')); dirs.push(outside);
    await symlink(outside, path.join(f.root, 'staging', 'alias'));
    expect(await f.newProvider().receive(actor, { ...f.input, stagingDirectory: 'staging/alias' }, AUTH))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(f.tally().started).toBe(0);
  });
});
