import type { ActivitySessionSummary, AuditEventRepository } from '@lnwjud/audit';
import type { LogSessionSummary } from '@lnwjud/ipc-contracts';

interface SessionVisibility {
  isVisible(event: { readonly timestamp: string; readonly workspaceId?: string; readonly sessionId?: string }): boolean;
}

export class ActivitySessionCatalog {
  private readonly sessions = new Map<string, ActivitySessionSummary>();
  private loaded = false;
  private loading: Promise<void> | null = null;

  public constructor(
    private readonly repository: Pick<AuditEventRepository, 'listActivitySessions'>,
    private readonly visibility: SessionVisibility,
  ) {}

  public record(event: { readonly timestamp: string; readonly workspaceId?: string; readonly sessionId?: string }): void {
    if (event.sessionId === undefined) return;
    this.merge({
      sessionId: event.sessionId,
      ...(event.workspaceId === undefined ? {} : { workspaceId: event.workspaceId }),
      startedAt: event.timestamp,
      lastActivityAt: event.timestamp,
    });
  }

  public async list(): Promise<readonly LogSessionSummary[]> {
    await this.ensureLoaded();
    return [...this.sessions.values()]
      .filter((session) => this.visibility.isVisible({
        timestamp: session.lastActivityAt,
        ...(session.workspaceId === undefined ? {} : { workspaceId: session.workspaceId }),
        sessionId: session.sessionId,
      }))
      .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt) || left.sessionId.localeCompare(right.sessionId))
      .map((session) => ({
        sessionId: session.sessionId,
        workspaceId: session.workspaceId ?? null,
        startedAt: session.startedAt,
        lastActivityAt: session.lastActivityAt,
      }));
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loading !== null) return this.loading;
    this.loading = this.repository.listActivitySessions('mcp_tool:').then((sessions) => {
      for (const session of sessions) this.merge(session);
      this.loaded = true;
    }).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private merge(session: ActivitySessionSummary): void {
    const key = `${session.sessionId}\0${session.workspaceId ?? ''}`;
    const existing = this.sessions.get(key);
    if (existing === undefined) {
      this.sessions.set(key, session);
      return;
    }
    this.sessions.set(key, {
      sessionId: session.sessionId,
      ...(session.workspaceId === undefined ? {} : { workspaceId: session.workspaceId }),
      startedAt: existing.startedAt <= session.startedAt ? existing.startedAt : session.startedAt,
      lastActivityAt: existing.lastActivityAt >= session.lastActivityAt ? existing.lastActivityAt : session.lastActivityAt,
    });
  }
}
