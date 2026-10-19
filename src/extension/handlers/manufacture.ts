import { withTimeout, callWithTimeout, didTimeOut, flattenState, normalizeLayer, normalizeViaType } from './_utils';

// Manufacture exports (Gerber, BOM, 3D, PDF, DSN, DXF, etc.) call EasyEDA's
// generation pipeline. On dense or malformed designs these can hang in the
// runtime indefinitely with no timeout. We race each one against a deadline
// so a stuck export can't lock the extension and force a restart.
//
// Default 5 minutes — generous enough for big boards (Gerber on a 10-layer
// 500-component board genuinely takes ~3 minutes), tight enough that a
// genuinely hung export surfaces as an error instead of a wedged session.
// Override per-call via `_timeoutMs` (handled at the bridge layer) or per
// handler via `params.timeoutMs`.
const DEFAULT_EXPORT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_IMPORT_TIMEOUT_MS = 45_000;
const DEFAULT_DIRECT_IMPORT_OP_TIMEOUT_MS = 5_000;

function exportTimeoutMs(params: any): number {
	const v = Number(params?.timeoutMs);
	return Number.isFinite(v) && v > 0 ? v : DEFAULT_EXPORT_TIMEOUT_MS;
}

function importTimeoutMs(params: any): number {
	const v = Number(params?.timeoutMs ?? params?.importTimeoutMs);
	return Number.isFinite(v) && v > 0 ? v : DEFAULT_IMPORT_TIMEOUT_MS;
}

async function awaitExport<T>(label: string, p: Promise<T>, params: any): Promise<T> {
	const ms = exportTimeoutMs(params);
	const out = await withTimeout(p, ms);
	if (didTimeOut(out)) {
		throw new Error(
			`${label} timed out after ${ms}ms. EasyEDA's generator is still running in the background but is unlikely to recover. Common causes: malformed schematic/PCB primitives, missing footprints, infinite-loop nets. Pass a higher timeoutMs only after confirming the export is actually making progress.`,
		);
	}
	return out as T;
}

async function awaitImport<T>(
	label: string,
	invoke: () => Promise<T>,
	params: any,
	file: File,
	format: string,
): Promise<{ imported: boolean; rawResult: T | null; fileName: string; size: number; format: string }> {
	const ms = importTimeoutMs(params);
	const out = await callWithTimeout(invoke, ms);
	if (didTimeOut(out)) {
		throw new Error(
			`${label} timed out after ${ms}ms. EasyEDA may still be applying the file in the background; retry only after the editor is responsive. For autoroute SES files, keep the generated .ses path and import it manually if needed.`,
		);
	}
	return {
		imported: out === true,
		rawResult: (out ?? null) as T | null,
		fileName: file.name,
		size: file.size,
		format,
	};
}

async function fileToBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = reader.result as string;
			resolve(dataUrl.split(',')[1] || '');
		};
		reader.onerror = () => reject(new Error('Failed to read file'));
		reader.readAsDataURL(file);
	});
}

function base64ToFile(base64: string, fileName: string, mimeType = 'application/octet-stream'): File {
	let binaryStr: string;
	try {
		binaryStr = atob(base64);
	} catch (err: any) {
		throw new Error(`Invalid Base64 import data for ${fileName}: ${err instanceof Error ? err.message : String(err)}`);
	}
	const bytes = new Uint8Array(binaryStr.length);
	for (let i = 0; i < binaryStr.length; i++) {
		bytes[i] = binaryStr.charCodeAt(i);
	}
	return new File([bytes], fileName, { type: mimeType });
}

async function exportFile(file: File | undefined): Promise<{ fileName: string; data: string; size: number }> {
	if (!file) throw new Error('Failed to export file');
	const data = await fileToBase64(file);
	return { fileName: file.name, data, size: file.size };
}

