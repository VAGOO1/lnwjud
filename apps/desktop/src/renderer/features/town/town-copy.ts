import type { UiLocale } from '@lnwjud/ipc-contracts';
import type { TownReason, TownStatus } from './town-state.js';
import { TOWN_REASON_LABEL_TH, TOWN_STATUS_LABEL_TH } from './town-state.js';

const STATUS_EN: Readonly<Record<TownStatus, string>> = {
  IDLE: 'Idle', WORKING: 'Working', WAITING: 'Waiting', COMPLETED: 'Completed',
  STOP_SAFE: 'Safely stopped', FAILED: 'Failed', UNKNOWN: 'Unknown',
};

const REASON_EN: Readonly<Record<TownReason, string>> = {
  verified_idle: 'Checked: no work running',
  running_call_evidence: 'A tool call is really running',
  goal_checkpoint_fresh: 'Goal has a recent checkpoint',
  goal_checkpoint_stale: 'Goal checkpoint is too old',
  goal_completed_verified: 'Finished with verified checks/files',
  goal_completed_unverified: 'Not confirmed (no verified check or file)',
  goal_failed_traced: 'Failed with a traceable reason',
  goal_failed_untraceable: 'Failed, but no traceable reason found',
  goal_blocked_unclassified: 'Blocked, but who/what is unknown',
  goal_cancelled: 'Goal was cancelled',
  guard_stop_receipt: 'Guard stopped work, receipt on file',
  receipt_unverified: 'Receipt cannot be verified',
  owner_action_pending: 'Waiting for the owner (evidence on file)',
  mcp_not_running: 'MCP is not running',
  conflicting_evidence: 'Evidence conflicts',
  scope_mismatch: 'Data came from another scope',
  source_unreachable: 'Could not read the data',
  source_stale: 'Data is too old',
  clock_anomaly: 'Source clock looks wrong',
  no_evidence: 'No evidence',
};

const STATUS_LABELS: Readonly<Record<UiLocale, Readonly<Record<TownStatus, string>>>> = {
  th: TOWN_STATUS_LABEL_TH,
  en: STATUS_EN,
};

const REASON_LABELS: Readonly<Record<UiLocale, Readonly<Record<TownReason, string>>>> = {
  th: TOWN_REASON_LABEL_TH,
  en: REASON_EN,
};

export function statusLabel(locale: UiLocale, status: TownStatus): string {
  return STATUS_LABELS[locale][status];
}

export function reasonLabel(locale: UiLocale, reason: TownReason): string {
  return REASON_LABELS[locale][reason];
}

export interface TownCopy {
  readonly title: string; readonly subtitle: string;
  readonly liveReadOnly: string; readonly placeholderArt: string;
  readonly noWorkspace: string; readonly loading: string;
  readonly staleBanner: string; readonly lastRead: string; readonly never: string;
  readonly gate: string; readonly hall: string; readonly review: string; readonly archive: string; readonly compass: string;
  readonly mcpRunning: string; readonly mcpStopped: string; readonly unknownFact: string;
  readonly hallFacts: (w: number, d: number, s: number, u: number) => string;
  readonly reviewFacts: (cp: number, ct: number, fv: number, ft: number, failed: number) => string;
  readonly archiveFacts: (n: number) => string;
  readonly board: string; readonly colWorking: string; readonly colDone: string; readonly colStuck: string;
  readonly colOwner: string; readonly colUnverified: string; readonly empty: string;
  readonly unverifiedHint: string;
  readonly resting: string; readonly previously: string;
  readonly activeAi: string; readonly aiUnknown: string; readonly aiVisibilityNote: string;
  readonly plaza: string; readonly forge: string; readonly peak: string;
  readonly approvalGate: string; readonly messenger: string; readonly catStudio: string; readonly trainingYard: string;
  readonly plazaFacts: (calls: number, ai: number) => string;
  readonly forgeFacts: (installed: boolean, version: string | null, running: number) => string;
  readonly peakFacts: (running: number) => string;
  readonly notSupported: string; readonly demoOnly: string;
  readonly approvalFacts: (n: number) => string; readonly approvalHint: string;
  readonly aiCalls: (n: number) => string; readonly byAi: string;
}

