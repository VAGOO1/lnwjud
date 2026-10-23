import type { Invoice } from './invoice-fast-lane.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (label: string): never => { throw new Error(`DUPLICATE_CHECK_${label}`); };
const str = (v: unknown, label: string, max: number): string => {
  if (typeof v !== 'string' || !v.length || v !== v.trim() || v.length > max || [...v].some(c => c.charCodeAt(0) < 32)) fail(label);
  return v as string;
};
const date = (v: unknown): string => {
  const s = str(v, 'INVALID_DATE', 10);
  const parsed = new Date(`${s}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0,10) !== s) fail('INVALID_DATE');
  return s;
};
const posInt = (v: unknown, label: string): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) fail(label);
  return v as number;
};
const nonnegInt = (v: unknown, label: string): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) fail(label);
  return v as number;
};
const qty = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > Number.MAX_SAFE_INTEGER) fail('INVALID_QUANTITY');
  return v as number;
};
const exactKeys = (o: Obj, allowed: string[]): void => { if (Object.keys(o).some(k => !allowed.includes(k))) fail('UNKNOWN_FIELD'); };
const targetKeys = ['tabId','origin','pathname','title'];

export function analyzeDuplicateCheck(invoice: Invoice, raw: unknown, target: {tabId:string;origin:string;pathname:string;title:string}): Record<string, unknown> {
  if (!isObj(invoice) || typeof invoice.supplier !== 'string' || !invoice.supplier || !Array.isArray(invoice.rows) || invoice.rows.length < 1 || invoice.rows.length > 10) fail('INVALID_INVOICE');
  const rows = invoice.rows.map(r => { if (!isObj(r)) fail('INVALID_INVOICE_ROW'); return {sku:str(r.sku,'INVALID_SKU',80), quantity:qty(r.quantity), unit_cost_cents:posInt(r.unit_cost_cents,'INVALID_UNIT_COST')}; });
  if (new Set(rows.map(r=>r.sku)).size !== rows.length) fail('DUPLICATE_INVOICE_SKU');
  const invDate = date(invoice.date);
  const billRef = typeof invoice.bill_ref === 'string' ? invoice.bill_ref : fail('INVALID_BILL_REFERENCE');
  if (billRef.length > 128 || billRef !== billRef.trim()) fail('INVALID_BILL_REFERENCE');
  if (!isObj(raw)) fail('INVALID_EVIDENCE'); const evidence = raw as Obj;
  exactKeys(evidence,['ok','stockWrites','draftWrites','atUtc','target','source','products','scans','readProof']);
  const readProof = isObj(evidence.readProof) ? evidence.readProof : fail('INVALID_READ_PROOF');
  if (!Number.isSafeInteger(readProof.fetches) || (readProof.fetches as number) <= 0 || (readProof.fetches as number) > 48 || typeof readProof.elapsedMs !== 'number' || !Number.isFinite(readProof.elapsedMs) || readProof.elapsedMs < 0 || readProof.elapsedMs > 45000 || readProof.method !== 'GET' || readProof.observationsPerPage !== 2) fail('INVALID_READ_PROOF');
  if (evidence.ok !== true || evidence.stockWrites !== 0 || evidence.draftWrites !== 0) fail('WRITES_PRESENT');
  str(evidence.atUtc,'INVALID_TIMESTAMP',64);
  if (!isObj(evidence.target) || targetKeys.some(k => (evidence.target as Obj)[k] !== target[k as keyof typeof target])) fail('TARGET_MISMATCH');
  if (!isObj(evidence.source) || evidence.source.name !== invoice.supplier) fail('SOURCE_MISMATCH');
  const sourceId = posInt((evidence.source as Obj).id,'INVALID_SOURCE_ID');
  if (!Array.isArray(evidence.products) || evidence.products.length !== rows.length) fail('PRODUCT_CATALOG_INCOMPLETE');
  const productValues = evidence.products as unknown[];
  const products: Array<{id:number;sku:string;name:string;unit:string}> = productValues.map((p: unknown) => { if (!isObj(p)) fail('INVALID_PRODUCT'); const product = p as Obj; exactKeys(product,['id','sku','name','unit']); return {id:posInt(product.id,'INVALID_PRODUCT_ID'),sku:str(product.sku,'INVALID_PRODUCT_SKU',80),name:str(product.name,'INVALID_PRODUCT_NAME',300),unit:str(product.unit,'INVALID_PRODUCT_UNIT',40)}; });
  if (new Set(products.map(p=>p.sku)).size !== products.length || products.some(p=>p.unit !== 'กระสอบ' || !rows.some(r=>r.sku===p.sku))) fail('PRODUCT_CATALOG_INCOMPLETE');
  const bySku = new Map(products.map(p=>[p.sku,p]));
  if (rows.some(r=>!bySku.has(r.sku))) fail('PRODUCT_CATALOG_INCOMPLETE');
  if (!Array.isArray(evidence.scans) || evidence.scans.length !== 2) fail('SCAN_SET_INCOMPLETE');
  const scopes = new Set<string>();
  const scopeGroups = new Map<string, Obj[]>();
  let pagesRead = 0;
  for (const scanValue of evidence.scans as unknown[]) {
    const scan = isObj(scanValue) ? scanValue : fail('INVALID_SCAN');
    if (!isObj(scan)) fail('INVALID_SCAN'); exactKeys(scan,['scope','sourceId','from','to','pageCount','totalGroups','allPagesChecked','stableRead','groups']);
    const scope = str(scan.scope,'INVALID_SCAN_SCOPE',64); if (scopes.has(scope)) fail('DUPLICATE_SCAN_SCOPE'); scopes.add(scope);
    if (scope === 'SUPPLIER_ALL_DATES') { if (scan.sourceId !== sourceId || scan.from !== '' || scan.to !== '') fail('INVALID_SUPPLIER_SCAN'); }
    else if (scope === 'ALL_SOURCES_INVOICE_DATE') { if (scan.sourceId !== null || scan.from !== invDate || scan.to !== invDate) fail('INVALID_DATE_SCAN'); }
    else fail('INVALID_SCAN_SCOPE');
    const total = nonnegInt(scan.totalGroups,'INVALID_GROUP_COUNT'); const pages = posInt(scan.pageCount,'INVALID_PAGE_COUNT');
    if (pages !== Math.max(1, Math.ceil(total/50)) || scan.allPagesChecked !== true || scan.stableRead !== true || !Array.isArray(scan.groups) || scan.groups.length !== total || pages > 12) fail('INCOMPLETE_SCAN');
    pagesRead += pages;
    const groups: Obj[] = []; const ids = new Set<number>();
    const groupValues = Array.isArray(scan.groups) ? scan.groups : fail('INVALID_GROUP_ROWS');
    for (const gValue of groupValues) {
      const g = isObj(gValue) ? gValue : fail('INVALID_GROUP');
      if (!isObj(g)) fail('INVALID_GROUP'); exactKeys(g,['key','date','title','dateLine','rows']);
      const gd = date(g.date); if (scope === 'ALL_SOURCES_INVOICE_DATE' && gd !== invDate) fail('INVALID_DATE_SCAN');
      const key = str(g.key,'INVALID_GROUP_KEY',2000); const title = str(g.title,'INVALID_GROUP_TITLE',300); const dateLine = str(g.dateLine,'INVALID_DATE_LINE',600);
      if (!Array.isArray(g.rows) || g.rows.length < 1 || g.rows.length > 100) fail('INVALID_GROUP_ROWS'); const groupRows = g.rows as unknown[]; const gr: Obj[]=[];
      for (const rrValue of groupRows) { const rr = isObj(rrValue) ? rrValue : fail('INVALID_GROUP_ROW'); exactKeys(rr,['id','sku','name','unit','quantity','unitCostCents','status']); const id=posInt(rr.id,'INVALID_MOVEMENT_ID'); if(ids.has(id)) fail('DUPLICATE_MOVEMENT_ID'); ids.add(id); const status=rr.status; if(status!=='ACTIVE'&&status!=='CANCELLED') fail('INVALID_STATUS'); gr.push({id,sku:str(rr.sku,'INVALID_ROW_SKU',80),name:str(rr.name,'INVALID_ROW_NAME',300),unit:str(rr.unit,'INVALID_ROW_UNIT',40),quantity:qty(rr.quantity),unitCostCents:posInt(rr.unitCostCents,'INVALID_ROW_COST'),status}); }
      if (new Set(gr.map(x=>x.id)).size!==gr.length) fail('DUPLICATE_MOVEMENT_ID');
      if (key !== [...gr.map(x=>x.id as number)].sort((a,b)=>a-b).join(',')) fail('INVALID_GROUP_KEY'); groups.push({key,date:gd,title,dateLine,rows:gr});
    }
    scopeGroups.set(scope,groups);
  }
  if (!scopes.has('SUPPLIER_ALL_DATES') || !scopes.has('ALL_SOURCES_INVOICE_DATE')) fail('SCAN_SET_INCOMPLETE');
  if (readProof.fetches !== pagesRead * 2) fail('INCONSISTENT_READ_PROOF');
  const identityById = new Map<number,string>(); const uniqueGroups = new Map<string,Obj>(); const observedScopes = new Map<string,Set<string>>();
  for (const [scope, groups] of scopeGroups) for (const g of groups) { const identity=JSON.stringify({date:g.date,title:g.title,dateLine:g.dateLine,rows:g.rows}); for (const rr of g.rows as Obj[]) { const id=rr.id as number; if(identityById.has(id) && identityById.get(id)!==identity) fail('INCONSISTENT_CROSS_SCAN_ID'); identityById.set(id,identity); } uniqueGroups.set(identity,g); (observedScopes.get(identity) ?? (observedScopes.set(identity,new Set()),observedScopes.get(identity)!)).add(scope); }
  const wanted = new Map(rows.map(r=>[r.sku,r]));
  const matches: Obj[]=[];
  for (const g of uniqueGroups.values()) {
    const groupRows = g.rows as Obj[];
    const mr = groupRows.filter(x => wanted.has(String(x.sku)) && bySku.get(String(x.sku))?.unit === x.unit && wanted.get(String(x.sku))!.quantity === x.quantity && wanted.get(String(x.sku))!.unit_cost_cents === x.unitCostCents);
    const matchedSkus = new Set(mr.map(x=>String(x.sku))); const duplicateSku = new Set(mr.map(x=>String(x.sku))).size !== mr.length; const missingSkus = rows.filter(r=>!matchedSkus.has(r.sku)).map(r=>r.sku);
    if (!mr.length) continue;
    const full = matchedSkus.size === rows.length && mr.length === rows.length;
    const category = duplicateSku ? 'AMBIGUOUS' : (full && groupRows.length > mr.length ? 'SUBSET_IN_LARGER_GROUP' : (full ? 'FULL_SET' : 'PARTIAL'));
    const identity=JSON.stringify({date:g.date,title:g.title,dateLine:g.dateLine,rows:g.rows});
    matches.push({date:g.date,groupKey:g.key,allGroupIDs:groupRows.map(x=>x.id),groupRowCount:groupRows.length,matchedRows:mr,missingSkus,statuses:mr.map(x=>x.status),category,dateRelation:g.date===invDate?'SAME_DATE':'DIFFERENT_DATE',observedScopes:[...(observedScopes.get(identity)??[])],sourceVerification:(observedScopes.get(identity)?.has('SUPPLIER_ALL_DATES')?'SUPPLIER_FILTERED_HISTORY':'UNVERIFIED_ALL_SOURCE_HISTORY')});
  }
  const truncated = matches.length > 50; const outputMatches = matches.slice(0,50);
  const result: Obj = {status: billRef || truncated ? 'INCOMPLETE' : (matches.length ? 'REVIEW_REQUIRED' : 'NO_MATCH_IN_CHECKED_SCOPE'),stockWrites:0,draftWrites:0,planWrites:0,canCommit:false,automaticReplayAllowed:false,source:{id:sourceId,name:invoice.supplier},products,historyProof:{scopes:[...scopes],scanCount:2,totalGroups:[...scopeGroups.values()].reduce((n,g)=>n+g.length,0),allPagesChecked:true,stableRead:true,readProof:evidence.readProof,consistency:'TWO_OBSERVATIONS_NOT_ATOMIC_SNAPSHOT',groupSourceProof:'SUPPLIER_FILTER_ECHO_OR_UNVERIFIED_ALL_SOURCE; NO_STRUCTURED_GROUP_SOURCE_ID'},matches:outputMatches,matchesTruncated:truncated,totalMatchGroups:matches.length,billReferenceVerification:billRef ? 'UNAVAILABLE_FROM_STRUCTURED_DOM' : 'NOT_APPLICABLE',billReference:billRef,outputLimitBytes:49152};
  // Keep the final MCP result bounded; every omitted candidate remains explicit.
  while (Buffer.byteLength(JSON.stringify(result),'utf8') > 49152 && outputMatches.length) {
    outputMatches.pop(); result.status='INCOMPLETE'; result.matchesTruncated=true; result.truncationReason='RESPONSE_BYTE_LIMIT';
  }
  if (Buffer.byteLength(JSON.stringify(result),'utf8') > 49152) fail('OUTPUT_LIMIT');
  return result;
}
