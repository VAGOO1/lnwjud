// Windows GitHub CI ONLY: no Host, Production or real artifact transfer.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { ok, type InvocationAuthorization } from '@lnwjud/domain';
import type { Workspace, WorkspaceRepository } from '@lnwjud/workspace';
import type { ManagedWriterAdmissionPort } from './writer-admission.js';
import { ArtifactTransferProviderR1, type PinnedArtifact, type TrustedSource, type WindowsStageSealPort } from './artifact-transfer-provider-r1.js';
import { windowsRepositoryImportAnchorSource } from '../../capabilities/src/windows-repository-import-anchor.js';

const temporary: string[] = [];
const ACTOR = { clientId: 'windows-ci', clientName: 'Synthetic Windows CI', sessionId: 'windows-ci-session' };
const AUTH: InvocationAuthorization = {
  mode: 'standard', applicationApproved: true, bypassApplicationAuthorization: false, source: 'host_approval',
};
const PAYLOAD = Buffer.from('PK\x03\x04panya-windows-native-stage-seal-synthetic');
// The *existing* RepositoryImportAnchor holds the staging PARENT in its constructor
// and the staging DIRECTORY via PrepareStage(), returning its real NTFS File ID.
// No duplicate native P/Invoke implementation is introduced here.
const HOLD_SCRIPT = [
  'param([string]$Root,[string]$Workspace,[string]$Relative,[string]$Stage,[string]$Ready,[string]$Stop)',
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -Path (Join-Path $Root 'anchor.cs') -ErrorAction Stop",
  '$anchor = $null',
  'try {',
  ' $anchor = [RepositoryImportAnchor]::new($Workspace,$Relative)',
  ' $identity = $anchor.PrepareStage($Stage)',
  " if ($identity -notmatch '^[0-9A-F]{16}-[0-9A-F]{32}$') { throw 'NATIVE_IDENTITY_UNVERIFIED' }",
  ' [System.IO.File]::WriteAllText($Ready,$identity)',
  ' $clock = [System.Diagnostics.Stopwatch]::StartNew()',
  ' while (-not [System.IO.File]::Exists($Stop)) {',
  "  if ($clock.Elapsed.TotalSeconds -gt 55) { throw 'NATIVE_HOLD_TIMED_OUT' }",
  '  Start-Sleep -Milliseconds 35',
  ' }',
  '} finally {',
  ' if ($null -ne $anchor) { $anchor.Dispose() }',
  '}',
].join('\n');

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'panya-windows-seal-'));
  temporary.push(temp);
  const workspaceRoot = path.join(temp, 'workspace');
  const stage = path.join(workspaceRoot, 'staging', 'ci');
  const outside = path.join(temp, 'outside');
  await mkdir(stage, { recursive: true });
  await mkdir(outside);
  const marker = path.join(outside, 'untouched.txt');
  await writeFile(marker, 'do-not-mutate-outside');
  await writeFile(path.join(temp, 'anchor.cs'), windowsRepositoryImportAnchorSource);
  await writeFile(path.join(temp, 'hold.ps1'), HOLD_SCRIPT);
  const root = await realpath(workspaceRoot);
  const ws: Workspace = { id: 'windows-ci-workspace', displayName: 'CI NTFS sandbox',
    rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
  const workspaces: Pick<WorkspaceRepository, 'get'> = { async get(id) { return id === ws.id ? ws : null; } };
  const pin: PinnedArtifact = {
    repository: 'VAGOO1/lnwjud', runId: 39105715503,
    commit: '6e88fe45c03cd50d251eaf9a4a7459becfb6a396',
    artifactId: 12128073768, name: 'panya-r5c-win-unpacked-39105715503-1',
    size: PAYLOAD.length, sha256: createHash('sha256').update(PAYLOAD).digest('hex'),
  };
  let streams = 0;
  const source: TrustedSource = {
    async describe() { return { ...pin, expired: false }; },
    async *chunks() { streams++; yield PAYLOAD; },
  };
  const writer: ManagedWriterAdmissionPort = {
    async enter() { return ok({ id: 'synthetic-writer-only',
      async releaseAfterVerifiedTermination() {} }); },
  };
  const input = { workspaceId: ws.id, stagingDirectory: 'staging/ci' };
  return { temp, root, stage, outside, marker, ws, workspaces, writer, pin, source, input,
    streams: () => streams,
    final: path.join(stage, 'artifact-' + pin.artifactId + '.zip'),
    intent: path.join(stage, 'artifact-' + pin.artifactId + '.intent.json'),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function holdNativeStage(f: Fixture, relativeStage: string) {
  const ready = path.join(f.temp, 'ready-' + randomUUID() + '.txt');
  const stop = path.join(f.temp, 'stop-' + randomUUID() + '.txt');
  const runner = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-File', path.join(f.temp, 'hold.ps1'),
    f.temp, f.root, relativeStage, path.join(f.root, ...relativeStage.split('/')), ready, stop,
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  runner.stderr?.on('data', (data: Buffer) => { stderr = (stderr + data.toString('utf8')).slice(-3500); });
  let identity = '';
  for (let i = 0; i < 400; i++) {
    try { identity = (await readFile(ready, 'utf8')).trim(); } catch { /* Still compiling native anchor. */ }
    if (identity) break;
    if (runner.exitCode !== null) break;
    await delay(40);
  }
  if (!/^[0-9A-F]{16}-[0-9A-F]{32}$/.test(identity) || runner.exitCode !== null) {
    runner.kill();
    throw new Error('WINDOWS_NATIVE_ANCHOR_NOT_ADMITTED ' + stderr);
  }
  return {
    nativeDirectoryIdentity: identity,
    async verify() { return runner.exitCode === null && (await readFile(ready, 'utf8')).trim() === identity; },
    async release() {
      if (runner.exitCode !== null) throw new Error('NATIVE_ANCHOR_EXITED_EARLY');
      const closed = new Promise<void>((resolve, reject) => {
        runner.once('exit', code => code === 0 ? resolve() : reject(new Error('ANCHOR_EXIT_NONZERO ' + stderr)));
        runner.once('error', reject);
      });
      await writeFile(stop, 'release', { flag: 'wx' });
      await Promise.race([closed, new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('ANCHOR_RELEASE_TIMEOUT')), 6_000).unref();
      })]);
    },
  };
}
async function mustRejectRename(stage: string, alternate: string) {
  let refused = false;
  try { await rename(stage, alternate); }
  catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error;
    refused = true;
  }
  expect(refused).toBe(true);
}

