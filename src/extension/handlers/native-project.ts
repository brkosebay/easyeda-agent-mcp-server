import { equivalentNativeSource } from '../native-source';
import { boundedNativeOperation as bounded, nativeOperationStatus, acknowledgeNativeOperation, resetNativeOperations } from '../native-operation-gate';

async function guard(params: Record<string, any>) {
  const project = await eda.dmt_Project.getCurrentProjectInfo();
  const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  if (!doc || !project || project.uuid !== params.projectUuid || doc?.parentProjectUuid !== params.projectUuid) throw new Error('Active EasyEDA project does not match the requested project UUID.');
  if (params.expectedDocument && doc.uuid !== params.expectedDocument) throw new Error('Active document does not match the requested document.');
  return {projectUuid: project.uuid, documentUuid: doc.uuid};
}
async function encodeFile(file: File | undefined) {
  if (!file || file.size === 0) throw new Error('EasyEDA returned no export file. Check native export permissions and the active document.');
  if (file.size > 64 * 1024 * 1024) throw new Error('Native export exceeds the 64 MiB bridge limit; export it directly in EasyEDA.');
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Cannot read native export.'));
    reader.readAsDataURL(file);
  });
  return {fileName: file.name, mimeType: file.type, size: file.size, data};
}
/** Fixed compatibility path used by EasyEDA Pro 2.2's own schematic export UI. */
async function nativeSchematicSvg(fileName: string): Promise<File | undefined> {
  let bus: {publish: (topic: string, payload: unknown) => void} | undefined;
  try {
    const host = globalThis as unknown as {UI?: {gVars?: {messageBus?: typeof bus}}};
    bus = host.UI?.gVars?.messageBus;
    if (!bus) bus = (globalThis as unknown as {top?: typeof host}).top?.UI?.gVars?.messageBus;
  } catch { /* Isolated extension realm: use the public host API below. */ }
  if (bus) {
    return new Promise<File>((resolve, reject) => {
      bus!.publish('sch/getExportFileData', {
        config: {exportObject:'Current Page',fileType:'fileSVG',language:'en',needMenu:false,isMerge:false,lineWidthCfg:'followZoom',colorType:'Default',isAllRange:true,rangeStart:1,rangeEnd:1},
        cb: (success: boolean, result: {data?: Blob | string;fileName?:string;extension?:string}) => {
          if (!success || !result?.data) { reject(new Error('Native schematic SVG export failed.')); return; }
          resolve(new File([result.data],fileName+'.svg',{type:'image/svg+xml'}));
        },
      });
    });
  }
  return eda.sch_ManufactureData.getExportDocumentFile(fileName, 'SVG' as Parameters<typeof eda.sch_ManufactureData.getExportDocumentFile>[1], undefined, 'Current Schematic Page');
}
export const nativeProjectHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
  'editor.native.operationStatus': async () => nativeOperationStatus(),
  // Bypasses the gate (see ws-client GATE_BYPASS_METHODS): the recovery path
  // when an EasyEDA call hangs and holds the request queue.
  'editor.native.resetQueue': async (params) => resetNativeOperations({ clearQuarantine: params.clearQuarantine === true }),
  'editor.native.inspectUncertain': async (params) => {
    const status = nativeOperationStatus();
    if (!status.uncertain || status.uncertain.outcome === 'pending') throw new Error('No settled uncertain operation to inspect.');
    const context = await guard(params);
    const source = await eda.sys_FileManager.getDocumentSource();
    await guard(params);
    if (!source) throw new Error('No source available for reconciliation.');
    return { ...status, ...context, source };
  },
  'editor.native.reconcile': async (params) => {
    const context = await guard(params);
    const source = await eda.sys_FileManager.getDocumentSource();
    await guard(params);
    if (!source || source !== params.expectedSource) throw new Error('Native source changed since reconciliation preview.');
    acknowledgeNativeOperation(params.operationId);
    return { ...context, reconciled: true, note: 'Acknowledged current document state; this does not assert that the timed-out edit succeeded or that other project documents are unchanged.' };
  },
  'editor.native.exportProject': async (params) => {
    const context = await guard(params);
    // Exports persisted local state. Unsaved editor overlays require separate source checkpoints.
    const result = await encodeFile(await bounded('Native project export', () => eda.sys_FileManager.getProjectFile(params.fileName)));
    await guard(params);
    return {...context, ...result, coverage:'persisted-project-state', note:'Archive does not guarantee unsaved canvas changes. Save first or also export native document source for edited documents.'};
  },
  'editor.native.getSource': async (params) => {
    const context = await guard(params);
    const source = await bounded('Native source read', () => eda.sys_FileManager.getDocumentSource());
    if (!source) throw new Error('No native document source returned.');
    await guard(params);
    return {...context, source};
  },
  'editor.native.set': async (params) => {
    const context = await guard(params);
    const current = await bounded('Native source read', () => eda.sys_FileManager.getDocumentSource());
    if (!current || current !== params.expectedSource) throw new Error('Native document changed since the restore preview. Read it again before restoring.');
    await guard(params);
    const restored = await bounded('Native document restore', () => eda.sys_FileManager.setDocumentSource(params.source));
    if (!restored) throw new Error('EasyEDA did not restore the document.');
    await guard(params);
    const readBack = await bounded('Restored source verification', () => eda.sys_FileManager.getDocumentSource());
    await guard(params);
    if (!readBack || !equivalentNativeSource(params.source, readBack)) throw new Error('Restore returned success but source read-back differs. Inspect the active document before saving or retrying.');
    return {...context, restored: true, saved: false, verification: readBack === params.source ? 'exact-source' : 'identical-records-component-order-normalized', note: 'Document source replaced in the active editor. Inspect and explicitly save after validation.'};
  },
  'editor.native.importProject': async (params) => {
    const binary = atob(params.data);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const file = new File([bytes], params.fileName, {type:'application/octet-stream'});
    const project = await bounded('Native project recovery', () => eda.sys_FileManager.importProjectByProjectFile(file, 'EasyEDA Pro', {
      importOption: 'ImportDocument' as NonNullable<Parameters<typeof eda.sys_FileManager.importProjectByProjectFile>[2]>['importOption'],
      schematicObjectStyle: 'system' as NonNullable<Parameters<typeof eda.sys_FileManager.importProjectByProjectFile>[2]>['schematicObjectStyle'],
      associateFootprint: false, associate3DModel: false, importFootprintNotesLayer: true,
    }, {
      operation: 'New Project', newProjectOwnerTeamUuid: params.teamUuid, newProjectName: params.name, newProjectFriendlyName: params.name,
    }));
    if (!project?.uuid) throw new Error('EasyEDA did not return a recovered project UUID. Inspect the project list before retrying.');
    return {project, note:'Recovered to a new project. Existing Backplane bindings have not changed.'};
  },
  'editor.native.exportSchematicSvg': async (params) => {
    const context = await guard(params);
    const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    if (doc?.documentType !== 1) throw new Error('Open the requested schematic page first.');
    // Public API on newer hosts. Older hosts can declare the wrapper but omit its handler.
    const file = await bounded('Schematic SVG export', () => nativeSchematicSvg(params.fileName || 'schematic'), 10000);
    const result = await encodeFile(file);
    await guard(params);
    return {...context, ...result};
  },
};
