import {mkdtemp,readFile,readdir,rm,writeFile,rename} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {ok,type InvocationAuthorization,type Result} from '@lnwjud/domain';
import {createFastLaneBridge,parseFastLaneRequest,FAST_LANE_CONTRACT,FAST_LANE_ORIGIN,FAST_LANE_PATH,FAST_LANE_TITLE} from './invoice-fast-lane.js';
import {summarizeDomCdpMutationForApproval} from './approval-summary.js';
import {fastLaneBrowserProgram} from './invoice-fast-lane-browser.js';

const auth:InvocationAuthorization={mode:'standard',applicationApproved:true,bypassApplicationAuthorization:false,source:'host_approval'};
const invoice={supplier:'ผู้ขายจำลอง',date:'2026-10-19',bill_ref:'SIM-NATIVE-UNIT',note:'SIMULATION ONLY',rows:[{sku:'SIM-1',quantity:5,unit_cost_cents:34500}]};
const target={tabId:'FAKE-TAB',origin:FAST_LANE_ORIGIN,pathname:FAST_LANE_PATH,title:FAST_LANE_TITLE};
const dirs:string[]=[];
const request=(r:Record<string,unknown>):Record<string,unknown>=>({action:r.operation==='status'?'query':'evaluate',tab_id:target.tabId,approval:'use_policy',userConfirmed:true,parameters:{invoice_fast_lane:r}});
function object(x:unknown):Record<string,unknown>{if(x===null||typeof x!=='object'||Array.isArray(x))throw Error('object expected');return x as Record<string,unknown>;}
function config(input:unknown):Record<string,unknown>{const x=object(input),p=object(x.parameters),expression=String(p.expression),start=expression.indexOf('const c=')+8,end=expression.indexOf(',fail=x=>');if(start<8||end<start)throw Error('Fixed-program config absent');return JSON.parse(expression.slice(start,end)) as Record<string,unknown>;}
interface Fixture {dir:string;options:Parameters<typeof createFastLaneBridge>[0];bridge:ReturnType<typeof createFastLaneBridge>;pre:Record<string,unknown>;envelope:{invoice:typeof invoice;plan_id:unknown;payload_hash:unknown};execute:ReturnType<typeof vi.fn<(_tool:unknown,input:unknown)=>Promise<Result<unknown>>>>;commits:()=>number;lose:()=>void;recover:()=>void;}
async function fixture(owner='client:session',stock=100,allowPreflightFailure=false,initialInvoice=invoice,historyRows:Record<string,unknown>[]=[]):Promise<Fixture>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'lnwjud-fastlane-unit-'));dirs.push(dir);let commitCalls=0,loss=false,recovery=false;
 const execute=vi.fn(async(_tool:unknown,input:unknown)=>{
  const i=object(input);if(Array.isArray(i.steps)){
   const last=object(i.steps.at(-1)),expression=String(object(last.parameters).expression);
   if(expression.includes('return readbackFull()')){if(!recovery)throw Error('SIMULATED READBACK EVIDENCE INCOMPLETE');const c=config(last);return ok({steps:[{status:'RECEIVED_VERIFIED',payloadHash:c.payloadHash,target,stockWrites:1,committedBatches:1,movementIds:initialInvoice.rows.map((_,n)=>6000+n),receipt:initialInvoice.rows.map((_,n)=>({id:6000+n}))}]});}
   return ok({steps:[{ok:true,stockWrites:0,target,source:{id:12,name:initialInvoice.supplier},products:initialInvoice.rows.map((r,n)=>({id:30+n,sku:r.sku,name:n===0?'สินค้าจำลอง':'สินค้าจำลอง '+r.sku,unit:'กระสอบ',stock,cost:r.unit_cost_cents/100,sell:385,sourceId:12})),history:{rows:historyRows,matches:[],allPagesChecked:true,pageCount:1,totalGroups:new Set(historyRows.map(x=>x.groupKey)).size},atUtc:new Date().toISOString()}]});
  }
  const p=object(i.parameters),expression=String(p.expression);if(!expression.includes('const c='))return ok({ok:true});
  const c=config(i);if(expression.includes('return prepareFull()'))return ok({status:'REVIEW_READY',payloadHash:c.payloadHash,target,stockWrites:0});
  if(expression.includes('return commitFull()')){commitCalls++;if(loss)throw Error('SIMULATED RESPONSE LOSS AFTER DISPATCH');return ok({status:'RECEIVED_VERIFIED',payloadHash:c.payloadHash,target,stockWrites:1,committedBatches:1,movementIds:initialInvoice.rows.map((_,n)=>6000+n),receipt:initialInvoice.rows.map((_,n)=>({id:6000+n}))});}
  throw Error('Unexpected fake transport call');
 });
 const options={owner,runtimeStatePath:path.join(dir,'runtime.json'),capabilities:{execute}};
 const bridge=createFastLaneBridge(options);
 const pre=await bridge(request({operation:'preflight',invoice:initialInvoice}),undefined,auth);if(!pre?.ok){if(!allowPreflightFailure)throw Error(JSON.stringify(pre));return{dir,options,bridge,pre:undefined as never,envelope:{invoice:initialInvoice,plan_id:undefined,payload_hash:undefined},execute,commits:():number=>commitCalls,lose:():void=>{loss=true;},recover:():void=>{recovery=true;}};}const plan=object(pre.value);
 const envelope={invoice:initialInvoice,plan_id:plan.planId,payload_hash:plan.payloadHash};
 return{dir,options,bridge,pre:plan,envelope,execute,commits:():number=>commitCalls,lose:():void=>{loss=true;},recover:():void=>{recovery=true;}};
}
afterEach(async()=>{for(const dir of dirs.splice(0)){const p=path.resolve(dir);if(path.dirname(p)!==path.resolve(os.tmpdir())||!path.basename(p).startsWith('lnwjud-fastlane-unit-'))throw Error('Unsafe test cleanup');await rm(p,{recursive:true,force:true});}});