describe.runIf(process.platform === 'win32')('PANYA Windows NTFS real reparse/swap seal (no Windows skip)', () => {
  it('native anchor rejects an actual junction into an outside directory', async () => {
    const f = await fixture();
    await symlink(f.outside, path.join(f.root, 'staging', 'redirect'), 'junction');
    await expect(holdNativeStage(f, 'staging/redirect')).rejects.toThrow(/IMPORT_REPARSE_OR_INVALID_DIRECTORY|IMPORT_ANCHOR_REFUSED_/);
    expect(await readFile(f.marker, 'utf8')).toBe('do-not-mutate-outside');
    expect(await lstat(f.final).catch(() => null)).toBeNull();
  }, 35_000);

  it('anchors actual NTFS handles while provider receives bytes and refuses three directory swaps', async () => {
    const f = await fixture();
    let starts = 0;
    const moved = path.join(f.root, 'staging', 'ci-moved');
    const source: TrustedSource = {
      async describe() { return { ...f.pin, expired: false }; },
      async *chunks() {
        starts++;
        await mustRejectRename(f.stage, moved); // Before first bytes.
        yield PAYLOAD.subarray(0, 6);
        await mustRejectRename(f.stage, moved); // During partial file.
        yield PAYLOAD.subarray(6);
        await mustRejectRename(f.stage, moved); // After bytes, before publication.
      },
    };
    const windowsStageSeal: WindowsStageSealPort = {
      async acquire(input) {
        expect(input.workspaceRoot).toBe(f.root);
        expect(input.relativeStage).toBe('staging/ci');
        return holdNativeStage(f, input.relativeStage);
      },
    };
    const result = await new ArtifactTransferProviderR1({
      workspaces: f.workspaces, writer: f.writer, source, pinned: f.pin, windowsStageSeal,
    }).receive(ACTOR, f.input, AUTH);
    expect(result).toMatchObject({ ok: true, value: { verdict: 'VERIFIED_ARTIFACT_SOURCE_ONLY' } });
    expect(starts).toBe(1);
    expect(await readFile(f.final)).toEqual(PAYLOAD);
    expect(await readFile(f.marker, 'utf8')).toBe('do-not-mutate-outside');
  }, 40_000);

  it('rejects a junction swapped in after preflight but before native acquisition', async () => {
    const f = await fixture();
    const moved = path.join(f.root, 'staging', 'ci-original');
    const windowsStageSeal: WindowsStageSealPort = {
      async acquire(input) {
        await rename(f.stage, moved);
        await symlink(f.outside, f.stage, 'junction');
        return holdNativeStage(f, input.relativeStage);
      },
    };
    const result = await new ArtifactTransferProviderR1({
      workspaces: f.workspaces, writer: f.writer, source: f.source,
      pinned: f.pin, windowsStageSeal,
    }).receive(ACTOR, f.input, AUTH);
    expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(f.streams()).toBe(0);
    expect(await lstat(f.intent).catch(() => null)).toBeNull();
    expect(await readFile(f.marker, 'utf8')).toBe('do-not-mutate-outside');
  }, 35_000);

  it('fails closed before writer or network if the native Windows seal is absent', async () => {
    const f = await fixture();
    const result = await new ArtifactTransferProviderR1({
      workspaces: f.workspaces, writer: f.writer, source: f.source, pinned: f.pin,
    }).receive(ACTOR, f.input, AUTH);
    expect(result).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(f.streams()).toBe(0);
    expect(await lstat(f.intent).catch(() => null)).toBeNull();
  });
});
