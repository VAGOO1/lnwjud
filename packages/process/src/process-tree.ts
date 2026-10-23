import type { ChildProcess } from 'node:child_process';
import { PosixProcessTree } from './posix-process-tree.js';
import { WindowsProcessTree } from './windows-process-tree.js';

/**
 * Host-neutral process-tree termination contract.
 *
 * Implementations must return only after the owned process tree is known to
 * be gone.  A rejected promise means that ownership or termination could not
 * be proven; callers must keep the task in an unverified state.
 */
export interface ProcessTreeTerminator {
  stop(child: ChildProcess, pid: number): Promise<void>;
  /**
   * Stop an externally-owned process tree when no ChildProcess handle exists.
   * Implementations may omit this only for legacy test doubles; production
   * terminators expose it so stdio transports cannot leak descendants.
   */
  stopPid?(pid: number): Promise<void>;
}

/** Select the one process implementation for the current composition root. */
export function createProcessTreeTerminator(platform: NodeJS.Platform = process.platform): ProcessTreeTerminator {
  return platform === 'win32'
    ? new WindowsProcessTree({ platform })
    : new PosixProcessTree({ platform });
}
