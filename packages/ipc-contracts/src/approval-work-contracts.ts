/** Desktop host lifecycle only; these channels are not MCP tools or action approval. */
export const approvalWorkChannels = {
  list: 'lnwjud:list-approval-works', prepare: 'lnwjud:prepare-approval-work',
  start: 'lnwjud:start-approval-work', resume: 'lnwjud:resume-approval-work', deactivate: 'lnwjud:deactivate-approval-work',
} as const;
export interface StartDesktopApprovalWorkRequest { readonly reviewToken: string; readonly userConfirmed: true; }
export interface SelectDesktopApprovalWorkRequest { readonly primaryWorkId: string; readonly userConfirmed: true; }
export interface DesktopApprovalWorkResult { readonly hostWorkId: string; }
/** Display-only fields; owner/session identities and action plans never cross into renderer. */
export interface DesktopApprovalWorkSummary {
  readonly primaryWorkId: string;
  readonly hostWorkId: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly pageUrl: string;
  readonly selected: boolean;
  readonly shown: number;
  readonly remaining: number;
  readonly limit: 3;
  readonly blocked: number;
  readonly inDoubt: number;
  readonly revision: number;
  readonly continuationRevision?: number;
  readonly targets?: readonly { readonly tabId: string; readonly pageUrl: string }[];
}
export interface DesktopApprovalWorkList { readonly workspaceId: string | null; readonly works: readonly DesktopApprovalWorkSummary[]; }
export interface PreparedDesktopApprovalWork { readonly reviewToken: string; readonly expiresAt: number; readonly work: DesktopApprovalWorkSummary; }