const TH: TownCopy = {
  title: 'PANYA TOWN เมืองแห่งปัญญา',
  subtitle: 'แสดงเฉพาะสิ่งที่ตรวจพบจริงจากระบบ ถ้าไม่มีหลักฐานตัวละครจะพักหรือขึ้น "ไม่ทราบ" (อ่านอย่างเดียว กดสั่งงานจากหน้านี้ไม่ได้)',
  liveReadOnly: 'ข้อมูลจริง · อ่านอย่างเดียว', placeholderArt: 'ภาพชั่วคราว ยังไม่ใช่งานศิลป์จริง',
  noWorkspace: 'ยังไม่ได้เลือกโปรเจกต์ จึงยังไม่มีข้อมูลให้แสดง', loading: 'กำลังอ่านข้อมูล…',
  staleBanner: 'ข้อมูลล่าสุดอ่านไม่สำเร็จหรือเก่าเกินไป ทุกสถานะจึงแสดงเป็น "ไม่ทราบ"',
  lastRead: 'อ่านสำเร็จล่าสุด', never: 'ยังไม่เคย',
  gate: 'Town Gate · ประตูเมือง', hall: 'Mission Hall · ห้องภารกิจ', review: 'Review Gate · ด่านตรวจ',
  archive: 'Archive Hall · หอจดหมายเหตุ', compass: 'Compass House · บ้านปัญญา',
  mcpRunning: 'MCP รันอยู่', mcpStopped: 'MCP ไม่ได้รัน', unknownFact: 'ไม่ทราบ',
  hallFacts: (w, d, s, u) => `กำลังทำ ${w} · สำเร็จ ${d} · ติดขัด ${s} · ยังไม่ยืนยัน ${u}`,
  reviewFacts: (cp, ct, fv, ft, failed) => `ผลตรวจผ่าน ${cp}/${ct} · ไฟล์ยืนยันแล้ว ${fv}/${ft} · ไม่ผ่าน ${failed}`,
  archiveFacts: (n) => `เป้าหมายที่มีบันทึกความคืบหน้า ${n} รายการ`,
  board: 'Mission Board · กระดานภารกิจ', colWorking: 'กำลังทำ', colDone: 'สำเร็จ (ยืนยันแล้ว)',
  colStuck: 'ติดขัด', colOwner: 'รอเจ้าของอนุมัติ', colUnverified: 'ยังไม่ยืนยัน', empty: 'ไม่มีรายการ',
  unverifiedHint: 'เสร็จหรือกำลังทำ แต่ยังพิสูจน์ไม่ได้ จึงไม่นับเป็นสำเร็จ',
  resting: 'พัก', previously: 'รายงานก่อนหน้า',
  activeAi: 'AI ที่กำลังใช้งานผ่าน lnwjud', aiUnknown: 'ไม่ทราบชื่อ AI',
  aiVisibilityNote: 'เห็นเฉพาะ AI ที่ทำงานผ่าน lnwjud เท่านั้น AI ที่ไม่ได้ผ่านที่นี่จะไม่ปรากฏ (ไม่ได้แปลว่าว่าง)',
  aiCalls: (n) => `${n} งาน`, byAi: 'โดย',
  plaza: 'Central Plaza · ลานกลางเมือง', forge: 'Codex Forge · โรงตีดาบ Codex', peak: 'Research Peak · ยอดเขาค้นคว้า',
  approvalGate: 'Approval Gate · ประตูอนุมัติ', messenger: 'Messenger Post · ที่ทำการส่งสาร',
  catStudio: 'Orange Cat Studio · สตูดิโอแมวส้ม', trainingYard: 'Training Yard · ลานฝึก',
  plazaFacts: (calls, ai) => `ตอนนี้มีงานรันอยู่ ${calls} งาน จาก ${ai} AI`,
  forgeFacts: (installed, version, running) => `${installed ? `ติดตั้งแล้ว${version === null ? '' : ` (v${version})`}` : 'ยังไม่ได้ติดตั้ง'} · งาน Codex ที่รันอยู่ ${running}`,
  peakFacts: (running) => `งานค้นหา/ค้นคว้าที่รันอยู่ ${running}`,
  notSupported: 'ยังไม่รองรับ: ยังไม่มีข้อมูลจริงส่งมาให้หน้านี้ จึงไม่แสดงสถานะ (ไม่ใช่ "ว่าง")',
  demoOnly: 'ตัวอย่างเท่านั้น ยังไม่มีข้อมูลจริง ไม่แสดงสถานะการทำงาน',
  approvalFacts: (n) => n === 0 ? 'ไม่มีคำขอรออนุมัติ' : `มี ${n} คำขอรอเจ้าของอนุมัติ`,
  approvalHint: 'นับทั้งแอป ตอบได้ที่หน้าต่างอนุมัติที่เด้งขึ้นเท่านั้น หน้านี้ไม่มีปุ่มอนุมัติและไม่แสดงเนื้อหาคำขอ',
};

