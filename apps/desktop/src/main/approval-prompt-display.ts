/** Optional host-owned lifecycle; neither renderer events nor caller fields grant approval. */
export interface ApprovalPromptDisplayGate {
  readonly signal?: AbortSignal;
  beforeShow(): Promise<boolean>;
  onShown(): Promise<boolean>;
}

export interface ApprovalPromptWindow {
  show(): void;
  focus(): void;
  close(): void;
  isDestroyed(): boolean;
  on(event: 'show', listener: () => void): unknown;
  once(event: 'ready-to-show' | 'closed', listener: () => void): unknown;
}

/** Every show() entry is gated; only Electron's actual show event records a display. */
export function attachApprovalPromptDisplay(window: ApprovalPromptWindow, gate?: ApprovalPromptDisplayGate): void {
  const close = (): void => { if (!window.isDestroyed()) window.close(); };
  if (gate !== undefined) {
    const nativeShow = window.show.bind(window);
    let revealing = false;
    let revealed = false;
    window.show = (): void => {
      if (window.isDestroyed() || revealing) return;
      // A pending prompt never needs to hide/reopen; a new display needs a new reservation.
      if (revealed || gate.signal?.aborted) { close(); return; }
      revealing = true;
      void gate.beforeShow().then((allowed) => {
        if (!allowed || window.isDestroyed() || gate.signal?.aborted) { close(); return; }
        revealed = true;
        nativeShow();
        if (!window.isDestroyed()) window.focus();
      }).catch(close).finally(() => { revealing = false; });
    };
    window.on('show', () => {
      void gate.onShown().then((recorded) => { if (!recorded) close(); }).catch(close);
    });
    const onAbort = (): void => close();
    gate.signal?.addEventListener('abort', onAbort, { once: true });
    window.once('closed', () => { gate.signal?.removeEventListener('abort', onAbort); });
    if (gate.signal?.aborted) close();
  }
  window.once('ready-to-show', () => {
    if (window.isDestroyed()) return;
    window.show();
    if (gate === undefined) window.focus();
  });
}
