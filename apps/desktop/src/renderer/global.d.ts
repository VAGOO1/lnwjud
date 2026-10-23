import type { LnwjudApi } from '@lnwjud/ipc-contracts';

declare global {
  interface Window {
    readonly lnwjud: LnwjudApi;
  }
}

export {};
