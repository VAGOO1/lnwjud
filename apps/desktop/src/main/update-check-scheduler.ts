export const AUTO_UPDATE_STARTUP_DELAY_MS = 5_000;
export const AUTO_UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1_000;

export interface UpdateCheckSchedulerOptions {
  readonly check: () => void;
  readonly startupDelayMs?: number;
  readonly intervalMs?: number;
  readonly checkOnStartup?: boolean;
}

export class UpdateCheckScheduler {
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;

  public constructor(private readonly options: UpdateCheckSchedulerOptions) {}

  public start(): void {
    if (this.startupTimer !== null || this.intervalTimer !== null) return;
    const startupDelayMs = this.options.startupDelayMs ?? AUTO_UPDATE_STARTUP_DELAY_MS;
    const intervalMs = this.options.intervalMs ?? AUTO_UPDATE_CHECK_INTERVAL_MS;
    if (this.options.checkOnStartup !== false) {
      this.startupTimer = setTimeout(() => {
        this.startupTimer = null;
        this.options.check();
      }, startupDelayMs);
    }
    this.intervalTimer = setInterval(() => this.options.check(), intervalMs);
  }

  public stop(): void {
    if (this.startupTimer !== null) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.intervalTimer !== null) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }
}