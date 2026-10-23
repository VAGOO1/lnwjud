import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type DesktopSessionState = 'running' | 'shutdown_requested' | 'clean_exit';

export interface DesktopSessionRecord {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly pid: number;
  readonly appVersion: string;
  readonly electronVersion: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly processStartedAt: string;
  readonly startedAt: string;
  readonly lastHeartbeatAt: string;
  readonly state: DesktopSessionState;
  readonly shutdownReason?: string;
  readonly cleanExitAt?: string;
}

export interface DesktopSessionSnapshot {
  readonly schemaVersion: 1;
  readonly current: DesktopSessionRecord;
  readonly previous: DesktopSessionRecord | null;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const SESSION_FILE = 'desktop-session.json';

export class DesktopSessionDiagnostics {
  public readonly filePath: string;
  private readonly previous: DesktopSessionRecord | null;
  private current: DesktopSessionRecord;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  public constructor(
    dataPath: string,
    appVersion: string,
    private readonly now: () => Date = () => new Date(),
    private readonly onPersistError: (error: unknown) => void = () => undefined,
  ) {
    this.filePath = path.join(dataPath, 'diagnostics', SESSION_FILE);
    const previousSnapshot = readDesktopSessionSnapshot(dataPath);
    this.previous = previousSnapshot?.current ?? null;
    const started = this.now();
    this.current = {
      schemaVersion: 1,
      sessionId: randomUUID(),
      pid: process.pid,
      appVersion,
      electronVersion: process.versions.electron ?? 'unknown',
      platform: process.platform,
      arch: process.arch,
      processStartedAt: new Date(started.getTime() - Math.max(0, process.uptime() * 1000)).toISOString(),
      startedAt: started.toISOString(),
      lastHeartbeatAt: started.toISOString(),
      state: 'running',
    };
  }

  public start(): void {
    if (this.heartbeatTimer !== null) return;
    this.persist();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  public markShutdownRequested(reason: string): void {
    if (this.current.state === 'clean_exit') return;
    const timestamp = this.now().toISOString();
    this.current = { ...this.current, state: 'shutdown_requested', lastHeartbeatAt: timestamp, shutdownReason: reason.slice(0, 256) };
    this.persist();
  }

  public markCleanExit(): void {
    const timestamp = this.now().toISOString();
    this.current = { ...this.current, state: 'clean_exit', lastHeartbeatAt: timestamp, cleanExitAt: timestamp };
    this.persist();
    this.stopHeartbeat();
  }

  public snapshot(): DesktopSessionSnapshot {
    return { schemaVersion: 1, current: this.current, previous: this.previous };
  }

  private heartbeat(): void {
    if (this.current.state === 'clean_exit') return;
    this.current = { ...this.current, lastHeartbeatAt: this.now().toISOString() };
    this.persist();
  }

  private persist(): void {
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileSync(tempPath, `${JSON.stringify(this.snapshot())}\n`, 'utf8');
      renameSync(tempPath, this.filePath);
    } catch (error: unknown) {
      try { rmSync(tempPath, { force: true }); } catch { /* best-effort cleanup */ }
      this.onPersistError(error);
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === null) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}

export function readDesktopSessionSnapshot(dataPath: string): DesktopSessionSnapshot | null {
  const filePath = path.join(dataPath, 'diagnostics', SESSION_FILE);
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return isDesktopSessionSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}


export function previousDesktopSessionEndedUncleanly(snapshot: DesktopSessionSnapshot | null): boolean {
  return snapshot !== null && snapshot.previous !== null && snapshot.previous.state !== 'clean_exit';
}

function isDesktopSessionSnapshot(value: unknown): value is DesktopSessionSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { schemaVersion?: unknown; current?: unknown; previous?: unknown };
  return candidate.schemaVersion === 1
    && isDesktopSessionRecord(candidate.current)
    && (candidate.previous === null || isDesktopSessionRecord(candidate.previous));
}

function isDesktopSessionRecord(value: unknown): value is DesktopSessionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.schemaVersion === 1
    && typeof candidate.sessionId === 'string'
    && typeof candidate.pid === 'number'
    && typeof candidate.appVersion === 'string'
    && typeof candidate.electronVersion === 'string'
    && typeof candidate.platform === 'string'
    && typeof candidate.arch === 'string'
    && typeof candidate.processStartedAt === 'string'
    && typeof candidate.startedAt === 'string'
    && typeof candidate.lastHeartbeatAt === 'string'
    && (candidate.state === 'running' || candidate.state === 'shutdown_requested' || candidate.state === 'clean_exit');
}
