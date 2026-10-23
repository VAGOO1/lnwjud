import { approvalWorkChannels } from '../../../../packages/ipc-contracts/src/approval-work-contracts.js';
import type { DesktopApprovalWorkList, PreparedDesktopApprovalWork, DesktopApprovalWorkResult } from '../../../../packages/ipc-contracts/src/approval-work-contracts.js';

export interface DesktopApprovalWorkControls {
  list(): Promise<DesktopApprovalWorkList>;
  prepareFromRegistry(primaryWorkId: string): Promise<PreparedDesktopApprovalWork>;
  startReviewed(reviewToken: string): Promise<DesktopApprovalWorkResult>;
  resume(primaryWorkId: string): Promise<DesktopApprovalWorkResult>;
  deactivate(primaryWorkId: string): Promise<void>;
}

export function registerApprovalWorkIpc<TEvent>(
  register: (channel: string, handler: (event: TEvent, payload: unknown) => unknown | Promise<unknown>) => void,
  authorize: (event: TEvent) => void,
  work: () => DesktopApprovalWorkControls | undefined,
): void {
  register(approvalWorkChannels.list, async (event, payload) => {
    authorize(event);
    if (payload !== undefined) throw new Error('Desktop work listing takes no payload');
    return required(work()).list();
  });
  register(approvalWorkChannels.prepare, async (event, payload) => {
    authorize(event); const value = confirmed(payload, ['primaryWorkId', 'userConfirmed']);
    return required(work()).prepareFromRegistry(primaryId(value.primaryWorkId));
  });
  register(approvalWorkChannels.start, async (event, payload) => {
    authorize(event); const value = confirmed(payload, ['reviewToken', 'userConfirmed']);
    return required(work()).startReviewed(primaryId(value.reviewToken));
  });
  register(approvalWorkChannels.resume, async (event, payload) => {
    authorize(event); const value = confirmed(payload, ['primaryWorkId', 'userConfirmed']);
    return required(work()).resume(primaryId(value.primaryWorkId));
  });
  register(approvalWorkChannels.deactivate, async (event, payload) => {
    authorize(event); const value = confirmed(payload, ['primaryWorkId', 'userConfirmed']);
    await required(work()).deactivate(primaryId(value.primaryWorkId));
    return { deactivated: true as const };
  });
}
function confirmed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || (value as Record<string, unknown>).userConfirmed !== true || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('Explicit Desktop work confirmation is required');
  return value as Record<string, unknown>;
}
function primaryId(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || value !== value.trim() || /\p{Cc}/u.test(value)) throw new Error('Invalid primary work ID');
  return value;
}
function required<T>(value: T | undefined): T { if (value === undefined) throw new Error('Desktop approval work is unavailable'); return value; }
