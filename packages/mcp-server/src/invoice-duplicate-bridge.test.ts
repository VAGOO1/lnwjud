import {mkdtemp,readdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {ok,type InvocationAuthorization} from '@lnwjud/domain';
import {permissionProfiles} from '@lnwjud/permissions';
import {createFastLaneBridge,parseFastLaneRequest,FAST_LANE_CONTRACT,FAST_LANE_ORIGIN,FAST_LANE_PATH,FAST_LANE_TITLE} from './invoice-fast-lane.js';
import {summarizeDomCdpMutationForApproval} from './approval-summary.js';
import {ToolRegistry,type McpApplicationServices} from './tool-registry.js';

const auth:InvocationAuthorization={mode:'standard',applicationApproved:true,bypassApplicationAuthorization:false,source:'host_approval'};
const invoice={supplier:'ผู้ขายจำลอง',date:'2026-09-01',bill_ref:'',note:'',rows:[{sku:'SIM-1',quantity:20,unit_cost_cents:49400}]};
const target={tabId:'SIM-TAB',origin:FAST_LANE_ORIGIN,pathname:FAST_LANE_PATH,title:FAST_LANE_TITLE};
const request=(extra:Record<string,unknown>={}):Record<string,unknown>=>({action:'evaluate',tab_id:target.tabId,approval:'use_policy',userConfirmed:true,parameters:{invoice_fast_lane:{operation:'duplicate_check',invoice,...extra}}});
function evidence():Record<string,unknown>{return{ok:true,stockWrites:0,draftWrites:0,atUtc:new Date().toISOString(),target,source:{id:10,name:invoice.supplier},products:[{id:34,sku:'SIM-1',name:'สินค้าจำลอง',unit:'กระสอบ'}],scans:[{scope:'SUPPLIER_ALL_DATES',sourceId:10,from:'',to:'',pageCount:1,totalGroups:0,allPagesChecked:true,stableRead:true,groups:[]},{scope:'ALL_SOURCES_INVOICE_DATE',sourceId:null,from:invoice.date,to:invoice.date,pageCount:1,totalGroups:0,allPagesChecked:true,stableRead:true,groups:[]}],readProof:{fetches:4,elapsedMs:50,method:'GET',observationsPerPage:2}};}
const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0)){if(path.dirname(path.resolve(dir))!==path.resolve(os.tmpdir())||!path.basename(dir).startsWith('panya-duplicate-'))throw Error('Unsafe fixture cleanup');await rm(dir,{recursive:true,force:true});}});