export const manufactureHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	// === Export ===

	'pcb.manufacture.getDsnFile': async (params) => {
		const file = await awaitExport('DSN export', eda.pcb_ManufactureData.getDsnFile(params.fileName), params);
		return exportFile(file);
	},

	'pcb.manufacture.getAutoRouteJsonFile': async (params) => {
		const file = await awaitExport('AutoRoute JSON export', eda.pcb_ManufactureData.getAutoRouteJsonFile(params.fileName), params);
		return exportFile(file);
	},

	'pcb.manufacture.getAutoLayoutJsonFile': async (params) => {
		const file = await awaitExport('AutoLayout JSON export', eda.pcb_ManufactureData.getAutoLayoutJsonFile(params.fileName), params);
		return exportFile(file);
	},

	'pcb.manufacture.getGerberFile': async (params) => {
		const file = await awaitExport('Gerber export', eda.pcb_ManufactureData.getGerberFile(
			params.fileName,
			params.colorSilkscreen,
			params.unit,
			params.digitalFormat,
			params.other,
			params.layers,
			params.objects,
		), params);
		return exportFile(file);
	},

	'pcb.manufacture.getBomFile': async (params) => {
		const file = await awaitExport('BOM export', eda.pcb_ManufactureData.getBomFile(
			params.fileName,
			params.fileType,
			params.template,
			params.filterOptions,
			params.statistics,
			params.property,
			params.columns,
		), params);
		return exportFile(file);
	},

	'pcb.manufacture.getPickAndPlaceFile': async (params) => {
		const file = await awaitExport('Pick&Place export', eda.pcb_ManufactureData.getPickAndPlaceFile(
			params.fileName,
			params.fileType,
			params.unit,
		), params);
		return exportFile(file);
	},

	'pcb.manufacture.get3DFile': async (params) => {
		const file = await awaitExport('3D export', eda.pcb_ManufactureData.get3DFile(
			params.fileName,
			params.fileType,
			params.element,
			params.modelMode,
			params.autoGenerateModels,
		), params);
		return exportFile(file);
	},

	'pcb.manufacture.getPdfFile': async (params) => {
		const file = await awaitExport('PDF export', eda.pcb_ManufactureData.getPdfFile(params.fileName), params);
		return exportFile(file);
	},

	'pcb.manufacture.getNetlistFile': async (params) => {
		const file = await awaitExport('Netlist export', eda.pcb_ManufactureData.getNetlistFile(params.fileName, params.netlistType), params);
		return exportFile(file);
	},

	'pcb.manufacture.getDxfFile': async (params) => {
		const file = await awaitExport('DXF export', eda.pcb_ManufactureData.getDxfFile(params.fileName, params.layers, params.objects), params);
		return exportFile(file);
	},

	'pcb.manufacture.getAltiumDesignerFile': async (params) => {
		const file = await awaitExport('Altium Designer export', eda.pcb_ManufactureData.getAltiumDesignerFile(params.fileName), params);
		return exportFile(file);
	},

	'pcb.manufacture.getPadsFile': async (params) => {
		const file = await awaitExport('PADS export', eda.pcb_ManufactureData.getPadsFile(params.fileName), params);
		return exportFile(file);
	},

	// === Import ===

	'pcb.manufacture.importAutoRouteJson': async (params) => {
		const file = base64ToFile(params.data, params.fileName || 'autoroute.json');
		return awaitImport('AutoRoute JSON import', () => eda.pcb_Document.importAutoRouteJsonFile(file), params, file, 'autoroute_json');
	},

	'pcb.manufacture.importAutoLayoutJson': async (params) => {
		const file = base64ToFile(params.data, params.fileName || 'autolayout.json');
		return awaitImport('AutoLayout JSON import', () => eda.pcb_Document.importAutoLayoutJsonFile(file), params, file, 'autolayout_json');
	},

	'pcb.manufacture.importAutoRouteSes': async (params) => {
		const file = base64ToFile(params.data, params.fileName || 'autoroute.ses');
		const doc = eda.pcb_Document as any;
		if (typeof doc.importAutoRouteSesFile !== 'function') {
			throw new Error('importAutoRouteSesFile API is not available in this version');
		}
		return awaitImport('SES import', () => doc.importAutoRouteSesFile(file), params, file, 'autoroute_ses');
	},

	'pcb.manufacture.commitSesRoutesDirect': async (params) => {
		const operations = Array.isArray(params.operations) ? params.operations : [];
		const dryRun = params.dryRun === true;
		const onError: 'continue' | 'abort' = params.onError === 'abort' ? 'abort' : 'continue';
		const maxResultIds = Math.max(0, Math.floor(Number(params.maxResultIds ?? 100)));
		const perOperationTimeoutMs = Math.max(1, Math.floor(Number(params.perOperationTimeoutMs ?? DEFAULT_DIRECT_IMPORT_OP_TIMEOUT_MS)));
		let createdTracks = 0;
		let createdVias = 0;
		const primitiveIds: string[] = [];
		const errors: Array<Record<string, any>> = [];

		if (dryRun) {
			return {
				dryRun: true,
				operationCount: operations.length,
				trackCount: operations.filter((op: any) => op?.type === 'create_track').length,
				viaCount: operations.filter((op: any) => op?.type === 'create_via').length,
			};
		}

		for (let index = 0; index < operations.length; index++) {
			const op = operations[index] || {};
			try {
				if (op.type === 'create_track') {
					const result = await callWithTimeout(
						() => eda.pcb_PrimitiveLine.create(
							String(op.net),
							normalizeLayer(op.layer),
							Number(op.startX),
							Number(op.startY),
							Number(op.endX),
							Number(op.endY),
							Number(op.lineWidth),
						),
						perOperationTimeoutMs,
					);
					if (didTimeOut(result)) throw new Error(`Track create timed out after ${perOperationTimeoutMs}ms`);
					createdTracks += 1;
					const flat: any = flattenState(result);
					const id = flat?.primitiveId ?? flat?.globalIndex;
					if (id && primitiveIds.length < maxResultIds) primitiveIds.push(String(id));
				} else if (op.type === 'create_via') {
					const result = await callWithTimeout(
						() => eda.pcb_PrimitiveVia.create(
							String(op.net),
							Number(op.x),
							Number(op.y),
							Number(op.holeDiameter),
							Number(op.diameter),
							normalizeViaType(op.viaType ?? 'Through'),
						),
						perOperationTimeoutMs,
					);
					if (didTimeOut(result)) throw new Error(`Via create timed out after ${perOperationTimeoutMs}ms`);
					createdVias += 1;
					const flat: any = flattenState(result);
					const id = flat?.primitiveId ?? flat?.globalIndex;
					if (id && primitiveIds.length < maxResultIds) primitiveIds.push(String(id));
				} else {
					throw new Error(`Unsupported operation type "${op.type}"`);
				}
			} catch (err: any) {
				errors.push({
					index,
					type: op.type,
					net: op.net,
					error: err instanceof Error ? err.message : String(err),
				});
				if (onError === 'abort') break;
			}
		}

		return {
			dryRun: false,
			operationCount: operations.length,
			createdTracks,
			createdVias,
			errorCount: errors.length,
			errors: errors.slice(0, 50),
			primitiveIds,
			primitiveIdsTruncated: primitiveIds.length >= maxResultIds,
		};
	},
};
