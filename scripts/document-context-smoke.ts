import assert from 'node:assert/strict';
import { activateNativeDocument } from '../src/extension/document-context';
import { nativeOperationStatus } from '../src/extension/native-operation-gate';
async function main() {
 let active = {uuid:'pcb',parentProjectUuid:'project',documentType:3};
 let tabs:Array<{tabId:string}>=[];
 let opens=0,activates=0,compat=0;
 const root=globalThis as any;
 const fast={pollMs:10,failedGraceMs:20,timeoutMs:2000};
 root.eda={
  dmt_Project:{getCurrentProjectInfo:async()=>({uuid:'project'})},
  dmt_SelectControl:{getCurrentDocumentInfo:async()=>active},
  dmt_Pcb:{getAllPcbsInfo:async()=>[{uuid:'pcb'}]},
  dmt_EditorControl:{getSplitScreenTree:async()=>({children:[{tabs}]}),activateDocument:async(id:string)=>{activates++;active={...active,uuid:id.split('@')[0]};return true;},openDocument:async(id:string)=>{opens++;active={...active,uuid:id};return id+'@project';}},
 };
 root.UI={gVars:{messageBus:{rpcCall:async(topic:string,payload:any)=>{assert.equal(topic,'openPcbByUUid');compat++;active={...active,uuid:payload.uuid};}}}};
 await activateNativeDocument('pcb');
 assert.equal(opens+activates+compat,0,'already-active uses fresh identity');
 await activateNativeDocument('pcb@project');
 assert.equal(opens+activates+compat,0,'tab ids compare by bare uuid');
 active={...active,uuid:'sch'};tabs=[{tabId:'pcb@project'}];
 await activateNativeDocument('pcb',fast);assert.equal(activates,1);
 active={...active,uuid:'sch'};tabs=[];
 await activateNativeDocument('pcb',fast);assert.equal(compat,1);assert.equal(opens,0);
 await activateNativeDocument('sch',fast);assert.equal(opens,1);
 root.eda.dmt_EditorControl.openDocument=async()=>{};
 await assert.rejects(activateNativeDocument('other',fast),/did not reach.*returned no tab/);
 active={uuid:'pcb',parentProjectUuid:'other-project',documentType:3};
 await assert.rejects(activateNativeDocument('pcb',fast),/did not reach.*not bound to the current project/);
 // Activation failures are view-state failures: the gate must stay usable.
 assert.equal(nativeOperationStatus().status,'ready');
 assert.equal(nativeOperationStatus().uncertain,null);
 console.log('Fresh identity, existing-tab activation, PCB compatibility opener, postcondition checks and non-quarantining failures: passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
