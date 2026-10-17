// PANYA P1 source-only integration candidate; pinned upstream v5.8.7 / MIT notice retained in LICENSE.
import type { Result } from '@lnwjud/domain';
import type { WindowsContainedLaunch } from '@lnwjud/process';

export interface ManagedWriterAdmissionLease {
  readonly id: string;
  /** Release only when the mutation and all child processes are provably terminal. */
  releaseAfterVerifiedTermination(): Promise<void>;
  /** Binds Host-owned job receipt proof under the index lock, BEFORE child spawn. */
  bindNativeReceipt?(launch: WindowsContainedLaunch): Promise<Result<void>>;
}

export interface ManagedWriterAdmissionPort {
  enter(input: {
    readonly actorClientId: string;
    readonly workspaceId: string;
    readonly kind: 'synchronous_mutation' | 'uncontained_process' | 'contained_process';
    readonly nativeReceiptPath?: string;
  }): Promise<Result<ManagedWriterAdmissionLease>>;
}
