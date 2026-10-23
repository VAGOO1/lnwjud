/* Fixed packaged GET-only reader. Callers provide validated invoice data, never code. */
export function duplicateCheckBrowserProgram(config: Record<string, unknown>): string {
  return `(async()=>{const c=${JSON.stringify(config)};\n${PROGRAM}\n})()`;
}

const PROGRAM = String.raw`
const fail=code=>{throw Error('DUPLICATE_CHECK_'+code);};
const start=Date.now(),deadline=start+45000;
let fetches=0,totalRows=0;
const text=x=>String(x??'').replace(/\s+/g,' ').trim();
function bounded(x,max){const s=text(x);if(!s||s.length>max)fail('DOM_FIELD');return s;}
function pin(){if(location.origin!==c.target.origin||location.pathname!==c.target.pathname||document.title!==c.target.title)fail('WRONG_PAGE');}
function catalog(){
 const e=document.querySelector('#sourceSearch');let k=e&&Object.keys(e).find(k=>k.startsWith('__reactFiber$')),f=k&&e[k],p;
 for(let n=0;f&&n<30;n++,f=f.return)if(Array.isArray(f.memoizedProps?.products)&&Array.isArray(f.memoizedProps?.sources)){p=f.memoizedProps;break;}
 if(!p)fail('CATALOG_ABSENT');
 const sources=p.sources.filter(s=>s.isActive===true&&s.label===c.supplier);
 if(sources.length!==1)fail('SOURCE_NOT_EXACT');
 const id=Number(sources[0].value);if(!Number.isSafeInteger(id)||id<1)fail('SOURCE_ID');
 const products=c.rows.map(row=>{
  const a=p.products.filter(v=>v.productCode===row.sku&&Number(v.sourceId)===id);
  if(a.length!==1||!Number.isSafeInteger(a[0].id)||a[0].id<1||a[0].unitLabel!=='กระสอบ')fail('PRODUCT_NOT_EXACT');
  return{id:a[0].id,sku:a[0].productCode,name:bounded(a[0].name,300),unit:a[0].unitLabel};
 });
 return{source:{id,name:c.supplier},products};
}
const numeric='(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)';
function money(value){
 const m=text(value).match(new RegExp('^฿?\\s*('+numeric+')(?:\\.([0-9]{1,2}))?\\s*(?:บาท)?$'));
 if(!m)fail('COST_FORMAT');
 const n=Number(m[1].replace(/,/g,''))*100+Number((m[2]??'').padEnd(2,'0'));
 if(!Number.isSafeInteger(n)||n<1)fail('COST_VALUE');return n;
}
function movementDate(value){
 const m=value.match(/•\s*วันที่รายการ\s+(\d{1,2})\s+(\S+)\s+(\d{4})$/),months=['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
 if(!m||!months.includes(m[2]))fail('DATE_FORMAT');
 const date=(Number(m[3])-543)+'-'+String(months.indexOf(m[2])+1).padStart(2,'0')+'-'+m[1].padStart(2,'0');
 const parsed=new Date(date+'T12:00:00Z');if(Number.isNaN(parsed.valueOf())||parsed.toISOString().slice(0,10)!==date)fail('DATE_VALUE');return date;
}
function field(article,label){
 const a=[...article.querySelectorAll('p')].filter(p=>text(p.textContent)===label);
 if(a.length!==1||!a[0].nextElementSibling)fail('FIELD_UNAVAILABLE');
 return bounded(a[0].nextElementSibling.textContent,100);
}
function row(article){
 const ids=[...article.querySelectorAll('span')].filter(s=>/^#[0-9]+$/.test(text(s.textContent)));
 if(ids.length!==1)fail('MOVEMENT_ID');
 const id=Number(text(ids[0].textContent).slice(1)),header=ids[0].parentElement;
 if(!Number.isSafeInteger(id)||id<1||!header)fail('MOVEMENT_ID');
 const names=[...header.children].filter(e=>e.tagName==='P'),code=header.nextElementSibling;
 if(names.length!==1||code?.tagName!=='P')fail('PRODUCT_HEADER');
 const parts=text(code.textContent).split(/\s*•\s*/);if(parts.length<2)fail('PRODUCT_CODE');
 const sku=bounded(parts[0],80),name=bounded(names[0].textContent,300);
 const q=field(article,'จำนวน').match(new RegExp('^('+numeric+'(?:\\.[0-9]+)?)\\s+(.+)$'));
 if(!q)fail('QUANTITY_FORMAT');const quantity=Number(q[1].replace(/,/g,'')),unit=bounded(q[2],40);
 if(!Number.isFinite(quantity)||quantity<=0||quantity>Number.MAX_SAFE_INTEGER)fail('QUANTITY_VALUE');
 const state=field(article,'สถานะ'),status=state==='ใช้งานอยู่'?'ACTIVE':['ยกเลิก','ยกเลิกแล้ว'].includes(state)?'CANCELLED':null;
 if(!status)fail('STATUS_UNAVAILABLE');
 return{id,sku,name,unit,quantity,unitCostCents:money(field(article,'ต้นทุนต่อหน่วย')),status};
}
function groupsFrom(d){
 return [...d.querySelectorAll('details')].filter(e=>!e.parentElement?.closest('details')).map(detail=>{
  const summary=[...detail.children].filter(e=>e.tagName==='SUMMARY');if(summary.length!==1)fail('GROUP_SUMMARY');
  const lines=[...summary[0].querySelectorAll('p')].map(p=>text(p.textContent)).filter(s=>s.startsWith('บันทึก ')&&s.includes('• วันที่รายการ '));
  const titles=summary[0].querySelectorAll('h2');if(lines.length!==1||titles.length!==1)fail('GROUP_HEADER');
  const rows=[...detail.querySelectorAll('article')].filter(a=>a.closest('details')===detail).map(row);
  const counts=[...summary[0].querySelectorAll('span')].map(s=>text(s.textContent)).filter(s=>/^[0-9,]+ รายการ$/.test(s));
  if(counts.length!==1||Number(counts[0].replace(/[^0-9]/g,''))!==rows.length||!rows.length||rows.length>100)fail('GROUP_ROWS_INCOMPLETE');
  totalRows+=rows.length;if(totalRows>24000)fail('ROW_LIMIT');
  rows.sort((a,b)=>a.id-b.id);
  return{key:rows.map(r=>r.id).join(','),date:movementDate(lines[0]),title:bounded(titles[0].textContent,300),dateLine:bounded(lines[0],600),rows};
 });
}
async function page(scope,n){
 pin();if(Date.now()>deadline)fail('DEADLINE');if(++fetches>48)fail('FETCH_LIMIT');
 const params=new URLSearchParams({movementType:'IN',sourceId:scope.sourceId===null?'':String(scope.sourceId),status:'',q:'',from:scope.from,to:scope.to,pageSize:'50',sortBy:'date',sortDir:'desc',page:String(n)});
 const response=await fetch('/movements?'+params,{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(Math.min(4000,Math.max(1,deadline-Date.now())))});
 if(!response.ok||!response.headers.get('content-type')?.includes('text/html'))fail('HISTORY_FETCH');
 const html=await response.text();if(html.length>2000000)fail('HISTORY_SIZE');
 const d=new DOMParser().parseFromString(html,'text/html');d.querySelectorAll('script,style').forEach(e=>e.remove());
 for(const [key,wanted]of Object.entries({sourceId:params.get('sourceId'),movementType:'IN',status:'',q:'',from:scope.from,to:scope.to,pageSize:'50'})){
  const fields=d.querySelectorAll('[name="'+key+'"]');if(fields.length!==1||fields[0].value!==wanted)fail('HISTORY_FILTER');
 }
 const body=text(d.body.textContent),range=body.match(/แสดง\s*([0-9,]+)[-–]([0-9,]+)\s*จาก\s*([0-9,]+)\s*กลุ่มรายการ/),position=body.match(/หน้า\s*(\d+)\s*\/\s*(\d+)/);
 if(!range||!position)fail('HISTORY_PAGINATION');
 const number=x=>Number(x.replace(/,/g,'')),totalGroups=number(range[3]),pageCount=Number(position[2]);
 if(!Number.isSafeInteger(totalGroups)||totalGroups<0||pageCount<1||pageCount>12||pageCount!==Math.max(1,Math.ceil(totalGroups/50))||Number(position[1])!==n||number(range[1])!==(totalGroups?(n-1)*50+1:0)||number(range[2])!==Math.min(n*50,totalGroups))fail('HISTORY_CHANGED');
 const groups=groupsFrom(d);if(groups.length!==Math.min(50,Math.max(0,totalGroups-(n-1)*50)))fail('HISTORY_GROUP_COUNT');
 if(scope.from&&groups.some(g=>g.date!==scope.from))fail('DATE_FILTER_MISMATCH');
 return{totalGroups,pageCount,groups};
}
async function scan(scope){
 let groups=[],first,observations=[];const seen=new Set();
 for(let n=1;n<=(first?.pageCount??1);n++){
  const current=await page(scope,n);if(!first)first=current;
  if(current.totalGroups!==first.totalGroups||current.pageCount!==first.pageCount)fail('HISTORY_CHANGED');
  for(const group of current.groups)for(const item of group.rows){if(seen.has(item.id))fail('HISTORY_DUPLICATE_ID');seen.add(item.id);}
  groups.push(...current.groups);observations.push(JSON.stringify(current));
 }
 // Two complete observations catch page shifts and edits with unchanged totals.
 for(let n=1;n<=first.pageCount;n++)if(JSON.stringify(await page(scope,n))!==observations[n-1])fail('HISTORY_CHANGED');
 if(groups.length!==first.totalGroups)fail('HISTORY_INCOMPLETE');
 return{...scope,pageCount:first.pageCount,totalGroups:first.totalGroups,allPagesChecked:true,stableRead:true,groups};
}
pin();const before=catalog();
const scans=[];
scans.push(await scan({scope:'SUPPLIER_ALL_DATES',sourceId:before.source.id,from:'',to:''}));
scans.push(await scan({scope:'ALL_SOURCES_INVOICE_DATE',sourceId:null,from:c.date,to:c.date}));
pin();if(JSON.stringify(catalog())!==JSON.stringify(before))fail('CATALOG_CHANGED');
return{ok:true,stockWrites:0,draftWrites:0,atUtc:new Date().toISOString(),target:c.target,...before,scans,readProof:{fetches,elapsedMs:Date.now()-start,method:'GET',observationsPerPage:2}};
`;
