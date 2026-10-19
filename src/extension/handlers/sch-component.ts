import { fetchParsedNetlist } from './sch-netlist-utils';
import { boundedNativeOperation, NativeOperationTimeoutError } from '../native-operation-gate';
import { flattenState } from './_utils';
import { componentYSign, SCH_COORDINATE_SPACE } from './sch-frame';
import {
	COMPONENT_STATE_SETTERS,
	correctedCoordinate,
	mergeOtherProperty,
	NET_FLAG_TITLES,
	NET_PORT_TITLES,
	parseSchNetSymbols,
	pinNetsFromGeometry,
	primitiveIdNumber,
	type SourceNetSymbol,
} from './sch-geometry';

/** Wrap an SDK call so a runaway hang surfaces as a clean error instead
 *  of leaving the WebSocket frame stuck pending. Modal dialogs (multi-part
 *  subPartName prompts), internal locks, and renderer stalls all manifest
 *  as hangs in the EasyEDA Pro SDK without this guard. */
function withSdkTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`SDK call "${label}" did not return within ${ms}ms — likely a modal dialog or runtime stall. Inspect EasyEDA for an open dialog, or retry with a different subPartName.`)), ms);
		promise.then(
			(v) => { clearTimeout(t); resolve(v); },
			(e) => { clearTimeout(t); reject(e); },
		);
	});
}

// === Tracked placement ====================================================
// Placing a part/flag whose project-library device is older than the
// library version opens EasyEDA's modal "Found this device have been
// updated, do you want to update this device first in the project?"
// [Update] [Place] [Cancel], and the SDK call waits on it. There is no API
// to suppress it (only Setting → System → "Placing updated device"). So
// placements run as bounded native operations: on timeout the operation is
// recorded as uncertain (document writes are blocked until
// native_operation_reconcile), because a later click on [Place] still
// creates the primitive — it must not appear untracked.

class PlacementStallError extends Error {}

const PLACEMENT_STALL_HINT = 'EasyEDA is most likely waiting on its "Found this device have been updated… [Update] [Place] [Cancel]" dialog (or another modal). Choose Place or Cancel in EasyEDA, then run native_operation_status / native_operation_reconcile before further edits. To stop the dialog for good: EasyEDA Setting → System → "Placing updated device" → do not show the updated-notice dialog.';

async function placeTracked<T>(label: string, run: () => Promise<T>, ms: number): Promise<T> {
	try {
		return await boundedNativeOperation(label, run, ms);
	} catch (err) {
		if (err instanceof NativeOperationTimeoutError) {
			throw new PlacementStallError(`${label} did not finish within ${Math.round(ms / 1000)}s. ${PLACEMENT_STALL_HINT}`);
		}
		throw err;
	}
}

// === Coordinate frame =====================================================
// All component positions crossing the bridge use the pin/wire frame (see
// sch-frame.ts). `coordinateFrame: "api"` opts out for raw EasyEDA values.

function isRawFrame(params: Record<string, any>): boolean {
	return params?.coordinateFrame === 'api';
}

/** Flatten a component primitive and express its Y in the canvas frame. */
function componentToCanvas(inst: any, ySign: 1 | -1): any {
	if (!inst || typeof inst !== 'object') return inst;
	const flat = flattenState(inst);
	if (typeof flat.y === 'number') flat.y = ySign * flat.y;
	flat.coordinateSpace = SCH_COORDINATE_SPACE;
	return flat;
}

async function componentsToCanvas(result: any, params: Record<string, any>): Promise<any> {
	const ySign = await componentYSign(isRawFrame(params));
	if (Array.isArray(result)) return result.map((c) => componentToCanvas(c, ySign));
	return componentToCanvas(result, ySign);
}

// === Net flags / net ports ================================================
// EasyEDA resolves the flag/port symbol itself (from the system library by
// device title — "Ground-GND", "Netport-OUT", ...) as long as nobody has
// overridden it. Older builds of this extension forced hard-coded symbol
// UUIDs through setNetFlagComponentUuid_*; that setter validates the device
// with a library lookup, and for UUIDs this EasyEDA build does not know it
// throws "获取器件详情失败" (failed to get device details) before anything is
// placed. So: use EasyEDA's default first, and only on failure look the
// symbol up in the system library by title.

type NetSymbolKind = 'netflag' | 'netport';

const NET_FLAG_SETTERS: Record<string, (c: any) => Promise<boolean>> = {
	Power: (c) => eda.sch_PrimitiveComponent.setNetFlagComponentUuid_Power(c),
	Ground: (c) => eda.sch_PrimitiveComponent.setNetFlagComponentUuid_Ground(c),
	AnalogGround: (c) => eda.sch_PrimitiveComponent.setNetFlagComponentUuid_AnalogGround(c),
	ProtectGround: (c) => eda.sch_PrimitiveComponent.setNetFlagComponentUuid_ProtectGround(c),
};
const NET_PORT_SETTERS: Record<string, (c: any) => Promise<boolean>> = {
	IN: (c) => eda.sch_PrimitiveComponent.setNetPortComponentUuid_IN(c),
	OUT: (c) => eda.sch_PrimitiveComponent.setNetPortComponentUuid_OUT(c),
	BI: (c) => eda.sch_PrimitiveComponent.setNetPortComponentUuid_BI(c),
};

