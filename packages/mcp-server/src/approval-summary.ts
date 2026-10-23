// MIT, Copyright (c) 2026 Adisorn (lnwjud project).
import {parseFastLaneRequest, FAST_LANE_ORIGIN, FAST_LANE_PATH, FAST_LANE_TITLE} from './invoice-fast-lane.js';
export const MAX_APPROVAL_SUMMARY_LENGTH = 8_192;
type JsonRecord = Record<string, unknown>;
const ACTIONS = new Set(['launch','status','list_tabs','new_tab','activate_tab','set_files','close_tab','navigate','evaluate','query','click','type','wait','screenshot']);
const TARGETED = new Set(['activate_tab','set_files','close_tab','navigate','evaluate','query','click','type','wait','screenshot']);
export function snapshotApprovalInput(input: unknown): unknown | undefined {
  try { return structuredClone(input); } catch { return undefined; }
}
function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s"'\\,;}]+/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|password|secret|access[_-]?token|refresh[_-]?token|token|private[_-]?key)\s*["']?\s*[:=]\s*(?:\\?["'])?)[^\s"'\\,;}]+/gi, '$1[redacted]');
}
function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (!record(value)) return value;
  const out: JsonRecord = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    const name = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    out[key] = /^(authorization|proxyauthorization|cookie|setcookie|token|accesstoken|refreshtoken|secret|password|apikey|privatekey)$/.test(name)
      ? '[redacted]' : redactValue(value[key]);
  }
  return out;
}
/** Complete display of one request; never silently abbreviate a step. */
export function summarizeDomCdpMutationForApproval(input: unknown, existingRedactor: (text: string) => string = text => text): string | null {
  if (!record(input)) return null;
  const hasSteps = input.steps !== undefined;
  if ((input.action !== undefined) === hasSteps) return null;
  const topTab = typeof input.tab_id === 'string' ? input.tab_id.trim() : undefined;
  const nestedTab = record(input.parameters) && typeof input.parameters.tab_id === 'string' ? input.parameters.tab_id.trim() : undefined;
  if (topTab && nestedTab && topTab !== nestedTab) return null;
  if (hasSteps && nestedTab) return null;
  const tab = topTab || (!hasSteps ? nestedTab : undefined);
  const steps = hasSteps ? input.steps : [{ action: input.action, parameters: input.parameters ?? {} }];
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 100) return null;
  if (hasSteps && !tab) return null;
  if (!hasSteps && record(input.parameters) && 'invoice_fast_lane' in input.parameters) {
    try { const result=summarizeInvoiceFastLane(input); if(result===null)return null;const summary=existingRedactor(result);return summary.length<=MAX_APPROVAL_SUMMARY_LENGTH?summary:null; } catch { return null; }
  }
  const lines = ['tool = dom_cdp'];
  if (tab) lines.push('tab_id = ' + JSON.stringify(tab));
  lines.push('stepCount = ' + steps.length);
  try {
    for (const [index, step] of steps.entries()) {
      if (!record(step) || typeof step.action !== 'string' || !ACTIONS.has(step.action)) return null;
      if (TARGETED.has(step.action) && !tab) return null;
      const params = step.parameters ?? {};
      if (!record(params) || (hasSteps && ('tab_id' in params || 'invoice_fast_lane' in params))) return null;
      lines.push('step[' + (index + 1) + '].action = ' + JSON.stringify(step.action));
      lines.push('step[' + (index + 1) + '].parameters = ' + JSON.stringify(redactValue(params)));
    }
    const summary = existingRedactor(lines.join('\n'));
    return summary.length <= MAX_APPROVAL_SUMMARY_LENGTH ? summary : null;
  } catch { return null; }
}

