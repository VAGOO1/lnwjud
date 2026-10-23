import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { err, ok, type Result } from '@lnwjud/domain';
import type { FileActor } from '@lnwjud/application';
import type { McpApplicationServices } from '../../../../packages/mcp-server/src/tools/tool-types.js';
import type { DesktopApprovalWork } from './desktop-approval-work.js';
import { prepareChromeWorkLaunch, type ChromeWorkLaunch } from './chrome-work-launch.js';

type Port = NonNullable<McpApplicationServices['chromeWork']>;
type Proposal = Parameters<Port['prepare']>[1];
interface Entry {
  readonly ticket: ChromeWorkLaunch;
  readonly clientId: string;
  sessionId: string;
  readonly workspaceId: string;
  readonly fingerprint: string;
  readonly continuityToken: string;
  readonly tokenHash: Buffer;
  readonly registration: { readonly primaryWorkId: string; readonly hostWorkId: string; readonly connectionRevision: number };
}
interface Host {
  register(ticket: ChromeWorkLaunch): ReturnType<DesktopApprovalWork['registerChromeWork']>;
  reconnect(ticket: ChromeWorkLaunch, revision: number, sessionId: string): ReturnType<DesktopApprovalWork['reconnectChromeWork']>;
}

/** Transport-facing proposals are inert. Only the existing trusted Desktop review can select work. */
export function createChromeWorkMcp(host: Host, work: DesktopApprovalWork): Port {
  const entries = new Map<string, Entry>();
  const intents = new Map<string, { readonly fingerprint: string; readonly operation: Promise<Entry> }>();
  // Serialize enrollment/rebinding above await points; SQLite remains the budget's cross-process fence.
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = tail.then(operation); tail = pending.catch(() => undefined); return pending;
  };
  const checked = async (actor: FileActor, workspaceId: string, primaryWorkId: string): Promise<Entry> => {
    const entry = entries.get(primaryWorkId);
    if (entry === undefined || entry.clientId !== actor.clientId || entry.workspaceId !== workspaceId) throw new Error('CONTINUITY_UNAVAILABLE');
    await work.list(workspaceId); // Revalidate the journal; never synthesize a replacement after a fault/restart.
    return entry;
  };
  const describe = async (entry: Entry): Promise<unknown> => {
    const summary = (await work.list(entry.workspaceId)).works.find((row) => row.primaryWorkId === entry.registration.primaryWorkId);
    if (summary === undefined) throw new Error('CONTINUITY_UNAVAILABLE');
    const connection = await work.chromeConnection(entry.registration.primaryWorkId, entry.workspaceId);
    return { status: summary.selected ? 'SELECTED' : 'HOST_REVIEW_REQUIRED', ...summary, connectionRevision: connection.revision, browserActionsStartedByThisMetadataCall: false, automaticReplayAllowed: false };
  };
  const safe = async (signal: AbortSignal, operation: () => Promise<unknown>): Promise<Result<unknown>> => {
    if (signal.aborted) return err({ code: 'PROCESS_TIMEOUT', message: 'Chrome work metadata request cancelled', recoverable: false });
    try { return ok(await operation()); }
    catch (cause) {
      const known = new Set(['CONTINUITY_UNAVAILABLE', 'INTENT_CHANGED', 'EXPLICIT_CONTINUITY_REQUIRED', 'EXISTING_HOST_WORK_REQUIRES_REVIEW', 'CONTINUITY_REQUIRED', 'CANCELLED']);
      const reason = cause instanceof Error && known.has(cause.message) ? cause.message : 'HOST_CHROME_WORK_UNAVAILABLE';
      return err({ code: 'PERMISSION_DENIED', message: 'Chrome work registration or continuity could not be verified; inspect the host work without replaying', recoverable: false,
        details: { reason, automaticReplayAllowed: 0 } });
    }
  };
  return {
    prepare: (actor, proposal, signal) => safe(signal, () => serial(async () => {
      if (signal.aborted) throw new Error('CANCELLED');
      const sessionId = actor.sessionId ?? actor.clientId;
      const fingerprint = digest([proposal.workspaceId, proposal.tabId, proposal.pageUrl, proposal.requestDigests]).toString('hex');
      const key = JSON.stringify([actor.clientId, proposal.workspaceId, proposal.idempotencyKey]);
      const previous = intents.get(key);
      if (previous !== undefined && previous.fingerprint !== fingerprint) throw new Error('INTENT_CHANGED');
      const reuse = previous === undefined ? [...entries.values()].find((entry) => entry.clientId === actor.clientId && entry.fingerprint === fingerprint) : await previous.operation;
      if (reuse !== undefined) {
        if (reuse.sessionId !== sessionId) throw new Error('EXPLICIT_CONTINUITY_REQUIRED');
        intents.set(key, { fingerprint, operation: Promise.resolve(reuse) });
        return { ...await describe(reuse) as object, continuityToken: reuse.continuityToken };
      }
      const saved = (await work.list(proposal.workspaceId)).works.filter((row) => row.tabId === proposal.tabId || row.targets?.some((target) => target.tabId === proposal.tabId));
      // No in-memory ticket after process restart: retained journal evidence must not become a fresh budget.
      if (saved.some((row) => !entries.has(row.primaryWorkId) || row.selected)) throw new Error('EXISTING_HOST_WORK_REQUIRES_REVIEW');
      const operation = enroll(actor, sessionId, proposal, fingerprint);
      intents.set(key, { fingerprint, operation });
      const entry = await operation;
      return { ...await describe(entry) as object, continuityToken: entry.continuityToken };
    })),
    status: (actor, input, signal) => safe(signal, async () => {
      const entry = await checked(actor, input.workspaceId, input.primaryWorkId);
      if (entry.sessionId !== (actor.sessionId ?? actor.clientId)
        && (input.continuityToken === undefined || !timingSafeEqual(entry.tokenHash, digest(input.continuityToken)))) throw new Error('EXPLICIT_CONTINUITY_REQUIRED');
      return describe(entry);
    }),
    extend: (actor, input, proposal, signal) => safe(signal, () => serial(async () => {
      const entry = await checked(actor, input.workspaceId, input.primaryWorkId);
      if (entry.sessionId !== (actor.sessionId ?? actor.clientId) || !timingSafeEqual(entry.tokenHash, digest(input.continuityToken))) throw new Error('CONTINUITY_REQUIRED');
      const launch = await work.chromeConnection(input.primaryWorkId, input.workspaceId);
      if (launch.revision !== input.expectedConnectionRevision) throw new Error('EXPLICIT_CONTINUITY_REQUIRED');
      if (signal.aborted) throw new Error('CANCELLED');
      if (proposal.workspaceId !== input.workspaceId) throw new Error('INTENT_CHANGED');
      await work.extendChromeWork(entry.ticket, { ...input, idempotencyKey: proposal.idempotencyKey, tabId: proposal.tabId, pageUrl: proposal.pageUrl, requestDigests: proposal.requestDigests });
      return describe(entry);
    })),
    reconnect: (actor, input, signal) => safe(signal, () => serial(async () => {
      if (signal.aborted) throw new Error('CANCELLED');
      const entry = await checked(actor, input.workspaceId, input.primaryWorkId);
      if (!timingSafeEqual(entry.tokenHash, digest(input.continuityToken))) throw new Error('CONTINUITY_REQUIRED');
      if (signal.aborted) throw new Error('CANCELLED');
      const connection = await host.reconnect(entry.ticket, input.expectedConnectionRevision, actor.sessionId ?? actor.clientId);
      entry.sessionId = connection.sessionId;
      return describe(entry);
    })),
  };

  async function enroll(actor: FileActor, sessionId: string, proposal: Proposal, fingerprint: string): Promise<Entry> {
    const continuityToken = randomBytes(32).toString('base64url');
    const ticket = prepareChromeWorkLaunch({ clientId: actor.clientId, sessionId, workspaceId: proposal.workspaceId,
      tabId: proposal.tabId, pageUrl: proposal.pageUrl, requestDigests: proposal.requestDigests });
    const registration = await host.register(ticket);
    const entry: Entry = { ticket, clientId: actor.clientId, sessionId, workspaceId: proposal.workspaceId, fingerprint,
      continuityToken, tokenHash: digest(continuityToken), registration };
    entries.set(registration.primaryWorkId, entry);
    return entry;
  }
}
function digest(value: unknown): Buffer { return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest(); }
