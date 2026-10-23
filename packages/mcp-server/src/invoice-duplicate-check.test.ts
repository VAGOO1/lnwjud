import {describe,expect,it} from 'vitest';
import {analyzeDuplicateCheck} from './invoice-duplicate-check.js';
import type {Invoice} from './invoice-fast-lane.js';

const invoice:Invoice={supplier:'สินเกษตร',date:'2026-09-01',bill_ref:'',note:'',rows:[{sku:'Sin-04',quantity:20,unit_cost_cents:49400},{sku:'Sin-02',quantity:60,unit_cost_cents:34700},{sku:'Sin-01',quantity:60,unit_cost_cents:42400}]};
const target={tabId:'tab-1',origin:'https://app.polcharoennewgen.com',pathname:'/stock-in/batch',title:'ระบบสต๊อก'};
const products=invoice.rows.map((r,i)=>({id:31+i,sku:r.sku,name:r.sku,unit:'กระสอบ'}));
interface Row {id:number;sku:string;name:string;unit:string;quantity:number;unitCostCents:number;status:string;}
interface Group {key:string;date:string;title:string;dateLine:string;rows:Row[];}
interface Match {category:string;dateRelation:string;statuses:string[];matchedRows:Row[];missingSkus:string[];observedScopes:string[];sourceVerification:string;}
const row=(id:number,sku:string,quantity:number,cost:number,status='ACTIVE'):Row=>({id,sku,name:sku,unit:'กระสอบ',quantity,unitCostCents:cost,status});
const group=(date:string,rows:Row[]):Group=>({key:rows.map(r=>r.id).sort((a,b)=>a-b).join(','),date,title:'บิล',dateLine:date,rows});
const wanted=(start=1,status='ACTIVE'):Row[]=>invoice.rows.map((r,i)=>row(start+i,r.sku,r.quantity,r.unit_cost_cents,status));
const scan=(scope:string,groups:Group[],sourceId:number|null):{scope:string;sourceId:number|null;from:string;to:string;pageCount:number;totalGroups:number;allPagesChecked:boolean;stableRead:boolean;groups:Group[]}=>({scope,sourceId,from:scope==='ALL_SOURCES_INVOICE_DATE'?invoice.date:'',to:scope==='ALL_SOURCES_INVOICE_DATE'?invoice.date:'',pageCount:Math.max(1,Math.ceil(groups.length/50)),totalGroups:groups.length,allPagesChecked:true,stableRead:true,groups});
function evidence(groups:Group[]=[],onDate:Group[]=[]):{ok:boolean;stockWrites:number;draftWrites:number;atUtc:string;target:typeof target;source:{id:number;name:string};products:typeof products;readProof:{fetches:number;elapsedMs:number;method:string;observationsPerPage:number};scans:ReturnType<typeof scan>[]} {
 const scans=[scan('SUPPLIER_ALL_DATES',groups,10),scan('ALL_SOURCES_INVOICE_DATE',onDate,null)];
 return{ok:true,stockWrites:0,draftWrites:0,atUtc:'2026-10-20T00:00:00Z',target:{...target},source:{id:10,name:invoice.supplier},products,readProof:{fetches:2*scans.reduce((n,s)=>n+s.pageCount,0),elapsedMs:100,method:'GET',observationsPerPage:2},scans};
}
const matches=(result:Record<string,unknown>):Match[]=>result.matches as Match[];