function summarizeInvoiceFastLane(input:JsonRecord):string|null{
  const r=parseFastLaneRequest(input);if(!r)return null;
  const lines=['tool = dom_cdp','workflow = invoice_fast_lane','operation = '+r.operation,'แท็บ = '+JSON.stringify(input.tab_id),'หน้า = '+FAST_LANE_TITLE,'เว็บไซต์ = '+FAST_LANE_ORIGIN+FAST_LANE_PATH];
  if(r.invoice){const i=r.invoice;lines.push('ผู้ขาย = '+JSON.stringify(i.supplier),'วันที่รับเข้า = '+i.date,'เลขที่บิล = '+JSON.stringify(i.bill_ref),'หมายเหตุ = '+JSON.stringify(i.note));let total=0;for(const[n,x]of i.rows.entries()){const amount=x.quantity*x.unit_cost_cents;total+=amount;lines.push('รายการ '+(n+1)+' = SKU '+JSON.stringify(x.sku)+'; '+x.quantity+' กระสอบ; ทุน '+(x.unit_cost_cents/100).toFixed(2)+' บาท/กระสอบ; รวม '+(amount/100).toFixed(2)+' บาท');}lines.push('รวม '+i.rows.reduce((n,x)=>n+x.quantity,0)+' กระสอบ; '+(total/100).toFixed(2)+' บาท','คงราคาขายเดิม; ไม่ลงเงินสด ไม่แก้ข้อมูลสินค้าแยกจากการรับเข้าตามระบบ');}
  if(r.plan_id)lines.push('รหัสแผน = '+r.plan_id,'ขอบเขต SHA256 = '+r.payload_hash);
  if(r.operation!=='duplicate_check')lines.push('รายการเดิมที่ตรวจแล้วว่าเป็นคนละบิล = '+JSON.stringify(r.acknowledged_candidate_ids));
  if(r.operation==='duplicate_check')lines.push('ผลกระทบ = อ่านประวัติรับเข้าของผู้ขายทุกวันที่และทุกแหล่งในวันที่ระบุ; ไม่กรอก/ล้างร่าง ไม่สร้างแผน ไม่เพิ่มสต๊อก','ขอบเขต = สูงสุด 12 หน้าต่อชุด 45 วินาที อ่านทุกหน้าสองรอบ; หากข้อมูลไม่ครบหรือเปลี่ยนให้หยุด ไม่สรุปว่าไม่ซ้ำ','ผลเป็นข้อมูลให้ตรวจต่อ ไม่ใช้อนุญาตบันทึกหรือยืนยันเลขบิลจากข้อความหมายเหตุ');
  if(r.operation==='preflight')lines.push('ผลกระทบ = อ่านประวัติครบทุกหน้าและสินค้า; โหลดหน้าฟอร์มใหม่; ยังไม่เพิ่มสต๊อก','อนุญาตล้างร่างของบิลนี้ = '+String(r.clear_existing_draft));
  if(r.operation==='prepare')lines.push('ผลกระทบ = ตรวจซ้ำ กรอกและเปิดหน้าทบทวน; เพิ่มสต๊อก 0 ชุด');
  if(r.operation==='commit')lines.push('ผลกระทบ = ตรวจซ้ำและบันทึกรับเข้าจริง พร้อมอ่านผลกลับครบทุกแถว','อาจส่งตรวจสอบ 1 ครั้ง แล้วส่งยืนยันจริง 1 ครั้ง; เพิ่มสต๊อกสำเร็จได้ 1 ชุดเท่านั้น','ยืนยันคำเตือนเฉพาะ movement เดิมที่ระบุและพิสูจน์แล้วว่ารอบตรวจยังไม่บันทึก; ไม่ส่งซ้ำหากผล UNKNOWN');
  if(r.operation==='status')lines.push('ผลกระทบ = อ่านแผน/ใบเสร็จที่เก็บไว้เท่านั้น ไม่สั่งเบราว์เซอร์หรือเริ่มธุรกรรมใหม่');
  const text=lines.join('\n');return text.length<=MAX_APPROVAL_SUMMARY_LENGTH?text:null;
}
