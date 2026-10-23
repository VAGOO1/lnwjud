export interface ContinuationStoreOptions {
  readonly maxEntries?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

interface StoredContinuation<T> {
  readonly value: T;
  readonly expiresAtMs: number;
}

const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export function scopedContinuationKey(scope: string, token: string): string {
  return `${scope.length}:${scope}:${token}`;
}

/** Bounded one-shot storage for abandoned MCP pagination tokens. */
export class ContinuationStore<T> {
  private readonly entries = new Map<string, StoredContinuation<T>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  public constructor(options: ContinuationStoreOptions = {}) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
    this.ttlMs = Math.max(1, Math.floor(options.ttlMs ?? DEFAULT_TTL_MS));
    this.now = options.now ?? Date.now;
  }

  public set(token: string, value: T): void {
    const now = this.now();
    this.pruneExpired(now);
    this.entries.delete(token);
    this.entries.set(token, { value, expiresAtMs: now + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.entries.delete(oldest);
    }
  }

  public take(token: string): T | undefined {
    this.pruneExpired(this.now());
    const stored = this.entries.get(token);
    if (stored === undefined) return undefined;
    this.entries.delete(token);
    return stored.value;
  }

  public size(): number {
    this.pruneExpired(this.now());
    return this.entries.size;
  }

  private pruneExpired(now: number): void {
    for (const [token, stored] of this.entries) {
      if (now >= stored.expiresAtMs) this.entries.delete(token);
    }
  }
}