const EN: TownCopy = {
  title: 'PANYA TOWN — City of Wisdom',
  subtitle: 'Shows only what the system actually verified. With no evidence, characters rest or show "Unknown". Read-only; you cannot command work from this page.',
  liveReadOnly: 'Live data · read-only', placeholderArt: 'Placeholder art — not final artwork',
  noWorkspace: 'No project selected, so there is nothing to show yet.', loading: 'Reading data…',
  staleBanner: 'The latest read failed or is too old, so every status is shown as "Unknown".',
  lastRead: 'Last successful read', never: 'never',
  gate: 'Town Gate', hall: 'Mission Hall', review: 'Review Gate', archive: 'Archive Hall', compass: 'Compass House',
  mcpRunning: 'MCP running', mcpStopped: 'MCP not running', unknownFact: 'Unknown',
  hallFacts: (w, d, s, u) => `Working ${w} · Done ${d} · Stuck ${s} · Unverified ${u}`,
  reviewFacts: (cp, ct, fv, ft, failed) => `Checks passed ${cp}/${ct} · Files verified ${fv}/${ft} · Failing ${failed}`,
  archiveFacts: (n) => `${n} goal(s) with a checkpoint`,
  board: 'Mission Board', colWorking: 'Working', colDone: 'Done (verified)', colStuck: 'Stuck',
  colOwner: 'Awaiting owner approval', colUnverified: 'Unverified', empty: 'Nothing here',
  unverifiedHint: 'Finished or running but not provable, so not counted as done.',
  resting: 'Resting', previously: 'Previously reported',
  activeAi: 'AIs working through lnwjud', aiUnknown: 'AI name unknown',
  aiVisibilityNote: 'Only AIs working through lnwjud are visible. An AI that does not go through here will not appear (that does not mean it is idle).',
  aiCalls: (n) => `${n} call(s)`, byAi: 'by',
  plaza: 'Central Plaza', forge: 'Codex Forge', peak: 'Research Peak',
  approvalGate: 'Approval Gate', messenger: 'Messenger Post', catStudio: 'Orange Cat Studio', trainingYard: 'Training Yard',
  plazaFacts: (calls, ai) => `${calls} call(s) running now from ${ai} AI(s)`,
  forgeFacts: (installed, version, running) => `${installed ? `Installed${version === null ? '' : ` (v${version})`}` : 'Not installed'} · Codex calls running ${running}`,
  peakFacts: (running) => `Look-up calls running ${running}`,
  notSupported: 'Not supported yet: no real data is sent to this page, so no status is shown (this is not "idle").',
  demoOnly: 'Demo only: no real data, so no working status is shown.',
  approvalFacts: (n) => n === 0 ? 'No approvals waiting' : `${n} approval(s) waiting for the owner`,
  approvalHint: 'Counted app-wide. Answer only in the approval window that pops up; this page has no approve button and never shows the request.',
};

const COPY: Readonly<Record<UiLocale, TownCopy>> = { th: TH, en: EN };

export function townCopy(locale: UiLocale): TownCopy {
  return COPY[locale];
}
