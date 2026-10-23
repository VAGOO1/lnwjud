import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type InvocationAuthorization, type Result } from '@lnwjud/domain';
import { CodexRulesProbe, type RulesProbeEvidence } from './codex-rules-probe.js';

const MAX_BYTES = 256 * 1024, TTL = 120_000, HASH = /^[a-f0-9]{64}$/i, ID = /^[a-f0-9-]{16,128}$/i;
export type CodexRulesTarget = 'global' | 'override';
export interface CodexRulesServiceDependencies { readonly codexHomeProvider?: () => string | undefined; readonly backupRootProvider?: () => string; readonly hostIdentityProvider?: () => string; readonly now?: () => Date; readonly idFactory?: () => string; /** Trusted test/host checkpoint; never exposed through MCP. */ readonly beforeCommit?: () => Promise<void>; }
export interface CodexRulesSnapshot { readonly snapshotId: string; readonly target: CodexRulesTarget; readonly canonicalPath: string; readonly exists: boolean; readonly oldSha256: string | null; readonly byteLength: number; readonly overridePresent: boolean; readonly expiresAt: string; }
export interface CodexRulesApplyReceipt { readonly target: CodexRulesTarget; readonly canonicalPath: string; readonly oldSha256: string | null; readonly newSha256: string; readonly backupId: string; readonly backupSha256: string | null; }
interface Target { readonly target: CodexRulesTarget; readonly file: string; readonly other: string; }
interface Snapshot { readonly owner: string; readonly host: string; readonly target: Target; readonly oldHash: string | null; readonly expiry: number; }
interface Manifest { readonly version: 1; readonly backupId: string; readonly owner: string; readonly target: CodexRulesTarget; readonly targetPath: string; readonly host: string; readonly originalExisted: boolean; readonly oldSha256: string | null; readonly newSha256: string; readonly backupFile: string | null; readonly backupSha256: string | null; }

