import { randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, openSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type ApprovalJobBudgetJournal,
  type ApprovalJobBudgetState,
  type ApprovalJobIdentity,
  assertApprovalJobIdentity,
  freshApprovalJobBudgetState,
  sameApprovalJobIdentity,
} from './approval-job-budget.js';

const SCHEMA_VERSION = '6';
const DIGEST = /^[a-f0-9]{64}$/;

export type ApprovalHostStoreOpenMode = 'createNew' | 'openExisting';

export interface ApprovalHostJobScope {
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly targetId: string;
  readonly scopeDigest: string;
}

export interface ApprovalHostJobRecord {
  readonly primaryWorkId: string;
  readonly identity: ApprovalJobIdentity;
  /** Immutable SHA-256 list for the exact trusted host plan. */
  readonly requestDigests: readonly string[];
}
export interface ChromeWorkRegistration { readonly credentialHash: string; readonly clientId: string; readonly sessionId: string; }
export interface ApprovalPhaseBatch { readonly revision: number; readonly idempotencyKey: string; readonly tabId: string; readonly pageUrl: string; readonly requestDigests: readonly string[]; }
export interface ApprovalContinuationRequest { readonly idempotencyKey: string; readonly tabId?: string; readonly pageUrl: string; readonly requestDigests: readonly string[]; readonly expectedConnectionRevision: number; readonly expectedBudgetRevision: number; readonly expectedContinuationRevision: number; }
export interface ChromeWorkConnection { readonly clientId: string; readonly sessionId: string; readonly revision: number; }

export class ApprovalHostStoreError extends Error {
  public constructor(message: string) { super(message); this.name = 'ApprovalHostStoreError'; }
}

/**
 * A dedicated, explicitly supplied SQLite file for fixture-host approval evidence.
 * It has no application-settings fallback and will never create evidence while opening.
 */
export class SqliteApprovalHostStore implements ApprovalJobBudgetJournal {
  private readonly database!: DatabaseSync;
  private closed = false;
  private supportsContinuations = true;
  private supportsTargetContinuations = true;

  public constructor(private readonly filename: string, mode: ApprovalHostStoreOpenMode) {
    assertDedicatedFilename(filename);
    if (mode === 'createNew') createExclusiveFile(filename);
    else assertExistingFile(filename);
    try {
      this.database = new DatabaseSync(filename, { timeout: 5_000 });
      this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
      if (mode === 'createNew') {
        this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
        this.createSchema();
      } else {
        // Do not change an unknown or incompatible file merely by attempting to resume it.
        this.verifySchema();
        this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      }
    } catch (cause) {
      try { this.database?.close(); } catch { /* retain original opening failure */ }
      throw new ApprovalHostStoreError(`Approval host store cannot open: ${message(cause)}`);
    }
  }

  public static createNew(filename: string): SqliteApprovalHostStore { return new SqliteApprovalHostStore(filename, 'createNew'); }
  public static openExisting(filename: string): SqliteApprovalHostStore { return new SqliteApprovalHostStore(filename, 'openExisting'); }

