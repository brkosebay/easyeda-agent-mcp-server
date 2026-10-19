import assert from 'node:assert/strict';
import { panelizeHandlers } from '../src/extension/handlers/panelize';
async function main() {
 let source='["DOCTYPE","PCB","1.8"]\n["PANELIZE",0,1,1,0,0,0]\n';
 let parameters:any={on:false,row:1,column:1,rowSpacing:0,columnSpacing:0,minSpacing:1,stampRow:false,stampColumn:false,success:false};
 let confirms=0;
 const targetWindow={};
 const subscribers=new Map<string,Set<(value:any,bridge?:unknown,source?:unknown)=>void>>();
 let box:object|undefined;
 const nativeHandles:Record<string,any[]>={close_Panelize:[]};
 const makeHandle=(cancel:()=>void)=>{let active=true;return{running:()=>active,cancel:()=>{active=false;cancel();}};};
 const bus={subscribed:nativeHandles,subscribe:(topic:string,callback:(value:any,bridge?:unknown,source?:unknown)=>void)=>{const set=subscribers.get(topic)??new Set();set.add(callback);subscribers.set(topic,set);return makeHandle(()=>{set.delete(callback);});},publish:(topic:string,payload:any)=>{
  if(topic==='ui/closeDialog'){assert.equal(payload,'Panelize');box=undefined;}
  if(topic==='openPanelizeDlg'){box={};nativeHandles.close_Panelize.push(makeHandle(()=>{}));}
  if(topic==='openPanelizeDlg') for(const callback of subscribers.get('dialogPcbOpen')??[])callback({action:'panelize',dialogId:'dialog',bbox:{width:100,height:100},unit:'mm',panelizeParam:{...parameters}},undefined,targetWindow);
  if(topic==='pcbdialogClose'){
   if(payload.action==='confirm'){confirms++;parameters={...payload.panelizeParam,success:true};source=`["DOCTYPE","PCB","1.8"]\n${JSON.stringify(['PANELIZE',1,parameters.row,parameters.column,parameters.rowSpacing*10,parameters.columnSpacing*10,0])}\n`;}
   for(const callback of subscribers.get('PcbcloseDialog')??[])callback(payload,undefined,targetWindow);
  }
 }};
 const host=globalThis as any;host.document={getElementById:()=>box};host.UI={gVars:{messageBus:bus,windowBridge:bus},tabBar:{getTabIFrame:async()=>({contentWindow:targetWindow})}};
 host.eda={dmt_EditorControl:{getSplitScreenTree:async()=>({tabs:[{tabId:'pcb@project'}]})},sys_Environment:{getEditorCurrentVersion:async()=> '2.2.47.7'},dmt_Project:{getCurrentProjectInfo:async()=>({uuid:'project'})},dmt_SelectControl:{getCurrentDocumentInfo:async()=>({uuid:'pcb',parentProjectUuid:'project',documentType:3})},sys_FileManager:{getDocumentSource:async()=>source}};
 const params={projectUuid:'project',expectedDocument:'pcb',rows:2,columns:3,rowSpacingMm:2,columnSpacingMm:2};
 const preview=await panelizeHandlers['pcb.panelize.inspect'](params) as any;
 assert.equal(confirms,0);assert.equal(preview.planned.rowSpacing,2/0.254);
 await assert.rejects(panelizeHandlers['pcb.panelize.apply']({...params,expectedSource:'stale'}),/changed/);
 const applied=await panelizeHandlers['pcb.panelize.apply']({...params,expectedSource:preview.source}) as any;
 assert.equal(applied.applied,true);assert.equal(confirms,1);assert.equal(box,undefined);assert.equal(nativeHandles.close_Panelize.some(h=>h.running()),false);
 await assert.rejects(panelizeHandlers['pcb.panelize.inspect']({...params,rows:101}),/1–100/);
 assert.equal(confirms,1);
 for(const set of subscribers.values())assert.equal(set.size,0);
 host.eda.sys_Environment.getEditorCurrentVersion=async()=> '2.3.0';
 await assert.rejects(panelizeHandlers['pcb.panelize.inspect'](params),/only verified/);
 console.log('Native panel preview/cancel, exact-source guard, grid bounds, unit conversion, result checks and listener cleanup: passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