/** Exact-file, host-owned rule deployment. No user path is accepted. Every operation requires native host approval. */
export class CodexRulesService {
  private readonly probeService = new CodexRulesProbe();
  private readonly beforeCommit: (() => Promise<void>) | undefined;
  private readonly home: () => string | undefined; private readonly backupRoot: () => string; private readonly identity: () => string; private readonly now: () => Date; private readonly ids: () => string; private readonly snapshots = new Map<string, Snapshot>();
  public constructor(d: CodexRulesServiceDependencies = {}) {
    this.home = d.codexHomeProvider ?? ((): string | undefined => process.env.CODEX_HOME ?? (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.codex') : undefined));
    this.backupRoot = d.backupRootProvider ?? ((): string => path.join(process.cwd(), '.lnwjud-data', 'codex-rules-backups'));
    this.identity = d.hostIdentityProvider ?? ((): string => `${process.env.USERNAME ?? 'unknown'}@${process.env.COMPUTERNAME ?? 'unknown'}`);
    this.now = d.now ?? ((): Date => new Date()); this.ids = d.idFactory ?? randomUUID; this.beforeCommit = d.beforeCommit;
  }
  public async inspect(owner: string, target: CodexRulesTarget, auth: InvocationAuthorization | undefined, signal?: AbortSignal): Promise<Result<CodexRulesSnapshot>> {
    if (!approved(auth)) return denied(); if (signal?.aborted) return cancelled();
    const resolved = await this.resolve(target); if (!resolved.ok) return resolved;
    const current = await readSafe(resolved.value.file, true); if (!current.ok) return current;
    const other = await readSafe(resolved.value.other, true); if (!other.ok) return other;
    if (signal?.aborted) return cancelled();
    const snapshotId = this.ids(), expiry = this.now().getTime() + TTL, oldHash = current.value ? digest(current.value) : null;
    this.snapshots.set(snapshotId, { owner, host: this.identity(), target: resolved.value, oldHash, expiry });
    return ok({ snapshotId, target, canonicalPath: resolved.value.file, exists: current.value !== null, oldSha256: oldHash, byteLength: current.value?.byteLength ?? 0, overridePresent: other.value !== null, expiresAt: new Date(expiry).toISOString() });
  }

  /** Metadata only: no global rule bytes are opened before native approval. */
  public async approvalMetadata(owner: string, operation: string, target: CodexRulesTarget, id?: string): Promise<Result<{ canonicalPath: string; target: CodexRulesTarget }>> {
    if (operation === 'backup_apply') {
      const snapshot = id === undefined ? undefined : this.snapshots.get(id);
      if (!snapshot || snapshot.owner !== owner || snapshot.expiry <= this.now().getTime()) return denied();
      return ok({ canonicalPath: snapshot.target.file, target: snapshot.target.target });
    }
    if (operation === 'rollback') {
      if (!id || !ID.test(id)) return denied();
      const manifest = await this.manifest(id);
      if (!manifest.ok || manifest.value.owner !== owner || manifest.value.host !== this.identity()) return denied();
      target = manifest.value.target;
    }
    const home = this.home()?.trim();
    if (!home || !path.isAbsolute(home)) return denied();
    return ok({ canonicalPath: path.join(path.resolve(home), target === 'override' ? 'AGENTS.override.md' : 'AGENTS.md'), target });
  }

  public async probeNewSession(owner: string, target: CodexRulesTarget, expected: string, auth: InvocationAuthorization | undefined, signal?: AbortSignal): Promise<Result<RulesProbeEvidence>> {
    if (!approved(auth)) return denied();
    if (!HASH.test(expected) || signal?.aborted) return cancelled();
    const resolved = await this.resolve(target);
    if (!resolved.ok) return resolved;
    const current = await readSafe(resolved.value.file, false);
    if (!current.ok) return current;
    if (!current.value || digest(current.value) !== expected.toLowerCase()) return err(appError('CONFLICT', 'Rule hash differs from approved probe'));
    if (target === 'global') {
      const override = await readSafe(resolved.value.other, true);
      if (!override.ok) return override;
      if (override.value?.length) return err(appError('CONFLICT', 'Global rule is shadowed by AGENTS.override.md'));
    }
    return this.probeService.start(owner, path.dirname(resolved.value.file), await this.root(), resolved.value.file, current.value.toString('utf8'), expected.toLowerCase(), signal);
  }

  public async probeStatus(owner: string, id: string, auth: InvocationAuthorization | undefined, signal?: AbortSignal): Promise<Result<RulesProbeEvidence>> {
    if (!approved(auth)) return denied();
    return this.probeService.status(owner, id, signal);
  }
  public async backupApply(owner: string, snapshotId: string, expectedOldHash: string | null, source: Buffer, sourceHash: string, auth: InvocationAuthorization | undefined, signal?: AbortSignal): Promise<Result<CodexRulesApplyReceipt>> {
    if (!approved(auth)) return denied(); if ((expectedOldHash !== null && !HASH.test(expectedOldHash)) || !HASH.test(sourceHash) || source.byteLength > MAX_BYTES || digest(source) !== sourceHash.toLowerCase()) return err(appError('INVALID_INPUT', 'Source content does not match declared SHA-256'));
    if (signal?.aborted) return cancelled();
    const snap = this.take(owner, snapshotId); if (!snap.ok) return snap;
    if (snap.value.oldHash !== (expectedOldHash === null ? null : expectedOldHash.toLowerCase())) return err(appError('CONFLICT', 'Declared old SHA-256 does not match approved inspection'));
    const resolved = await this.resolve(snap.value.target.target);
    if (!resolved.ok || resolved.value.file !== snap.value.target.file || this.identity() !== snap.value.host) return err(appError('CONFLICT', 'Host or target changed after inspection'));
    const other = await readSafe(resolved.value.other, true); if (!other.ok) return other;
    if (resolved.value.target === 'global' && other.value !== null) return err(appError('CONFLICT', 'AGENTS.override.md is present; inspect and select override explicitly'));
    const current = await readSafe(resolved.value.file, true); if (!current.ok) return current;
    const oldHash = current.value ? digest(current.value) : null;
    if (oldHash !== snap.value.oldHash) return err(appError('CONFLICT', 'Target changed since inspection; refusing replacement'));
    if (signal?.aborted) return cancelled();
    const backupId = this.ids(); if (!ID.test(backupId)) return err(appError('INTERNAL_ERROR', 'Invalid generated backup identifier', true));
    const files = await this.backupFiles(backupId, current.value !== null); if (!files.ok) return files;
    if (current.value !== null) { const saved = await writeNew(files.value.backup!, current.value); if (!saved.ok) return saved; const checked = await readSafe(files.value.backup!, false); if (!checked.ok || checked.value === null || digest(checked.value) !== oldHash) return err(appError('INTERNAL_ERROR', 'Backup verification failed; target unchanged', true)); }
    // Persist recovery identity before publishing the replacement, including a crash between these steps.
    const manifest: Manifest = { version: 1, backupId, owner, target: resolved.value.target, targetPath: resolved.value.file, host: snap.value.host, originalExisted: current.value !== null, oldSha256: oldHash, newSha256: sourceHash.toLowerCase(), backupFile: files.value.name, backupSha256: oldHash };
    const recorded = await writeNew(files.value.manifest, Buffer.from(JSON.stringify(manifest), 'utf8'));
    if (!recorded.ok) return recorded;
    await this.beforeCommit?.();
    if (signal?.aborted) return cancelled();
    const commitCheck = await readSafe(resolved.value.file, true); if (!commitCheck.ok) return commitCheck;
    if ((commitCheck.value === null ? null : digest(commitCheck.value)) !== oldHash) return err(appError('CONFLICT', 'Target changed while preparing backup; refusing replacement'));
    const published = await replace(resolved.value.file, source, oldHash, signal); if (!published.ok) return published;
    const readback = await readSafe(resolved.value.file, false);
    if (!readback.ok || readback.value === null || digest(readback.value) !== sourceHash.toLowerCase()) { const restored = await this.restore(resolved.value.file, current.value, sourceHash.toLowerCase()); return err(appError('INTERNAL_ERROR', restored ? 'Readback failed; original was restored' : 'Readback failed; recovery is UNKNOWN', true)); }
    return ok({ target: resolved.value.target, canonicalPath: resolved.value.file, oldSha256: oldHash, newSha256: sourceHash.toLowerCase(), backupId, backupSha256: oldHash });
  }
  public async rollback(owner: string, backupId: string, expected: string, auth: InvocationAuthorization | undefined, signal?: AbortSignal): Promise<Result<{ readonly target: CodexRulesTarget; readonly canonicalPath: string; readonly restoredSha256: string | null }>> {
    if (!approved(auth)) return denied(); if (!owner || !ID.test(backupId) || !HASH.test(expected)) return err(appError('INVALID_INPUT', 'Invalid rollback input')); if (signal?.aborted) return cancelled();
    const manifest = await this.manifest(backupId); if (!manifest.ok) return manifest;
    const resolved = await this.resolve(manifest.value.target);
    if (!resolved.ok || resolved.value.file !== manifest.value.targetPath || this.identity() !== manifest.value.host || manifest.value.owner !== owner) return err(appError('CONFLICT', 'Rollback target, caller, or host mismatch'));
    const current = await readSafe(resolved.value.file, true); if (!current.ok || current.value === null) return current.ok ? err(appError('CONFLICT', 'Rule target missing; refusing rollback')) : current;
    if (digest(current.value) !== expected.toLowerCase() || digest(current.value) !== manifest.value.newSha256) return err(appError('CONFLICT', 'Rule changed since apply; refusing rollback'));
    if (signal?.aborted) return cancelled();
    if (manifest.value.originalExisted) {
      if (!manifest.value.backupFile || !manifest.value.backupSha256) return err(appError('INTERNAL_ERROR', 'Incomplete receipt', true));
      const old = await readSafe(path.join(await this.root(), manifest.value.backupFile), false);
      if (!old.ok || old.value === null || digest(old.value) !== manifest.value.backupSha256) return err(appError('CONFLICT', 'Owned backup missing or changed'));
      const written = await replace(resolved.value.file, old.value, expected.toLowerCase(), signal);
      if (!written.ok) return written;
    } else {
      const checked = await readSafe(resolved.value.file, false);
      if (!checked.ok || !checked.value || digest(checked.value) !== expected.toLowerCase() || signal?.aborted) return err(appError('CONFLICT', 'Target changed or rollback cancelled'));
      try { await unlink(resolved.value.file); } catch (e: unknown) { return err(appError('INTERNAL_ERROR', `Unable to remove new rule: ${msg(e)}`, true)); }
    }
    const verified = await readSafe(resolved.value.file, true);
    if (!verified.ok || (manifest.value.originalExisted ? verified.value === null || digest(verified.value) !== manifest.value.oldSha256 : verified.value !== null)) return err(appError('INTERNAL_ERROR', 'Rollback readback failed; recovery is UNKNOWN', true));
    return ok({ target: resolved.value.target, canonicalPath: resolved.value.file, restoredSha256: manifest.value.oldSha256 });
  }
  private take(owner: string, id: string): Result<Snapshot> { const snapshot = this.snapshots.get(id); if (snapshot?.owner === owner) this.snapshots.delete(id); return snapshot === undefined || snapshot.owner !== owner || snapshot.expiry <= this.now().getTime() ? err(appError('PERMISSION_DENIED', 'Snapshot missing, expired, consumed, or belongs to another caller')) : ok(snapshot); }
  private async resolve(target: CodexRulesTarget): Promise<Result<Target>> {
    const home = this.home()?.trim();
    if (!home || !path.isAbsolute(home)) return err(appError('PERMISSION_DENIED', 'Effective CODEX_HOME is unavailable'));
    const root = path.resolve(home);
    try { await canonicalDirectory(root); } catch (e: unknown) { return err(appError('PERMISSION_DENIED', `CODEX_HOME is not canonical: ${msg(e)}`)); }
    return ok({ target, file: path.join(root, target === 'global' ? 'AGENTS.md' : 'AGENTS.override.md'), other: path.join(root, target === 'global' ? 'AGENTS.override.md' : 'AGENTS.md') });
  }
  private async root(): Promise<string> { const root = path.resolve(this.backupRoot()); await mkdir(root, { recursive: true, mode: 0o700 }); await canonicalDirectory(root); return root; }
  private async backupFiles(id: string, existed: boolean): Promise<Result<{ readonly backup: string | null; readonly name: string | null; readonly manifest: string }>> { try { const root = await this.root(), name = existed ? `${id}.bak` : null; return ok({ backup: name ? path.join(root, name) : null, name, manifest: path.join(root, `${id}.json`) }); } catch (e: unknown) { return err(appError('INTERNAL_ERROR', `Unable to prepare backup: ${msg(e)}`, true)); } }
  private async manifest(id: string): Promise<Result<Manifest>> {
    try {
      const bytes = await readSafe(path.join(await this.root(), `${id}.json`), false);
      if (!bytes.ok || !bytes.value) return err(appError('CONFLICT', 'Rollback receipt unavailable'));
      const value: unknown = JSON.parse(bytes.value.toString('utf8'));
      return isManifest(value) && value.backupId === id && value.oldSha256 === value.backupSha256
        && value.backupFile === (value.originalExisted ? `${id}.bak` : null)
        ? ok(value) : err(appError('CONFLICT', 'Malformed rollback receipt'));
    } catch (e: unknown) { return err(appError('FILE_NOT_FOUND', `Unable to read rollback receipt: ${msg(e)}`)); }
  }
  private async restore(file: string, old: Buffer | null, newHash: string): Promise<boolean> {
    const current = await readSafe(file, true);
    if (!current.ok || current.value === null || digest(current.value) !== newHash) return false;
    if (old === null) await unlink(file).catch(() => undefined);
    else if (!(await replace(file, old, newHash)).ok) return false;
    const checked = await readSafe(file, true);
    return checked.ok && (old === null ? checked.value === null : checked.value !== null && digest(checked.value) === digest(old));
  }
}
function approved(a: InvocationAuthorization | undefined): boolean { return a?.applicationApproved === true && a.source === 'host_approval'; } function denied(): Result<never> { return err(appError('PERMISSION_DENIED', 'codex_rules requires fresh native host approval')); } function cancelled(): Result<never> { return err(appError('PROCESS_TIMEOUT', 'codex_rules cancelled before side effect', true)); } function digest(value: Buffer): string { return createHash('sha256').update(value).digest('hex'); } function msg(e: unknown): string { return e instanceof Error ? e.message : 'unknown error'; } function missing(e: unknown): boolean { return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'ENOENT'; }
async function readSafe(file: string, allowMissing: boolean): Promise<Result<Buffer | null>> {
  try {
    await canonicalDirectory(path.dirname(file));
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return err(appError('PERMISSION_DENIED', 'Rule path must be a regular non-link file'));
    if (stat.size > MAX_BYTES) return err(appError('INVALID_INPUT', 'Rule file exceeds 256 KiB'));
    const bytes = await readFile(file);
    return bytes.byteLength > MAX_BYTES ? err(appError('INVALID_INPUT', 'Rule file exceeds 256 KiB')) : ok(bytes);
  } catch (e: unknown) { return allowMissing && missing(e) ? ok(null) : err(appError(missing(e) ? 'FILE_NOT_FOUND' : 'INTERNAL_ERROR', `Unable to read rule path: ${msg(e)}`)); }
}
async function writeNew(file: string, bytes: Buffer): Promise<Result<void>> { try { await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); return ok(undefined); } catch (e: unknown) { return err(appError('CONFLICT', `Unable to create backup: ${msg(e)}`)); } }
async function replace(file: string, bytes: Buffer, expected?: string | null, signal?: AbortSignal): Promise<Result<void>> {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.lnwjud-${randomUUID()}.tmp`);
  try {
    await canonicalDirectory(path.dirname(file));
    await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
    const checked = await readSafe(file, true);
    if (!checked.ok) throw Error(checked.error.message);
    if (expected !== undefined && (checked.value === null ? null : digest(checked.value)) !== expected) throw Error('Target changed immediately before replace');
    if (signal?.aborted) throw Error('Request cancelled before replace');
    await rename(temp, file);
    return ok(undefined);
  } catch (e: unknown) { await rm(temp, { force: true }).catch(() => undefined); return err(appError('CONFLICT', `Atomic replacement refused: ${msg(e)}`, true)); }
}
async function canonicalDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory), actual = await realpath(directory), expected = path.resolve(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform === 'win32' ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected)) throw Error('Directory or ancestor is a link/reparse path');
}
function isManifest(value: unknown): value is Manifest { if (typeof value !== 'object' || value === null) return false; const x = value as Partial<Manifest>; return x.version === 1 && typeof x.backupId === 'string' && ID.test(x.backupId) && typeof x.owner === 'string' && (x.target === 'global' || x.target === 'override') && typeof x.targetPath === 'string' && typeof x.host === 'string' && typeof x.originalExisted === 'boolean' && (x.oldSha256 === null || typeof x.oldSha256 === 'string' && HASH.test(x.oldSha256)) && typeof x.newSha256 === 'string' && HASH.test(x.newSha256) && (x.backupFile === null || typeof x.backupFile === 'string' && /^[a-f0-9-]+\.bak$/i.test(x.backupFile)) && (x.backupSha256 === null || typeof x.backupSha256 === 'string' && HASH.test(x.backupSha256)); }
