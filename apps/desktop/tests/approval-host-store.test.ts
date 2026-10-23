import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteApprovalHostStore } from '../src/main/approval-host-store.js';
import { freshApprovalJobBudgetState, type ApprovalJobBudgetState } from '../src/main/approval-job-budget.js';

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const directories: string[] = [];
const stores: SqliteApprovalHostStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((directory) => {
    if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('lnwjud-approval-host-store-')) throw new Error('Unexpected fixture cleanup path');
    return rm(directory, { recursive: true, force: true });
  }));
});

async function fixture(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-approval-host-store-'));
  directories.push(directory);
  return path.join(directory, 'fixture-approval.sqlite');
}

function track(store: SqliteApprovalHostStore): SqliteApprovalHostStore {
  stores.push(store);
  return store;
}

describe('SqliteApprovalHostStore', () => {
  it('retains legacy-v4 base budgets without migrating or resetting them and refuses appended phases', async () => {
    const filename = await fixture(); const first = track(SqliteApprovalHostStore.createNew(filename));
    const job = first.createHostJob('legacy-work', { ownerId: 'owner', workspaceId: 'workspace', targetId: 'tab', scopeDigest: digest('anchor') }, [digest('base')], { pageUrl: 'https://fixture.invalid/form' }, { credentialHash: digest('credential'), clientId: 'client', sessionId: 'session' });
    first.close();
    const raw = new DatabaseSync(filename);
    raw.exec("DROP TRIGGER approval_phase_batches_immutable_update; DROP TRIGGER approval_phase_batches_immutable_delete; DROP TABLE approval_phase_batches; UPDATE approval_host_store_meta SET value='4' WHERE key='schema_version'");
    raw.close();
    const legacy = track(SqliteApprovalHostStore.openExisting(filename));
    expect(legacy.readHostJob(job.identity.hostWorkId)).toEqual(job);
    expect(legacy.readPhaseBatches(job.identity.hostWorkId)).toEqual([]);
    legacy.selectDesktopWork(job.identity.hostWorkId, true);
    const state = await legacy.load(job.identity.hostWorkId) as ApprovalJobBudgetState;
    expect(await legacy.compareAndSwap(job.identity.hostWorkId, state.revision, { ...state, revision: state.revision + 1 }, 1)).toBe(true);
    expect(() => legacy.appendPhaseBatch(job.identity.hostWorkId, digest('credential'), { idempotencyKey: 'new', pageUrl: 'https://fixture.invalid/form', requestDigests: [digest('next')], expectedBudgetRevision: 2, expectedConnectionRevision: 1, expectedContinuationRevision: 0 })).toThrow('explicit schema upgrade');
    const evidence = new DatabaseSync(filename, { readOnly: true });
    try { expect(evidence.prepare("SELECT value FROM approval_host_store_meta WHERE key='schema_version'").get()).toEqual({ value: '4' }); expect(evidence.prepare('SELECT COUNT(*) AS count FROM approval_host_jobs').get()).toEqual({ count: 1 }); }
    finally { evidence.close(); }
  });

  it('checks review revision and expiry atomically before selecting persisted work', async () => {
    const filename = await fixture(); const first = track(SqliteApprovalHostStore.createNew(filename));
    const job = first.createHostJob('primary-review', { ownerId: 'owner-a', workspaceId: 'workspace-a', targetId: 'tab-a', scopeDigest: digest('review-scope') }, [digest('one')], { fixture: 'host-plan' });
    const second = track(SqliteApprovalHostStore.openExisting(filename)); const state = await first.load(job.identity.hostWorkId) as ApprovalJobBudgetState;
    expect(await second.compareAndSwap(job.identity.hostWorkId, state.revision, { ...state, revision: state.revision + 1 })).toBe(false); // Inactive Desktop work cannot reserve/write a budget.
    first.selectDesktopWork(job.identity.hostWorkId, true); // Simulate another already selected host request updating evidence.
    expect(await second.compareAndSwap(job.identity.hostWorkId, state.revision, { ...state, revision: state.revision + 1 })).toBe(true);
    first.selectDesktopWork(job.identity.hostWorkId, false);
    expect(() => first.selectDesktopWork(job.identity.hostWorkId, true, { revision: state.revision, expiresAt: Date.now() + 60_000 })).toThrow('stale or expired');
    expect(() => first.selectDesktopWork(job.identity.hostWorkId, true, { revision: state.revision + 1, expiresAt: Date.now() })).toThrow('stale or expired');
    expect(first.isDesktopWorkSelected(job.identity.hostWorkId)).toBe(false);
    first.selectDesktopWork(job.identity.hostWorkId, true, { revision: state.revision + 1, expiresAt: Date.now() + 60_000 });
    expect(first.isDesktopWorkSelected(job.identity.hostWorkId)).toBe(true);
  });
  it('mints immutable host identity and its initial budget together, then survives close/reopen', async () => {
    const filename = await fixture();
    const store = track(SqliteApprovalHostStore.createNew(filename));
    const job = store.createHostJob('primary-work', { ownerId: 'owner-a', workspaceId: 'workspace-a', targetId: 'tab-a', scopeDigest: digest('scope') }, [digest('one'), digest('two')]);
    expect(job.identity.hostWorkId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await store.load(job.identity.hostWorkId) as ApprovalJobBudgetState).revision).toBe(1);
    const edited = job.requestDigests as string[];
    edited[0] = digest('edited');
    expect(store.readHostJob(job.identity.hostWorkId)?.requestDigests).toEqual([digest('one'), digest('two')]);
    store.close();

    const reopened = track(SqliteApprovalHostStore.openExisting(filename));
    expect(reopened.readHostJob(job.identity.hostWorkId)).toEqual({ primaryWorkId: 'primary-work', identity: job.identity, requestDigests: [digest('one'), digest('two')] });
    expect(await reopened.load(job.identity.hostWorkId)).toMatchObject({ identity: job.identity, revision: 1 });
    reopened.close();
  });

  it('performs real revision CAS across two SQLite connections', async () => {
    const filename = await fixture();
    const first = track(SqliteApprovalHostStore.createNew(filename));
    const job = first.createHostJob('primary-work', { ownerId: 'owner-a', workspaceId: 'workspace-a', targetId: 'tab-a', scopeDigest: digest('scope') }, [digest('one')]);
    const second = track(SqliteApprovalHostStore.openExisting(filename));
    const state = await first.load(job.identity.hostWorkId) as ApprovalJobBudgetState;
    const update = { ...state, revision: 2, requested: 1 };
    expect(await first.compareAndSwap(job.identity.hostWorkId, 1, update)).toBe(true);
    expect(await second.compareAndSwap(job.identity.hostWorkId, 1, update)).toBe(false);
    expect(await second.load(job.identity.hostWorkId)).toMatchObject({ revision: 2, requested: 1 });
    first.close(); second.close();
  });

  it('never recreates a missing budget for an existing host job', async () => {
    const filename = await fixture();
    const store = track(SqliteApprovalHostStore.createNew(filename));
    const job = store.createHostJob('primary-work', { ownerId: 'owner-a', workspaceId: 'workspace-a', targetId: 'tab-a', scopeDigest: digest('scope') }, [digest('one')]);
    const raw = new DatabaseSync(filename);
    raw.exec('PRAGMA foreign_keys = OFF');
    raw.prepare('DELETE FROM approval_job_budgets WHERE host_work_id=?').run(job.identity.hostWorkId);
    raw.close();
    expect(await store.load(job.identity.hostWorkId)).toBeUndefined();
    expect(await store.compareAndSwap(job.identity.hostWorkId, null, freshApprovalJobBudgetState(job.identity))).toBe(false);
    expect(store.createHostJob('primary-work', { ownerId: 'owner-a', workspaceId: 'workspace-a', targetId: 'tab-a', scopeDigest: digest('scope') }, [digest('one')]).identity.hostWorkId).toBe(job.identity.hostWorkId);
    expect(await store.load(job.identity.hostWorkId)).toBeUndefined();
    store.close();
  });

  it('creates one immutable parent for a stable primary work key across connections and interrupted returns', async () => {
    const filename = await fixture(); const first = track(SqliteApprovalHostStore.createNew(filename));
    const scope = { ownerId: 'owner-a', workspaceId: 'workspace-a', targetId: 'tab-a', scopeDigest: digest('scope') };
    first.createHostJob('primary-work', scope, [digest('one')]); // Simulate a committed create whose response is lost.
    first.close();
    const second = track(SqliteApprovalHostStore.openExisting(filename)); const third = track(SqliteApprovalHostStore.openExisting(filename));
    const [a, b] = await Promise.all([Promise.resolve().then(() => second.createHostJob('primary-work', scope, [digest('one')])), Promise.resolve().then(() => third.createHostJob('primary-work', scope, [digest('one')]))]);
    expect(a).toEqual(b);
    const raw = new DatabaseSync(filename, { readOnly: true });
    try { expect(raw.prepare('SELECT COUNT(*) AS count FROM approval_host_jobs').get()).toMatchObject({ count: 1 }); }
    finally { raw.close(); }
    expect(() => second.createHostJob('primary-work', { ...scope, ownerId: 'other' }, [digest('one')])).toThrow(/different identity/);
    expect(() => second.createHostJob('primary-work', scope, [digest('changed')])).toThrow(/different identity/);
  });

  it('fails closed for missing, corrupt, and schema-mismatched files without creating a replacement', async () => {
    const filename = await fixture();
    expect(() => SqliteApprovalHostStore.openExisting(filename)).toThrow(/opening refused/i);
    const corrupt = path.join(path.dirname(filename), 'corrupt.sqlite');
    await writeFile(corrupt, 'not sqlite');
    expect(() => SqliteApprovalHostStore.openExisting(corrupt)).toThrow();
    const empty = path.join(path.dirname(filename), 'empty.sqlite');
    const raw = new DatabaseSync(empty); raw.close();
    expect(() => SqliteApprovalHostStore.openExisting(empty)).toThrow();
  });

  it('uses full synchronous SQLite durability and keeps its dedicated fixture file separate', async () => {
    const filename = await fixture();
    const store = track(SqliteApprovalHostStore.createNew(filename));
    const raw = new DatabaseSync(filename, { readOnly: true });
    expect(raw.prepare('PRAGMA synchronous').get()).toMatchObject({ synchronous: 2 });
    expect(raw.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
    raw.close(); store.close();
  });

  it('rolls back parent, budget and Desktop plan together on a plan write failure', async () => {
    const filename = await fixture(); const store = track(SqliteApprovalHostStore.createNew(filename));
    const raw = new DatabaseSync(filename);
    try {
      raw.exec("CREATE TRIGGER fixture_abort_plan BEFORE INSERT ON approval_desktop_plans BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
      expect(() => store.createHostJob('primary', { ownerId: 'owner', workspaceId: 'workspace', targetId: 'tab', scopeDigest: digest('scope') }, [digest('action')], { primaryWorkId: 'primary' })).toThrow('fixture failure');
      for (const table of ['approval_host_jobs', 'approval_job_budgets', 'approval_desktop_plans', 'approval_desktop_selection']) {
        expect(raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toMatchObject({ count: 0 });
      }
    } finally { raw.close(); }
  });

  it('refuses a current-schema registry with its selected-work uniqueness constraint missing', async () => {
    const filename = await fixture(); const store = track(SqliteApprovalHostStore.createNew(filename)); store.close();
    const raw = new DatabaseSync(filename); raw.exec('DROP INDEX approval_desktop_one_selected'); raw.close();
    expect(() => SqliteApprovalHostStore.openExisting(filename)).toThrow(/selection uniqueness/);
  });
});