describe('typed duplicate check stays isolated from receipt/stock workflow',()=>{
 it('publishes the new typed mode to tool discovery without a browser call',async()=>{
  const execute=vi.fn(async()=>ok(evidence()));
  const registry=new ToolRegistry({capabilities:{execute}} as unknown as McpApplicationServices,{clientId:'discovery',clientName:'fixture'});
  expect(registry.listAll().find(t=>t.name==='dom_cdp')?.description).toContain('operation=duplicate_check');
  const described=await registry.invoke('tool_describe',{name:'dom_cdp'});
  expect(described.isError,JSON.stringify(described)).not.toBe(true);expect(JSON.stringify(described)).toContain('PANYA-DUPLICATE-CHECK1');expect(execute).not.toHaveBeenCalled();
 });
 it('accepts a blank bill/note without a transaction plan and advertises the bounded read contract',()=>{
  expect(parseFastLaneRequest(request())).toMatchObject({operation:'duplicate_check',invoice,clear_existing_draft:false});
  expect(FAST_LANE_CONTRACT.operations).toContain('duplicate_check');
  expect(FAST_LANE_CONTRACT).toMatchObject({duplicateCheck:{version:'PANYA-DUPLICATE-CHECK1',maxPagesPerScope:12,deadlineMs:45000,canCommit:false}});
 });
 it('rejects draft clearing, candidate acknowledgements, plan reuse, injected code, changed guard and invalid dates',()=>{
  for(const extra of[{clear_existing_draft:true},{acknowledged_candidate_ids:[]},{plan_id:'00000000-0000-0000-0000-000000000000'},{payload_hash:'a'.repeat(64)},{expression:'alert(1)'},{invoice:{...invoice,date:'2026-02-30'}}])expect(()=>parseFastLaneRequest(request(extra))).toThrow();
  expect(()=>parseFastLaneRequest({...request(),approval:'skip'})).toThrow();
  expect(()=>parseFastLaneRequest({...request(),parameters:{invoice_fast_lane:{operation:'duplicate_check',invoice},expression:'alert(1)'}})).toThrow();
 });
 it('keeps native approval mandatory; rejects missing approval and cancellation without dispatch',async()=>{
  const execute=vi.fn(async()=>ok(evidence())),bridge=createFastLaneBridge({capabilities:{execute},owner:'sim-owner'});
  expect((await bridge(request()))?.ok).toBe(false);
  const controller=new AbortController();controller.abort();expect((await bridge(request(),controller.signal,auth))?.ok).toBe(false);
  expect(execute).not.toHaveBeenCalled();
 });
 it('runs one fixed reader, creates no files or plan, and cannot turn its result into a commit',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'panya-duplicate-'));dirs.push(dir);
  const execute=vi.fn(async()=>ok(evidence())),bridge=createFastLaneBridge({capabilities:{execute},runtimeStatePath:path.join(dir,'runtime.json'),owner:'sim-owner'});
  const result=await bridge(request(),undefined,auth);expect(result?.ok,JSON.stringify(result)).toBe(true);
  if(!result?.ok)throw Error('read failed');
  expect(result.value).toMatchObject({stockWrites:0,draftWrites:0,planWrites:0,canCommit:false,automaticReplayAllowed:false});
  expect(result.value).not.toHaveProperty('planId');expect(result.value).not.toHaveProperty('payloadHash');
  expect(execute).toHaveBeenCalledTimes(1);expect(await readdir(dir)).toEqual([]);
  const call=execute.mock.calls[0] as unknown as unknown[];expect(call[0]).toBe('dom_cdp');expect(call[1]).toMatchObject({action:'evaluate',tab_id:target.tabId,approval:'use_policy',timeout_seconds:60});
  const expression=String((call[1] as {parameters:{expression:string}}).parameters.expression);
  for(const forbidden of['.click(','.dispatchEvent(',"method:'POST'",'location.assign','.requestSubmit(','commitFull','prepareFull'])expect(expression).not.toContain(forbidden);
  expect(()=>parseFastLaneRequest(request({operation:'commit',checkId:'not-a-plan'}))).toThrow();
 });
 it('stops invalid evidence and lost CDP response after one read with no fallback or replay',async()=>{
  const execute=vi.fn(async()=>{throw Error('SIMULATED_CDP_LOSS');}),bridge=createFastLaneBridge({capabilities:{execute},owner:'sim-owner'});
  const failed=await bridge(request(),undefined,auth);expect(failed?.ok).toBe(false);expect(execute).toHaveBeenCalledTimes(1);
  const wrong={...evidence(),target:{...target,tabId:'OTHER'}};
  const wrongBridge=createFastLaneBridge({capabilities:{execute:async()=>ok(wrong)},owner:'sim-owner'});
  expect((await wrongBridge(request(),undefined,auth))?.ok).toBe(false);
 });
 it('shows the complete read-only scope and all ten tuples without unknown-impact generic text',()=>{
  const ten={...invoice,rows:Array.from({length:10},(_,n)=>({sku:'SIM-'+(n+1),quantity:n+1,unit_cost_cents:49400}))};
  const summary=summarizeDomCdpMutationForApproval(request({invoice:ten}));
  expect(summary).toContain('operation = duplicate_check');expect(summary).toContain('รายการ 10 = SKU "SIM-10"; 10 กระสอบ');
  expect(summary).toContain('ไม่กรอก/ล้างร่าง');expect(summary).toContain('ทุกแหล่งในวันที่ระบุ');expect(summary).not.toContain('โหลดหน้าฟอร์มใหม่');
 });
 it('ToolRegistry asks one approval callback in standard and Full Bypass modes, denial dispatches zero',async()=>{
  for(const mode of ['standard','full_bypass'] as const){
   const execute=vi.fn(async()=>ok(evidence())),approvals=vi.fn(async()=>true);
   const registry=new ToolRegistry({capabilities:{execute}} as unknown as McpApplicationServices,{clientId:'sim',clientName:'sim'},{profileProvider:():typeof permissionProfiles.full=>permissionProfiles.full,authorizationModeProvider:():typeof mode=>mode,hostMutationApprovalProvider:approvals});
   const allowed=await registry.invoke('dom_cdp',request());expect(allowed.isError,JSON.stringify(allowed)).not.toBe(true);expect(approvals).toHaveBeenCalledTimes(1);expect(execute).toHaveBeenCalledTimes(1);
   approvals.mockResolvedValueOnce(false);const denied=await registry.invoke('dom_cdp',request());expect(denied.isError).toBe(true);expect(approvals).toHaveBeenCalledTimes(2);expect(execute).toHaveBeenCalledTimes(1);
  }
 });
});
