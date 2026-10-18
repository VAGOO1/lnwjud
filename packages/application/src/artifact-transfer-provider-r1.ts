/** PANYA R1 source-only: Host-owned source and approval required; no live tool registration. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, lstat, open, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type InvocationAuthorization, type Result } from '@lnwjud/domain';
import { DefaultPermissionEngine, permissionProfiles, type PermissionEngine, type PermissionProfile } from '@lnwjud/permissions';
import { WorkspacePathGuard, type Workspace, type WorkspaceRepository } from '@lnwjud/workspace';
import { createGuardedWriteValidator } from './guarded-write.js';
import type { FileActor } from './file-service.js';
import type { ManagedWriterAdmissionPort } from './writer-admission.js';

const MAX_ARCHIVE = 8 * 1024 * 1024 * 1024;
const MAX_CHUNK = 8 * 1024 * 1024;
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/;
const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
export interface PinnedArtifact {
  readonly repository: string;
  readonly runId: number;
  readonly commit: string;
  readonly artifactId: number;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}
export interface ArtifactMetadata extends PinnedArtifact { readonly expired: boolean }
export interface TrustedSource {
  /** Trusted Host adapter, not arbitrary caller URL or credentials. */
  describe(): Promise<ArtifactMetadata>;
  chunks(signal?: AbortSignal): AsyncIterable<Uint8Array>;
}
export interface ArtifactAdmissionInput { readonly workspaceId: string; readonly stagingDirectory: string }
export interface ArtifactAdmissionReceipt {
  readonly verdict: 'VERIFIED_ARTIFACT_SOURCE_ONLY';
  readonly relativePath: string;
  readonly sha256: string;
  readonly bytes: number;
}
export interface ArtifactAdmissionDependencies {
  readonly workspaces: Pick<WorkspaceRepository, 'get'>;
  readonly writer: ManagedWriterAdmissionPort;
  readonly source: TrustedSource;
  /** Immutable identity supplied by an authorized Host, not a tool request. */
  readonly pinned: PinnedArtifact;
  readonly guard?: WorkspacePathGuard;
  readonly permissionEngine?: PermissionEngine;
  readonly profileProvider?: () => PermissionProfile;
}
function validStage(x: string): boolean {
  if (typeof x !== 'string' || x.length > 1024 || x.includes('\\')) return false;
  const segs = x.split('/');
  return segs.length >= 2 && segs[0] === 'staging'
    && segs.every(s => SEGMENT.test(s) && s !== '.' && s !== '..'
      && !s.endsWith('.') && !DEVICE.test(s) && s.toLowerCase() !== '.git');
}
function validPin(x: PinnedArtifact): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(x.repository)
    && Number.isSafeInteger(x.runId) && x.runId > 0
    && Number.isSafeInteger(x.artifactId) && x.artifactId > 0
    && /^[a-f0-9]{40}$/.test(x.commit) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(x.name)
    && Number.isSafeInteger(x.size) && x.size > 0 && x.size <= MAX_ARCHIVE
    && /^[a-f0-9]{64}$/.test(x.sha256);
}
function same(a: PinnedArtifact, b: PinnedArtifact): boolean {
  return a.repository === b.repository && a.runId === b.runId && a.commit === b.commit
    && a.artifactId === b.artifactId && a.name === b.name && a.size === b.size && a.sha256 === b.sha256;
}
function samePath(a: string, b: string): boolean {
  const x = path.normalize(a), y = path.normalize(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}
async function present(p: string): Promise<boolean> {
  try { await lstat(p); return true; }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
/** Require an existing staging chain. Junctions/symlinks fail even inside the workspace. */
async function existingStage(workspace: Workspace, relative: string): Promise<string> {
  const root = await realpath(workspace.rootPath);
  if (!samePath(root, await realpath(workspace.realRootPath))) throw new Error('ROOT_CHANGED');
  let current = root;
  for (const seg of relative.split('/')) {
    current = path.join(current, seg);
    const st = await lstat(current);
    if (!st.isDirectory() || st.isSymbolicLink() || !samePath(await realpath(current), current)) {
      throw new Error('UNSAFE_STAGE');
    }
  }
  return current;
}
async function diskSha256(filename: string): Promise<string> {
  const h = createHash('sha256');
  for await (const b of createReadStream(filename)) h.update(b);
  return h.digest('hex');
}
function evidence(pin: PinnedArtifact, verdict: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ schema: 'panya-transfer-r1/v1', verdict, repository: pin.repository,
    runId: pin.runId, commit: pin.commit, artifactId: pin.artifactId,
    size: pin.size, sha256: pin.sha256, ...extra }, null, 2) + '\n';
}
export class ArtifactTransferProviderR1 {
  private readonly guard: WorkspacePathGuard;
  private readonly permission: PermissionEngine;
  private readonly profile: () => PermissionProfile;
  constructor(private readonly d: ArtifactAdmissionDependencies) {
    this.guard = d.guard ?? new WorkspacePathGuard();
    this.permission = d.permissionEngine ?? new DefaultPermissionEngine();
    this.profile = d.profileProvider ?? (() => permissionProfiles.safe);
  }
  async receive(actor: FileActor, request: ArtifactAdmissionInput,
    auth?: InvocationAuthorization, signal?: AbortSignal): Promise<Result<ArtifactAdmissionReceipt>> {
    if (auth?.applicationApproved !== true || auth.mode !== 'standard' || auth.bypassApplicationAuthorization) {
      return err(appError('PERMISSION_REQUIRED', 'Exact Host approval required'));
    }
    if (!request || !/^[A-Za-z0-9._:-]{1,128}$/.test(request.workspaceId)
      || !actor.clientId || !actor.sessionId
      || !validStage(request.stagingDirectory) || !validPin(this.d.pinned)) {
      return err(appError('INVALID_INPUT', 'Invalid owner, staging path or pinned identity'));
    }
    if (signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Cancelled before transfer'));
    const workspace = await this.d.workspaces.get(request.workspaceId);
    if (workspace === null) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace unavailable'));
    if (this.permission.decide(this.profile(), { action: 'artifact_to_staging',
      level: 'WRITE', workspaceId: workspace.id, target: request.stagingDirectory, destructive: false }) === 'DENY') {
      return err(appError('PERMISSION_DENIED', 'Permission profile denied staging'));
    }
    let metadata: ArtifactMetadata;
    try { metadata = await this.d.source.describe(); }
    catch { return err(appError('INTERNAL_ERROR', 'Trusted source unavailable')); }
    if (!metadata || metadata.expired !== false || !same(this.d.pinned, metadata)) {
      return err(appError('CONFLICT', 'Unverified GitHub identity, digest or expiration'));
    }
    let stage: string;
    try { stage = await existingStage(workspace, request.stagingDirectory); }
    catch { return err(appError('CONFLICT', 'Unsafe or missing staging chain')); }
    const lease = await this.d.writer.enter({ actorClientId: actor.clientId,
      workspaceId: workspace.id, kind: 'synchronous_mutation' });
    if (!lease.ok) return lease;
    let outcome: Result<ArtifactAdmissionReceipt>;
    try { outcome = await this.transfer(workspace, request.stagingDirectory, stage, auth, signal); }
    catch { outcome = err(appError('CONFLICT', 'Transfer outcome UNKNOWN; inspect before retry')); }
    try { await lease.value.releaseAfterVerifiedTermination(); }
    catch { return err(appError('CONFLICT', 'Writer release unverified; no replay')); }
    return outcome;
  }
  private async transfer(workspace: Workspace, relative: string, stage: string,
    auth: InvocationAuthorization, signal?: AbortSignal): Promise<Result<ArtifactAdmissionReceipt>> {
    const pin = this.d.pinned;
    const stem = 'artifact-' + pin.artifactId;
    const file = (suffix: string) => path.join(stage, stem + '.' + suffix);
    const part = file('part'), zip = file('zip'), intent = file('intent.json');
    const verified = file('verified.json'), stopped = file('stop-safe.json');
    for (const target of [part, zip, intent, verified, stopped]) {
      const rel = relative + '/' + path.basename(target);
      const check = await this.guard.resolveForWrite(workspace, rel, auth);
      if (!check.ok || check.value.outsideWorkspace === true) {
        return err(appError('PERMISSION_DENIED', 'Workspace Guard rejected destination'));
      }
      if (await present(target)) return err(appError('CONFLICT', 'Existing artifact or receipt; replay forbidden'));
      if (!(await createGuardedWriteValidator(this.guard, workspace, rel, check.value, auth)()).ok) {
        return err(appError('CONFLICT', 'Destination changed during preflight'));
      }
    }
    // Create-only durable intent BEFORE touching the network. Never overwrite receipts.
    await writeFile(intent, evidence(pin, 'PENDING_NO_REPLAY'), { flag: 'wx', mode: 0o600 });
    if (!(await readFile(intent, 'utf8')).includes('PENDING_NO_REPLAY')) {
      return err(appError('CONFLICT', 'Intent readback unverified'));
    }
    let size = 0, published = false;
    try {
      const handle = await open(part, 'wx', 0o600);
      const hash = createHash('sha256');
      try {
        for await (const bytes of this.d.source.chunks(signal)) {
          if (signal?.aborted || !(bytes instanceof Uint8Array)
            || bytes.length === 0 || bytes.length > MAX_CHUNK) throw new Error('STREAM_UNSAFE');
          size += bytes.byteLength;
          if (size > pin.size) throw new Error('OVERSIZE');
          hash.update(bytes);
          await handle.writeFile(bytes);
        }
        await handle.sync();
      } finally { await handle.close(); }
      if (signal?.aborted || size !== pin.size || hash.digest('hex') !== pin.sha256) {
        throw new Error('SIZE_OR_HASH_MISMATCH');
      }
      if (!samePath(await existingStage(workspace, relative), stage)) throw new Error('STAGE_CHANGED');
      const relZip = relative + '/' + path.basename(zip);
      const guardZip = await this.guard.resolveForWrite(workspace, relZip, auth);
      if (!guardZip.ok || guardZip.value.exists
        || !(await createGuardedWriteValidator(this.guard, workspace, relZip, guardZip.value, auth)()).ok) {
        throw new Error('DESTINATION_CHANGED');
      }
      const st = await lstat(part);
      if (!st.isFile() || st.isSymbolicLink() || st.size !== size) throw new Error('PART_CHANGED');
      await link(part, zip); // Same-volume atomic CREATE_ONLY; never rename over old data.
      published = true;
      if ((await diskSha256(zip)) !== pin.sha256) throw new Error('DISK_READBACK_MISMATCH');
      await writeFile(verified, evidence(pin, 'VERIFIED_ARTIFACT_SOURCE_ONLY',
        { archivePath: relZip, diskSha256: pin.sha256 }), { flag: 'wx', mode: 0o600 });
      if (!(await readFile(verified, 'utf8')).includes('VERIFIED_ARTIFACT_SOURCE_ONLY')) {
        throw new Error('VERIFIED_RECEIPT_READBACK');
      }
      await unlink(part); // Remove only the verified temporary hardlink created by this call.
      return ok({ verdict: 'VERIFIED_ARTIFACT_SOURCE_ONLY',
        relativePath: relZip, sha256: pin.sha256, bytes: size });
    } catch {
      try {
        await writeFile(stopped, evidence(pin, 'STOP_SAFE_NO_REPLAY',
          { bytesObserved: size, destinationMayExist: published }), { flag: 'wx', mode: 0o600 });
      } catch { /* Intact intent alone prevents retry after an uncertain failure. */ }
      return err(appError('CONFLICT', 'STOP_SAFE; inspect receipt and staged bytes, never replay'));
    }
  }
}
