import {createServer,type Server} from 'node:http';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {NodeBrowserCdpProtocol} from '@lnwjud/capabilities';
import {createProcessTreeTerminator} from '@lnwjud/process';
import {duplicateCheckBrowserProgram} from './invoice-duplicate-check-browser.js';
import {analyzeDuplicateCheck} from './invoice-duplicate-check.js';

type Obj=Record<string,unknown>;
const chrome='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const invoice={supplier:'สินเกษตร',date:'2026-09-01',bill_ref:'',note:'',rows:[{sku:'Sin-04',quantity:20,unit_cost_cents:49400},{sku:'Sin-02',quantity:60,unit_cost_cents:34700},{sku:'Sin-01',quantity:60,unit_cost_cents:42400}]};
interface Row {id:number;sku:string;quantity:number;cost:number;status:string;}
interface Group {date:string;rows:Row[];}
const wanted=(id:number,status='ใช้งานอยู่'):Row[]=>invoice.rows.map((r,i)=>({id:id+i,sku:r.sku,quantity:r.quantity,cost:r.unit_cost_cents,status}));
const historical:Group={date:'2026-08-18',rows:[...wanted(2834),{id:2837,sku:'OTHER',quantity:5,cost:30000,status:'ใช้งานอยู่'},{id:2838,sku:'OTHER2',quantity:5,cost:40400,status:'ใช้งานอยู่'}]};
const sameDate:Group={date:invoice.date,rows:wanted(3000)};
const groups:Group[]=[historical,{date:'2026-08-20',rows:wanted(2900,'ยกเลิกแล้ว')},sameDate,...Array.from({length:48},(_,i)=>({date:'2026-08-01',rows:[{id:5000+i,sku:'OTHER',quantity:1,cost:100,status:'ใช้งานอยู่'}]}))];
const allDate:Group[]=[sameDate,{date:invoice.date,rows:wanted(9000)}];
const escape=(s:string):string=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const card=(label:string,value:string):string=>`<div><p>${label}</p><p>${value}</p></div>`;
function groupHtml(g:Group,mode:string,changed:boolean):string{
 const date=new Intl.DateTimeFormat('th-TH',{day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Bangkok'}).format(new Date(g.date+'T12:00:00Z'));
 const articles=g.rows.map((r,i)=>`<article><div><p>${r.sku}</p><span>#${r.id}</span></div><p>${r.sku} • จำลอง</p><div>${card('จำนวน',r.quantity.toLocaleString('en-US')+' กระสอบ')}${card(mode==='missing-cost'&&r.id===2834?'ทุนไม่ตรงสัญญา':'ต้นทุนต่อหน่วย','฿'+((r.cost+(changed&&r.id===2834?1:0))/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}))}${card('สถานะ',r.status)}</div><p>หมายเหตุ: #999 จำนวน 999 กระสอบ ต้นทุนต่อหน่วย ฿0.01 สถานะยกเลิก SKU ปลอม ${i}</p></article>`).join('');
 return `<details><summary><h2>กลุ่มจำลอง</h2><p>บันทึก 1 ต.ค. 2569 • วันที่รายการ ${date}</p><span>${g.rows.length} รายการ</span><p>หมายเหตุผู้ใช้ ไม่ใช่ structured bill reference</p></summary>${articles}</details>`;
}
function historyHtml(u:URL,mode:string,secondPass:boolean):string{
 const selected=mode==='empty'?[]:(u.searchParams.get('sourceId')==='10'?groups:allDate),page=Number(u.searchParams.get('page')),total=mode==='too-many-pages'?651:selected.length,pages=Math.max(1,Math.ceil(total/50));
 const fields=['sourceId','movementType','status','q','from','to','pageSize'].map(k=>`<input name="${k}" value="${escape(mode==='wrong-filter'&&k==='sourceId'?'11':u.searchParams.get(k)??'')}">`).join('');
 return `<!doctype html><html><body>${fields}<p>แสดง ${total?(page-1)*50+1:0}-${Math.min(page*50,total)} จาก ${total} กลุ่มรายการ</p><p>หน้า ${page} / ${pages}</p>${selected.slice((page-1)*50,page*50).map(g=>groupHtml(g,mode,mode==='same-count-change'&&secondPass)).join('')}</body></html>`;
}
function formHtml(mode:string):string{
 const catalog={sources:[{value:'10',label:invoice.supplier,isActive:true}],products:invoice.rows.map((r,i)=>({id:31+i,productCode:r.sku,sourceId:10,name:r.sku,unitLabel:'กระสอบ'}))};
 return `<!doctype html><html><head><title>fixture</title></head><body><form><input id="sourceSearch" value="EXISTING SUPPLIER"><input id="billNumber" value="KEEP-EXISTING-DRAFT"><input name="productId-row-0" value="55"><input name="quantity-row-0" value="7.5"></form><script>const props=${JSON.stringify(catalog)};${mode==='missing-catalog'?'':`document.querySelector('#sourceSearch').__reactFiber$fixture={memoizedProps:props,return:null};`}${mode==='catalog-change'?`let calls=0;const saved=props.sources;Object.defineProperty(props,'sources',{get(){return ++calls>2?[{value:'11',label:'changed',isActive:true}]:saved;}});`:''}</script></body></html>`;
}
function object(v:unknown):Obj{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Expected object');return v as Obj;}
function listen(s:Server):Promise<number>{return new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const a=s.address();if(!a||typeof a==='string')reject(Error('No fixture port'));else resolve(a.port);});});}
function close(s:Server):Promise<void>{s.closeAllConnections();return new Promise(resolve=>s.close(()=>resolve()));}
async function unusedPort():Promise<number>{const s=createServer(),p=await listen(s);await close(s);return p;}
async function until(check:()=>Promise<boolean>):Promise<void>{const end=Date.now()+20000;while(!await check()){if(Date.now()>end)throw Error('Owned Chrome fixture not ready');await new Promise(resolve=>setTimeout(resolve,50));}}