async function findSystemNetSymbols(kind: NetSymbolKind, key: string): Promise<Array<{ libraryUuid: string; uuid: string; name?: string }>> {
	const titles = (kind === 'netflag' ? NET_FLAG_TITLES : NET_PORT_TITLES)[key] ?? [];
	const symbolType = kind === 'netflag' ? 18 : 19; // ELIB_SymbolType.NET_FLAG / NET_PORT
	const libraryUuid = await eda.lib_LibrariesList.getSystemLibraryUuid().catch(() => undefined);
	const found: Array<{ libraryUuid: string; uuid: string; name?: string }> = [];
	for (const title of titles) {
		let hits: any[] = [];
		try {
			hits = (await withSdkTimeout(eda.lib_Device.search(title, libraryUuid, undefined, symbolType as any, 20, 1), 10_000, 'lib_Device.search')) ?? [];
		} catch { continue; }
		const exact = hits.filter((h) => String(h?.name ?? '').toLowerCase() === title.toLowerCase());
		for (const h of [...exact, ...hits]) {
			if (h?.uuid && h?.libraryUuid && !found.some((f) => f.uuid === h.uuid)) found.push({ libraryUuid: h.libraryUuid, uuid: h.uuid, name: h.name });
			if (found.length >= 3) return found;
		}
	}
	return found;
}

async function createNetSymbol(kind: NetSymbolKind, params: Record<string, any>): Promise<any> {
	const key = String(kind === 'netflag' ? params.identification : params.direction);
	const setter = (kind === 'netflag' ? NET_FLAG_SETTERS : NET_PORT_SETTERS)[key];
	if (!setter) {
		throw new Error(kind === 'netflag'
			? `Unknown net flag identification "${key}" (use Power, Ground, AnalogGround or ProtectGround).`
			: `Unknown net port direction "${key}" (use IN, OUT or BI).`);
	}
	if (typeof params.net !== 'string' || !params.net || typeof params.x !== 'number' || typeof params.y !== 'number') {
		throw new Error(`${kind === 'netflag' ? 'sch_create_net_flag' : 'sch_create_net_port'} requires net, x and y.`);
	}
	const ySign = await componentYSign(isRawFrame(params));
	const apiY = ySign * params.y;
	// Stay inside the caller's deadline: if this handler outlives it, the
	// extension's gate quarantines the document (reconciliation-required).
	const deadline = Date.now() + Math.max(8_000, (Number(params._timeoutMs) || 30_000) - 5_000);
	const left = () => deadline - Date.now();
	const stepMs = (cap: number) => Math.max(1_000, Math.min(cap, left() - 1_000));
	const create = () => placeTracked<any>(
		kind === 'netflag' ? 'sch_PrimitiveComponent.createNetFlag' : 'sch_PrimitiveComponent.createNetPort',
		() => (kind === 'netflag'
			? eda.sch_PrimitiveComponent.createNetFlag(key as any, params.net, params.x, apiY, params.rotation, params.mirror)
			: eda.sch_PrimitiveComponent.createNetPort(key as any, params.net, params.x, apiY, params.rotation, params.mirror)) as Promise<any>,
		stepMs(15_000),
	);
	const done = (created: any, via: string) => ({ ...componentToCanvas(created, ySign), symbolSource: via });

	if (params.component) {
		await withSdkTimeout(setter(params.component), stepMs(10_000), `set ${kind} symbol`);
		const created = await create();
		if (!created) throw new Error(`EasyEDA returned no ${kind} for the supplied component override.`);
		return done(created, 'override');
	}

	const errors: string[] = [];
	// 1. The library device already used by a symbol with this net name on
	//    the page (e.g. this project's own GND flag), placed by borrowing
	//    EasyEDA's default-symbol slot for one call and restoring it — no
	//    library lookup, which is what fails in Half Offline mode.
	try {
		const recs = await readSourceNetSymbols();
		const same = recs.find((r) => r.deviceUuid && String(r.name ?? '').toUpperCase() === String(params.net).toUpperCase());
		if (same?.deviceUuid && left() > 3_000) {
			const created = await placeWithDevice(kind, key, { uuid: same.deviceUuid }, () => create());
			if (created) return done(created, `page-device:${same.id}`);
			errors.push(`device of ${same.id}: EasyEDA returned nothing`);
		}
	} catch (err: any) {
		if (err instanceof PlacementStallError) throw err;
		errors.push(`page device: ${err?.message ?? err}`);
	}
	// 2. EasyEDA's own default symbol.
	if (left() > 3_000) {
		try {
			const created = await create();
			if (created) return done(created, 'easyeda-default');
			errors.push('default symbol: EasyEDA returned nothing');
		} catch (err: any) {
			if (err instanceof PlacementStallError) throw err;
			errors.push(`default symbol: ${err?.message ?? err}`);
		}
	}
	// 3. System library search by title (slow; only with time to spare).
	if (left() > 12_000) {
		for (const candidate of await findSystemNetSymbols(kind, key)) {
			if (left() < 5_000) break;
			try {
				const created = await placeWithDevice(kind, key, candidate, () => create());
				if (created) return done(created, `system-library:${candidate.name ?? candidate.uuid}`);
				errors.push(`${candidate.name ?? candidate.uuid}: EasyEDA returned nothing`);
			} catch (err: any) {
				if (err instanceof PlacementStallError) throw err;
				errors.push(`${candidate.name ?? candidate.uuid}: ${err?.message ?? err}`);
			}
		}
	}
	throw new Error(`Could not create ${kind} "${key}" for net ${params.net}. Tried: ${errors.join(' | ') || 'nothing (time budget exhausted)'}. Nothing was placed. Pass an explicit \`component\` {libraryUuid, uuid}, or place one symbol of this net in the GUI so later calls reuse its device.`);
}

