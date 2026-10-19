import { boundedNativeOperation as bounded } from '../native-operation-gate';
import { canonicalDocumentId } from '../../shared/method-classes';
import { setCopperLayerCount } from './layer-analysis';

type PhysicalStack = { name: string; layerCount: number; list: Array<Record<string, unknown>> };

async function boundDocument(params: Record<string, any>) {
	const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	// Tab ids carry "@<project>"; compare the bare document UUIDs.
	if (!doc || !params.expectedDocument || canonicalDocumentId(doc.uuid) !== canonicalDocumentId(params.expectedDocument) || doc.documentType !== 3) throw new Error('Physical-stack operation requires the bound PCB document.');
	return { documentUuid: doc.uuid, projectUuid: doc.parentProjectUuid };
}

function validateStack(value: unknown): asserts value is PhysicalStack {
	const v = value as PhysicalStack;
	if (!v || typeof v !== 'object' || typeof v.name !== 'string' || !Number.isInteger(v.layerCount) || v.layerCount < 1 || !Array.isArray(v.list) || !v.list.length || v.list.some(r => !r || typeof r !== 'object' || Array.isArray(r))) throw new Error('Invalid vendor physical-stack configuration; require name, layerCount and nonempty record list from getter/schema.');
}

export const layerHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'pcb.layer.physical.get': async (params) => {
		const context = await boundDocument(params);
		const api = eda.pcb_Layer as unknown as Record<string, any>;
		if (typeof api.getCurrentPhysicalStackingConfiguration !== 'function') return { ...context, supported: false, reason: 'Host does not expose getCurrentPhysicalStackingConfiguration' };
		const configuration = await bounded('Physical stack read', () => api.getCurrentPhysicalStackingConfiguration(), 10000);
		await boundDocument(params);
		// EasyEDA Pro 3.2 types the getter but ships an empty body (returns undefined).
		if (!configuration) return { ...context, supported: false, reason: 'Host exposes getCurrentPhysicalStackingConfiguration but it returned no configuration (stub on EasyEDA Pro 3.2)' };
		validateStack(configuration);
		return { ...context, supported: true, configuration, overwriteAvailable: typeof api.overwriteCurrentPhysicalStackingConfiguration === 'function' };
	},

	'pcb.layer.physical.overwrite': async (params) => {
		const context = await boundDocument(params);
		validateStack(params.configuration);
		validateStack(params.expectedConfiguration);
		const api = eda.pcb_Layer as unknown as Record<string, any>;
		if (typeof api.getCurrentPhysicalStackingConfiguration !== 'function' || typeof api.overwriteCurrentPhysicalStackingConfiguration !== 'function') throw new Error('Host physical-stack replacement API unavailable.');
		const before = await bounded('Physical stack precondition read', () => api.getCurrentPhysicalStackingConfiguration(), 10000);
		if (JSON.stringify(before) !== JSON.stringify(params.expectedConfiguration)) throw new Error('Physical-stack configuration changed since the repair preview.');
		await boundDocument(params);
		if (params.dryRun !== false) return { ...context, dryRun: true, before, planned: params.configuration };
		const applied = await bounded('Physical stack overwrite', () => api.overwriteCurrentPhysicalStackingConfiguration(params.configuration), 10000);
		await boundDocument(params);
		if (applied !== true) throw new Error('Host refused physical-stack replacement.');
		const after = await bounded('Physical stack verification read', () => api.getCurrentPhysicalStackingConfiguration(), 10000);
		await boundDocument(params);
		return { ...context, applied: true, saved: false, before, after, exactReadback: JSON.stringify(after) === JSON.stringify(params.configuration), note: 'Verify native source, copper identities and component/pad geometry before saving.' };
	},
	'pcb.layer.getAll': async () => {
		return eda.pcb_Layer.getAllLayers();
	},

	'pcb.layer.select': async (params) => {
		return eda.pcb_Layer.selectLayer(params.layer);
	},

	'pcb.layer.setVisible': async (params) => {
		return eda.pcb_Layer.setLayerVisible(params.layer, params.setOtherLayerInvisible);
	},

	'pcb.layer.setInvisible': async (params) => {
		return eda.pcb_Layer.setLayerInvisible(params.layer, params.setOtherLayerVisible);
	},

	'pcb.layer.lock': async (params) => {
		return eda.pcb_Layer.lockLayer(params.layer);
	},

	'pcb.layer.unlock': async (params) => {
		return eda.pcb_Layer.unlockLayer(params.layer);
	},

	// Guarded: refuses to drop inner layers that still carry copper unless
	// force:true, and verifies the new count by re-reading the layers.
	'pcb.layer.setCopperCount': async (params) => {
		return setCopperLayerCount({ count: params.count, force: params.force === true, dryRun: params.dryRun === true });
	},

	'pcb.layer.modify': async (params) => {
		return eda.pcb_Layer.modifyLayer(params.layer, params.property);
	},

	'pcb.layer.addCustom': async () => {
		return eda.pcb_Layer.addCustomLayer();
	},

	'pcb.layer.remove': async (params) => {
		return eda.pcb_Layer.removeLayer(params.layer);
	},
};