  /** Mints the host ID and writes parent identity plus its initial budget in one SQLite transaction. */
  public createHostJob(primaryWorkId: string, scope: ApprovalHostJobScope, requestDigests: readonly string[], desktopPlan?: unknown, chrome?: ChromeWorkRegistration): ApprovalHostJobRecord {
    this.assertOpen();
    assertPrimaryWorkId(primaryWorkId);
    assertScope(scope);
    assertRequestDigests(requestDigests);
    if (chrome !== undefined && (desktopPlan === undefined || !DIGEST.test(chrome.credentialHash))) throw new ApprovalHostStoreError('Chrome registration requires its host plan and credential');
    if (chrome !== undefined) { assertPrimaryWorkId(chrome.clientId); assertPrimaryWorkId(chrome.sessionId); }
    return this.transaction(() => {
      const existing = this.database.prepare(`SELECT host_work_id, primary_work_id, owner_id, workspace_id, target_id, scope_digest, request_digests_json
        FROM approval_host_jobs WHERE primary_work_id=?`).get(primaryWorkId) as HostJobRow | undefined;
      if (existing !== undefined) {
        const record = decodeHostJob(existing);
        if (record.identity.ownerId !== scope.ownerId || record.identity.workspaceId !== scope.workspaceId
          || record.identity.targetId !== scope.targetId || record.identity.scopeDigest !== scope.scopeDigest
          || JSON.stringify(record.requestDigests) !== JSON.stringify(requestDigests)) {
          throw new ApprovalHostStoreError('The primary host work already exists with a different identity or plan');
        }
        if (desktopPlan !== undefined) {
          const saved = this.database.prepare('SELECT plan_json FROM approval_desktop_plans WHERE host_work_id=?').get(record.identity.hostWorkId) as { plan_json: string } | undefined;
          if (saved?.plan_json !== JSON.stringify(desktopPlan)) throw new ApprovalHostStoreError('Desktop approval lifecycle plan is missing or changed');
        }
        if (chrome !== undefined) this.verifyChromeCredential(record.identity.hostWorkId, chrome.credentialHash);
        return record; // An interrupted create resumes its existing budget; never inserts a replacement.
      }
      const identity: ApprovalJobIdentity = {
        hostWorkId: randomUUID(),
        ownerId: scope.ownerId,
        workspaceId: scope.workspaceId,
        targetId: scope.targetId,
        scopeDigest: scope.scopeDigest,
      };
      const state = freshApprovalJobBudgetState(identity);
      this.database.prepare(`INSERT INTO approval_host_jobs
        (host_work_id, primary_work_id, owner_id, workspace_id, target_id, scope_digest, request_digests_json, chrome_registered)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(identity.hostWorkId, primaryWorkId, identity.ownerId, identity.workspaceId, identity.targetId, identity.scopeDigest, JSON.stringify([...requestDigests]), chrome === undefined ? 0 : 1);
      this.database.prepare('INSERT INTO approval_job_budgets (host_work_id, revision, state_json) VALUES (?, ?, ?)')
        .run(identity.hostWorkId, state.revision, JSON.stringify(state));
      if (desktopPlan !== undefined) {
        this.database.prepare('INSERT INTO approval_desktop_plans (host_work_id, plan_json) VALUES (?, ?)').run(identity.hostWorkId, JSON.stringify(desktopPlan));
        this.database.prepare('INSERT INTO approval_desktop_selection (host_work_id, scope_key, active) VALUES (?, ?, 0)')
          .run(identity.hostWorkId, JSON.stringify([identity.ownerId, identity.workspaceId, identity.targetId]));
      }
      if (chrome !== undefined) {
        this.database.prepare('INSERT INTO approval_chrome_owners (host_work_id, credential_hash, client_id) VALUES (?, ?, ?)').run(identity.hostWorkId, chrome.credentialHash, chrome.clientId);
        this.database.prepare('INSERT INTO approval_chrome_connections (host_work_id, session_id, revision) VALUES (?, ?, 1)').run(identity.hostWorkId, chrome.sessionId);
      }
      return { primaryWorkId, identity, requestDigests: [...requestDigests] };
    });
  }

  public readHostJob(hostWorkId: string): ApprovalHostJobRecord | undefined {
    this.assertOpen();
    assertHostWorkId(hostWorkId);
    const row = this.database.prepare(`SELECT host_work_id, primary_work_id, owner_id, workspace_id, target_id, scope_digest, request_digests_json
      FROM approval_host_jobs WHERE host_work_id=?`).get(hostWorkId) as HostJobRow | undefined;
    return row === undefined ? undefined : decodeHostJob(row);
  }

  public selectDesktopWork(hostWorkId: string, active: boolean, review?: { readonly revision: number; readonly expiresAt: number; readonly connectionRevision?: number; readonly continuationRevision?: number }): void {
    this.assertOpen();
    this.transaction(() => {
      const row = this.database.prepare('SELECT scope_key FROM approval_desktop_selection WHERE host_work_id=?').get(hostWorkId) as { scope_key: string } | undefined;
      if (row === undefined) throw new ApprovalHostStoreError('Desktop work selection evidence is missing');
      const state = this.database.prepare('SELECT revision, state_json FROM approval_job_budgets WHERE host_work_id=?').get(hostWorkId) as { revision: number; state_json: string } | undefined;
      if (state === undefined || (JSON.parse(state.state_json) as { inDoubt?: unknown }).inDoubt !== 0) throw new ApprovalHostStoreError('Desktop work has pending or unknown approval evidence');
      if (review !== undefined && (state.revision !== review.revision || review.expiresAt <= Date.now())) throw new ApprovalHostStoreError('Desktop review is stale or expired');
      const continuationRevision = this.readPhaseBatches(hostWorkId).length;
      if (review !== undefined && continuationRevision !== (review.continuationRevision ?? 0)) throw new ApprovalHostStoreError('Desktop continuation review is stale');
      const connection = this.readChromeConnection(hostWorkId);
      if (review !== undefined && connection?.revision !== review.connectionRevision) throw new ApprovalHostStoreError('Desktop Chrome connection review is stale');
      if (active && connection !== undefined) this.assertChromeSelection(hostWorkId, connection);
      if (active && this.database.prepare('SELECT host_work_id FROM approval_desktop_selection WHERE scope_key=? AND active=1 AND host_work_id<>?').get(row.scope_key, hostWorkId) !== undefined) {
        throw new ApprovalHostStoreError('Another Desktop work is still selected for this scope');
      }
      this.database.prepare('UPDATE approval_desktop_selection SET active=? WHERE host_work_id=?').run(active ? 1 : 0, hostWorkId);
    });
  }

  public isDesktopWorkSelected(hostWorkId: string): boolean {
    this.assertOpen();
    const row = this.database.prepare('SELECT active FROM approval_desktop_selection WHERE host_work_id=?').get(hostWorkId) as { active: number } | undefined;
    if (row === undefined) throw new ApprovalHostStoreError('Desktop work selection evidence is missing');
    return row.active === 1;
  }

  public readChromeConnection(hostWorkId: string): ChromeWorkConnection | undefined {
    this.assertOpen();
    const row = this.database.prepare(`SELECT j.chrome_registered, o.client_id, c.session_id, c.revision FROM approval_host_jobs AS j
      LEFT JOIN approval_chrome_owners AS o ON o.host_work_id=j.host_work_id
      LEFT JOIN approval_chrome_connections AS c ON c.host_work_id=j.host_work_id WHERE j.host_work_id=?`).get(hostWorkId) as { chrome_registered: unknown; client_id: unknown; session_id: unknown; revision: unknown } | undefined;
    if (row === undefined) return undefined;
    if (row.chrome_registered === 0 && row.client_id === null && row.session_id === null && row.revision === null) return undefined;
    if (row.chrome_registered !== 1) throw new ApprovalHostStoreError('Unexpected Chrome owner evidence');
    if (typeof row.client_id !== 'string' || typeof row.session_id !== 'string' || !Number.isSafeInteger(row.revision) || (row.revision as number) < 1) throw new ApprovalHostStoreError('Chrome connection evidence is missing or corrupt');
    return { clientId: row.client_id, sessionId: row.session_id, revision: row.revision as number };
  }

  public reconnectChromeWork(hostWorkId: string, credentialHash: string, expectedRevision: number, sessionId: string): ChromeWorkConnection {
    this.assertOpen(); assertPrimaryWorkId(sessionId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new ApprovalHostStoreError('Invalid Chrome connection revision');
    return this.transaction(() => {
      this.verifyChromeCredential(hostWorkId, credentialHash);
      const connection = this.readChromeConnection(hostWorkId)!;
      if (connection.revision !== expectedRevision) throw new ApprovalHostStoreError('Chrome continuity event is stale');
      const row = this.database.prepare('SELECT state_json FROM approval_job_budgets WHERE host_work_id=?').get(hostWorkId) as { state_json: string } | undefined;
      if (row === undefined || (JSON.parse(row.state_json) as { inDoubt?: unknown }).inDoubt !== 0) throw new ApprovalHostStoreError('Chrome work has pending or unknown approval evidence');
      if (this.isDesktopWorkSelected(hostWorkId)) this.assertChromeSelection(hostWorkId, { ...connection, sessionId });
      if (connection.sessionId === sessionId) return connection;
      const revision = connection.revision + 1;
      if (!Number.isSafeInteger(revision)) throw new ApprovalHostStoreError('Chrome connection revision exhausted');
      this.database.prepare('UPDATE approval_chrome_connections SET session_id=?, revision=? WHERE host_work_id=? AND revision=?').run(sessionId, revision, hostWorkId, expectedRevision);
      if (this.readPhaseBatches(hostWorkId).length !== 0) this.database.prepare('UPDATE approval_desktop_selection SET active=0 WHERE host_work_id=?').run(hostWorkId);
      return { clientId: connection.clientId, sessionId, revision };
    });
  }


  /** Additional exact phases are immutable proposals; appending never selects or dispatches them. */
  public appendPhaseBatch(hostWorkId: string, credentialHash: string, input: ApprovalContinuationRequest): number {
    this.assertOpen(); assertPrimaryWorkId(input.idempotencyKey); assertRequestDigests(input.requestDigests);
    if (!this.supportsContinuations) throw new ApprovalHostStoreError('This retained journal requires an explicit schema upgrade before continuation');
    if (input.requestDigests.length > 100 || ![input.expectedConnectionRevision, input.expectedBudgetRevision].every((n) => Number.isSafeInteger(n) && n >= 1)
      || !Number.isSafeInteger(input.expectedContinuationRevision) || input.expectedContinuationRevision < 0) throw new ApprovalHostStoreError('Invalid continuation revision or size');
    return this.transaction(() => {
      this.verifyChromeCredential(hostWorkId, credentialHash);
      const job = this.readHostJob(hostWorkId)!;
      const saved = this.database.prepare('SELECT plan_json FROM approval_desktop_plans WHERE host_work_id=?').get(hostWorkId) as { plan_json: string };
      const plan = JSON.parse(saved.plan_json) as { pageUrl?: unknown };
      const tabId = input.tabId ?? job.identity.targetId;
      assertExactTarget(tabId, input.pageUrl);
      if (!this.supportsTargetContinuations && (input.pageUrl !== plan.pageUrl || tabId !== job.identity.targetId)) throw new ApprovalHostStoreError('Legacy continuation must retain the original exact page and target');
      const connection = this.readChromeConnection(hostWorkId);
      if (connection?.revision !== input.expectedConnectionRevision) throw new ApprovalHostStoreError('Continuation connection is stale');
      const batches = this.readPhaseBatches(hostWorkId);
      const previous = batches.find((batch) => batch.idempotencyKey === input.idempotencyKey);
      if (previous !== undefined) {
        if (previous.tabId !== tabId || previous.pageUrl !== input.pageUrl || JSON.stringify(previous.requestDigests) !== JSON.stringify(input.requestDigests)) throw new ApprovalHostStoreError('Continuation intent changed');
        return previous.revision; // Lost metadata responses cannot mint a budget or reactivate selection.
      }
      const budget = this.database.prepare('SELECT revision, state_json FROM approval_job_budgets WHERE host_work_id=?').get(hostWorkId) as BudgetRow | undefined;
      if (budget === undefined) throw new ApprovalHostStoreError('Continuation budget is missing');
      const state = decodeBudget(budget);
      if (state.inDoubt !== 0 || state.revision !== input.expectedBudgetRevision || batches.length !== input.expectedContinuationRevision) throw new ApprovalHostStoreError('Continuation review is stale or has pending evidence');
      const known = [...job.requestDigests, ...batches.flatMap((batch) => [...batch.requestDigests])];
      if (known.length + input.requestDigests.length > 1000 || new Set([...known, ...input.requestDigests]).size !== known.length + input.requestDigests.length) throw new ApprovalHostStoreError('Continuation phases are duplicate or exceed the plan bound');
      const revision = batches.length + 1;
      this.database.prepare('INSERT INTO approval_phase_batches (host_work_id, revision, idempotency_key, batch_json) VALUES (?, ?, ?, ?)')
        .run(hostWorkId, revision, input.idempotencyKey, JSON.stringify({ ...(this.supportsTargetContinuations ? { tabId } : {}), pageUrl: input.pageUrl, requestDigests: input.requestDigests }));
      this.database.prepare('UPDATE approval_desktop_selection SET active=0 WHERE host_work_id=?').run(hostWorkId);
      return revision;
    });
  }

  public readPhaseBatches(hostWorkId: string): readonly ApprovalPhaseBatch[] {
    this.assertOpen();
    if (!this.supportsContinuations) return [];
    const job = this.readHostJob(hostWorkId);
    if (job === undefined) throw new ApprovalHostStoreError('Continuation parent is missing');
    const saved = this.database.prepare('SELECT plan_json FROM approval_desktop_plans WHERE host_work_id=?').get(hostWorkId) as { plan_json: string } | undefined;
    const plan = saved === undefined ? undefined : JSON.parse(saved.plan_json) as { pageUrl?: unknown };
    const rows = this.database.prepare('SELECT revision, idempotency_key, batch_json FROM approval_phase_batches WHERE host_work_id=? ORDER BY revision').all(hostWorkId) as Array<{ revision: number; idempotency_key: string; batch_json: string }>;
    const digests = new Set(job.requestDigests); const keys = new Set<string>();
    return rows.map((row, index) => {
      if (row.revision !== index + 1 || typeof row.batch_json !== 'string') throw new ApprovalHostStoreError('Continuation sequence is corrupt');
      assertPrimaryWorkId(row.idempotency_key);
      const value = JSON.parse(row.batch_json) as { tabId?: unknown; pageUrl?: unknown; requestDigests?: unknown };
      const tabId = this.supportsTargetContinuations ? value.tabId : job.identity.targetId;
      assertExactTarget(tabId, value.pageUrl);
      if ((!this.supportsTargetContinuations && (value.tabId !== undefined || value.pageUrl !== plan?.pageUrl)) || !Array.isArray(value.requestDigests) || value.requestDigests.length > 100 || keys.has(row.idempotency_key)) throw new ApprovalHostStoreError('Continuation scope or intent is corrupt');
      assertRequestDigests(value.requestDigests); keys.add(row.idempotency_key);
      for (const digest of value.requestDigests as string[]) { if (digests.has(digest)) throw new ApprovalHostStoreError('Continuation phase is ambiguous'); digests.add(digest); }
      if (digests.size > 1000) throw new ApprovalHostStoreError('Continuation plan bound exceeded');
      return { revision: row.revision, idempotencyKey: row.idempotency_key, tabId: tabId as string, pageUrl: value.pageUrl as string, requestDigests: value.requestDigests as string[] };
    });
  }

  private verifyChromeCredential(hostWorkId: string, credentialHash: string): void {
    const saved = this.database.prepare('SELECT credential_hash FROM approval_chrome_owners WHERE host_work_id=?').get(hostWorkId) as { credential_hash: unknown } | undefined;
    if (saved === undefined || typeof saved.credential_hash !== 'string' || !DIGEST.test(saved.credential_hash) || !DIGEST.test(credentialHash)
      || !timingSafeEqual(Buffer.from(saved.credential_hash, 'hex'), Buffer.from(credentialHash, 'hex'))) throw new ApprovalHostStoreError('Chrome owner continuity evidence does not match');
  }

  private assertChromeSelection(hostWorkId: string, connection: ChromeWorkConnection): void {
    const targets = new Set([this.readHostJob(hostWorkId)!.identity.targetId, ...this.readPhaseBatches(hostWorkId).map((batch) => batch.tabId)]);
    const others = this.database.prepare(`SELECT j.host_work_id, j.target_id FROM approval_desktop_selection AS s
      JOIN approval_host_jobs AS j ON j.host_work_id=s.host_work_id JOIN approval_chrome_owners AS o ON o.host_work_id=j.host_work_id
      JOIN approval_chrome_connections AS c ON c.host_work_id=j.host_work_id
      WHERE s.active=1 AND j.host_work_id<>? AND o.client_id=? AND c.session_id=?
      AND j.workspace_id=(SELECT workspace_id FROM approval_host_jobs WHERE host_work_id=?)`).all(hostWorkId, connection.clientId, connection.sessionId, hostWorkId) as Array<{ host_work_id: string; target_id: string }>;
    if (others.some((other) => [other.target_id, ...this.readPhaseBatches(other.host_work_id).map((batch) => batch.tabId)].some((tabId) => targets.has(tabId)))) {
      throw new ApprovalHostStoreError('Another Chrome work is still selected for this connection and target');
    }
  }

  public loadDesktopPlans(): readonly { readonly record: ApprovalHostJobRecord; readonly plan: unknown }[] {
    this.assertOpen();
    const rows = this.database.prepare(`SELECT j.host_work_id, j.primary_work_id, j.owner_id, j.workspace_id, j.target_id, j.scope_digest, j.request_digests_json, p.plan_json
      FROM approval_host_jobs AS j LEFT JOIN approval_desktop_plans AS p ON p.host_work_id=j.host_work_id`).all() as unknown as Array<HostJobRow & { plan_json: unknown }>;
    return rows.map((row) => {
      if (typeof row.plan_json !== 'string') throw new ApprovalHostStoreError('Desktop approval lifecycle evidence is missing');
      return { record: decodeHostJob(row), plan: JSON.parse(row.plan_json) as unknown };
    });
  }

  public async load(hostWorkId: string): Promise<unknown | undefined> {
    this.assertOpen();
    const job = this.readHostJob(hostWorkId);
    if (job === undefined) return undefined;
    const row = this.database.prepare('SELECT revision, state_json FROM approval_job_budgets WHERE host_work_id=?').get(hostWorkId) as BudgetRow | undefined;
    if (row === undefined) return undefined; // Provider.resumeJob fails closed; CAS will never recreate it.
    const state = decodeBudget(row);
    if (!sameApprovalJobIdentity(state.identity, job.identity) || state.revision !== row.revision) {
      throw new ApprovalHostStoreError('Approval budget does not match its immutable host job');
    }
    return state;
  }

  /** CAS only updates an existing budget bound to an existing host job; it never inserts one. */
  public async compareAndSwap(hostWorkId: string, expectedRevision: number | null, state: ApprovalJobBudgetState, connectionRevision?: number): Promise<boolean> {
    this.assertOpen();
    assertHostWorkId(hostWorkId);
    if (expectedRevision === null || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return false;
    assertApprovalJobIdentity(state.identity);
    if (state.identity.hostWorkId !== hostWorkId || !Number.isSafeInteger(state.revision) || state.revision !== expectedRevision + 1) {
      throw new ApprovalHostStoreError('Approval budget CAS state is invalid');
    }
    return this.transaction(() => {
      const job = this.readHostJob(hostWorkId);
      if (job === undefined || !sameApprovalJobIdentity(job.identity, state.identity)) return false;
      const desktop = this.database.prepare(`SELECT s.active FROM approval_desktop_plans AS p
        LEFT JOIN approval_desktop_selection AS s ON s.host_work_id=p.host_work_id WHERE p.host_work_id=?`).get(hostWorkId) as { active: unknown } | undefined;
      // Selection admission and reservation CAS share this transaction, including across host connections.
      if (desktop !== undefined && desktop.active !== 1) return false;
      const connection = this.readChromeConnection(hostWorkId);
      if (connection?.revision !== connectionRevision) return false;
      const current = this.database.prepare('SELECT revision FROM approval_job_budgets WHERE host_work_id=?').get(hostWorkId) as { revision?: unknown } | undefined;
      if (current === undefined || current.revision !== expectedRevision) return false;
      const result = this.database.prepare(`UPDATE approval_job_budgets SET revision=?, state_json=?
        WHERE host_work_id=? AND revision=?`).run(state.revision, JSON.stringify(state), hostWorkId, expectedRevision);
      return result.changes === 1;
    });
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private createSchema(): void {
    this.transaction(() => {
      this.database.exec(`CREATE TABLE approval_host_store_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
        INSERT INTO approval_host_store_meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}');
        CREATE TABLE approval_host_jobs (
          host_work_id TEXT PRIMARY KEY NOT NULL,
          primary_work_id TEXT UNIQUE NOT NULL,
          owner_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          target_id TEXT NOT NULL,
          scope_digest TEXT NOT NULL,
          request_digests_json TEXT NOT NULL,
          chrome_registered INTEGER NOT NULL CHECK(chrome_registered IN (0,1))
        );
        CREATE TABLE approval_job_budgets (
          host_work_id TEXT PRIMARY KEY NOT NULL REFERENCES approval_host_jobs(host_work_id),
          revision INTEGER NOT NULL,
          state_json TEXT NOT NULL
        );
        CREATE TABLE approval_desktop_plans (
          host_work_id TEXT PRIMARY KEY NOT NULL REFERENCES approval_host_jobs(host_work_id),
          plan_json TEXT NOT NULL
        );
        CREATE TABLE approval_desktop_selection (
          host_work_id TEXT PRIMARY KEY NOT NULL REFERENCES approval_desktop_plans(host_work_id),
          scope_key TEXT NOT NULL,
          active INTEGER NOT NULL CHECK(active IN (0,1))
        );
        CREATE UNIQUE INDEX approval_desktop_one_selected ON approval_desktop_selection(scope_key) WHERE active=1;
        CREATE TABLE approval_chrome_owners (
          host_work_id TEXT PRIMARY KEY NOT NULL REFERENCES approval_desktop_plans(host_work_id),
          credential_hash TEXT NOT NULL,
          client_id TEXT NOT NULL
        );
        CREATE TABLE approval_chrome_connections (
          host_work_id TEXT PRIMARY KEY NOT NULL REFERENCES approval_chrome_owners(host_work_id),
          session_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision>=1)
        );
        CREATE TABLE approval_phase_batches (
          host_work_id TEXT NOT NULL REFERENCES approval_desktop_plans(host_work_id),
          revision INTEGER NOT NULL CHECK(revision>=1),
          idempotency_key TEXT NOT NULL,
          batch_json TEXT NOT NULL,
          PRIMARY KEY(host_work_id, revision), UNIQUE(host_work_id, idempotency_key)
        );
        CREATE TRIGGER approval_phase_batches_immutable_update BEFORE UPDATE ON approval_phase_batches BEGIN SELECT RAISE(ABORT, 'Continuation phase batch is immutable'); END;
        CREATE TRIGGER approval_phase_batches_immutable_delete BEFORE DELETE ON approval_phase_batches BEGIN SELECT RAISE(ABORT, 'Continuation phase batch is immutable'); END;
        CREATE TRIGGER approval_chrome_owners_immutable_update BEFORE UPDATE ON approval_chrome_owners BEGIN SELECT RAISE(ABORT, 'Chrome owner is immutable'); END;
        CREATE TRIGGER approval_chrome_owners_immutable_delete BEFORE DELETE ON approval_chrome_owners BEGIN SELECT RAISE(ABORT, 'Chrome owner is immutable'); END;
        CREATE TRIGGER approval_desktop_plans_immutable_update BEFORE UPDATE ON approval_desktop_plans BEGIN SELECT RAISE(ABORT, 'Desktop approval plan is immutable'); END;
        CREATE TRIGGER approval_desktop_plans_immutable_delete BEFORE DELETE ON approval_desktop_plans BEGIN SELECT RAISE(ABORT, 'Desktop approval plan is immutable'); END;
        CREATE TRIGGER approval_host_jobs_immutable_update BEFORE UPDATE ON approval_host_jobs BEGIN SELECT RAISE(ABORT, 'approval host job is immutable'); END;
        CREATE TRIGGER approval_host_jobs_immutable_delete BEFORE DELETE ON approval_host_jobs BEGIN SELECT RAISE(ABORT, 'approval host job is immutable'); END;`);
    });
  }

  private verifySchema(): void {
    const version = this.database.prepare(`SELECT value FROM approval_host_store_meta WHERE key='schema_version'`).get() as { value?: unknown } | undefined;
    this.supportsTargetContinuations = version?.value === SCHEMA_VERSION;
    this.supportsContinuations = this.supportsTargetContinuations || version?.value === '5';
    if (!this.supportsContinuations && version?.value !== '4') throw new ApprovalHostStoreError('Approval host store schema is missing or unsupported');
    const tables = new Set((this.database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name?: unknown }>)
      .map((row) => row.name).filter((name): name is string => typeof name === 'string'));
    if (!tables.has('approval_host_jobs') || !tables.has('approval_job_budgets')) throw new ApprovalHostStoreError('Approval host store tables are missing');
    assertTableColumns(this.database, 'approval_host_jobs', ['host_work_id', 'primary_work_id', 'owner_id', 'workspace_id', 'target_id', 'scope_digest', 'request_digests_json', 'chrome_registered']);
    const primaryIndex = this.database.prepare("SELECT COUNT(*) AS count FROM pragma_index_list('approval_host_jobs') AS i JOIN pragma_index_info(i.name) AS c WHERE i.[unique]=1 AND i.partial=0 AND c.name='primary_work_id' AND (SELECT COUNT(*) FROM pragma_index_info(i.name))=1").get() as { count: number };
    if (primaryIndex.count !== 1) throw new ApprovalHostStoreError('Approval host primary work uniqueness is missing');
    assertTableColumns(this.database, 'approval_job_budgets', ['host_work_id', 'revision', 'state_json']);
    assertTableColumns(this.database, 'approval_desktop_plans', ['host_work_id', 'plan_json']);
    assertTableColumns(this.database, 'approval_desktop_selection', ['host_work_id', 'scope_key', 'active']);
    assertTableColumns(this.database, 'approval_chrome_owners', ['host_work_id', 'credential_hash', 'client_id']);
    assertTableColumns(this.database, 'approval_chrome_connections', ['host_work_id', 'session_id', 'revision']);
    const selectionIndex = this.database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='approval_desktop_one_selected'").get() as { sql?: unknown } | undefined;
    if (selectionIndex?.sql !== 'CREATE UNIQUE INDEX approval_desktop_one_selected ON approval_desktop_selection(scope_key) WHERE active=1') throw new ApprovalHostStoreError('Desktop work selection uniqueness is missing or unsupported');
    if (this.supportsContinuations) assertTableColumns(this.database, 'approval_phase_batches', ['host_work_id', 'revision', 'idempotency_key', 'batch_json']);
    else if (tables.has('approval_phase_batches')) throw new ApprovalHostStoreError('Unexpected continuation evidence in legacy journal');
    const triggers = new Set((this.database.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as Array<{ name?: unknown }>)
      .map((row) => row.name).filter((name): name is string => typeof name === 'string'));
    if (!triggers.has('approval_host_jobs_immutable_update') || !triggers.has('approval_host_jobs_immutable_delete')
      || !triggers.has('approval_desktop_plans_immutable_update') || !triggers.has('approval_desktop_plans_immutable_delete')
      || !triggers.has('approval_chrome_owners_immutable_update') || !triggers.has('approval_chrome_owners_immutable_delete')) {
      throw new ApprovalHostStoreError('Approval host store immutability triggers are missing');
    }
    if (this.supportsContinuations && (!triggers.has('approval_phase_batches_immutable_update') || !triggers.has('approval_phase_batches_immutable_delete'))) throw new ApprovalHostStoreError('Continuation immutability triggers are missing');
  }

  private transaction<T>(action: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.database.exec('COMMIT'); return value; }
    catch (cause) { try { this.database.exec('ROLLBACK'); } catch { /* preserve failure */ } throw cause; }
  }

  private assertOpen(): void { if (this.closed) throw new ApprovalHostStoreError('Approval host store is closed'); }
}

interface HostJobRow { host_work_id: unknown; primary_work_id: unknown; owner_id: unknown; workspace_id: unknown; target_id: unknown; scope_digest: unknown; request_digests_json: unknown; }
interface BudgetRow { revision: unknown; state_json: unknown; }

function decodeHostJob(row: HostJobRow): ApprovalHostJobRecord {
  if (![row.host_work_id, row.primary_work_id, row.owner_id, row.workspace_id, row.target_id, row.scope_digest, row.request_digests_json].every((value) => typeof value === 'string')) throw new ApprovalHostStoreError('Approval host job row is corrupt');
  assertPrimaryWorkId(row.primary_work_id as string);
  const identity: ApprovalJobIdentity = { hostWorkId: row.host_work_id as string, ownerId: row.owner_id as string, workspaceId: row.workspace_id as string, targetId: row.target_id as string, scopeDigest: row.scope_digest as string };
  assertApprovalJobIdentity(identity);
  let requestDigests: unknown;
  try { requestDigests = JSON.parse(row.request_digests_json as string); } catch { throw new ApprovalHostStoreError('Approval host job digest list is corrupt'); }
  if (!Array.isArray(requestDigests)) throw new ApprovalHostStoreError('Approval host job digest list is corrupt');
  assertRequestDigests(requestDigests);
  return { primaryWorkId: row.primary_work_id as string, identity, requestDigests: [...requestDigests] };
}

function decodeBudget(row: BudgetRow): ApprovalJobBudgetState {
  if (!Number.isSafeInteger(row.revision) || typeof row.state_json !== 'string') throw new ApprovalHostStoreError('Approval budget row is corrupt');
  try {
    const state = JSON.parse(row.state_json) as ApprovalJobBudgetState;
    if (typeof state !== 'object' || state === null) throw new Error('not an object');
    return state;
  } catch { throw new ApprovalHostStoreError('Approval budget JSON is corrupt'); }
}

function assertDedicatedFilename(filename: string): void {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename === ':memory:' || path.extname(filename).toLowerCase() !== '.sqlite') {
    throw new ApprovalHostStoreError('Approval host store requires an explicit absolute .sqlite fixture path');
  }
}
function createExclusiveFile(filename: string): void {
  try { closeSync(openSync(filename, 'wx')); } catch (cause) { throw new ApprovalHostStoreError(`Approval host store creation refused: ${message(cause)}`); }
}
function assertExistingFile(filename: string): void {
  try {
    if (!existsSync(filename) || !statSync(filename).isFile()) throw new Error('database file is missing');
  } catch (cause) { throw new ApprovalHostStoreError(`Approval host store opening refused: ${message(cause)}`); }
}
function assertHostWorkId(value: string): void { assertApprovalJobIdentity({ hostWorkId: value, ownerId: 'owner', workspaceId: 'workspace', targetId: 'target', scopeDigest: 'scope' }); }
function assertPrimaryWorkId(value: string): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || value !== value.trim() || /\p{Cc}/u.test(value)) {
    throw new ApprovalHostStoreError('A stable trusted primary host work ID is required');
  }
}
function assertScope(scope: ApprovalHostJobScope): void {
  assertApprovalJobIdentity({
    hostWorkId: randomUUID(),
    ownerId: scope.ownerId,
    workspaceId: scope.workspaceId,
    targetId: scope.targetId,
    scopeDigest: scope.scopeDigest,
  });
  if (!DIGEST.test(scope.scopeDigest)) throw new ApprovalHostStoreError('Approval host scope digest is invalid');
}
function assertRequestDigests(value: readonly string[]): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_000 || !value.every((digest) => typeof digest === 'string' && DIGEST.test(digest))) {
    throw new ApprovalHostStoreError('Approval host request digest plan is invalid');
  }
}
function assertTableColumns(database: DatabaseSync, table: string, expected: readonly string[]): void {
  const names = new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>)
    .map((row) => row.name).filter((name): name is string => typeof name === 'string'));
  if (expected.some((name) => !names.has(name))) throw new ApprovalHostStoreError(`Approval host store ${table} schema is unsupported`);
}
function message(cause: unknown): string { return cause instanceof Error ? cause.message : 'unknown error'; }

function assertExactTarget(tabId: unknown, pageUrl: unknown): void {
  if (typeof tabId !== 'string') throw new ApprovalHostStoreError('Exact continuation tab is required');
  assertPrimaryWorkId(tabId);
  if (typeof pageUrl !== 'string' || pageUrl.length > 512 || /\p{Cc}/u.test(pageUrl)) throw new ApprovalHostStoreError('Exact continuation page is required');
  const url = new URL(pageUrl);
  if (!['http:', 'https:'].includes(url.protocol) || pageUrl !== `${url.origin}${url.pathname}`) throw new ApprovalHostStoreError('Exact continuation origin/path is required');
}
