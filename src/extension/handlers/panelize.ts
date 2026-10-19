import { boundedNativeOperation, assertNativeOperationReady } from '../native-operation-gate';

type Parameters = Record<string, unknown> & {row: number; column: number; rowSpacing: number; columnSpacing: number; on: boolean; success?: boolean};
type PanelDialog = {action: string; dialogId: string; panelizeParam: Parameters; bbox: {width:number;height:number}; unit: string};
type Subscription = {cancel:()=>void; running:()=>boolean};
type Bus = {subscribe: (topic:string,callback:(payload:any,bridge:unknown,source:unknown)=>void)=>Subscription; publish:(topic:string,payload:unknown)=>void; subscribed:Record<string,Subscription[]>};
type NativeContext = {bus:Bus; target:unknown; document:Document; publish:(topic:string,payload:unknown)=>void; surface?:{box:HTMLElement;handles:Subscription[];conflict:boolean;watcher:Subscription}};
async function nativeContext(documentUuid:string,projectUuid:string):Promise<NativeContext> {
 type UI = {gVars?:{messageBus?:Bus;windowBridge?:{publish:(topic:string,payload:unknown,target:unknown)=>void}};tabBar?:{getTabIFrame:(tabId:string)=>Promise<{contentWindow?:unknown}|undefined>}};
 const host=globalThis as unknown as {UI?:UI;document?:Document;top?:{UI?:UI;document?:Document}};
 const ui=host.UI??host.top?.UI;
 const document=host.top?.document??host.document;
 if(!document || !ui?.gVars?.messageBus?.subscribed || !ui.gVars.messageBus.publish || !ui.gVars.windowBridge || !ui.tabBar) throw new Error('Native panelization frame bridge is unavailable.');
 const tree=await eda.dmt_EditorControl.getSplitScreenTree();
 function find(node:any):string|undefined {
  const found=node?.tabs?.find((tab:any)=>tab.tabId===`${documentUuid}@${projectUuid}`);
  return found?.tabId??node?.children?.map(find).find(Boolean);
 }
 const tabId=find(tree);
 if(!tabId)throw new Error('The requested PCB tab is not open.');
 const frame=await ui.tabBar.getTabIFrame(tabId);
 if(!frame?.contentWindow)throw new Error('PCB frame is unavailable.');
 await guard(projectUuid,documentUuid);
 const target=frame.contentWindow;
 const bridge=ui.gVars.windowBridge;
 return {bus:ui.gVars.messageBus,target,document,publish:(topic,payload)=>bridge.publish(topic,payload,target)};
}
async function guard(projectUuid:string,documentUuid:string) {
 const project=await eda.dmt_Project.getCurrentProjectInfo();
 const doc=await eda.dmt_SelectControl.getCurrentDocumentInfo();
 if(project?.uuid!==projectUuid || doc?.parentProjectUuid!==projectUuid || doc.uuid!==documentUuid || doc.documentType!==3) throw new Error('Panelization requires the exact bound PCB and project.');
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 20));
async function open(context:NativeContext):Promise<PanelDialog> {
 const handles=()=>context.bus.subscribed.close_Panelize??[];
 if(context.document.getElementById('Panelize_dialog_box') || handles().some(handle=>handle.running())) throw new Error('A native panel dialog is already owned by another operation. Close it before retrying.');
 const baseline=new Set(handles());
 let opening:PanelDialog|undefined;
 const surface={box:undefined as unknown as HTMLElement,handles:[] as Subscription[],conflict:false,watcher:undefined as unknown as Subscription};
 surface.watcher=context.bus.subscribe('dialogPcbOpen',(value:PanelDialog,_bridge,source)=>{
  if(value?.action!=='panelize')return;
  if(!opening && source===context.target) opening=value;
  else surface.conflict=true;
 });
 context.surface=surface;
 try {
  const dialog=await new Promise<PanelDialog>((resolve,reject)=>{
   const subscription=context.bus.subscribe('dialogPcbOpen',(value:PanelDialog,_bridge,source)=>{
    if(source!==context.target || value?.action!=='panelize')return;
    subscription.cancel();
    if(!value.dialogId || !value.panelizeParam || !value.bbox) {reject(new Error('Unsupported native panel dialog payload.'));return;}
    resolve(value);
   });
   try{context.publish('openPanelizeDlg',{});}catch(error){subscription.cancel();reject(error);}
  });
  // Native dialog creation and React effect registration happen after the PCB event.
  while(!surface.conflict) {
   const box=context.document.getElementById('Panelize_dialog_box');
   const owned=handles().filter(handle=>!baseline.has(handle)&&handle.running());
   if(box && owned.length) {surface.box=box;surface.handles=owned;assertNativeOperationReady();return dialog;}
   await tick();
  }
  throw new Error('Another PCB opened the shared panel dialog. Inspect the editor before retrying.');
 } catch(error) {surface.watcher.cancel();throw error;}
}
async function disposeSurface(context:NativeContext) {
 const surface=context.surface;
 if(!surface)return;
 try {
  if(surface.conflict || context.document.getElementById('Panelize_dialog_box')!==surface.box) throw new Error('Native panel dialog ownership changed; automatic cleanup refused.');
  for(const handle of surface.handles)handle.cancel();
  context.bus.publish('ui/closeDialog','Panelize');
  while(context.document.getElementById('Panelize_dialog_box')===surface.box) await tick();
 } finally {surface.watcher.cancel();context.surface=undefined;}
}
async function close(context:NativeContext,dialogId:string,parameters?:Parameters) {
 await new Promise<void>((resolve,reject)=>{
  const action=parameters?'confirm':'cancel';
  const subscription=context.bus.subscribe('PcbcloseDialog',(value:{dialogId?:string;action?:string},_bridge,source)=>{
   if(source!==context.target)return;
   if(value?.dialogId!==dialogId) return;
   if(value.action==='cancel' && action==='confirm') { subscription.cancel();reject(new Error('Native panel dialog was cancelled.'));return; }
   if(value.action!==action)return;
   subscription.cancel();resolve();
  });
  if(context.surface?.conflict){subscription.cancel();reject(new Error('Panel dialog ownership changed.'));return;}
  try{context.publish('pcbdialogClose',{action,dialogId,...(parameters?{panelizeParam:parameters}:{})});}catch(error){subscription.cancel();reject(error);}
 });
 await disposeSurface(context);
}
function planned(current:Parameters,params:Record<string,any>):Parameters {
 const value:Parameters={...current,on:true,row:params.rows,column:params.columns,rowSpacing:params.rowSpacingMm/0.254,columnSpacing:params.columnSpacingMm/0.254};
 for(const number of [value.row,value.column,value.rowSpacing,value.columnSpacing]) if(!Number.isFinite(number)) throw new Error('Panel dimensions must be finite.');
 if(!Number.isInteger(value.row)||!Number.isInteger(value.column)||value.row<1||value.column<1||value.row*value.column>100) throw new Error('Panel grid must contain 1–100 boards.');
 if(value.rowSpacing<0 || value.columnSpacing<0 || params.rowSpacingMm>100 || params.columnSpacingMm>100) throw new Error('Spacing must be between 0 and 100 mm.');
 if(current.stampRow===true || current.stampColumn===true) throw new Error('Stamp-hole panelization is not supported by this grid adapter; disable stamp holes in the native preview first.');
 const minimum=Number(current.minSpacing);
 if(!Number.isFinite(minimum)) throw new Error('Native panel spacing constraints are unavailable.');
 if(value.rowSpacing<minimum && !(value.rowSpacing===0 && current.stampRow===false)) throw new Error('Row spacing is below the native minimum.');
 if(value.columnSpacing<minimum && !(value.columnSpacing===0 && current.stampColumn===false)) throw new Error('Column spacing is below the native minimum.');
 for(const key of ['createBorder','vCutHorizontal','onlyOutlineBefore']) delete value[key];
 return value;
}
async function panelize(params:Record<string,any>,apply:boolean) {
 const version=await eda.sys_Environment.getEditorCurrentVersion();
 if(version!=='2.2.47.7') throw new Error(`Native panelization is only verified for EasyEDA Pro 2.2.47.7; host reports ${version}.`);
 await guard(params.projectUuid,params.expectedDocument);
 const before=await eda.sys_FileManager.getDocumentSource();
 if(!before) throw new Error('Native PCB source unavailable.');
 if(apply && before!==params.expectedSource) throw new Error('PCB changed since panelization preview.');
 const context=await nativeContext(params.expectedDocument,params.projectUuid);
 const dialog=await open(context);
 let dismissed=false;
 try {
  if(!Number.isFinite(dialog.bbox.width)||!Number.isFinite(dialog.bbox.height)||dialog.bbox.width<=0||dialog.bbox.height<=0) throw new Error('Panelization needs a nonempty board outline.');
  const next=planned(dialog.panelizeParam,params);
  await guard(params.projectUuid,params.expectedDocument);
  if(await eda.sys_FileManager.getDocumentSource()!==before) throw new Error('PCB changed while the panel dialog was open.');
  if(apply) assertNativeOperationReady();
  dismissed=true;await close(context,dialog.dialogId,apply?next:undefined);
  if(!apply) return {source:before,version,grid:{rows:next.row,columns:next.column,rowSpacingMm:params.rowSpacingMm,columnSpacingMm:params.columnSpacingMm},current:dialog.panelizeParam,planned:next};
  await guard(params.projectUuid,params.expectedDocument);
  const source=await eda.sys_FileManager.getDocumentSource();
  if(!source) throw new Error('No source after native panelization. Inspect before retrying.');
  let main=false,record:unknown[]|undefined;
  for(const line of source.split('\n')) {
   if(!line.trim())continue;
   const row=JSON.parse(line);
   if(row[0]==='DOCTYPE')main=row[1]==='PCB';
   if(main&&row[0]==='PANELIZE')record=row;
  }
  if(!record || !Number.isFinite(record[4]) || !Number.isFinite(record[5]) || record[6]!==Number(Boolean(next.onlyOutline)) || record[1]!==1 || record[2]!==next.row || record[3]!==next.column || Math.abs(Number(record[4])-next.rowSpacing*10)>0.0002 || Math.abs(Number(record[5])-next.columnSpacing*10)>0.0002) throw new Error('Panel source verification failed; inspect the PCB before retrying.');
  const verify=await open(context);
  await close(context,verify.dialogId);
  await guard(params.projectUuid,params.expectedDocument);
  if(verify.panelizeParam.success!==true || verify.panelizeParam.row!==next.row || verify.panelizeParam.column!==next.column) throw new Error('Native panelization did not confirm successful geometry.');
  return {applied:true,saved:false,version,grid:{rows:next.row,columns:next.column},note:'Native array verified. Inspect rails, tooling, separation and manufacturing rules before saving or exporting.'};
 }finally{if(!dismissed)await close(context,dialog.dialogId);}
}
export const panelizeHandlers:Record<string,(params:Record<string,any>)=>Promise<unknown>>={
 'pcb.panelize.inspect':params=>boundedNativeOperation('Panelization preview',()=>panelize(params,false),30000),
 'pcb.panelize.apply':params=>boundedNativeOperation('Native PCB panelization',()=>panelize(params,true),60000),
};
