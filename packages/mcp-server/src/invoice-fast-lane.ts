import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,readFile,rename,unlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {appError,err,ok,type InvocationAuthorization,type Result} from '@lnwjud/domain';
import type {CapabilityService} from '@lnwjud/capabilities';
import {fastLaneBrowserProgram} from './invoice-fast-lane-browser.js';
import {duplicateCheckBrowserProgram} from './invoice-duplicate-check-browser.js';
import {analyzeDuplicateCheck} from './invoice-duplicate-check.js';

type Obj=Record<string,unknown>;
export interface InvoiceRow {sku:string;quantity:number;unit_cost_cents:number;}
export interface Invoice {supplier:string;date:string;bill_ref:string;note:string;rows:InvoiceRow[];}
export interface FastRequest {operation:'preflight'|'prepare'|'commit'|'status'|'duplicate_check';invoice?:Invoice;plan_id?:string;payload_hash?:string;clear_existing_draft:boolean;acknowledged_candidate_ids:number[];}
interface LedgerRow {id:number;text:string;summary:string;groupKey?:string;date?:string|null;}
interface ProductRow {id:number;sku:string;name:string;unit:string;stock:number;cost:number;sell:number;sourceId:number;}
interface ConfigRow {sku:string;productId:number;productName:string;unit:string;quantity:number;unitCostCents:number;stockBefore:number;sellCents:number;baselineCostCents:number;expectedMasterCostCents:number;}
interface Target {tabId:string;origin:string;pathname:string;title:string;}
interface Plan {version:1;planId:string;owner:string;machine:string;tabId:string;createdAtUtc:string;expiresAt:number;phase:string;invoice:Invoice;config:Obj;payloadHash:string;candidates:LedgerRow[];sourceId:number;result?:unknown;}
export const FAST_LANE_ORIGIN='https://app.polcharoennewgen.com';
export const FAST_LANE_PATH='/stock-in/batch';
export const FAST_LANE_TITLE='ระบบสต๊อกร้านข้าวสารและอาหารสัตว์';
export const FAST_LANE_VERSION='PANYA-FASTLANE-NATIVE-1';
// Separate from the native prompt's existing 120-second lifetime.
const TTL=600000;
const rec=(x:unknown):x is Obj=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const sha=(x:unknown):string=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function bad(s:string):never{throw Error(s);}
function str(x:unknown,label:string,max=256):string{if(typeof x!=='string'||!x.trim()||x!==x.trim()||x.length>max||Array.from(x).some(c=>c.charCodeAt(0)<32))bad('INVALID_'+label);return x;}
function optionalStr(x:unknown,label:string,max=256):string{if(typeof x!=='string'||x!==x.trim()||x.length>max||Array.from(x).some(c=>c.charCodeAt(0)<32))bad('INVALID_'+label);return x;}
function num(x:unknown,label:string):number{if(typeof x!=='number'||!Number.isSafeInteger(x)||x<=0)bad('INVALID_'+label);return x;}
function keys(o:Obj,allowed:string[]):void{if(Object.keys(o).some(k=>!allowed.includes(k)))bad('UNKNOWN_FAST_LANE_FIELD');}
export function parseFastLaneRequest(input:Obj):FastRequest|null{
  if(Array.isArray(input.steps)&&input.steps.some(s=>rec(s)&&rec(s.parameters)&&'invoice_fast_lane'in s.parameters))bad('NESTED_FAST_LANE_FORBIDDEN');
  const p=input.parameters;if(!rec(p)||!('invoice_fast_lane'in p))return null;
  if(input.steps!==undefined||Object.keys(p).length!==1||!rec(p.invoice_fast_lane))bad('MIXED_FAST_LANE_INPUT');
  const r=p.invoice_fast_lane;keys(r,['operation','invoice','plan_id','payload_hash','clear_existing_draft','acknowledged_candidate_ids']);
  if(!['preflight','prepare','commit','status','duplicate_check'].includes(String(r.operation)))bad('INVALID_FAST_LANE_OPERATION');
  const operation=r.operation as FastRequest['operation'];
  if(input.action!=='evaluate'&&!(operation==='status'&&input.action==='query'))bad('INVALID_FAST_LANE_ACTION');
  str(input.tab_id,'TAB_ID',200);
  if(input.approval!==undefined&&input.approval!=='use_policy')bad('FAST_LANE_REQUIRES_NORMAL_GUARD');
  if(input.dry_run===true)bad('USE_ISOLATED_FIXTURE_FOR_FAST_LANE_TESTS');
  if(operation!=='status'&&input.userConfirmed!==true)bad('EXPLICIT_SCOPE_CONFIRMATION_REQUIRED');
  let invoice:Invoice|undefined;
  if(operation!=='status'||r.invoice!==undefined){
    if(!rec(r.invoice))bad('INVOICE_SNAPSHOT_REQUIRED');const raw=r.invoice;keys(raw,['supplier','date','bill_ref','note','rows']);
    const date=str(raw.date,'DATE',10),d=new Date(date+'T12:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(d.valueOf())||d.toISOString().slice(0,10)!==date)bad('INVALID_DATE');
    if(!Array.isArray(raw.rows)||raw.rows.length<1||raw.rows.length>10)bad('INVALID_ROW_COUNT');const seen=new Set<string>();let total=0;
    const rows=raw.rows.map(x=>{if(!rec(x))bad('INVALID_ROW');keys(x,['sku','quantity','unit_cost_cents']);const sku=str(x.sku,'SKU',80);if(seen.has(sku))bad('DUPLICATE_SKU');seen.add(sku);const quantity=num(x.quantity,'QUANTITY'),unit_cost_cents=num(x.unit_cost_cents,'UNIT_COST');total+=quantity*unit_cost_cents;if(!Number.isSafeInteger(total))bad('TOTAL_OVERFLOW');return{sku,quantity,unit_cost_cents};});
    invoice={supplier:str(raw.supplier,'SUPPLIER',200),date,bill_ref:optionalStr(raw.bill_ref,'BILL_REFERENCE',128),note:operation==='duplicate_check'?optionalStr(raw.note??'','NOTE',1400):str(raw.note,'NOTE',1400),rows};
  }
  const plan_id=r.plan_id===undefined?undefined:str(r.plan_id,'PLAN_ID',36);if(plan_id&&!/^[a-f0-9-]{36}$/.test(plan_id))bad('INVALID_PLAN_ID');
  const payload_hash=r.payload_hash===undefined?undefined:str(r.payload_hash,'HASH',64);if(payload_hash&&!/^[a-f0-9]{64}$/.test(payload_hash))bad('INVALID_HASH');
  if(operation==='preflight'&&(plan_id||payload_hash))bad('PREFLIGHT_CANNOT_REUSE_PLAN');
  if(operation==='duplicate_check'&&(plan_id||payload_hash||r.acknowledged_candidate_ids!==undefined||r.clear_existing_draft===true))bad('DUPLICATE_CHECK_IS_READ_ONLY');
  if(operation!=='preflight'&&operation!=='duplicate_check'&&(!plan_id||!payload_hash))bad('PLAN_AND_HASH_REQUIRED');
  if(r.clear_existing_draft!==undefined&&typeof r.clear_existing_draft!=='boolean')bad('INVALID_CLEAR_DRAFT');
  if(operation==='commit'&&r.clear_existing_draft!==undefined)bad('COMMIT_CANNOT_CLEAR_DRAFT');
  if(operation==='prepare'&&r.clear_existing_draft===true)bad('CLEAR_DRAFT_ONLY_IN_PREFLIGHT');
  if(operation==='status'&&(r.invoice!==undefined||r.clear_existing_draft!==undefined||r.acknowledged_candidate_ids!==undefined))bad('STATUS_IS_RECONCILIATION_ONLY');
  const ack=r.acknowledged_candidate_ids??[];if(!Array.isArray(ack)||ack.length>12)bad('INVALID_CANDIDATE_ACK');const acknowledged_candidate_ids=ack.map(x=>num(x,'CANDIDATE_ID')).sort((a,b)=>a-b);if(new Set(acknowledged_candidate_ids).size!==acknowledged_candidate_ids.length)bad('DUPLICATE_CANDIDATE_ACK');
  if(operation==='preflight'&&acknowledged_candidate_ids.length)bad('CANNOT_ACK_UNSEEN_CANDIDATES');
  return{operation,...(invoice?{invoice}:{}),...(plan_id?{plan_id}:{}),...(payload_hash?{payload_hash}:{}),clear_existing_draft:r.clear_existing_draft===true,acknowledged_candidate_ids};
}
export const FAST_LANE_CONTRACT={version:FAST_LANE_VERSION,warningPolicy:'LATEST_MATCH_PER_ROW_V2',transport:'dom_cdp',action:'evaluate',operations:['preflight','prepare','commit','status'],target:{origin:FAST_LANE_ORIGIN,pathname:FAST_LANE_PATH,title:FAST_LANE_TITLE},rules:['list_tabs first; use exact returned tab_id','Repeat identical full invoice in preflight, prepare and commit; never submit caller JavaScript','Keep approval=use_policy and userConfirmed=true; native Guard remains unchanged','preflight returns planId,payloadHash,products,similarCandidates','Acknowledge exactly the returned similar-candidate IDs only after verifying a different bill','prepare returns REVIEW_READY and stockWrites=0','commit is single-consumption; lost response/UNKNOWN -> status only, never replay','status uses action=query with plan_id,payload_hash, no network or mutation','Plans expire 10 minutes after preflight or successful prepare; each native prompt still expires after 120 seconds','Only sack units; 1-10 rows; bill_ref may be intentionally empty and is deduplicated by supplier/date/rows; costs in integer satang; existing selling prices and cash untouched'],example:{action:'evaluate',tab_id:'<exact returned shop tab>',approval:'use_policy',userConfirmed:true,parameters:{invoice_fast_lane:{operation:'preflight',invoice:{supplier:'<exact supplier>',date:'2026-10-19',bill_ref:'<actual bill or intentionally empty>',note:'<actual approved note>',rows:[{sku:'<actual SKU>',quantity:1,unit_cost_cents:34500}]},clear_existing_draft:false}}},nextPhase:{operation:'prepare',plan_id:'<planId>',payload_hash:'<payloadHash>',invoice:'<repeat identical full invoice object>',acknowledged_candidate_ids:[]},finalPhase:{operation:'commit',plan_id:'<planId>',payload_hash:'<payloadHash>',invoice:'<repeat identical full invoice object>',acknowledged_candidate_ids:[]}};
Object.assign(FAST_LANE_CONTRACT,{extensionVersion:'PANYA-FASTLANE10-RECEIPT1',receiptRecovery:'fresh read-only document after CDP error; hashed baseline IDs; never resubmit; old UNKNOWN plans unchanged',limits:{maxRows:10,emptyBillReference:true,stockPrecision:'preserve catalog decimal; readback absolute tolerance 1e-9'}});
FAST_LANE_CONTRACT.operations.push('duplicate_check');
Object.assign(FAST_LANE_CONTRACT,{duplicateCheck:{version:'PANYA-DUPLICATE-CHECK1',maxPagesPerScope:12,deadlineMs:45000,canCommit:false,requires:'existing exact stock-in/batch tab; one normal native approval; full invoice snapshot, no plan/hash/ack; note may be empty',scopes:['supplier all dates','all sources on invoice date'],effects:'GET only; no draft changes, transaction plan, stock or receipt writes',limits:'two observations per page; no atomic snapshot; incomplete/drift/budget -> stop; bill reference unavailable in structured history -> INCOMPLETE; candidate matches require review',example:{action:'evaluate',tab_id:'<exact returned shop tab>',approval:'use_policy',userConfirmed:true,parameters:{invoice_fast_lane:{operation:'duplicate_check',invoice:{supplier:'<exact supplier>',date:'2026-09-01',bill_ref:'',note:'',rows:[{sku:'<actual SKU>',quantity:20,unit_cost_cents:49400}]}}}}}});

function cents(x:unknown):number{if(typeof x!=='number'||!Number.isFinite(x)||x<0||!Number.isSafeInteger(Math.round(x*100)))bad('INVALID_CATALOG_MONEY');return Math.round(x*100);}
function ledgerCost(x:LedgerRow):number{const m=x.text.match(/ต้นทุนต่อหน่วย฿([0-9,.]+)/);if(!m)bad('LEDGER_COST_ABSENT');const cost=Math.round(Number(m[1]!.replace(/,/g,''))*100);if(!Number.isSafeInteger(cost)||cost<=0)bad('INVALID_LEDGER_COST');return cost;}
function productMatch(x:LedgerRow,r:ConfigRow):boolean{return x.text.startsWith(r.productName+'#'+x.id+r.sku+' •');}
function configFrom(invoice:Invoice,target:Target,raw:Obj):{config:Obj;candidates:LedgerRow[];sourceId:number;products:ConfigRow[]}{
  if(raw.ok!==true||raw.stockWrites!==0||!rec(raw.source)||raw.source.name!==invoice.supplier||!rec(raw.history)||raw.history.allPagesChecked!==true||!Array.isArray(raw.history.rows)||!Array.isArray(raw.history.matches)||(invoice.bill_ref!==''&&raw.history.matches.length))bad('PREFLIGHT_INVALID_OR_DUPLICATE');
  const rawTarget=raw.target;if(!rec(rawTarget)||Object.entries(target).some(([k,v])=>rawTarget[k]!==v))bad('PREFLIGHT_TARGET_MISMATCH');
  const sourceId=num(raw.source.id,'SOURCE_ID');if(!Array.isArray(raw.products))bad('PRODUCTS_ABSENT');const history=raw.history.rows as LedgerRow[];
  for(const item of history)if(!rec(item)||typeof item.text!=='string'||typeof item.summary!=='string'||item.text.length>12000||item.summary.length>12000||!Number.isSafeInteger(item.id)||item.id<=0)bad('MALFORMED_HISTORY_ROW');
  const rows=invoice.rows.map(r=>{const matches=(raw.products as ProductRow[]).filter(p=>p.sku===r.sku&&Number(p.sourceId)===sourceId);if(matches.length!==1)bad('SKU_NOT_UNIQUE_'+r.sku);const p=matches[0]!;num(p.id,'PRODUCT_ID');if(p.unit!=='กระสอบ'||typeof p.stock!=='number'||!Number.isFinite(p.stock)||p.stock<0||p.stock>Number.MAX_SAFE_INTEGER-r.quantity)bad('UNIT_OR_STOCK_INVALID_'+r.sku);const row:ConfigRow={sku:r.sku,productId:p.id,productName:str(p.name,'PRODUCT_NAME',300),unit:p.unit,quantity:r.quantity,unitCostCents:r.unit_cost_cents,stockBefore:p.stock,sellCents:cents(p.sell),baselineCostCents:cents(p.cost),expectedMasterCostCents:r.unit_cost_cents};
    const relevant=history.filter(x=>productMatch(x,row)&&x.text.includes('สถานะใช้งานอยู่')).map(x=>{if(!Number.isSafeInteger(x.id)||!x.date||!/^\d{4}-\d{2}-\d{2}$/.test(x.date))bad('LATEST_COST_HISTORY_MALFORMED');return{id:x.id,date:x.date,cost:ledgerCost(x)};}).sort((a,b)=>b.date.localeCompare(a.date)||b.id-a.id);if(relevant[0]&&invoice.date<relevant[0].date)row.expectedMasterCostCents=relevant[0].cost;return row;});
  const label=new Intl.DateTimeFormat('th-TH',{day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Bangkok'}).format(new Date(invoice.date+'T12:00:00Z'));
  const candidates=history.filter(x=>x.text.includes('สถานะใช้งานอยู่')&&x.summary.includes('วันที่รายการ '+label)&&rows.some(r=>productMatch(x,r)&&x.text.includes('จำนวน'+r.quantity.toLocaleString('en-US')+' '+r.unit)&&ledgerCost(x)===r.unitCostCents));
  if(invoice.bill_ref===''){const groups=new Map<string,LedgerRow[]>();for(const x of history)if(x.text.includes('สถานะใช้งานอยู่')&&x.summary.includes('วันที่รายการ '+label)){if(typeof x.groupKey!=='string'||!x.groupKey)bad('BLANK_BILL_GROUP_IDENTITY_ABSENT');groups.set(x.groupKey,[...(groups.get(x.groupKey)??[]),x]);}for(const group of groups.values()){const matched=group.map(x=>rows.filter(r=>productMatch(x,r)&&x.text.includes('จำนวน'+r.quantity.toLocaleString('en-US')+' '+r.unit)&&ledgerCost(x)===r.unitCostCents)).filter(x=>x.length===1).map(x=>x[0]!.sku);if(group.length===rows.length&&matched.length===rows.length&&new Set(matched).size===rows.length)bad('BLANK_BILL_DUPLICATE_OR_AMBIGUOUS_NO_REPLAY');}}
  for(const x of candidates){num(x.id,'CANDIDATE');if(invoice.bill_ref!==''){const old=x.text.match(/เลขที่บิล:\s*([^|]+)/)?.[1]?.trim();if(!old||old===invoice.bill_ref)bad('UNIDENTIFIED_SIMILAR_RECEIPT');}}
  if(candidates.length>12)bad('TOO_MANY_SIMILAR_RECEIPTS');
  const totalCents=rows.reduce((n,r)=>n+r.quantity*r.unitCostCents,0);if(!Number.isSafeInteger(totalCents))bad('TOTAL_OVERFLOW');
  const baselineMovementIds=history.map(x=>x.id).sort((a,b)=>a-b);if(new Set(baselineMovementIds).size!==baselineMovementIds.length)bad('DUPLICATE_HISTORY_IDS');
  return{sourceId,candidates,products:rows,config:{target,sourceName:invoice.supplier,sourceId,date:invoice.date,billRef:invoice.bill_ref,note:invoice.note,rows,totalCents,acknowledgedCandidates:candidates,baselineMovementIds}};
}
function receiptKey(sourceId:number,invoice:Invoice):string{if(invoice.bill_ref!=='')return sha({origin:FAST_LANE_ORIGIN,sourceId,billRef:invoice.bill_ref});return sha({origin:FAST_LANE_ORIGIN,sourceId,supplier:invoice.supplier,date:invoice.date,rows:[...invoice.rows].sort((a,b)=>a.sku.localeCompare(b.sku))});}
function aborted(signal?:AbortSignal):void{if(signal?.aborted)bad('CANCELLED_NO_DISPATCH');}
// Windows can refuse directory handles; file FlushFileBuffers + atomic rename remain in force.
async function syncDirectory(file:string):Promise<void>{let fd;try{fd=await open(path.dirname(file),'r');await fd.sync();}catch(e){if(process.platform!=='win32'||!['EPERM','EACCES','EISDIR','EINVAL'].includes(String((e as NodeJS.ErrnoException).code)))throw e;}finally{await fd?.close();}}
async function durableNew(file:string,value:unknown):Promise<void>{const fd=await open(file,'wx',0o600);try{await fd.writeFile(JSON.stringify(value)+'\n','utf8');await fd.sync();}finally{await fd.close();}await syncDirectory(file);}
async function durableReplace(file:string,value:unknown):Promise<void>{const temp=file+'.'+randomUUID()+'.tmp';await durableNew(temp,value);await rename(temp,file);await syncDirectory(file);}
async function readJson(file:string):Promise<unknown>{return JSON.parse(await readFile(file,'utf8'));}

export function createFastLaneBridge(options:{capabilities:Pick<CapabilityService,'execute'>;runtimeStatePath?:string;owner:string}):(input:Obj,signal?:AbortSignal,authorization?:InvocationAuthorization)=>Promise<Result<unknown>|null>{
  const root=options.runtimeStatePath?path.join(path.dirname(options.runtimeStatePath),'invoice-fast-lane'):undefined;
  return async(input,signal,authorization)=>{
    let r:FastRequest|null;try{r=parseFastLaneRequest(input);}catch(e){return err(appError('INVALID_INPUT',String(e)));}if(!r)return null;if(!root&&r.operation!=='duplicate_check')return err(appError('INVALID_INPUT','Durable Fast Lane storage unavailable'));
    if(r.operation!=='status'&&authorization?.source!=='host_approval')return err(appError('PERMISSION_DENIED','Fast Lane requires this exact native approval'));
    const tabId=String(input.tab_id),machine=os.hostname(),at=():string=>new Date().toISOString();
    const call=async(request:Obj,timeoutSeconds=60):Promise<Obj>=>{aborted(signal);const value=await options.capabilities.execute('dom_cdp',{...request,tab_id:tabId,approval:'use_policy',userConfirmed:true,timeout_seconds:timeoutSeconds},signal,authorization);if(!value.ok)bad(value.error.code+': '+value.error.message);let raw=value.value;if(rec(raw)&&Array.isArray(raw.steps))raw=raw.steps.at(-1);if(!rec(raw)||raw.ok===false)bad('BROWSER_RESULT_INVALID');return raw;};
    const evaluate=(expression:string):Promise<Obj>=>call({action:'evaluate',parameters:{expression}});
    let lock:string|undefined,lockOwned=false,claimed=false,claimFile:string|undefined,receiptFile:string|undefined,plan:Plan|undefined;
    // This branch never enters the transactional journal, draft or receipt paths.
    if(r.operation==='duplicate_check'){
      try{
        aborted(signal);
        const invoice=r.invoice!,target:Target={tabId,origin:FAST_LANE_ORIGIN,pathname:FAST_LANE_PATH,title:FAST_LANE_TITLE};
        const raw=await evaluate(duplicateCheckBrowserProgram({target,supplier:invoice.supplier,date:invoice.date,rows:invoice.rows}));
        aborted(signal);
        const result=analyzeDuplicateCheck(invoice,raw,target);
        return ok({...result,contractVersion:FAST_LANE_VERSION,duplicateCheckVersion:'PANYA-DUPLICATE-CHECK1',checkId:randomUUID(),checkHash:sha({machine,owner:options.owner,target,invoice}),machine});
      }catch(e){return err(appError('CONFLICT',String(e)));}
    }
    if(!root)return err(appError('INVALID_INPUT','Durable Fast Lane storage unavailable'));
    try{
      aborted(signal);if(r.operation==='preflight'){await mkdir(path.join(root,'plans'),{recursive:true});await mkdir(path.join(root,'claims'),{recursive:true});await mkdir(path.join(root,'receipts'),{recursive:true});}
      if(r.operation==='preflight'){
        const invoice=r.invoice!,target:Target={tabId,origin:FAST_LANE_ORIGIN,pathname:FAST_LANE_PATH,title:FAST_LANE_TITLE};
        const emptyCheck='(()=>{if(location.origin!=='+JSON.stringify(FAST_LANE_ORIGIN)+'||location.pathname!=='+JSON.stringify(FAST_LANE_PATH)+'||document.title!=='+JSON.stringify(FAST_LANE_TITLE)+')throw Error("WRONG_PAGE");const bill=document.querySelector("#billNumber")?.value??"",filled=[...document.querySelectorAll("input[name^=productId-row-]")].some(x=>x.value);if((bill||filled)&&(!'+JSON.stringify(r.clear_existing_draft)+'||(bill&&bill!=='+JSON.stringify(invoice.bill_ref)+')))throw Error("EXISTING_DRAFT_REQUIRES_REVIEW");return{ok:true};})()';
        await evaluate(emptyCheck);aborted(signal);
        const raw=await call({steps:[{action:'navigate',parameters:{url:FAST_LANE_ORIGIN+FAST_LANE_PATH}},{action:'wait',parameters:{expression:"!!document.querySelector('#sourceSearch')&&Object.keys(document.querySelector('#sourceSearch')).some(k=>k.startsWith('__reactFiber$'))",poll_interval_seconds:0.1}},{action:'evaluate',parameters:{expression:fastLaneBrowserProgram('preflight',{target,sourceName:invoice.supplier,sourceId:null,date:invoice.date,billRef:invoice.bill_ref,note:invoice.note,rows:invoice.rows,totalCents:0,payloadHash:null})}}]});
        aborted(signal);const data=configFrom(invoice,target,raw),payloadHash=sha({machine,invoice,...data.config});
        const key=receiptKey(data.sourceId,invoice);try{await readFile(path.join(root,'claims',key+'.json'));bad('EXISTING_CLAIM_RECONCILE_ONLY');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
        plan={version:1,planId:randomUUID(),owner:options.owner,machine,tabId,createdAtUtc:at(),expiresAt:Date.now()+TTL,phase:'PREFLIGHT',invoice,config:{...data.config,payloadHash},payloadHash,candidates:data.candidates,sourceId:data.sourceId};
        await durableNew(path.join(root,'plans',plan.planId+'.json'),plan);
        return ok({status:'PREFLIGHT_READY',contractVersion:FAST_LANE_VERSION,machine,planId:plan.planId,payloadHash,expiresAtUtc:new Date(plan.expiresAt).toISOString(),stockWrites:0,source:raw.source,products:data.products,similarCandidates:data.candidates,historyProof:rec(raw.history)?{atUtc:raw.atUtc,pageCount:raw.history.pageCount,totalGroups:raw.history.totalGroups,allPagesChecked:true}:null});
      }
      const file=path.join(root,'plans',r.plan_id!+'.json');const saved=await readJson(file);if(!rec(saved)||saved.version!==1)bad('PLAN_CORRUPT');plan=saved as unknown as Plan;
      if(plan.owner!==options.owner||plan.machine!==machine||plan.tabId!==tabId||plan.payloadHash!==r.payload_hash)bad('PLAN_OWNER_HOST_TAB_OR_HASH_MISMATCH');
      const expected=sha({machine,invoice:plan.invoice,...Object.fromEntries(Object.entries(plan.config).filter(([k])=>k!=='payloadHash'))});if(expected!==plan.payloadHash||plan.config.payloadHash!==plan.payloadHash)bad('PLAN_DATA_HASH_MISMATCH');
      const key=receiptKey(plan.sourceId,plan.invoice);claimFile=path.join(root,'claims',key+'.json');receiptFile=path.join(root,'receipts',key+'.json');
      if(r.operation==='status'){
        let claim:unknown=null,receipt:unknown=null;
        try{claim=await readJson(claimFile);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')bad('CLAIM_CORRUPT_NO_REPLAY');}
        try{receipt=await readJson(receiptFile);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')bad('RECEIPT_CORRUPT_NO_REPLAY');}
        const bound=(x:unknown):boolean=>rec(x)&&x.planId===plan!.planId&&x.payloadHash===plan!.payloadHash&&x.owner===plan!.owner&&x.machine===machine&&x.tabId===tabId&&x.sourceId===plan!.sourceId&&sha(x.invoice)===sha(plan!.invoice);
        if(claim!==null&&!bound(claim))bad('CLAIM_BINDING_MISMATCH_NO_REPLAY');
        if(receipt!==null&&(!bound(receipt)||!rec(receipt)||receipt.status!=='VERIFIED_LIVE'||!rec(receipt.result)||receipt.result.status!=='RECEIVED_VERIFIED'||receipt.result.committedBatches!==1))bad('RECEIPT_BINDING_MISMATCH_NO_REPLAY');
        const status=receipt!==null?'VERIFIED':claim!==null?'UNKNOWN':plan.phase==='VERIFIED'?'UNKNOWN':plan.phase;
        return ok({status,contractVersion:FAST_LANE_VERSION,machine,planId:plan.planId,payloadHash:plan.payloadHash,expired:Date.now()>plan.expiresAt,claim,receipt,automaticReplayAllowed:false,recoveryNeeded:status==='UNKNOWN'||status==='PREPARING',reconcileOnly:status!=='PREFLIGHT'&&status!=='REVIEW_READY',stockWrites:0});
      }
      if(sha(r.invoice)!==sha(plan.invoice))bad('INVOICE_SNAPSHOT_MISMATCH');if(Date.now()>plan.expiresAt)bad('PLAN_EXPIRED');if(sha(r.acknowledged_candidate_ids)!==sha(plan.candidates.map(x=>x.id).sort((a,b)=>a-b)))bad('SIMILAR_CANDIDATES_REQUIRE_EXACT_ACK');
      lock=path.join(root,'plans',plan.planId+'.lock');await durableNew(lock,{owner:options.owner,atUtc:at()});lockOwned=true;aborted(signal);
      if(r.operation==='prepare'){
        if(plan.phase!=='PREFLIGHT')bad('PREPARE_ALREADY_USED_OR_UNKNOWN');
        plan={...plan,phase:'PREPARING'};await durableReplace(file,plan);aborted(signal);
        const result=await evaluate(fastLaneBrowserProgram('prepare',plan.config));aborted(signal);if(result.status!=='REVIEW_READY'||result.payloadHash!==plan.payloadHash||result.stockWrites!==0)bad('PREPARE_NOT_VERIFIED');
        plan={...plan,phase:'REVIEW_READY',expiresAt:Date.now()+TTL,result};await durableReplace(file,plan);return ok({...result,planId:plan.planId,machine,expiresAtUtc:new Date(plan.expiresAt).toISOString()});
      }
      if(plan.phase!=='REVIEW_READY')bad('COMMIT_REQUIRES_REVIEW_READY');aborted(signal);
      await durableNew(claimFile,{version:1,state:'CLAIMED',planId:plan.planId,payloadHash:plan.payloadHash,owner:options.owner,machine,tabId,invoice:plan.invoice,sourceId:plan.sourceId,claimedAtUtc:at(),automaticReplayAllowed:false});claimed=true;
      plan={...plan,phase:'CLAIMED'};await durableReplace(file,plan);aborted(signal);
      let result:Obj;
      try{result=await evaluate(fastLaneBrowserProgram('commit',plan.config));}
      catch(dispatchError){
        // The durable claim is already consumed. This branch can only read the new document.
        // Older plans have no hashed baseline and deliberately remain reconcile-only UNKNOWN.
        if(!Array.isArray(plan.config.baselineMovementIds))throw dispatchError;
        try{
          const recovered=await call({steps:[{action:'wait',parameters:{expression:"location.origin==="+JSON.stringify(FAST_LANE_ORIGIN)+"&&location.pathname==="+JSON.stringify(FAST_LANE_PATH)+"&&document.title==="+JSON.stringify(FAST_LANE_TITLE)+"&&!!document.querySelector('#sourceSearch')&&Object.keys(document.querySelector('#sourceSearch')).some(k=>k.startsWith('__reactFiber$'))",poll_interval_seconds:0.1}},{action:'evaluate',parameters:{expression:fastLaneBrowserProgram('readback',plan.config)}}]},15);
          result={...recovered,recovery:{mode:'READ_ONLY_AFTER_CDP_ERROR',dispatchError:String(dispatchError)}};
        }catch(readbackError){bad('DISPATCH_UNKNOWN: '+String(dispatchError)+'; READ_ONLY_RECOVERY_FAILED: '+String(readbackError));}
      }
      if(result.status!=='RECEIVED_VERIFIED'||result.payloadHash!==plan.payloadHash||result.stockWrites!==1||result.committedBatches!==1||!Array.isArray(result.movementIds)||result.movementIds.length!==plan.invoice.rows.length)bad('COMMIT_RECEIPT_NOT_VERIFIED');
      const receipt={status:'VERIFIED_LIVE',contractVersion:FAST_LANE_VERSION,planId:plan.planId,payloadHash:plan.payloadHash,machine,tabId,sourceId:plan.sourceId,owner:options.owner,atUtc:at(),invoice:plan.invoice,result,automaticReplayAllowed:false};await durableNew(receiptFile,receipt);plan={...plan,phase:'VERIFIED',result};await durableReplace(file,plan);return ok({...result,planId:plan.planId,machine,receiptId:key,automaticReplayAllowed:false});
    }catch(e){
      if(claimed&&plan){try{plan={...plan,phase:'UNKNOWN',result:{error:String(e),automaticReplayAllowed:false}};await durableReplace(path.join(root,'plans',plan.planId+'.json'),plan);}catch{/* Claim remains consumed even if receipt recording fails. */}return ok({status:'UNKNOWN',planId:plan.planId,payloadHash:plan.payloadHash,error:String(e),automaticReplayAllowed:false,reconcileOnly:true});}
      return err(appError('CONFLICT',String(e)));
    }finally{if(lock&&lockOwned)await unlink(lock).catch(()=>undefined);}
  };
}
