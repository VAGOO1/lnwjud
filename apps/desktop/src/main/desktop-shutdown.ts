export interface DesktopShutdownCoordinatorOptions {
  readonly closeRuntime: () => Promise<void>;
  readonly onDeferred: (error: Error) => void;
}

export type DesktopShutdownResult = 'quit' | 'deferred';
export type DesktopQuitIntent = 'normal' | 'install';

interface PendingQuitIntent {
  readonly intent: DesktopQuitIntent;
  readonly quit: () => void;
}

/**
 * Keeps successful shutdown idempotent while allowing a failed shutdown to be
 * attempted again. Concurrent callers share the same in-flight attempt.
 */
export function createRetryableShutdown(closeRuntime: () => Promise<void>): () => Promise<void> {
  let closing: Promise<void> | null = null;
  return (): Promise<void> => {
    if (closing !== null) return closing;
    const attempt = closeRuntime();
    closing = attempt;
    void attempt.catch(() => {
      if (closing === attempt) closing = null;
    });
    return attempt;
  };
}

/**
 * Serializes every app/update quit through the owned-runtime shutdown. A
 * failed shutdown is deliberately retryable: the application keeps running
 * with its ownership state intact instead of falling through to app.quit().
 * A later install quit can upgrade an ordinary quit while cleanup is pending.
 */
export class DesktopShutdownCoordinator {
  private shutdown: Promise<DesktopShutdownResult> | null = null;
  private quitAllowed = false;
  private quitIssued = false;
  private pendingQuit: PendingQuitIntent | null = null;

  public constructor(private readonly options: DesktopShutdownCoordinatorOptions) {}

  public canQuit(): boolean {
    return this.quitAllowed;
  }

  public requestQuit(quit: () => void, intent: DesktopQuitIntent = 'normal'): Promise<DesktopShutdownResult> {
    this.rememberQuitIntent(quit, intent);
    if (this.quitAllowed) {
      this.issuePendingQuit();
      return Promise.resolve('quit');
    }
    if (this.shutdown !== null) return this.shutdown;
    this.shutdown = this.closeThenQuit();
    return this.shutdown;
  }

  private async closeThenQuit(): Promise<DesktopShutdownResult> {
    try {
      await this.options.closeRuntime();
      this.quitAllowed = true;
      this.issuePendingQuit();
      return 'quit';
    } catch (error: unknown) {
      const normalized = error instanceof Error ? error : new Error('Desktop shutdown could not be verified');
      this.options.onDeferred(normalized);
      return 'deferred';
    } finally {
      this.shutdown = null;
    }
  }

  private rememberQuitIntent(quit: () => void, intent: DesktopQuitIntent): void {
    if (this.pendingQuit === null || quitIntentPriority(intent) > quitIntentPriority(this.pendingQuit.intent)) {
      this.pendingQuit = { intent, quit };
    }
  }

  private issuePendingQuit(): void {
    if (this.quitIssued || this.pendingQuit === null) return;
    const pending = this.pendingQuit;
    this.quitIssued = true;
    this.pendingQuit = null;
    pending.quit();
  }
}

function quitIntentPriority(intent: DesktopQuitIntent): number {
  return intent === 'install' ? 1 : 0;
}
