import { createHash } from 'node:crypto';

/** Stable display form used to bind a gate claim to its host-launched command. */
export function formatEngineeringCommand(executable: string, args: readonly string[]): string {
  const display = (part: string): string => /^[A-Za-z0-9_./:@+\\-]+$/.test(part) ? part : JSON.stringify(part);
  return [executable, ...args].map(display).join(' ');
}

export function engineeringCommandFingerprint(command: string): string {
  return createHash('sha256').update(command).digest('hex');
}
