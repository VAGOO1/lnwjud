export const fixtureTitle = 'PANYA APPROVAL 3 STEP — จำลองเท่านั้น';
export const fixtureProducts = [
  { sku: 'FF-05', code: '442', name: 'ปลากินพืชกลาง 442', qty: 5, cost: 360, stock: 86, price: 375 },
  { sku: 'FF-04', code: '443', name: 'ปลากินพืชใหญ่ 443', qty: 10, cost: 345, stock: 263, price: 365 },
  { sku: 'FF-01', code: '4643', name: 'ปลาดุกใหญ่ 4643', qty: 10, cost: 450, stock: 314, price: 470 },
  { sku: 'FF-03', code: '4641', name: 'ปลาดุกเล็ก 4641', qty: 10, cost: 480, stock: 125, price: 495 },
];
type Step = { action: 'query' | 'navigate' | 'wait' | 'type' | 'click'; parameters: Record<string, unknown> };
export function invoiceThreeStepPlan(origin: string, caseId: string): { bill: string; historyUrl: string; invoiceUrl: string; duplicateQuery: Step; prepare: Step[]; precommit: Step; commit: Step[]; readback: Step; fields: number; expectedPromptCount: number } {
  const bill = 'FAKE-3STEP-' + caseId;
  const historyUrl = origin + '/history?case=' + encodeURIComponent(caseId);
  const invoiceUrl = origin + '/invoice?case=' + encodeURIComponent(caseId);
  const query = (pathname: string, queries: Record<string, unknown>[]): Step => ({ action: 'query', parameters: { page: { origin, pathname, search: '?case=' + encodeURIComponent(caseId), title: fixtureTitle }, queries } });
  const field = (key: string, selector: string, value: string): Record<string, unknown> => ({ key, selector, fields: ['value'], expect: { count: 1, value } });
  const text = (key: string, selector: string, value: string): Record<string, unknown> => ({ key, selector, fields: ['text'], expect: { count: 1, text: value } });
  const type = (selector: string, value: string): Step => ({ action: 'type', parameters: { selector, text: value, clear: true } });
  const click = (selector: string, expectedText: string): Step => ({ action: 'click', parameters: { selector, expected_text: expectedText, mouse_event_sequence: true } });
  const duplicateQuery = query('/history', [{ key: 'duplicate', selector: '#existing-bill', fields: ['text'], expect: { count: 0 } }, text('commits', '#commit-count', '0')]);
  const prepare: Step[] = [duplicateQuery, { action: 'navigate', parameters: { url: invoiceUrl } }, { action: 'wait', parameters: { selector: '#invoice-form' } }, query('/invoice', [field('emptyBill', '#billNumber', '')]), type('#billNumber', bill), type('#movementDate', '2026-10-19'), type('#sourceSearch', 'ผู้ขายจำลอง'), { action: 'click', parameters: { selector: '#source-option', expected_text: 'ผู้ขายจำลอง ID 13', mouse_event: 'mousedown' } }, query('/invoice', [text('selectedSource', '#selected-source', 'ผู้ขายจำลอง ID 13')])];
  for (let i = 0; i < 4; i++) {
    const p = fixtureProducts[i]!;
    prepare.push(type('#product-' + i, p.code), click('#product-option-' + i, p.name + ' (' + p.sku + ')'), type('#quantity-' + i, String(p.qty)), type('#cost-' + i, String(p.cost)), type('#sell-' + i, ''));
  }
  for (let i = 0; i < 31; i++) prepare.push(type('#extra-' + i, 'จำลอง-' + i));
  prepare.push(query('/invoice', [text('source', '#selected-source', 'ผู้ขายจำลอง ID 13')]), click('#review-button', 'ตรวจทานบิลจำลอง'), { action: 'wait', parameters: { selector: '#review-total' } });
  const expected: Record<string, unknown>[] = [field('bill', '#billNumber', bill), field('date', '#movementDate', '2026-10-19'), text('source', '#selected-source', 'ผู้ขายจำลอง ID 13'), text('reviewBill', '#review-bill', bill), text('quantity', '#review-quantity', '35'), text('total', '#review-total', '14550')];
  for (let i = 0; i < 4; i++) { const p = fixtureProducts[i]!; expected.push(field('product' + i, '#product-' + i, p.name + ' (' + p.sku + ')'), field('qty' + i, '#quantity-' + i, String(p.qty)), field('cost' + i, '#cost-' + i, String(p.cost)), field('sell' + i, '#sell-' + i, '')); }
  for (let i = 0; i < 31; i++) expected.push(field('extra' + i, '#extra-' + i, 'จำลอง-' + i));
  const precommit = query('/invoice', expected);
  const readback = query('/history', [text('bill', '#existing-bill', bill), text('commits', '#commit-count', '1'), text('quantity', '#saved-quantity', '35'), text('total', '#saved-total', '14550'), ...fixtureProducts.flatMap((p, i) => [text('stock' + i, '#stock-' + i, String(p.stock)), text('price' + i, '#price-' + i, String(p.price))]), { key: 'lines', selector: '#saved-lines p', fields: ['text'], expect: { count: 4 } }]);
  const commit: Step[] = [precommit, click('#commit-button', 'ยืนยันบิลจำลอง'), { action: 'wait', parameters: { selector: '#receipt-ready' } }, query('/invoice', [text('commits', '#receipt-commits', '1'), text('total', '#receipt-total', '14550')]), { action: 'navigate', parameters: { url: historyUrl } }, { action: 'wait', parameters: { selector: '#history-ready' } }, readback];
  return { bill, historyUrl, invoiceUrl, duplicateQuery, prepare, precommit, commit, readback, fields: 50, expectedPromptCount: 3 };
}
