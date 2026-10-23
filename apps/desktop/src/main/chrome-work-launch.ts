import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { snapshotPlan, type ApprovalHostPlan } from './approval-host-runtime.js';

/** Main-process capability. Its JSON representation is never launch or continuity authority. */
export interface ChromeWorkLaunch { readonly chromeWorkLaunch: true; }
const launches = new WeakMap<ChromeWorkLaunch, { readonly plan: ApprovalHostPlan; readonly credentialHash: string }>();

/** Called by the host work owner with its full plan before any browser mutation. */
export function prepareChromeWorkLaunch(input: Omit<ApprovalHostPlan, 'primaryWorkId'>): ChromeWorkLaunch {
  const plan = snapshotPlan({ ...input, primaryWorkId: `chrome-${randomUUID()}` });
  if (new Set(plan.requestDigests).size !== plan.requestDigests.length) throw new Error('Chrome launch phases must be unambiguous');
  const ticket = Object.freeze({ chromeWorkLaunch: true as const });
  launches.set(ticket, Object.freeze({ plan, credentialHash: createHash('sha256').update(randomBytes(32)).digest('hex') }));
  return ticket;
}

export function readChromeWorkLaunch(value: unknown): { readonly plan: ApprovalHostPlan; readonly credentialHash: string } {
  const launch = typeof value === 'object' && value !== null ? launches.get(value as ChromeWorkLaunch) : undefined;
  if (launch === undefined) throw new Error('Host Chrome launch capability is required');
  return launch;
}