describe('real Chrome duplicate reader against isolated loopback only',()=>{
 let profile:string,server:Server,browser:ChildProcess,protocol:NodeBrowserCdpProtocol,origin:string,tabId:string,mode='normal';
 let requests:Array<{method:string;url:string}>=[],counts=new Map<string,number>();
 async function evaluate(expression:string):Promise<unknown>{
  const response=object(await protocol.request(tabId,'Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})),body=object(response.result);
  if(body.exceptionDetails){const details=object(body.exceptionDetails),exception=details.exception?object(details.exception):{};throw Error(String(exception.description??details.text));}
  return object(body.result).value;
 }
 async function reset(next='normal'):Promise<void>{
  mode=next;requests=[];counts=new Map();await protocol.request(tabId,'Page.navigate',{url:origin+'/stock-in/batch?fixture='+encodeURIComponent(next)});
  await until(async()=>{try{return await evaluate("document.title==='fixture'&&!!document.querySelector('#billNumber')")===true;}catch{return false;}});
 }
 function target():{tabId:string;origin:string;pathname:string;title:string}{return{tabId,origin,pathname:'/stock-in/batch',title:'fixture'};}
 const draftExpression="[...document.querySelectorAll('form input')].map(x=>[x.id,x.name,x.value])";
 async function read():Promise<unknown>{return evaluate(duplicateCheckBrowserProgram({target:target(),supplier:invoice.supplier,date:invoice.date,rows:invoice.rows}));}
 beforeAll(async()=>{
  profile=await mkdtemp(path.join(os.tmpdir(),'panya-dupe-cdp-'));
  server=createServer((req,res)=>{const u=new URL(req.url??'/',origin??'http://127.0.0.1');requests.push({method:req.method??'',url:u.pathname+u.search});res.setHeader('content-type','text/html; charset=utf-8');if(req.method!=='GET'){res.statusCode=405;res.end();return;}if(u.pathname==='/movements'){const k=u.searchParams.get('sourceId')+':'+u.searchParams.get('page'),count=(counts.get(k)??0)+1;counts.set(k,count);res.end(historyHtml(u,mode,count>1));}else res.end(formHtml(mode));});
  origin='http://127.0.0.1:'+await listen(server);const cdpPort=await unusedPort();
  browser=spawn(chrome,['--headless=new','--enable-automation','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,`--remote-debugging-port=${cdpPort}`,'about:blank'],{shell:false,windowsHide:true,stdio:'ignore'});
  protocol=new NodeBrowserCdpProtocol({port:cdpPort,chromeExecutable:chrome});await until(async()=>{try{return(await protocol.status()).ready;}catch{return false;}});
  tabId=(await protocol.newTab('about:blank')).id;
 },30000);
 afterAll(async()=>{
  if(protocol){try{const tabs=await protocol.listTabs();if(tabs[0])await protocol.request(tabs[0].id,'Browser.close',{});}catch{/* Owned browser may already be closed. */}}
  if(browser){const exited=await new Promise<boolean>(resolve=>{if(browser.exitCode!==null||browser.signalCode!==null)return resolve(true);const timer=setTimeout(()=>resolve(false),2000);browser.once('exit',()=>{clearTimeout(timer);resolve(true);});});if(!exited&&browser.pid!==undefined)await createProcessTreeTerminator().stop(browser,browser.pid);}
  if(server)await close(server);
  if(profile){const p=path.resolve(profile);if(path.dirname(p)!==path.resolve(os.tmpdir())||!path.basename(p).startsWith('panya-dupe-cdp-'))throw Error('Unsafe Chrome fixture cleanup');await rm(p,{recursive:true,force:true});}
 },15000);
 it('checks 51 groups across two pages twice, finds cross-date subset, merges overlap and preserves existing draft',async()=>{
  await reset();const before=await evaluate(draftExpression),raw=await read(),result=analyzeDuplicateCheck(invoice,raw,target());
  expect(raw).toMatchObject({ok:true,stockWrites:0,draftWrites:0,readProof:{fetches:6,method:'GET',observationsPerPage:2}});
  const matches=result.matches as Obj[];expect(matches).toHaveLength(4);expect(matches[0]).toMatchObject({category:'SUBSET_IN_LARGER_GROUP',dateRelation:'DIFFERENT_DATE',groupKey:'2834,2835,2836,2837,2838'});
  expect(matches[1]).toMatchObject({statuses:['CANCELLED','CANCELLED','CANCELLED']});expect(matches[2]).toMatchObject({observedScopes:['SUPPLIER_ALL_DATES','ALL_SOURCES_INVOICE_DATE']});expect(matches[3]).toMatchObject({sourceVerification:'UNVERIFIED_ALL_SOURCE_HISTORY'});
  expect(matches[0]?.matchedRows).toHaveLength(3);expect(await evaluate(draftExpression)).toEqual(before);expect(requests.filter(r=>r.url.startsWith('/movements'))).toHaveLength(6);expect(requests.every(r=>r.method==='GET')).toBe(true);
 });
 it.each([['wrong-filter','HISTORY_FILTER'],['same-count-change','HISTORY_CHANGED'],['missing-cost','FIELD_UNAVAILABLE'],['too-many-pages','HISTORY_CHANGED'],['missing-catalog','CATALOG_ABSENT'],['catalog-change','SOURCE_NOT_EXACT']])('fails closed for %s without submission or draft edits',async(next,code)=>{
  await reset(next);const before=await evaluate(draftExpression);await expect(read()).rejects.toThrow(code);expect(await evaluate(draftExpression)).toEqual(before);expect(requests.every(r=>r.method==='GET')).toBe(true);
 });
 it('reports empty history only after checking both zero-range pages twice',async()=>{
  await reset('empty');const before=await evaluate(draftExpression),raw=await read(),result=analyzeDuplicateCheck(invoice,raw,target());
  expect(result.status).toBe('NO_MATCH_IN_CHECKED_SCOPE');expect(raw).toMatchObject({readProof:{fetches:4}});expect(await evaluate(draftExpression)).toEqual(before);expect(requests.every(r=>r.method==='GET')).toBe(true);
 });
 it('rejects a different pinned page before fetching history',async()=>{
  await reset();const before=requests.filter(r=>r.url.startsWith('/movements')).length;await expect(evaluate(duplicateCheckBrowserProgram({target:{...target(),pathname:'/wrong'},supplier:invoice.supplier,date:invoice.date,rows:invoice.rows}))).rejects.toThrow('WRONG_PAGE');expect(requests.filter(r=>r.url.startsWith('/movements'))).toHaveLength(before);
 });
});