describe('typed native Fast Lane durable orchestration (fake transport, not business E2E)',()=>{
 it('rejects invalid dates, mixed JS, unknown fields, overflow, duplicate SKUs and incomplete snapshots',()=>{
  for(const change of[{date:'2026-02-30'},{rows:[...invoice.rows,...invoice.rows]},{rows:[{sku:'X',quantity:Number.MAX_SAFE_INTEGER,unit_cost_cents:2}]},{rows:[{...invoice.rows[0],extra:true}]},{extra:true}])expect(()=>parseFastLaneRequest(request({operation:'preflight',invoice:{...invoice,...change}}))).toThrow();
  expect(()=>parseFastLaneRequest({...request({operation:'preflight',invoice}),parameters:{invoice_fast_lane:{operation:'preflight',invoice},expression:'alert(1)'}})).toThrow();
  expect(()=>parseFastLaneRequest(request({operation:'commit',plan_id:'00000000-0000-0000-0000-000000000000',payload_hash:'a'.repeat(64)}))).toThrow();
 });
 it('accepts 1-10 rows and an explicitly intentional empty bill reference',()=>{
  const tenRows=Array.from({length:10},(_,n)=>({sku:'SIM-'+(n+1),quantity:1,unit_cost_cents:34500}));
  const parsed=parseFastLaneRequest(request({operation:'preflight',invoice:{...invoice,rows:tenRows,bill_ref:''}}));
  expect(parsed).toMatchObject({operation:'preflight',invoice:{bill_ref:'',rows:tenRows}});
  expect(FAST_LANE_CONTRACT).toMatchObject({extensionVersion:'PANYA-FASTLANE10-RECEIPT1',limits:{maxRows:10,emptyBillReference:true}});
  const elevenRows=Array.from({length:11},(_,n)=>({sku:'SIM-'+(n+1),quantity:1,unit_cost_cents:34500}));
  expect(()=>parseFastLaneRequest(request({operation:'preflight',invoice:{...invoice,rows:elevenRows}}))).toThrow('INVALID_ROW_COUNT');
 });
 it('preserves fractional current stock exactly through preflight',async()=>{
  const f=await fixture('client:session',223.996725);
  expect(object(f.pre).products).toMatchObject([{stockBefore:223.996725}]);
 });
 it('rejects nonfinite, negative, and unsafe post-receipt catalog stock before any durable plan',async()=>{
  for(const stock of [NaN,Infinity,-0.1,Number.MAX_VALUE]){
   const f=await fixture('client:session',stock,true);
   expect(f.pre).toBeUndefined();
   expect(await readdir(path.join(f.dir,'invoice-fast-lane','plans'))).toHaveLength(0);
  }
 });
 it('fails closed for one no-label historical blank-bill group with the exact row tuple',async()=>{
  const blank={...invoice,bill_ref:'',note:'หมายเหตุใหม่'};
  const label=new Intl.DateTimeFormat('th-TH',{day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Bangkok'}).format(new Date(blank.date+'T12:00:00Z'));
  const history=[{id:901,text:'สินค้าจำลอง#901SIM-1 • จำนวน5 กระสอบ ต้นทุนต่อหน่วย฿345.00 สถานะใช้งานอยู่ หมายเหตุ: หมายเหตุบิล: เก่า',summary:'วันที่รายการ '+label,groupKey:'1:0',date:'2026-10-19'}];
  const f=await fixture('client:session',100,true,blank,history);
  expect(f.pre).toBeUndefined();
  expect(await readdir(path.join(f.dir,'invoice-fast-lane','plans'))).toHaveLength(0);
 });
 it('does not merge distinct history groups merely because their summaries are identical',async()=>{
  const blank={...invoice,bill_ref:''};
  const label=new Intl.DateTimeFormat('th-TH',{day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Bangkok'}).format(new Date(blank.date+'T12:00:00Z'));
  const history=[901,902].map((id,n)=>({id,text:'สินค้าจำลอง#'+id+'SIM-1 • จำนวน5 กระสอบต้นทุนต่อหน่วย฿345.00สถานะใช้งานอยู่หมายเหตุ: หมายเหตุบิล: เก่า',summary:'วันที่รายการ '+label,groupKey:'1:'+n,date:blank.date}));
  const f=await fixture('client:session',100,true,blank,history);
  expect(f.pre).toBeUndefined();expect(await readdir(path.join(f.dir,'invoice-fast-lane','plans'))).toHaveLength(0);
 });
 it('does not assemble one duplicate invoice from rows in separate history groups',async()=>{
  const blank={...invoice,bill_ref:'',rows:[...invoice.rows,{sku:'SIM-2',quantity:2,unit_cost_cents:20000}]};
  const label=new Intl.DateTimeFormat('th-TH',{day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Bangkok'}).format(new Date(blank.date+'T12:00:00Z'));
  const history=[{id:901,text:'สินค้าจำลอง#901SIM-1 • จำนวน5 กระสอบต้นทุนต่อหน่วย฿345.00สถานะใช้งานอยู่',summary:'วันที่รายการ '+label,groupKey:'1:0',date:blank.date},{id:902,text:'สินค้าจำลอง SIM-2#902SIM-2 • จำนวน2 กระสอบต้นทุนต่อหน่วย฿200.00สถานะใช้งานอยู่',summary:'วันที่รายการ '+label,groupKey:'1:1',date:blank.date}];
  const f=await fixture('client:session',100,false,blank,history);
  expect(f.pre.status).toBe('PREFLIGHT_READY');expect(f.pre.similarCandidates).toHaveLength(2);expect(f.commits()).toBe(0);
 });
 it('keeps a blank-bill claim consumed despite changed note or canonical row order, with independent dates and tuples',async()=>{
  const blank={...invoice,bill_ref:'',rows:[...invoice.rows,{sku:'SIM-2',quantity:2,unit_cost_cents:20000}]};
  const f=await fixture('client:session',100,false,blank);
  expect((await f.bridge(request({operation:'prepare',...f.envelope}),undefined,auth))?.ok).toBe(true);
  expect((await f.bridge(request({operation:'commit',...f.envelope}),undefined,auth))?.ok).toBe(true);
  const replay=await f.bridge(request({operation:'preflight',invoice:{...blank,note:'เปลี่ยนหมายเหตุ',rows:[...blank.rows].reverse()}}),undefined,auth);
  expect(replay?.ok).toBe(false);expect(JSON.stringify(replay)).toContain('EXISTING_CLAIM_RECONCILE_ONLY');expect(f.commits()).toBe(1);
  for(const next of [{...blank,date:'2026-10-20'},{...blank,rows:blank.rows.map((r,n)=>n===0?{...r,quantity:r.quantity+1}:r)}]){
   const result=await f.bridge(request({operation:'preflight',invoice:next}),undefined,auth);expect(result?.ok,JSON.stringify(result)).toBe(true);
  }
  expect(f.commits()).toBe(1);
 });
 it('rejects an expired plan before another browser dispatch',async()=>{
  const f=await fixture(),file=path.join(f.dir,'invoice-fast-lane','plans',String(f.pre.planId)+'.json');
  const plan=JSON.parse(await readFile(file,'utf8'));plan.expiresAt=Date.now()-1;await writeFile(file,JSON.stringify(plan));
  const before=f.execute.mock.calls.length,result=await f.bridge(request({operation:'prepare',...f.envelope}),undefined,auth);
  expect(result?.ok).toBe(false);expect(JSON.stringify(result)).toContain('PLAN_EXPIRED');expect(f.execute).toHaveBeenCalledTimes(before);expect(f.commits()).toBe(0);
 });
 it('shows the full tenth row, explicit blank reference and exact amount in each approval phase',()=>{
  const ten={...invoice,bill_ref:'',rows:Array.from({length:10},(_,n)=>({sku:'SIM-'+(n+1),quantity:1,unit_cost_cents:34500}))};
  for(const operation of ['preflight','prepare','commit']){
   const summary=summarizeDomCdpMutationForApproval(request({operation,invoice:ten,...(operation==='preflight'?{}:{plan_id:'00000000-0000-0000-0000-000000000000',payload_hash:'a'.repeat(64)})}));
   expect(summary).toContain('เลขที่บิล = ""');expect(summary).toContain('รายการ 10 = SKU "SIM-10"; 1 กระสอบ; ทุน 345.00');expect(summary).toContain('3450.00 บาท');
  }
 });
 it('uses a canonical blank-bill claim tuple: note/order cannot bypass it, while a different date is independent',async()=>{
  const blank={...invoice,bill_ref:'',note:'first'};
  const f=await fixture('client:session',100,false,blank);
  expect((await f.bridge(request({operation:'prepare',...f.envelope}),undefined,auth))?.ok).toBe(true);
  expect((await f.bridge(request({operation:'commit',...f.envelope}),undefined,auth))?.ok).toBe(true);
  expect((await f.bridge(request({operation:'preflight',invoice:{...blank,note:'different note'}}),undefined,auth))?.ok).toBe(false);
  expect((await f.bridge(request({operation:'preflight',invoice:{...blank,date:'2026-10-20'}}),undefined,auth))?.ok).toBe(true);
 });
 it('expires a review plan before further browser dispatch',async()=>{
  const f=await fixture();expect((await f.bridge(request({operation:'prepare',...f.envelope}),undefined,auth))?.ok).toBe(true);
  const before=f.execute.mock.calls.length;vi.useFakeTimers();vi.setSystemTime(Date.now()+600001);
  expect((await f.bridge(request({operation:'commit',...f.envelope}),undefined,auth))?.ok).toBe(false);expect(f.execute).toHaveBeenCalledTimes(before);
 });
 it('requires host approval even if caller claims userConfirmed',async()=>{
  const f=await fixture();const before=f.execute.mock.calls.length;
  const result=await f.bridge(request({operation:'preflight',invoice}));expect(result?.ok).toBe(false);expect(f.execute).toHaveBeenCalledTimes(before);
 });
 it('repeats exact scope in each approval summary and never truncates or throws on malformed data',()=>{
  for(const operation of['preflight','prepare','commit']){const s=summarizeDomCdpMutationForApproval(request({operation,invoice,...(operation==='preflight'?{}:{plan_id:'00000000-0000-0000-0000-000000000000',payload_hash:'a'.repeat(64)})}));expect(s).toContain('SIM-NATIVE-UNIT');expect(s).toContain('SIM-1');expect(s).toContain('1725.00');expect(s).toContain('FAKE-TAB');expect(s).toContain(invoice.note);}
  expect(()=>summarizeDomCdpMutationForApproval(request({operation:'preflight',invoice:{...invoice,rows:[{}]}}))).not.toThrow();expect(summarizeDomCdpMutationForApproval(request({operation:'preflight',invoice:{...invoice,rows:[{}]}}))).toBeNull();
 });
 it('stops tampered invoice, hash, owner and target before dispatch',async()=>{
  const f=await fixture();const before=f.execute.mock.calls.length;
  for(const r of[{...f.envelope,invoice:{...invoice,bill_ref:'ALTERED'}},{...f.envelope,payload_hash:'b'.repeat(64)}])expect((await f.bridge(request({operation:'prepare',...r}),undefined,auth))?.ok).toBe(false);
  expect((await createFastLaneBridge({...f.options,owner:'other'})(request({operation:'prepare',...f.envelope}),undefined,auth))?.ok).toBe(false);
  expect((await f.bridge({...request({operation:'prepare',...f.envelope}),tab_id:'WRONG'},undefined,auth))?.ok).toBe(false);expect(f.execute).toHaveBeenCalledTimes(before);
 });
 it('persists one claim and receipt across a new bridge, and status performs zero browser calls',async()=>{
  const f=await fixture(),prepared=await f.bridge(request({operation:'prepare',...f.envelope}),undefined,auth);expect(prepared?.ok,JSON.stringify(prepared)).toBe(true);
  const committed=await f.bridge(request({operation:'commit',...f.envelope}),undefined,auth);expect(committed?.ok&&object(committed.value).status).toBe('RECEIVED_VERIFIED');expect(f.commits()).toBe(1);
  const restarted=createFastLaneBridge(f.options),before=f.execute.mock.calls.length;
  const status=await restarted(request({operation:'status',plan_id:f.pre.planId,payload_hash:f.pre.payloadHash}));expect(status?.ok&&object(status.value).status).toBe('VERIFIED');expect(f.execute).toHaveBeenCalledTimes(before);
  expect((await restarted(request({operation:'commit',...f.envelope}),undefined,auth))?.ok).toBe(false);expect(f.commits()).toBe(1);
  const receipts=await readdir(path.join(f.dir,'invoice-fast-lane','receipts'));expect(receipts).toHaveLength(1);const receipt=JSON.parse(await readFile(path.join(f.dir,'invoice-fast-lane','receipts',receipts[0]!),'utf8'));expect(receipt.automaticReplayAllowed).toBe(false);
 });
 it('response loss consumes claim permanently and restart remains UNKNOWN without another commit',async()=>{
  const f=await fixture();await f.bridge(request({operation:'prepare',...f.envelope}),undefined,auth);f.lose();
  const r=await f.bridge(request({operation:'commit',...f.envelope}),undefined,auth);expect(r?.ok&&object(r.value).status).toBe('UNKNOWN');expect(f.commits()).toBe(1);
  const restart=createFastLaneBridge(f.options);expect((await restart(request({operation:'commit',...f.envelope}),undefined,auth))?.ok).toBe(false);expect(f.commits()).toBe(1);
 });
 it('after response loss recovers by one fresh read-only program and persists one bound receipt without resubmitting',async()=>{
  const f=await fixture();await f.bridge(request({operation:'prepare',...f.envelope}),undefined,auth);f.lose();f.recover();
  const result=await f.bridge(request({operation:'commit',...f.envelope}),undefined,auth);
  expect(result?.ok&&object(result.value)).toMatchObject({status:'RECEIVED_VERIFIED',automaticReplayAllowed:false,recovery:{mode:'READ_ONLY_AFTER_CDP_ERROR'}});
  expect(f.commits()).toBe(1);
  const recoveries=f.execute.mock.calls.filter(([,input])=>JSON.stringify(input).includes('return readbackFull()'));
  expect(recoveries).toHaveLength(1);
  const recoveryRequest=object(recoveries[0]![1]),recoverySteps=recoveryRequest.steps as unknown[];
  expect(recoveryRequest.timeout_seconds).toBe(15);
  const configSnapshot=config(recoverySteps.at(-1));
  expect(configSnapshot.baselineMovementIds).toEqual([]);
  const before=f.execute.mock.calls.length,status=await createFastLaneBridge(f.options)(request({operation:'status',plan_id:f.pre.planId,payload_hash:f.pre.payloadHash}));
  expect(status?.ok&&object(status.value)).toMatchObject({status:'VERIFIED',receipt:{status:'VERIFIED_LIVE'},automaticReplayAllowed:false,recoveryNeeded:false,stockWrites:0});
  expect(f.execute).toHaveBeenCalledTimes(before);expect(await readdir(path.join(f.dir,'invoice-fast-lane','receipts'))).toHaveLength(1);
  expect((await f.bridge(request({operation:'commit',...f.envelope}),undefined,auth))?.ok).toBe(false);expect(f.commits()).toBe(1);
 });
 it('fresh readback contains no submission, click, fill, navigation or POST path and requires baseline plus one unambiguous new group',()=>{
  const expression=fastLaneBrowserProgram('readback',{date:invoice.date,baselineMovementIds:[]});
  expect(expression).toContain('return readbackFull()');
  for(const forbidden of ['.click(','.dispatchEvent(',"method:'POST'",'commitFull','reviewKnownWarning','waitResult','location.assign'])expect(expression).not.toContain(forbidden);
  for(const check of ['READBACK_SUCCESS_NAVIGATION_ABSENT','READBACK_BASELINE_ABSENT','READBACK_OLD_MOVEMENT','READBACK_AMBIGUOUS_GROUP','RECEIPT_COUNT','READBACK_MISMATCH_NO_REPLAY','STOCK_PRICE_CHANGED'])expect(expression).toContain(check);
  expect(()=>new Function('return '+expression)).not.toThrow();
 });
 it('same-plan racing commits dispatch one browser commit and do not remove another operation lock',async()=>{
  const f=await fixture();await f.bridge(request({operation:'prepare',...f.envelope}),undefined,auth);
  const result=await Promise.all([f.bridge(request({operation:'commit',...f.envelope}),undefined,auth),createFastLaneBridge(f.options)(request({operation:'commit',...f.envelope}),undefined,auth)]);
  expect(result.filter(x=>x?.ok&&object(x.value).status==='RECEIVED_VERIFIED')).toHaveLength(1);expect(f.commits()).toBe(1);
 });
 it('cancellation before dispatch leaves browser and journal untouched',async()=>{
  const f=await fixture(),before=f.execute.mock.calls.length,controller=new AbortController();controller.abort();
  expect((await f.bridge(request({operation:'prepare',...f.envelope}),controller.signal,auth))?.ok).toBe(false);expect(f.execute).toHaveBeenCalledTimes(before);expect(await readdir(path.join(f.dir,'invoice-fast-lane','claims'))).toHaveLength(0);
 });
 it('derives recovery status from claim and receipt across plan-write crash windows',async()=>{
  const f=await fixture();await f.bridge(request({operation:'prepare',...f.envelope}),undefined,auth);const planFile=path.join(f.dir,'invoice-fast-lane','plans',String(f.pre.planId)+'.json'),beforePlan=await readFile(planFile,'utf8');
  await f.bridge(request({operation:'commit',...f.envelope}),undefined,auth);await writeFile(planFile,beforePlan);const calls=f.execute.mock.calls.length,restart=createFastLaneBridge(f.options),statusArgs=request({operation:'status',plan_id:f.pre.planId,payload_hash:f.pre.payloadHash});
  const verified=await restart(statusArgs);expect(verified?.ok&&object(verified.value).status).toBe('VERIFIED');
  const folder=path.join(f.dir,'invoice-fast-lane','receipts'),files=await readdir(folder);await rename(path.join(folder,files[0]!),path.join(f.dir,'receipt-after-crash.json'));
  const unknown=await restart(statusArgs);expect(unknown?.ok&&object(unknown.value).status).toBe('UNKNOWN');expect(unknown?.ok&&object(unknown.value).reconcileOnly).toBe(true);expect(f.execute).toHaveBeenCalledTimes(calls);
 });
});
