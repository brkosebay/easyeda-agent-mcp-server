import { flattenState, flattenStateArray, normalizeLayer } from './_utils';

export const documentHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	// === Document ===

	'pcb.document.save': async (params) => {
		return eda.pcb_Document.save(params.uuid);
	},

	// Force a canvas refresh: cycle the ratline calculator and re-zoom.
	// Use this when newly created tracks/vias don't visually appear even
	// though the API reports them as present.
	'pcb.document.refresh': async (params) => {
		const ratlineStatus = await eda.pcb_Document.getCalculatingRatlineStatus().catch(() => null);
		await eda.pcb_Document.stopCalculatingRatline().catch(() => {});
		await eda.pcb_Document.startCalculatingRatline().catch(() => {});
		if (params?.zoom !== false) await eda.pcb_Document.zoomToBoardOutline().catch(() => {});
		return { ratlineStatus };
	},

	// Inspect canvas filter — reveals when Track/Via/etc display has been
	// turned off in the UI ("why don't I see my tracks?").
	//
	// EasyEDA's getCurrentFilterConfiguration() can hang forever on some
	// builds (web app especially). Race it against a 5 s internal deadline
	// so the call fails fast with a clear message instead of waiting out
	// the bridge's 120 s timeout.
	'pcb.document.getCanvasFilter': async () => {
		const result = await Promise.race([
			eda.pcb_Document.getCurrentFilterConfiguration(),
			new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5_000)),
		]);
		if (result === undefined) {
			throw new Error(
				'getCurrentFilterConfiguration() did not respond within 5s. ' +
				'This API is known to hang on the EasyEDA Pro web app; try the desktop Electron build, ' +
				'or use pcb_get_layer_status for layer visibility info instead.',
			);
		}
		return result;
	},

	// Get layer visibility + lock status in a flat shape.
	'pcb.layer.getStatus': async () => {
		const layers = await eda.pcb_Layer.getAllLayers();
		return (layers || []).map((l: any) => ({
			id: l.id,
			name: l.name,
			type: l.type,
			layerStatus: l.layerStatus,    // 0=NOTUSED, 1=SHOW, 2=HIDDEN
			locked: l.locked,
			transparency: l.transparency,
		}));
	},

	'pcb.document.navigateTo': async (params) => {
		return eda.pcb_Document.navigateToCoordinates(params.x, params.y);
	},

	'pcb.document.navigateToRegion': async (params) => {
		return eda.pcb_Document.navigateToRegion(params.left, params.right, params.top, params.bottom);
	},

	'pcb.document.getPrimitiveAtPoint': async (params) => {
		return eda.pcb_Document.getPrimitiveAtPoint(params.x, params.y);
	},

	'pcb.document.getPrimitivesInRegion': async (params) => {
		return eda.pcb_Document.getPrimitivesInRegion(
			params.left,
			params.right,
			params.top,
			params.bottom,
			params.leftToRight,
		);
	},

	'pcb.document.zoomToBoardOutline': async () => {
		return eda.pcb_Document.zoomToBoardOutline();
	},

	'pcb.document.getCanvasOrigin': async () => {
		return eda.pcb_Document.getCanvasOrigin();
	},

	'pcb.document.setCanvasOrigin': async (params) => {
		return eda.pcb_Document.setCanvasOrigin(params.offsetX, params.offsetY);
	},

	'pcb.document.convertCanvasToData': async (params) => {
		return eda.pcb_Document.convertCanvasOriginToDataOrigin(params.x, params.y);
	},

	'pcb.document.convertDataToCanvas': async (params) => {
		return eda.pcb_Document.convertDataOriginToCanvasOrigin(params.x, params.y);
	},

	'pcb.document.importChanges': async (params) => {
		return eda.pcb_Document.importChanges(params.uuid);
	},

	// === Selection ===

	'pcb.select.getAll': async () => {
		return eda.pcb_SelectControl.getAllSelectedPrimitives();
	},

	'pcb.select.clear': async () => {
		return eda.pcb_SelectControl.clearSelected();
	},

	// === Pad ===

	'pcb.getAll.pad': async (params) => {
		const all = await eda.pcb_PrimitivePad.getAll(normalizeLayer(params.layer), params.net, params.primitiveLock);
		return flattenStateArray(all);
	},

	'pcb.get.pad': async (params) => {
		const result = await eda.pcb_PrimitivePad.get(params.primitiveIds);
		return Array.isArray(result) ? flattenStateArray(result) : flattenState(result);
	},

	'pcb.create.pad': async (params) => {
		return eda.pcb_PrimitivePad.create(
			params.layer,
			params.padNumber,
			params.x,
			params.y,
			params.rotation,
			params.pad,
			params.net,
			params.hole,
			params.holeOffsetX,
			params.holeOffsetY,
			params.holeRotation,
			params.metallization,
			params.padType,
			params.specialPad,
			params.solderMaskAndPasteMaskExpansion,
			params.heatWelding,
			params.primitiveLock,
		);
	},

	'pcb.modify.pad': async (params) => {
		return eda.pcb_PrimitivePad.modify(params.primitiveId, params.property);
	},

	'pcb.delete.pad': async (params) => {
		return eda.pcb_PrimitivePad.delete(params.ids);
	},
};
