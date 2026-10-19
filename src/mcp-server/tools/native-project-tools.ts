import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile, writeFile, stat, open } from 'node:fs/promises';
import { isAbsolute, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { WebSocketBridge } from '../bridge';
const withInstanceParam = <T extends Record<string, z.ZodTypeAny>>(params: T): T => params;

const MAX_BYTES = 64 * 1024 * 1024;
const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const result = (value: unknown) => ({content:[{type:'text' as const,text:JSON.stringify(value)}]});
async function fileBytes(path: string) {
  if (!isAbsolute(path)) throw new Error('Use an absolute file path.');
  if ((await stat(path)).size > MAX_BYTES) throw new Error('File exceeds 64 MiB bridge limit.');
  const data = await readFile(path);
  if (!data.length) throw new Error('File is empty.');
  return data;
}
export async function saveNativeExport(path: string, payload: unknown) {
  if (!isAbsolute(path)) throw new Error('Use an absolute outputPath.');
  const parsed = z.object({data:z.string().min(1),size:z.number().int().positive().max(MAX_BYTES),fileName:z.string()}).parse(payload);
  const data = Buffer.from(parsed.data,'base64');
  if (data.length !== parsed.size) throw new Error('Export size mismatch; no file written.');
  await writeFile(path,data,{flag:'wx'});
  return {outputPath:path,fileName:parsed.fileName,bytes:data.length,sha256:digest(data)};
}
export function registerNativeProjectTools(server: McpServer, bridge: WebSocketBridge) {
  const target = {instance_id:z.string().min(1),projectUuid:z.string().min(1),document:z.string().min(1)};
  server.tool('pcb_panelize_native', 'Preview or apply a native PCB fabrication array on verified EasyEDA Pro 2.2.47.7. Defaults to dryRun. Preserves native rail/stamp defaults; 1–100 boards maximum. Applying requires a NEW safetyBackupPath and the source hash from preview. Does not save. Native API compatibility path; inspect manufacturing output.', {...target,rows:z.number().int().min(1).max(100),columns:z.number().int().min(1).max(100),rowSpacingMm:z.number().min(0).max(100),columnSpacingMm:z.number().min(0).max(100),dryRun:z.boolean().default(true),expectedCurrentSha256:z.string().optional(),safetyBackupPath:z.string().optional()}, async ({dryRun,expectedCurrentSha256,safetyBackupPath,...params}) => {
    if(params.rows*params.columns>100) throw new Error('Panel grid exceeds 100 boards.');
    const preview=z.object({source:z.string().min(1)}).passthrough().parse(await bridge.send('pcb.panelize.inspect',{...params,expectedDocument:params.document}));
    const currentSha256=digest(preview.source);
    if(dryRun) {const {source,...details}=preview;return result({dryRun:true,currentSha256,...details});}
    if(expectedCurrentSha256!==currentSha256 || !safetyBackupPath || !isAbsolute(safetyBackupPath)) throw new Error('Applying requires a fresh preview hash and an absolute new safetyBackupPath.');
    await writeFile(safetyBackupPath,JSON.stringify({version:1,projectUuid:params.projectUuid,documentUuid:params.document,source:preview.source,sha256:currentSha256}),{flag:'wx'});
    const backup=await open(safetyBackupPath,'r+');
    try {await backup.sync();}finally{await backup.close();}
    const directory=await open(dirname(safetyBackupPath),'r');
    try {await directory.sync();}finally{await directory.close();}
    return result(await bridge.send('pcb.panelize.apply',{...params,expectedDocument:params.document,expectedSource:preview.source,_timeoutMs:70000}));
  });
  server.tool('native_operation_status', 'Inspect the extension request queue and native timeout quarantine without changing the active document: status ready|busy|reconciliation-required, the active operation and how long it has run, queued request count, and calls abandoned by the watchdog. Reconnect does not clear uncertain operations.', {instance_id:z.string().optional()}, async params => result(await bridge.send('editor.native.operationStatus',{...params,_timeoutMs:10000})));
  server.tool('native_operation_reset', 'Recovery when every EasyEDA request times out: release the extension request queue held by a hung EasyEDA call (e.g. an open dialog or an active mouse-placement mode) so new requests run, without restarting EasyEDA. Does not cancel the hung native call — first press Esc / close dialogs in EasyEDA. clearQuarantine=true also discards an unreconciled timed-out write; only use it after inspecting the document yourself. Clicking "Connect Claude" in EasyEDA while connected does the same queue reset plus a fresh reconnect.', {instance_id:z.string().optional(),clearQuarantine:z.boolean().default(false)}, async params => result(await bridge.send('editor.native.resetQueue',{...params,_timeoutMs:10000})));
  server.tool('native_operation_reconcile', 'Preview or explicitly acknowledge current native document state after a timed-out operation settles. Never changes design content or switches tabs. First inspect the editor and select the intended document manually. dryRun defaults true. Acknowledgement is not proof the earlier edit succeeded or the whole project is unchanged.', {...target,dryRun:z.boolean().default(true),operationId:z.number().int().optional(),expectedCurrentSha256:z.string().optional()}, async ({dryRun,operationId,expectedCurrentSha256,...params}) => {
    const payload = z.object({source:z.string().min(1),uncertain:z.object({id:z.number(),outcome:z.enum(['fulfilled','rejected'])})}).parse(await bridge.send('editor.native.inspectUncertain',{instance_id:params.instance_id,projectUuid:params.projectUuid,expectedDocument:params.document}));
    const currentSha256=digest(payload.source);
    if(dryRun) return result({dryRun:true,operationId:payload.uncertain.id,outcome:payload.uncertain.outcome,currentSha256});
    if(operationId!==payload.uncertain.id || expectedCurrentSha256!==currentSha256) throw new Error('Missing or stale reconciliation preview.');
    return result(await bridge.send('editor.native.reconcile',{instance_id:params.instance_id,projectUuid:params.projectUuid,expectedDocument:params.document,operationId,expectedSource:payload.source}));
  });
  server.tool('project_export_native','Export the current local EasyEDA project as a native archive to a NEW absolute outputPath. Requires native project-download permission. Includes persisted project state, not guaranteed unsaved canvas changes. Save first or pair live document source checkpoints. Verify the returned filename/type and recovery before relying on it.',withInstanceParam({...target,outputPath:z.string(),fileName:z.string().optional()}),async ({outputPath,...params}) => {
    const payload = await bridge.send('editor.native.exportProject',{...params,expectedDocument:params.document,_timeoutMs:130000});
    return result({...await saveNativeExport(outputPath,payload),projectUuid:params.projectUuid,documentUuid:params.document,kind:'native-project-archive',coverage:'persisted-project-state',note:'Unsaved canvas changes require document_export_native_source checkpoints or saving before archive export.'});
  });
  server.tool('document_export_native_source','Save the active document native source to a NEW absolute outputPath, with project/document binding and SHA-256. This covers one document, not the whole project or libraries.',withInstanceParam({...target,outputPath:z.string()}),async ({outputPath,...params}) => {
    if (!isAbsolute(outputPath)) throw new Error('Use an absolute outputPath.');
    const payload = z.object({source:z.string().min(1)}).parse(await bridge.send('editor.native.getSource',{...params,expectedDocument:params.document}));
    await writeFile(outputPath,JSON.stringify({version:1,projectUuid:params.projectUuid,documentUuid:params.document,sha256:digest(payload.source),source:payload.source}),{flag:'wx'});
    return result({outputPath,sha256:digest(payload.source),projectUuid:params.projectUuid,documentUuid:params.document,kind:'native-document-source'});
  });
  server.tool('document_restore_native_source','Preview or restore a native document-source backup to its SAME bound document. dryRun defaults true. Applying requires expectedCurrentSha256 from the preview and explicit user intent to replace document content. Does not save automatically.',withInstanceParam({...target,inputPath:z.string(),dryRun:z.boolean().default(true),expectedCurrentSha256:z.string().optional()}),async ({inputPath,dryRun,expectedCurrentSha256,...params}) => {
    const backup = z.object({version:z.literal(1),projectUuid:z.string(),documentUuid:z.string(),sha256:z.string(),source:z.string().min(1)}).parse(JSON.parse((await fileBytes(inputPath)).toString('utf8')));
    if (backup.projectUuid !== params.projectUuid || backup.documentUuid !== params.document || backup.sha256 !== digest(backup.source)) throw new Error('Backup identity or checksum does not match.');
    const current = z.object({source:z.string().min(1)}).parse(await bridge.send('editor.native.getSource',{...params,expectedDocument:params.document}));
    const currentSha256 = digest(current.source);
    if (dryRun) return result({dryRun:true,currentSha256,backupSha256:backup.sha256,changesDocument:currentSha256!==backup.sha256});
    if (!expectedCurrentSha256 || expectedCurrentSha256 !== currentSha256) throw new Error('Document changed or restore preview missing. Preview again.');
    return result(await bridge.send('editor.native.set',{...params,expectedDocument:params.document,source:backup.source,expectedSource:current.source,_timeoutMs:130000}));
  });
  server.tool('project_recover_native','Import a native archive into a NEW EasyEDA project. Never overwrites an existing project or changes Backplane binding. dryRun defaults true; inspect returned new project UUID after applying. Team UUID must be explicitly selected.',withInstanceParam({instance_id:z.string().min(1),inputPath:z.string(),teamUuid:z.string().min(1),name:z.string().min(1),dryRun:z.boolean().default(true)}),async ({inputPath,dryRun,...params}) => {
    const bytes=await fileBytes(inputPath);
    if (dryRun) return result({dryRun:true,fileName:basename(inputPath),bytes:bytes.length,sha256:digest(bytes),destination:'New Project',...params});
    return result(await bridge.send('editor.native.importProject',{...params,fileName:basename(inputPath),data:bytes.toString('base64'),_timeoutMs:130000}));
  });
  server.tool('sch_export_svg','Export native schematic SVG from the active page to a NEW absolute outputPath. Uses the native schematic export bus on EasyEDA Pro 2.2 and the public export API as fallback.',withInstanceParam({...target,outputPath:z.string(),fileName:z.string().optional()}),async ({outputPath,...params}) => result(await saveNativeExport(outputPath,await bridge.send('editor.native.exportSchematicSvg',{...params,expectedDocument:params.document}))));
}