/**
 * Run `create` with EasyEDA's default symbol for (kind, key) temporarily set
 * to `device`, then restore the previous value (never leaves an override
 * behind, unlike setNetFlagComponentUuid_*).
 */
async function placeWithDevice(kind: NetSymbolKind, key: string, device: { uuid: string; libraryUuid?: string }, create: () => Promise<any>): Promise<any> {
	const api = eda.sch_PrimitiveComponent as any;
	const slot = kind === 'netflag' ? `netFlagComponentUuid_${key}` : `netPortComponentUuid_${key}`;
	if (!(slot in api)) throw new Error(`EasyEDA does not expose ${slot}`);
	const saved = api[slot];
	api[slot] = { uuid: device.uuid, libraryUuid: device.libraryUuid || saved?.libraryUuid || api.defaultLibraryUuid };
	try {
		return await create();
	} finally {
		api[slot] = saved;
	}
}

// EasyEDA Pro 2.2's sch_PrimitiveComponent.getAll('netflag'|'netport') and
// get(id) run every record through a converter that reads multi-part and
// footprint data net flags/ports do not have, so they throw ("获取所有器件失败")
// and the old handler's catch turned that into []. getAllPrimitiveId() is a
// raw id lookup (no conversion) and the live document source carries each
// symbol's position and net name, so enumerate from those instead.

async function netSymbolIdKinds(allPages = false): Promise<Map<string, NetSymbolKind>> {
	const kinds = new Map<string, NetSymbolKind>();
	for (const kind of ['netflag', 'netport'] as NetSymbolKind[]) {
		try {
			const ids: string[] = (await withSdkTimeout<any>((eda.sch_PrimitiveComponent as any).getAllPrimitiveId(kind, allPages), 10_000, 'getAllPrimitiveId')) ?? [];
			for (const id of ids) {
				const num = primitiveIdNumber(id);
				if (num) kinds.set(num, kind);
			}
		} catch { /* reported by the caller when nothing is found */ }
	}
	return kinds;
}

async function readSourceNetSymbols(): Promise<SourceNetSymbol[]> {
	const source = await withSdkTimeout<any>(eda.sys_FileManager.getDocumentSource() as Promise<any>, 15_000, 'sys_FileManager.getDocumentSource');
	if (typeof source !== 'string' || !source) throw new Error('EasyEDA returned no document source for the active schematic page.');
	return parseSchNetSymbols(source);
}

function sourceSymbolToCanvas(r: SourceNetSymbol, kind: NetSymbolKind | 'unknown', ySign: 1 | -1) {
	return {
		primitiveId: r.id,
		componentType: kind,
		net: r.name,
		x: r.x,
		y: ySign * r.y,
		rotation: r.rotation,
		mirror: r.mirror,
		deviceUuid: r.deviceUuid,
		coordinateSpace: SCH_COORDINATE_SPACE,
	};
}

/**
 * Net flags + net ports on the active page. Three independent strategies;
 * the result records what each one saw so an empty answer is never silent:
 *   A. typed getAll('netflag'|'netport')        — fails on EasyEDA Pro 2.2
 *   B. raw getAllPrimitiveId(kind) + per-id get  — ids are reliable, get may throw
 *   C. live page source (sys_FileManager.getDocumentSource) parsed for
 *      COMPONENT records with empty part name, no Designator/Footprint + Name
 * Records from C are kept even when B cannot classify them (kind "unknown"),
 * because on some builds B returns ids in a form that does not match.
 */