describe('structured duplicate matcher with bounded evidence',()=>{
 it('finds three requested tuples inside five rows on another date and requires review',()=>{
  const result=analyzeDuplicateCheck(invoice,evidence([group('2026-08-18',[...wanted(),row(4,'Other',5,100),row(5,'Other2',5,100)])]),target);
  expect(result).toMatchObject({status:'REVIEW_REQUIRED',canCommit:false,stockWrites:0,draftWrites:0,planWrites:0,automaticReplayAllowed:false});
  expect(matches(result)[0]).toMatchObject({category:'SUBSET_IN_LARGER_GROUP',dateRelation:'DIFFERENT_DATE',sourceVerification:'SUPPLIER_FILTERED_HISTORY'});
 });
 it('keeps cancelled matches explicit and never authorizes writes',()=>{
  const result=analyzeDuplicateCheck(invoice,evidence([group('2026-08-18',wanted(1,'CANCELLED'))]),target);
  expect(matches(result)[0]?.statuses).toEqual(['CANCELLED','CANCELLED','CANCELLED']);expect(result.canCommit).toBe(false);
 });
 it('cannot verify a bill reference from unstructured notes',()=>{
  expect(analyzeDuplicateCheck({...invoice,bill_ref:'B-1'},evidence(),target)).toMatchObject({billReferenceVerification:'UNAVAILABLE_FROM_STRUCTURED_DOM',status:'INCOMPLETE'});
 });
 it('a changed cost is a partial match, and distinct groups never assemble a complete invoice',()=>{
  const rows=wanted();rows[0]!.unitCostCents++;
  const result=analyzeDuplicateCheck(invoice,evidence([group('2026-08-18',rows)]),target);
  expect(matches(result)[0]).toMatchObject({category:'PARTIAL',missingSkus:['Sin-04']});
  const separated=analyzeDuplicateCheck(invoice,evidence([group('2026-08-18',wanted().slice(0,1)),group('2026-08-18',wanted().slice(1))]),target);
  expect(matches(separated).map(m=>m.category)).toEqual(['PARTIAL','PARTIAL']);
 });
 it('deduplicates an identical group seen in both scopes and retains scope evidence',()=>{
  const g=group(invoice.date,wanted());const result=analyzeDuplicateCheck(invoice,evidence([g],[structuredClone(g)]),target);
  expect(matches(result)).toHaveLength(1);expect(matches(result)[0]?.observedScopes).toEqual(['SUPPLIER_ALL_DATES','ALL_SOURCES_INVOICE_DATE']);
 });
 it('all-source-only matches have unverified supplier attribution',()=>{
  const result=analyzeDuplicateCheck(invoice,evidence([],[group(invoice.date,wanted())]),target);
  expect(result.status).toBe('REVIEW_REQUIRED');expect(matches(result)[0]?.sourceVerification).toBe('UNVERIFIED_ALL_SOURCE_HISTORY');
 });
 it('rejects inconsistent cross-scan IDs and duplicated IDs within a scan',()=>{
  const g=group(invoice.date,wanted()),other=structuredClone(g);other.rows[0]!.quantity++;
  expect(()=>analyzeDuplicateCheck(invoice,evidence([g],[other]),target)).toThrow('INCONSISTENT_CROSS_SCAN_ID');
  expect(()=>analyzeDuplicateCheck(invoice,evidence([g,g]),target)).toThrow('DUPLICATE_MOVEMENT_ID');
 });
 it('duplicate matching SKU rows are ambiguous even when every wanted SKU is present',()=>{
  const result=analyzeDuplicateCheck(invoice,evidence([group('2026-08-18',[...wanted(),row(4,'Sin-04',20,49400)])]),target);
  expect(matches(result)[0]?.category).toBe('AMBIGUOUS');
 });
 it('rejects rollover dates in either the invoice or history',()=>{
  expect(()=>analyzeDuplicateCheck({...invoice,date:'2026-02-30'},evidence(),target)).toThrow('INVALID_DATE');
  expect(()=>analyzeDuplicateCheck(invoice,evidence([group('2026-02-30',wanted())]),target)).toThrow('INVALID_DATE');
 });
 it('rejects empty groups, forged group identity, target/source/catalog changes',()=>{
  const g=group('2026-08-18',wanted());g.key='forged';expect(()=>analyzeDuplicateCheck(invoice,evidence([g]),target)).toThrow('INVALID_GROUP_KEY');
  expect(()=>analyzeDuplicateCheck(invoice,evidence([{...group('2026-08-18',[]),key:'1'}]),target)).toThrow('INVALID_GROUP_ROWS');
  const e=evidence();e.target.tabId='other';expect(()=>analyzeDuplicateCheck(invoice,e,target)).toThrow('TARGET_MISMATCH');
  expect(()=>analyzeDuplicateCheck(invoice,{...evidence(),source:{id:10,name:'wrong'}},target)).toThrow('SOURCE_MISMATCH');
  expect(()=>analyzeDuplicateCheck(invoice,{...evidence(),products:[]},target)).toThrow('PRODUCT_CATALOG_INCOMPLETE');
 });
 it('rejects unstable/missing pages and inconsistent read counts rather than reporting no-match',()=>{
  const e=evidence();e.scans[0]!.stableRead=false;expect(()=>analyzeDuplicateCheck(invoice,e,target)).toThrow('INCOMPLETE_SCAN');
  const count=evidence();count.readProof.fetches=2;expect(()=>analyzeDuplicateCheck(invoice,count,target)).toThrow('INCONSISTENT_READ_PROOF');
  const pages=evidence();pages.scans[0]!.pageCount=2;expect(()=>analyzeDuplicateCheck(invoice,pages,target)).toThrow('INCOMPLETE_SCAN');
  const dateScope=evidence([],[group('2026-08-18',wanted())]);expect(()=>analyzeDuplicateCheck(invoice,dateScope,target)).toThrow('INVALID_DATE_SCAN');
 });
 it('reports no match only within the two completely checked scopes',()=>{
  const result=analyzeDuplicateCheck(invoice,evidence(),target);expect(result.status).toBe('NO_MATCH_IN_CHECKED_SCOPE');expect(result.historyProof).toMatchObject({consistency:'TWO_OBSERVATIONS_NOT_ATOMIC_SNAPSHOT'});
 });
 it('more than fifty candidates stays incomplete with an explicit total and truncation flag',()=>{
  const groups=Array.from({length:51},(_,i)=>group('2026-08-18',wanted(i*3+1)));
  const result=analyzeDuplicateCheck(invoice,evidence(groups),target);expect(result).toMatchObject({status:'INCOMPLETE',matchesTruncated:true,totalMatchGroups:51});expect(matches(result).length).toBeLessThanOrEqual(50);
 });
 it('caps UTF-8 output even for fifty groups of a hundred matching rows',()=>{
  const groups=Array.from({length:50},(_,n)=>group('2026-08-18',Array.from({length:100},(_,i)=>({...row(n*100+i+1,'Sin-04',20,49400),name:'ก'.repeat(300)}))));
  const result=analyzeDuplicateCheck(invoice,evidence(groups),target);
  expect(result).toMatchObject({status:'INCOMPLETE',matchesTruncated:true,totalMatchGroups:50,truncationReason:'RESPONSE_BYTE_LIMIT'});expect(Buffer.byteLength(JSON.stringify(result),'utf8')).toBeLessThanOrEqual(49152);
 });
});
