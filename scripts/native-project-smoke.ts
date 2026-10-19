import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {registerNativeProjectTools,saveNativeExport} from '../src/mcp-server/tools/native-project-tools';
import {createNativeOperationGate} from '../src/extension/native-operation-gate';
async function main() {
 const gate=createNativeOperationGate(); const order:string[]=[];
 let release!:()=>void; const blocker=new Promise<void>(resolve=>{release=resolve;});
 const read=gate(false,async()=>{order.push('read');await blocker;order.push('read-end');});
 const restore=gate(true,async()=>{order.push('restore');throw new Error('test');});
 const later=gate(false,async()=>{order.push('later');});
 await Promise.resolve();assert.deepEqual(order,['read']);release();
 await read;await assert.rejects(restore);await later;assert.deepEqual(order,['read','read-end','restore','later']);
 const root=await mkdtemp(join(tmpdir(),'easyeda-native-test-'));
 try {
  const path=join(root,'backup.epro');
  const payload={fileName:'board.epro',data:Buffer.from('native').toString('base64'),size:6};
  await saveNativeExport(path,payload);
  assert.equal((await readFile(path)).toString(),'native');
  await assert.rejects(saveNativeExport(path,payload));
  await assert.rejects(saveNativeExport(join(root,'bad'),{...payload,size:7}));
  const handlers:Record<string,Function>={};let applied=0;
  const registrar={tool:(name:string,_description:string,_schema:unknown,handler:Function)=>{handlers[name]=handler;}};
  const bridge={send:async(method:string)=>{if(method==='editor.native.getSource')return{source:'current'};if(method==='editor.native.set'){applied++;return{restored:true};}throw new Error(method);}};
  registerNativeProjectTools(registrar as any,bridge as any);
  const backup=join(root,'source.json');
  await writeFile(backup,JSON.stringify({version:1,projectUuid:'project',documentUuid:'doc',sha256:createHash('sha256').update('old').digest('hex'),source:'old'}));
  const args={instance_id:'instance',projectUuid:'project',document:'doc',inputPath:backup};
  const preview=JSON.parse((await handlers.document_restore_native_source({...args,dryRun:true})).content[0].text);
  assert.equal(applied,0);
  await assert.rejects(handlers.document_restore_native_source({...args,dryRun:false,expectedCurrentSha256:'stale'}));
  await assert.rejects(handlers.document_restore_native_source({...args,document:'other',dryRun:true}));
  await handlers.document_restore_native_source({...args,dryRun:false,expectedCurrentSha256:preview.currentSha256});
  assert.equal(applied,1);
  console.log('Native export/restore: no overwrite, size validation, identity binding, dry run and stale-source guard passed.');
 }finally{await rm(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
