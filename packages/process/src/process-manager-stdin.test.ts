import { spawn } from 'node:child_process';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ProcessManager } from './process-manager.js';
import { prepareWindowsContainedLaunch } from './windows-contained-launch.js';

const control=vi.hoisted(()=>({broken:false}));
vi.mock('./windows-contained-launch.js',()=>({
  prepareWindowsContainedLaunch:vi.fn(async()=>({executable:'C:\\fixture\\host.exe',args:[],receiptPath:'C:\\fixture\\receipt.json',cancelPath:'C:\\fixture\\cancel'})),
  readWindowsContainmentReceipt:vi.fn(async()=>({kind:'windows_job_v1',outcome:'completed',exitCode:0,activeProcesses:0})),
}));
vi.mock('node:child_process',async importOriginal=>{
  const original=await importOriginal<typeof import('node:child_process')>();
  const {EventEmitter}=await import('node:events');
  const {PassThrough}=await import('node:stream');
  return {...original,spawn:vi.fn(()=>{
    const child=Object.assign(new EventEmitter(),{pid:123,exitCode:null as number|null,signalCode:null,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});
    let text='';child.stdin.on('data',chunk=>{text+=chunk.toString('utf8');});
    child.stdin.once('end',()=>{
      if(control.broken) child.stdin.emit('error',new Error('EPIPE'));
      child.stdout.emit('data',Buffer.from(text));
      child.exitCode=0;child.emit('close',0);
    });
    queueMicrotask(()=>child.emit('spawn'));
    return child;
  })};
});

describe.skipIf(process.platform!=='win32')('mock native stdin transport',()=>{
  beforeEach(()=>{vi.clearAllMocks();control.broken=false;});
  it.each([false,true])('keeps receipt ownership and reports broken=%s without replay',async broken=>{
    control.broken=broken;
    let completed=0;
    const manager=new ProcessManager(undefined,undefined,undefined,undefined,'C:\\fixture');
    const prompt='ภาษาไทย\n"quoted" & %PATH% 🐘';
    const start=await manager.start({executable:process.execPath,args:['-'],cwd:process.cwd(),stdinText:prompt},undefined,undefined,()=>completed++);
    expect(start.ok).toBe(true);
    if(!start.ok) return;
    await expect.poll(()=>manager.status(start.value.processId)).toMatchObject({ok:true,value:{state:broken?'failed':'exited',exitCode:0}});
    const logs=manager.logs(start.value.processId,{});
    expect(logs.ok && logs.value.entries.map(entry=>entry.text).join('')).toBe(prompt);
    expect(prepareWindowsContainedLaunch).toHaveBeenCalledOnce();
    expect(prepareWindowsContainedLaunch).toHaveBeenCalledWith(expect.not.objectContaining({stdinText:expect.anything()}));
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith('C:\\fixture\\host.exe',[],expect.objectContaining({shell:false,windowsHide:true}));
    expect(completed).toBe(1);
  });
});