async function collectNetSymbols(params: Record<string, any>, wanted: NetSymbolKind[]): Promise<{ items: any[]; diagnostics: Record<string, any> }> {
	const allPages = params.allSchematicPages === true;
	const ySign = await componentYSign(isRawFrame(params));
	const byNum = new Map<string, any>();
	const d: Record<string, any> = { ySign, wanted, strategies: {} };
	const errMsg = (e: any) => String(e?.message ?? e);

	// A. typed getAll
	const a: Record<string, any> = {};
	for (const kind of wanted) {
		try {
			const list: any[] = (await withSdkTimeout<any>(eda.sch_PrimitiveComponent.getAll(kind as any, allPages) as Promise<any>, 10_000, `getAll(${kind})`)) ?? [];
			a[kind] = { returned: list.length };
			for (const inst of list) {
				const flat = flattenState(inst);
				const num = primitiveIdNumber(flat.primitiveId);
				if (!num || byNum.has(num)) continue;
				byNum.set(num, {
					primitiveId: flat.primitiveId, componentType: kind, net: flat.net ?? flat.name,
					x: flat.x, y: typeof flat.y === 'number' ? ySign * flat.y : flat.y,
					rotation: flat.rotation, mirror: flat.mirror, via: 'getAll', coordinateSpace: SCH_COORDINATE_SPACE,
				});
			}
		} catch (err) {
			a[kind] = { error: errMsg(err) };
		}
	}
	d.strategies.typedGetAll = a;

	// B. raw ids per kind (+ per-id get)
	const kinds = new Map<string, NetSymbolKind>();
	const b: Record<string, any> = {};
	for (const kind of ['netflag', 'netport'] as NetSymbolKind[]) {
		try {
			const ids: any[] = (await withSdkTimeout<any>((eda.sch_PrimitiveComponent as any).getAllPrimitiveId(kind, allPages), 10_000, 'getAllPrimitiveId')) ?? [];
			b[kind] = { count: ids.length, sample: ids.slice(0, 3) };
			for (const id of ids) {
				const num = primitiveIdNumber(id);
				if (num) kinds.set(num, kind);
			}
			if (!wanted.includes(kind)) continue;
			let got = 0; let failed = 0; let firstError: string | undefined;
			for (const id of ids.slice(0, 200)) {
				const num = primitiveIdNumber(id);
				if (!num || byNum.has(num)) continue;
				try {
					const inst: any = await withSdkTimeout<any>(eda.sch_PrimitiveComponent.get(String(id)) as Promise<any>, 5_000, 'get');
					const one = Array.isArray(inst) ? inst[0] : inst;
					if (!one) { failed += 1; continue; }
					const flat = flattenState(one);
					byNum.set(num, {
						primitiveId: flat.primitiveId ?? id, componentType: kind, net: flat.net ?? flat.name,
						x: flat.x, y: typeof flat.y === 'number' ? ySign * flat.y : flat.y,
						rotation: flat.rotation, mirror: flat.mirror, via: 'getAllPrimitiveId+get', coordinateSpace: SCH_COORDINATE_SPACE,
					});
					got += 1;
				} catch (err) {
					failed += 1;
					firstError ??= errMsg(err);
				}
			}
			Object.assign(b[kind], { getOk: got, getFailed: failed, getError: firstError });
		} catch (err) {
			b[kind] = { error: errMsg(err) };
		}
	}
	d.strategies.rawIds = b;

	// C. live page source — fills in anything A/B could not read (net names
	// and positions of ids whose get() failed, or everything if ids failed).
	const c: Record<string, any> = {};
	try {
		const source: any = await withSdkTimeout<any>(eda.sys_FileManager.getDocumentSource() as Promise<any>, 15_000, 'sys_FileManager.getDocumentSource');
		c.sourceType = typeof source;
		const text = typeof source === 'string' ? source : '';
		c.sourceLength = text.length;
		c.sourceHead = text.slice(0, 60);
		c.componentLines = (text.match(/^\["COMPONENT"/gm) ?? []).length;
		const records = parseSchNetSymbols(text);
		c.recordsParsed = records.length;
		let matchedIds = 0; let added = 0; let filtered = 0;
		for (const r of records) {
			const kind: NetSymbolKind | 'unknown' = kinds.get(r.num) ?? 'unknown';
			if (kind !== 'unknown') matchedIds += 1;
			if (kind !== 'unknown' && !wanted.includes(kind)) { filtered += 1; continue; }
			const existing = byNum.get(r.num);
			if (existing) {
				existing.net ??= r.name;
				existing.deviceUuid ??= r.deviceUuid;
				continue;
			}
			byNum.set(r.num, { ...sourceSymbolToCanvas(r, kind, ySign), via: 'document-source' });
			added += 1;
		}
		Object.assign(c, { matchedRawIds: matchedIds, added, filteredByKind: filtered });
	} catch (err) {
		c.error = errMsg(err);
	}
	d.strategies.documentSource = c;
	d.found = byNum.size;
	return { items: [...byNum.values()], diagnostics: d };
}

async function listNetSymbols(params: Record<string, any>, wanted: NetSymbolKind[]): Promise<any[]> {
	return (await collectNetSymbols(params, wanted)).items;
}

/**
 * Move / rotate / mirror / rename a net flag or net port. EasyEDA's modify()
 * refuses them and its get() cannot read them, so place an identical symbol
 * (same library device, same net unless renamed) at the target, and only
 * then delete the original — a failure leaves the original untouched. The
 * primitive ID changes; the result reports both.
 */
async function modifyNetSymbol(primitiveId: string, kind: NetSymbolKind, prop: Record<string, any>, ySign: 1 | -1): Promise<any> {
	const num = primitiveIdNumber(primitiveId);
	const rec = (await readSourceNetSymbols()).find((r) => r.num === num);
	if (!rec) throw new Error(`${kind} ${primitiveId} not found in the active schematic page source. Open its page first.`);
	const net = prop.net ?? rec.name;
	if (!net) throw new Error(`${kind} ${primitiveId} has no net name; pass \`net\`.`);
	const apiX = prop.x !== undefined ? Number(prop.x) : rec.x;
	const apiY = prop.y !== undefined ? ySign * Number(prop.y) : rec.y;
	const rotation = prop.rotation !== undefined ? Number(prop.rotation) : rec.rotation;
	const mirror = prop.mirror !== undefined ? !!prop.mirror : rec.mirror;
	const unsupported = Object.keys(prop).filter((k) => !['x', 'y', 'rotation', 'mirror', 'net', 'name'].includes(k) && prop[k] !== undefined);
	if (unsupported.length) throw new Error(`Net flags/ports only support x, y, rotation, mirror and net (got ${unsupported.join(', ')}).`);
	if (apiX === rec.x && apiY === rec.y && rotation === rec.rotation && mirror === rec.mirror && net === rec.name) {
		return { ...sourceSymbolToCanvas(rec, kind, ySign), modified: false, note: 'Nothing to change.' };
	}
	if (!rec.deviceUuid) throw new Error(`${kind} ${primitiveId} has no library device reference; cannot re-place it identically.`);

	// Borrow EasyEDA's default-symbol slot for this one placement so the new
	// symbol uses the original's exact library device, then restore it.
	const api = eda.sch_PrimitiveComponent as any;
	const slot = kind === 'netflag' ? 'netFlagComponentUuid_Ground' : 'netPortComponentUuid_OUT';
	if (!(slot in api)) throw new Error('This EasyEDA build does not expose the net symbol slot; delete and re-create the symbol with sch_create_net_flag / sch_create_net_port instead.');
	const saved = api[slot];
	const libraryUuid = saved?.libraryUuid || api.defaultLibraryUuid || await eda.lib_LibrariesList.getSystemLibraryUuid().catch(() => undefined);
	let created: any;
	api[slot] = { uuid: rec.deviceUuid, libraryUuid };
	try {
		// create() negates rotation internally; pass the negation so the stored
		// rotation equals the value reported by the listing.
		created = await placeTracked<any>(
			`re-place ${kind}`,
			() => (kind === 'netflag'
				? eda.sch_PrimitiveComponent.createNetFlag('Ground', net, apiX, apiY, -rotation, mirror)
				: eda.sch_PrimitiveComponent.createNetPort('OUT', net, apiX, apiY, -rotation, mirror)) as Promise<any>,
			15_000,
		);
	} finally {
		api[slot] = saved;
	}
	const newId = created?.getState_PrimitiveId?.() ?? created?.primitiveId;
	if (!newId) throw new Error(`EasyEDA did not place the replacement ${kind}; the original ${primitiveId} is unchanged.`);
	const deleted = await withSdkTimeout<any>(eda.sch_PrimitiveComponent.delete(primitiveId), 10_000, 'sch_PrimitiveComponent.delete');
	return {
		modified: true,
		replaced: true,
		oldPrimitiveId: primitiveId,
		primitiveId: newId,
		componentType: kind,
		net,
		x: apiX,
		y: ySign * apiY,
		rotation,
		mirror,
		coordinateSpace: SCH_COORDINATE_SPACE,
		warnings: deleted ? undefined : [`The replacement ${newId} was placed but deleting the original ${primitiveId} failed — delete it with sch_delete_component.`],
	};
}

// === Modify (parts, net flags, net ports) =================================
// sch_PrimitiveComponent.modify() cannot be used as-is on EasyEDA Pro 2.2.x:
// it fills an omitted supplierId from getState_SubPartName() (so "C7496597"
// became "FQP17P06.1"), blanks every otherProperty the caller did not
// re-send, and refuses net flags/ports. Instead fetch the live primitive,
// change only the requested fields, re-send the complete property set via
// done(), then read back and correct any position drift (rotation + mirror
// has been seen to negate X).

const PRESERVED_TEXT_FIELDS = ['designator', 'name', 'uniqueId', 'manufacturer', 'manufacturerId', 'supplier', 'supplierId'] as const;

function snapshotComponent(inst: any) {
	const g = (name: string) => { try { return inst?.[`getState_${name}`]?.(); } catch { return undefined; } };
	return {
		componentType: g('ComponentType'),
		x: g('X'), y: g('Y'), rotation: g('Rotation'), mirror: g('Mirror'),
		designator: g('Designator'), name: g('Name'), uniqueId: g('UniqueId'),
		manufacturer: g('Manufacturer'), manufacturerId: g('ManufacturerId'),
		supplier: g('Supplier'), supplierId: g('SupplierId'), net: g('Net'),
		otherProperty: g('OtherProperty'),
	};
}

async function fetchComponent(primitiveId: string): Promise<any> {
	const inst: any = await withSdkTimeout<any>(eda.sch_PrimitiveComponent.get(primitiveId) as Promise<any>, 10_000, 'sch_PrimitiveComponent.get');
	const one = Array.isArray(inst) ? inst[0] : inst;
	if (!one) throw new Error(`Schematic component ${primitiveId} not found on the active page.`);
	return one;
}

async function modifyComponent(params: Record<string, any>): Promise<any> {
	const primitiveId = String(params.primitiveId ?? '');
	if (!primitiveId) throw new Error('sch_modify_component requires primitiveId.');
	const prop: Record<string, any> = { ...(params.property ?? {}) };
	const ySign = await componentYSign(isRawFrame(params));

	// Net flags/ports: identified by the raw id lists, by get() reporting
	// their type, or — when get() cannot read them (EasyEDA Pro 2.2) — by
	// being a flag/port record in the page source. The re-place path does not
	// depend on flag-vs-port (EasyEDA places whatever the library device is).
	const num = primitiveIdNumber(primitiveId) ?? '';
	let netKind: NetSymbolKind | undefined = (await netSymbolIdKinds(false)).get(num);
	let inst: any;
	let getError: unknown;
	if (!netKind) {
		try {
			inst = await fetchComponent(primitiveId);
			const t = inst?.getState_ComponentType?.();
			if (t === 'netflag' || t === 'netport') netKind = t;
		} catch (err) {
			getError = err;
		}
	}
	if (!netKind && !inst) {
		const recs = await readSourceNetSymbols().catch(() => [] as SourceNetSymbol[]);
		if (recs.some((r) => r.num === num)) netKind = 'netflag';
	}
	if (netKind) return modifyNetSymbol(primitiveId, netKind, prop, ySign);
	if (!inst) throw getError instanceof Error ? getError : new Error(String(getError));
	const before = snapshotComponent(inst);
	const isNetSymbol = before.componentType === 'netflag' || before.componentType === 'netport';

	// Target state in the API frame.
	const target: Record<string, any> = { ...before };
	for (const key of Object.keys(COMPONENT_STATE_SETTERS)) {
		if (prop[key] === undefined) continue;
		// null = "leave empty" (EasyEDA semantics) and is passed through.
		target[key] = key === 'y' ? ySign * Number(prop.y) : prop[key];
	}
	if (isNetSymbol && prop.net !== undefined) target.name = prop.net; // flags carry their net in Name

	const apply = async (instance: any, t: Record<string, any>) => {
		for (const [key, setter] of Object.entries(COMPONENT_STATE_SETTERS)) {
			if (key === 'net' && !isNetSymbol) continue;
			if (t[key] === undefined && !(key in prop)) continue;
			if (typeof instance[setter] === 'function') instance[setter](t[key]);
		}
		if (typeof instance.setState_OtherProperty === 'function') {
			instance.setState_OtherProperty(mergeOtherProperty(before.otherProperty, prop.otherProperty));
		}
		await withSdkTimeout(instance.done(), 10_000, 'sch component done()');
	};

	await apply(inst, target);
	let after = snapshotComponent(await fetchComponent(primitiveId));
	const corrections: string[] = [];

	// Position drift: re-issue with corrected coordinates once.
	const fixX = correctedCoordinate(target.x, target.x, after.x);
	const fixY = correctedCoordinate(target.y, target.y, after.y);
	const textDrift = PRESERVED_TEXT_FIELDS.filter((f) => (target[f] ?? '') !== (after[f] ?? ''));
	if (fixX !== undefined || fixY !== undefined || textDrift.length) {
		const second = await fetchComponent(primitiveId);
		const t2 = { ...target, x: fixX ?? target.x, y: fixY ?? target.y };
		await apply(second, t2);
		after = snapshotComponent(await fetchComponent(primitiveId));
		if (fixX !== undefined) corrections.push(`EasyEDA moved x to ${after.x === target.x ? after.x : 'another value'} on the first write; re-sent as ${fixX}`);
		if (fixY !== undefined) corrections.push(`EasyEDA moved y on the first write; re-sent`);
		if (textDrift.length) corrections.push(`restored ${textDrift.join(', ')}`);
	}

	const posOk = correctedCoordinate(target.x, target.x, after.x) === undefined && correctedCoordinate(target.y, target.y, after.y) === undefined;
	const stillDrifted = PRESERVED_TEXT_FIELDS.filter((f) => (target[f] ?? '') !== (after[f] ?? ''));
	if (!posOk) {
		throw new Error(`sch_modify_component: EasyEDA moved ${primitiveId} to (${after.x}, ${ySign * after.y}) instead of (${target.x}, ${ySign * target.y}) and the correction did not hold. Check the part in the editor (undo with Ctrl+Z if needed).`);
	}
	const canvas = componentToCanvas(await fetchComponent(primitiveId), ySign);
	return {
		...canvas,
		modified: true,
		corrections: corrections.length ? corrections : undefined,
		warnings: stillDrifted.length ? [`EasyEDA changed ${stillDrifted.join(', ')} and it could not be restored`] : undefined,
	};
}

export const schComponentHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'sch.component.create': async (params) => {
		const ySign = await componentYSign(isRawFrame(params));
		const result = await placeTracked<any>(
			'sch_PrimitiveComponent.create',
			() => (eda.sch_PrimitiveComponent as any).create(
				params.component,
				params.x,
				ySign * params.y,
				params.subPartName,
				params.rotation,
				params.mirror,
				params.addIntoBom,
				params.addIntoPcb,
			),
			Math.max(5_000, (Number(params._timeoutMs) || 30_000) - 5_000),
		);
		if (!result) {
			throw new Error('sch.component.create returned null — most common cause: multi-part component placed without `subPartName`, or a designator/uniqueId conflict. Pass an explicit subPartName like "U1.A".');
		}
		return componentToCanvas(result, ySign);
	},

	'sch.component.createNetFlag': async (params) => {
		if (Array.isArray(params.batch)) {
			const results = [];
			const batchDeadline = Date.now() + (Number(params._timeoutMs) || 60_000) - 3_000;
			for (const item of params.batch) {
				const remaining = batchDeadline - Date.now();
				if (remaining < 8_000) { results.push({ error: 'Skipped: batch time budget exhausted (nothing placed).', request: item }); continue; }
				try {
					results.push(await createNetSymbol('netflag', { coordinateFrame: params.coordinateFrame, ...item, _timeoutMs: remaining }));
				} catch (err: any) {
					results.push({ error: err?.message ?? String(err), request: item });
					if (err instanceof PlacementStallError) break;
				}
			}
			return results;
		}
		return createNetSymbol('netflag', params);
	},

	'sch.component.createNetPort': async (params) => {
		if (Array.isArray(params.batch)) {
			const results = [];
			const batchDeadline = Date.now() + (Number(params._timeoutMs) || 60_000) - 3_000;
			for (const item of params.batch) {
				const remaining = batchDeadline - Date.now();
				if (remaining < 8_000) { results.push({ error: 'Skipped: batch time budget exhausted (nothing placed).', request: item }); continue; }
				try {
					results.push(await createNetSymbol('netport', { coordinateFrame: params.coordinateFrame, ...item, _timeoutMs: remaining }));
				} catch (err: any) {
					results.push({ error: err?.message ?? String(err), request: item });
					if (err instanceof PlacementStallError) break;
				}
			}
			return results;
		}
		return createNetSymbol('netport', params);
	},

	// Works for parts, net flags and net ports alike (all are components).
	'sch.component.delete': async (params) => {
		return withSdkTimeout(eda.sch_PrimitiveComponent.delete(params.ids), 10_000, 'sch_PrimitiveComponent.delete');
	},

	'sch.component.modify': async (params) => modifyComponent(params),

	'sch.component.get': async (params) => {
		try {
			return componentsToCanvas(await eda.sch_PrimitiveComponent.get(params.primitiveIds), params);
		} catch (err) {
			// get() cannot read net flags/ports on EasyEDA Pro 2.2 — answer
			// those from the document source instead.
			const ids: string[] = Array.isArray(params.primitiveIds) ? params.primitiveIds : [params.primitiveIds];
			const wanted = new Set(ids.map((id) => primitiveIdNumber(id)));
			const found = (await listNetSymbols(params, ['netflag', 'netport'])).filter((i) => wanted.has(primitiveIdNumber(i.primitiveId)));
			if (!found.length) throw err;
			return Array.isArray(params.primitiveIds) ? found : found[0];
		}
	},

	'sch.component.getAll': async (params) => {
		// Default to 'part' — without a componentType filter the runtime returns
		// every primitive on the page (parts, netflags, netports, junctions, …).
		const componentType = params.componentType ?? 'part';
		if (componentType === 'netflag' || componentType === 'netport') {
			return listNetSymbols(params, [componentType]);
		}
		return componentsToCanvas(await eda.sch_PrimitiveComponent.getAll(componentType, params.allSchematicPages), params);
	},

	'sch.component.listNetSymbols': async (params) => {
		const kinds: NetSymbolKind[] = params.kind === 'netflag' || params.kind === 'netport' ? [params.kind] : ['netflag', 'netport'];
		const { items: all, diagnostics } = await collectNetSymbols(params, kinds);
		let items = all;
		if (typeof params.net === 'string' && params.net) {
			const want = params.net.toUpperCase();
			items = items.filter((i) => String(i.net ?? '').toUpperCase() === want);
			diagnostics.afterNetFilter = items.length;
		}
		// Envelope shape ({items,total}) survives the bridge's fields/limit
		// post-processing. Diagnostics ride along when asked for or when the
		// answer is empty, so "nothing found" is always explained.
		const withDiag = params.diagnostics === true || items.length === 0;
		return { total: items.length, items, ...(withDiag ? { diagnostics } : {}) };
	},


	'sch.component.getAllPins': async (params) => {
		const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(params.primitiveId);
		if (!Array.isArray(pins) || pins.length === 0) return pins;

		// Look up the component's uniqueId, then find its nets in the netlist
		const rawComp: any = await eda.sch_PrimitiveComponent.get(params.primitiveId);
		const comp = Array.isArray(rawComp) ? rawComp[0] : rawComp;
		if (!comp?.uniqueId) return pins;

		const netlist = await fetchParsedNetlist();
		const netEntry = netlist[comp.uniqueId];
		if (!netEntry) return pins;

		return pins.map((pin: any) => ({
			...pin,
			net: netEntry.pins[String(pin.pinNumber)] ?? '',
		}));
	},

	// === Pin lookup by designator + pin number ===
	// Critical helper for "wire pin A to pin B" workflows. Resolves a pin
	// reference like {designator: "U3", pinNumber: "3"} (or "EN") to its
	// schematic-page coordinates plus net assignment. Walks all components
	// on the active page; pinNumber matches against both the numeric pin
	// number and the human-readable pin name (so "EN" works as well as "3").
	'sch.component.findPin': async (params) => {
		const designator: string = String(params.designator);
		const pinKey = String(params.pinNumber ?? params.pin ?? '');
		if (!designator || !pinKey) {
			throw new Error('sch_get_pin_position requires both `designator` and `pinNumber` (or `pin`).');
		}

		const designatorOf = (c: any): string | undefined => {
			try { if (typeof c?.getState_Designator === 'function') return c.getState_Designator(); } catch {/* */}
			return c?.designator;
		};
		const idOf = (c: any): string | undefined => {
			try { if (typeof c?.getState_PrimitiveId === 'function') return c.getState_PrimitiveId(); } catch {/* */}
			return c?.primitiveId;
		};
		const numberOf = (p: any): string | undefined => {
			try { if (typeof p?.getState_PinNumber === 'function') return String(p.getState_PinNumber()); } catch {/* */}
			return p?.pinNumber != null ? String(p.pinNumber) : undefined;
		};
		const nameOf = (p: any): string | undefined => {
			try { if (typeof p?.getState_PinName === 'function') return p.getState_PinName(); } catch {/* */}
			return p?.pinName ?? p?.name;
		};
		const xyOf = (p: any): { x: number; y: number; rotation?: number } => {
			try {
				const x = typeof p?.getState_X === 'function' ? p.getState_X() : p?.x;
				const y = typeof p?.getState_Y === 'function' ? p.getState_Y() : p?.y;
				const r = typeof p?.getState_Rotation === 'function' ? p.getState_Rotation() : p?.rotation;
				return { x, y, rotation: r };
			} catch {
				return { x: p?.x ?? 0, y: p?.y ?? 0 };
			}
		};

		const components = await (eda.sch_PrimitiveComponent as any).getAll('part', true).catch(() => []);
		const target = (components || []).find((c: any) => designatorOf(c) === designator);
		if (!target) {
			// EasyEDA's getAll('part', true) silently returns only the active page in
			// current builds, so cross-page designators look "missing". Cross-check
			// against the project-wide netlist to give an actionable error.
			let projectWideMatch: string | undefined;
			try {
				const netlist = await fetchParsedNetlist();
				for (const [uniqueId, entry] of Object.entries(netlist)) {
					if ((entry as any)?.designator === designator) { projectWideMatch = uniqueId; break; }
				}
			} catch { /* netlist may fail; fall through to default error */ }
			if (projectWideMatch) {
				throw new Error(`Component "${designator}" exists in the project but is on a different schematic page (uniqueId ${projectWideMatch}). Switch to that page first via editor_open_document, then retry. Cross-page pin lookup isn't supported — current EasyEDA Pro builds only expose components on the active page.`);
			}
			throw new Error(`Component "${designator}" not found in the project. Verify the designator and that the schematic is the active tab.`);
		}
		const targetId = idOf(target);
		if (!targetId) {
			throw new Error(`Could not resolve primitiveId for component "${designator}".`);
		}
		const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(targetId);
		const matched = (pins || []).find((p: any) => numberOf(p) === pinKey || nameOf(p) === pinKey);
		if (!matched) {
			const available = (pins || []).map((p: any) => `${numberOf(p)}${nameOf(p) ? `(${nameOf(p)})` : ''}`).join(', ');
			throw new Error(`Pin "${pinKey}" not found on ${designator}. Available pins: ${available}`);
		}

		const { x, y, rotation } = xyOf(matched);
		// Get the net via the parsed netlist (project-wide truth)
		const netlist = await fetchParsedNetlist().catch(() => ({} as any));
		const uniqueId = (target as any).getState_UniqueId?.() ?? (target as any).uniqueId;
		let net: string | undefined = uniqueId && netlist[uniqueId]?.pins[numberOf(matched) as string];
		let netSource = net ? 'netlist' : undefined;
		if (!net) {
			// The netlist reflects the last saved state; a part added/renamed
			// since then is missing from it. Read the pin's net from live wires
			// and net flags/ports instead.
			try {
				const wires = ((await eda.sch_PrimitiveWire.getAll()) ?? []).map((w: any) => ({ line: w.getState_Line?.() ?? w.line, net: w.getState_Net?.() ?? w.net }));
				let labels: Array<{ x: number; y: number; net: string }> = [];
				try {
					const src = await eda.sys_FileManager.getDocumentSource();
					const ySign = await componentYSign();
					labels = parseSchNetSymbols(String(src ?? '')).filter((r) => r.name).map((r) => ({ x: r.x, y: ySign * r.y, net: r.name as string }));
				} catch { /* no flags */ }
				const geo = pinNetsFromGeometry([{ number: String(numberOf(matched)), x: Number(x), y: Number(y) }], wires, labels);
				const g = geo[String(numberOf(matched))];
				if (g?.net) { net = g.net; netSource = 'geometry'; }
			} catch { /* leave empty */ }
		}

		return {
			designator,
			pinNumber: numberOf(matched),
			pinName: nameOf(matched),
			x,
			y,
			rotation,
			net: net ?? '',
			netSource,
			componentPrimitiveId: targetId,
			pinPrimitiveId: idOf(matched),
		};
	},

	// Batch component creation. Same shape as createNetFlag/createNetPort —
	// each entry is forwarded sequentially to eda.sch_PrimitiveComponent.create.
	// Returns an array of {primitiveId|null, error?} so callers can see which
	// placements succeeded.
	'sch.component.createBatch': async (params) => {
		const items = Array.isArray(params.batch) ? params.batch : [];
		if (items.length === 0) {
			throw new Error('sch.component.createBatch requires `batch: [{component, x, y, ...}, ...]`.');
		}
		const results: Array<{ index: number; designator?: string; primitiveId?: string; error?: string }> = [];
		const ySign = await componentYSign(isRawFrame(params));
		for (let i = 0; i < items.length; i++) {
			const item: any = items[i];
			try {
				const created = await placeTracked<any>(
					`sch_PrimitiveComponent.create (batch item ${i})`,
					() => eda.sch_PrimitiveComponent.create(
						item.component,
						item.x,
						ySign * item.y,
						item.subPartName,
						item.rotation,
						item.mirror,
						item.addIntoBom,
						item.addIntoPcb,
					) as Promise<any>,
					20_000,
				);
				const c: any = created;
				results.push({
					index: i,
					designator: c?.getState_Designator?.() ?? c?.designator,
					primitiveId: c?.getState_PrimitiveId?.() ?? c?.primitiveId,
				});
			} catch (err: any) {
				results.push({ index: i, error: err?.message ?? String(err) });
				// Later items would only hit the quarantine; stop here.
				if (err instanceof PlacementStallError) break;
			}
		}
		return {
			placed: results.filter((r) => r.primitiveId).length,
			requested: items.length,
			results,
		};
	},
};
