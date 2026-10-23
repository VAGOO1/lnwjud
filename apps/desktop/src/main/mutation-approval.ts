import { createRequire } from 'node:module';
import os from 'node:os';
import type { HostMutationApprovalRequest } from '@lnwjud/mcp-server';
import type { UiLocale } from '@lnwjud/ipc-contracts';

export interface MutationApprovalDialogOptions {
  readonly type: 'warning';
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly buttons: readonly [string, string];
  readonly defaultId: number;
  readonly cancelId: number;
  readonly noLink: boolean;
}

const MAX_MUTATION_APPROVAL_SUMMARY_LENGTH = 8_192;

export function isMutationApprovalRequestValid(request: HostMutationApprovalRequest): boolean {
  return request.toolName.trim().length > 0
    && request.reason.trim().length > 0
    && request.summary.trim().length > 0
    && request.summary.length <= MAX_MUTATION_APPROVAL_SUMMARY_LENGTH;
}

export function mutationApprovalDialogOptions(
  locale: UiLocale,
  request: HostMutationApprovalRequest,
  trustedHostWindowAvailable = detectTrustedHostWindowAvailable(),
): MutationApprovalDialogOptions {
  if (!isMutationApprovalRequestValid(request)) throw new Error('Invalid mutation approval request');
  if (!trustedHostWindowAvailable) throw new Error('Trusted host window is unavailable for mutation approval');

  const thai = locale === 'th';
  const workspace = request.workspaceRoot ?? (thai ? 'ไม่มี Active Project' : 'No Active Project');
  const workspaceId = request.workspaceId ?? '-';
  const machine = os.hostname() || (thai ? 'ไม่ทราบชื่อเครื่อง' : 'Unknown machine');
  const presentation = request.presentation;
  const detail = thai
    ? [
        'สรุปก่อนอนุมัติ:',
        `คำสั่งนี้จะทำอะไร: ${presentation?.impact ?? 'ยังสรุปผลกระทบจากคำสั่งนี้ไม่ได้'}`,
        `เครื่อง: ${machine}`,
        presentation?.browserTabId === undefined
          ? 'แท็บ/หน้าต่าง: ไม่มีข้อมูลเป้าหมายจากคำสั่ง'
          : formatBrowserTarget(presentation),
        presentation?.unknownImpact === true
          ? 'ผลกระทบ: ยังยืนยันไม่ได้ทั้งหมด อาจเปลี่ยนข้อมูลในเครื่องหรือบริการที่คำสั่งเข้าถึง'
          : 'ผลกระทบ: ตามรายละเอียดที่ตรวจได้ด้านบน',
        '',
        `โปรเจกต์: ${workspace}`,
        `รหัสโปรเจกต์: ${workspaceId}`,
        `เครื่องมือ: ${request.toolName}`,
        `ประเภท: ${request.mutationKind}`,
        `เหตุผล: ${request.reason}`,
        '',
        'รายละเอียดทางเทคนิคของคำสั่งจริง:',
        request.summary,
        '',
        'อนุญาตเฉพาะงานนี้หนึ่งครั้งเท่านั้น หากข้อมูลด้านบนไม่ตรงกับที่ตั้งใจ ให้กดยกเลิก',
      ].join('\n')
    : [
        `Project: ${workspace}`,
        `Project ID: ${workspaceId}`,
        `Tool: ${request.toolName}`,
        `Mutation: ${request.mutationKind}`,
        `Reason: ${request.reason}`,
        '',
        'Exact command or target:',
        request.summary,
        '',
        'Verify every path and argument before approving. This approval is valid once only.',
      ].join('\n');
  return {
    type: 'warning',
    title: thai ? 'ยืนยันคำสั่งที่มีความเสี่ยง' : 'Confirm high-risk action',
    message: thai
      ? 'lnwjud ขออนุมัติคำสั่งที่อาจมีผลต่อข้อมูล'
      : 'lnwjud is about to run an action that may delete or replace data',
    detail,
    buttons: thai ? ['ยกเลิก', 'อนุญาตครั้งนี้'] : ['Cancel', 'Approve once'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

function formatBrowserTarget(presentation: NonNullable<HostMutationApprovalRequest['presentation']>): string {
  if (presentation.browserTabLookup === 'resolved') {
    const title = presentation.browserTabTitle ?? 'ไม่มีชื่อแท็บ';
    const url = presentation.browserTabUrl ?? 'ไม่มี URL ที่แสดงได้';
    return `แท็บ: ${title}\nหน้า: ${url}\nรหัสแท็บ: ${presentation.browserTabId}`;
  }
  if (presentation.browserTabLookup === 'not_found') return `แท็บ: ไม่พบรหัส ${presentation.browserTabId} ในเบราว์เซอร์ที่จัดการอยู่`;
  if (presentation.browserTabLookup === 'timed_out') return `แท็บ: รหัส ${presentation.browserTabId} (ตรวจชื่อแท็บไม่ทันเวลา จึงไม่เดา)`;
  return `แท็บ: รหัส ${presentation.browserTabId} (ยังตรวจชื่อหรือ URL ของแท็บไม่ได้ จึงไม่เดา)`;
}

export function isMutationApprovalResponse(response: number): boolean {
  return response === 1;
}

function detectTrustedHostWindowAvailable(): boolean {
  const electronVersion = (process.versions as Record<string, string | undefined>).electron;
  if (electronVersion === undefined) return true;
  try {
    const runtimeRequire = createRequire(import.meta.url);
    const electron = runtimeRequire('electron') as {
      readonly BrowserWindow?: {
        getAllWindows(): readonly { isDestroyed(): boolean }[];
      };
    };
    return electron.BrowserWindow?.getAllWindows().some((window) => !window.isDestroyed()) === true;
  } catch {
    return false;
  }
}
