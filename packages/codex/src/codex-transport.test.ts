import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ok } from '@lnwjud/domain';
import { ProcessManager, type ManagedProcessStart } from '@lnwjud/process';
import { CodexAdapter, type CodexProcessManagerPort } from './codex-adapter.js';

// An inert local child: receives bytes and returns them. No Codex CLI/network/model.
const fixture = `
const args=process.argv.slice(2);
const answer=(prompt)=>process.stdout.write(JSON.stringify({prompt,args,eof:true}));
if(args.at(-1)==='-') {
  let input='';process.stdin.setEncoding('utf8');
  process.stdin.on('data',chunk=>input+=chunk);
  process.stdin.on('end',()=>answer(input));
} else { answer(args.at(-1)); }
`;
const prompt = 'ตรวจ "สินค้า" & | < > ^ %PATH% !VAR!\r\n--sandbox danger-full-access\nสรุป 🐘 C:\\store\\';

async function exercise(shim: boolean, contained: boolean): Promise<void> {
  const root=await mkdtemp(path.join(import.meta.dirname,'transport fixture-'));
  let preserve=false;
  try {
    const script=path.join(root,'fake-cli.cjs');
    const executable=shim ? path.join(root,'fake-cli.cmd') : process.execPath;
    await writeFile(script,fixture,'utf8');
    if(shim) await writeFile(executable,`@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,'utf8');
    const manager=new ProcessManager(undefined,undefined,undefined,undefined,contained ? path.join(root,'contained') : undefined);
    const calls: ManagedProcessStart[]=[];
    const port: CodexProcessManagerPort={
      start(spec,signal,onCreated) {
        calls.push(spec);
        return manager.start({...spec,args:shim ? spec.args : [script,...spec.args],timeoutMs:10000},signal,onCreated);
      },
      status:id=>manager.status(id), logs:(id,q)=>manager.logs(id,q), stop:id=>manager.stop(id),
    };
    const adapter=new CodexAdapter({async discover(){return ok({
      status:{installed:true,executablePath:executable,capabilities:['exec','sandbox','read-only']},
      capabilities:{instructionMode:'exec-argument',names:['exec','sandbox','read-only']},
    });}},port);
    const started=await adapter.start(root,prompt,undefined,undefined,'read-only');
    expect(started).toMatchObject({ok:true});
    if(!started.ok) return;
    try {
      for(let attempt=0;attempt<200;attempt++) {
        const status=manager.status(started.value.processId);
        if(status.ok && status.value.state==='termination_unverified') throw new Error(JSON.stringify({status,logs:manager.logs(started.value.processId,{})}));
        if(status.ok && !['starting','running'].includes(status.value.state)) break;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      expect(manager.status(started.value.processId)).toMatchObject({ok:true,value:{state:'exited',exitCode:0}});
      const output=manager.logs(started.value.processId,{});
      expect(output.ok).toBe(true);
      if(!output.ok) return;
      const result=JSON.parse(output.value.entries.filter(e=>e.stream==='stdout').map(e=>e.text).join(''));
      expect(result).toEqual({prompt,args:['exec','--sandbox','read-only','-'],eof:true});
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args).not.toContain(prompt);
      const status=manager.status(started.value.processId);
      expect(status.ok && status.value.args).not.toContain(prompt);
      if(contained) {
        const metadata=await readFile(path.join(root,'contained',started.value.processId,'containment.json'),'utf8');
        expect(metadata).not.toContain('ตรวจ');
        expect(JSON.parse(await readFile(path.join(root,'contained',started.value.processId,'containment.receipt.json'),'utf8'))).toMatchObject({activeProcesses:0,outcome:'completed',exitCode:0});
      }
    } catch(error) {
      preserve=true;
      const detail={fixture:root,status:manager.status(started.value.processId),logs:manager.logs(started.value.processId,{}),error:String(error)};
      const evidence=path.resolve(import.meta.dirname,'../../../..','evidence');
      await mkdir(evidence,{recursive:true});
      await writeFile(path.join(evidence,`transport-${shim}-${contained}.json`),JSON.stringify(detail,null,2));
      throw new Error(JSON.stringify(detail));
    } finally {
      const status=manager.status(started.value.processId);
      if(status.ok && status.value.state!=='termination_unverified') await manager.stop(started.value.processId);
    }
  } finally {
    if(path.dirname(root)!==import.meta.dirname) throw new Error('Fixture escaped test directory');
    if(!preserve) await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
}

describe('Codex prompt transport with inert CLI fixtures',()=>{
  it('sends exact UTF-8 multiline prompt, closes stdin and keeps flags out of the prompt',()=>exercise(false,false));
  it.skipIf(process.platform!=='win32')('delivers shell metacharacters through a Windows cmd shim without relaxing its guard',()=>exercise(true,false));
  it.skipIf(process.platform!=='win32')('delivers stdin and EOF through native containment and reads verified completion',()=>exercise(true,true),15000);
});
