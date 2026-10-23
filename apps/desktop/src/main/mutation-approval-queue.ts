export interface QueuedMutationApprovalContext {
  readonly signal: AbortSignal;
  cancel(): void;
}

/** Serialises native prompts while allowing cancellation to settle callers immediately. */
export class MutationApprovalQueue {
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;
  private accepting = true;
  private readonly cancellations = new Set<() => void>();

  public request(context: QueuedMutationApprovalContext, show: () => Promise<boolean>): Promise<boolean> {
    if (!this.accepting) {
      context.cancel();
      return Promise.resolve(false);
    }
    this.cancellations.add(context.cancel);
    const generation = this.generation;
    const queued = this.tail.then(() => (
      generation === this.generation && !context.signal.aborted ? show() : false
    ));
    this.tail = queued.then(() => undefined, () => undefined);
    const settled = settleOnAbort(queued, context.signal);
    void settled.finally(() => this.cancellations.delete(context.cancel));
    return settled;
  }

  public shutdown(): void {
    this.accepting = false;
    this.generation += 1;
    for (const cancel of [...this.cancellations]) cancel();
  }
}

function settleOnAbort(approval: Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const complete = (approved: boolean): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(approved);
    };
    const onAbort = (): void => complete(false);
    signal.addEventListener('abort', onAbort, { once: true });
    void approval.then(complete, () => complete(false));
  });
}
