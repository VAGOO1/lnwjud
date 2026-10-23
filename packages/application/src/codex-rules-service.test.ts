import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexRulesService } from './codex-rules-service.js';

const roots: string[] = [];
const approved = { applicationApproved: true, source: 'host_approval', mode: 'standard', bypassApplicationAuthorization: false } as const;

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('CodexRulesService', () => {
  async function fixture(extra: ConstructorParameters<typeof CodexRulesService>[0] = {}): Promise<{ root: string; home: string; backups: string; file: string; service: CodexRulesService; apply: (owner?: string, source?: string, hash?: string, signal?: AbortSignal) => ReturnType<CodexRulesService['backupApply']>; snapshot: import('./codex-rules-service.js').CodexRulesSnapshot }> {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-rules-'))); roots.push(root);
    const home = path.join(root, '.codex'), backups = path.join(root, 'data'), file = path.join(home, 'AGENTS.md');
    await mkdir(home); await writeFile(file, 'old');
    const service = new CodexRulesService({ codexHomeProvider: (): string => home, backupRootProvider: (): string => backups, hostIdentityProvider: (): string => 'owner@host', ...extra });
    const inspected = await service.inspect('client:session', 'global', approved);
    if (!inspected.ok) throw Error(inspected.error.message);
    const apply = (owner = 'client:session', source = 'new', hash = createHash('sha256').update(source).digest('hex'), signal?: AbortSignal): ReturnType<CodexRulesService['backupApply']> =>
      service.backupApply(owner, inspected.value.snapshotId, inspected.value.oldSha256, Buffer.from(source), hash, approved, signal);
    return { root, home, backups, file, service, apply, snapshot: inspected.value };
  }

  it('refuses a different caller/session without consuming the legitimate owner snapshot', async () => {
    const f = await fixture();
    expect(await f.apply('client:another-session')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(await readFile(f.file, 'utf8')).toBe('old');
    expect(await f.apply()).toMatchObject({ ok: true });
  });
  it('refuses a source whose bytes differ from the approved hash', async () => {
    const f = await fixture();
    expect(await f.apply('client:session', 'new', 'a'.repeat(64))).toMatchObject({ ok: false });
    expect(await readFile(f.file, 'utf8')).toBe('old');
  });
  it('refuses a target changed after inspect', async () => {
    const f = await fixture(); await writeFile(f.file, 'another writer');
    expect(await f.apply()).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await readFile(f.file, 'utf8')).toBe('another writer');
  });
  it('refuses an override introduced after inspection', async () => {
    const f = await fixture(); await writeFile(path.join(f.home, 'AGENTS.override.md'), 'override');
    expect(await f.apply()).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await readFile(f.file, 'utf8')).toBe('old');
  });
  it('refuses a host identity changed after inspect', async () => {
    let identity = 'first'; const f = await fixture({ hostIdentityProvider: () => identity }); identity = 'second';
    expect(await f.apply()).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await readFile(f.file, 'utf8')).toBe('old');
  });
  it('keeps the target unchanged when cancelled after backup preparation', async () => {
    const controller = new AbortController();
    const f = await fixture({ beforeCommit: async () => { controller.abort(); } });
    expect(await f.apply('client:session', 'new', createHash('sha256').update('new').digest('hex'), controller.signal)).toMatchObject({ ok: false });
    expect(await readFile(f.file, 'utf8')).toBe('old');
    expect((await readdir(f.backups)).some(name => name.endsWith('.bak'))).toBe(true);
  });
  it('does not overwrite another writer during backup preparation', async () => {
    let file = ''; const f = await fixture({ beforeCommit: async () => { await writeFile(file, 'concurrent'); } }); file = f.file;
    expect(await f.apply()).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await readFile(f.file, 'utf8')).toBe('concurrent');
  });
  it('refuses corrupted backup bytes and a changed current target on rollback', async () => {
    const f = await fixture(); const applied = await f.apply(); if (!applied.ok) throw Error('apply failed');
    await writeFile(path.join(f.backups, applied.value.backupId + '.bak'), 'corrupted');
    expect(await f.service.rollback('client:session', applied.value.backupId, applied.value.newSha256, approved)).toMatchObject({ ok: false });
    expect(await readFile(f.file, 'utf8')).toBe('new');
    await writeFile(f.file, 'concurrent');
    expect(await f.service.rollback('client:session', applied.value.backupId, applied.value.newSha256, approved)).toMatchObject({ ok: false });
    expect(await readFile(f.file, 'utf8')).toBe('concurrent');
  });
  it('refuses directory targets and ancestor junctions', async () => {
    const f = await fixture(); await unlink(f.file); await mkdir(f.file);
    expect(await f.service.inspect('client:session', 'global', approved)).toMatchObject({ ok: false });
    const real = path.join(f.root, 'real'), link = path.join(f.root, 'link');
    await mkdir(real); await mkdir(path.join(real, '.codex')); await writeFile(path.join(real, '.codex', 'AGENTS.md'), 'private');
    await symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    const linked = new CodexRulesService({ codexHomeProvider: (): string => path.join(link, '.codex') });
    expect(await linked.inspect('client:session', 'global', approved)).toMatchObject({ ok: false });
  });
  it('consumes an approved inspection once, applies with CAS, and rolls back from a durable receipt', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-rules-'))); roots.push(root);
    const home = path.join(root, '.codex'), backups = path.join(root, 'data'); await mkdir(home);
    await writeFile(path.join(home, 'AGENTS.md'), 'old');
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const service = new CodexRulesService({ codexHomeProvider: (): string => home, backupRootProvider: (): string => backups, hostIdentityProvider: (): string => 'owner@host', idFactory: (): string => ids.shift()! });
    const inspected = await service.inspect('client:', 'global', approved);
    expect(inspected).toMatchObject({ ok: true, value: { byteLength: 3 } });
    if (!inspected.ok) throw new Error('inspection failed');
    const actual = createHash('sha256').update('new').digest('hex');
    const receipt = await service.backupApply('client:', inspected.value.snapshotId, inspected.value.oldSha256, Buffer.from('new'), actual, approved);
    expect(receipt).toMatchObject({ ok: true, value: { oldSha256: inspected.value.oldSha256, newSha256: actual } });
    if (!receipt.ok) throw new Error('apply failed');
    await expect(service.backupApply('client:', inspected.value.snapshotId, inspected.value.oldSha256, Buffer.from('new'), actual, approved)).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(await readFile(path.join(home, 'AGENTS.md'), 'utf8')).toBe('new');
    await expect(service.rollback('other:', receipt.value.backupId, actual, approved)).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    await expect(service.rollback('client:', receipt.value.backupId, actual, approved)).resolves.toMatchObject({ ok: true, value: { restoredSha256: inspected.value.oldSha256 } });
    expect(await readFile(path.join(home, 'AGENTS.md'), 'utf8')).toBe('old');
  });

  it('rejects Full Bypass and expires inspection snapshots without a write', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-rules-'))); roots.push(root);
    const home = path.join(root, '.codex'); await mkdir(home); await writeFile(path.join(home, 'AGENTS.md'), 'old');
    let now = 0; const service = new CodexRulesService({ codexHomeProvider: (): string => home, now: (): Date => new Date(now), idFactory: (): string => '33333333-3333-4333-8333-333333333333' });
    const bypass = { ...approved, source: 'full_bypass' as const, mode: 'full_bypass' as const, bypassApplicationAuthorization: true };
    await expect(service.inspect('client:', 'global', bypass)).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    const inspected = await service.inspect('client:', 'global', approved); if (!inspected.ok) throw new Error('inspection failed');
    now = 120_001;
    await expect(service.backupApply('client:', inspected.value.snapshotId, inspected.value.oldSha256, Buffer.from('new'), createHash('sha256').update('new').digest('hex'), approved)).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(await readFile(path.join(home, 'AGENTS.md'), 'utf8')).toBe('old');
  });
});
