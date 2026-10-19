// pcb.extract.design — normalized PCB snapshot. Mirror of sch-extract.ts.
//
// One round-trip yields everything PCB-side analyzers need (cross-analysis,
// PCB EMC rules, DFM, decoupling-proximity, ground-plane continuity) without
// a dozen separate API calls.
//
// Heavy: components, pads, net membership, layer stack, pour/track/via
// counts. Track listings are NOT included by default (potentially 10K+
// entries) — the consumer can fetch per-net via `pcb.getAll.line` if needed.

import { mapWithConcurrency } from './_utils';
import { normalizeHoleShapeToMil, normalizePadShapeToMil } from './trace-obstacles';
import { componentPinScale } from './pin-units';

const PCB_FETCH_CONCURRENCY = 16;

interface ProjectInfo { name?: string; uuid?: string }
interface DocumentInfo { uuid?: string; name?: string; type?: string }

interface PadInfo {
	designator: string;
	padNumber: string;
	net: string;
	layer?: string;
	x?: number;
	y?: number;
	pad?: any;
	hole?: any;
}

interface ComponentInfo {
	primitiveId: string;
	designator: string;
	name?: string;
	mpn?: string;
	manufacturer?: string;
	supplier?: string;
	supplierId?: string;
	footprint?: string;
	layer?: string;
	position?: { x: number; y: number; rotation: number; mirror?: boolean };
	pinCount: number;
	otherProperties?: Record<string, any>;
}

interface NetInfo {
	name: string;
	pinCount: number;
	isPower: boolean;
	isGround: boolean;
	autoNamed: boolean;
	members: Array<{ designator: string; padNumber: string }>;
	netLengthMil?: number;
}

interface LayerInfo {
	name: string;
	id?: number | string;
	type?: string;
	visible?: boolean;
}

interface PcbDesignSnapshot {
	project: ProjectInfo;
	document: DocumentInfo;
	componentCount: number;
	netCount: number;
	padCount: number;
	components: Record<string, ComponentInfo>;
	nets: Record<string, NetInfo>;
	pads: PadInfo[];
	/** Units of every pad x/y/pad/hole (once, instead of per pad). Set when pads are listed. */
	padUnits?: 'mil';
	layers: LayerInfo[];
	stats: {
		byLayer: Record<string, { components: number; pads: number; tracks: number; vias: number; pours: number }>;
		nets: { power: number; ground: number; signal: number; autoNamed: number };
		passives: { resistors: number; capacitors: number; inductors: number };
		viaCount: number;
		trackCount: number;
		pourCount: number;
	};
}

const POWER_NET_RE = /^(VCC|VDD|V\+|VIN|VOUT|3V3|5V|1V8|1V2|2V5|VBAT|VBUS|VSYS|VAUX|AVDD|DVDD|VPP)/i;
const GROUND_NET_RE = /^(GND|VSS|0V|AGND|DGND|PGND|EGND|EARTH)/i;

function classifyNet(name: string): { isPower: boolean; isGround: boolean; autoNamed: boolean } {
	const autoNamed = name.startsWith('$') || /^N\d+$/i.test(name);
	if (GROUND_NET_RE.test(name)) return { isPower: false, isGround: true, autoNamed };
	if (POWER_NET_RE.test(name)) return { isPower: true, isGround: false, autoNamed };
	return { isPower: false, isGround: false, autoNamed };
}

function inferDeviceClass(c: ComponentInfo): 'resistor' | 'capacitor' | 'inductor' | null {
	const ref = (c.designator || '').toUpperCase();
	if (/^R\d/.test(ref)) return 'resistor';
	if (/^C\d/.test(ref)) return 'capacitor';
	if (/^L\d/.test(ref)) return 'inductor';
	return null;
}

function getProp(obj: any, ...keys: string[]): any {
	for (const k of keys) {
		const v = obj?.[k];
		if (v !== undefined && v !== null) return v;
	}
	return undefined;
}

function componentPadCoordToMil(pin: any, pinScale: number, ...keys: string[]): number | undefined {
	for (const key of keys) {
		const value = pin?.[key];
		if (typeof value === 'number' && Number.isFinite(value)) return value * pinScale;
	}
	return undefined;
}

function componentPadShapeToMil(pin: any, getter: 'Pad' | 'Hole', key: 'pad' | 'hole'): any {
	let shape: any;
	try {
		const fn = pin?.[`getState_${getter}`];
		if (typeof fn === 'function') shape = fn.call(pin);
	} catch {/* getter threw — fall back to the plain field */}
	if (shape == null) shape = pin?.[key];
	if (!Array.isArray(shape)) return undefined;
	// `pad` extents are already mil; only `hole` extents are 10-mil units.
	return key === 'hole' ? normalizeHoleShapeToMil(shape) : normalizePadShapeToMil(shape);
}

/** Extract a meaningful string from a possibly-nested EasyEDA SDK value.
 *  Handles primitives + the common `{ name, value, title, displayName }`
 *  shapes that the EasyEDA SDK uses for layer/footprint/etc. Returns undefined
 *  when no usable string is available (so `JSON.stringify` won't emit
 *  "[object Object]"). */
function strField(v: any): string | undefined {
	if (v == null) return undefined;
	if (typeof v === 'string') return v.trim() || undefined;
	if (typeof v === 'number') return String(v);
	if (typeof v === 'boolean') return v ? 'true' : 'false';
	if (typeof v === 'object') {
		for (const k of ['name', 'value', 'title', 'displayName', 'label', 'text']) {
			const sub = v[k];
			if (typeof sub === 'string' && sub.trim()) return sub.trim();
		}
		if (typeof v.id === 'string' && v.id.trim()) return v.id.trim();
		if (typeof v.id === 'number') return String(v.id);
		return undefined;
	}
	return String(v);
}

// Props already surfaced as first-class fields (or pure noise) — dropped from
// otherProperties unless `verbose: true`. Ported from sch-extract.ts, except
// Description and Value: a PCB component has no first-class field for them,
// and analyzers read the description.
const NOISE_PROPS = new Set([
	'Datasheet', '3D Model', '3D Model Title', '3D Model Transform',
	'JLCPCB Part Class', 'Add into BOM', 'Convert to PCB',
	'Symbol', 'Footprint', 'Supplier Footprint',
	'Designator', 'Manufacturer', 'Manufacturer Part', 'Supplier', 'Supplier Part',
	'LCSC Part Name', 'Name',
]);
// Default view: short scalar props only (what analyzers and agents read —
// description, tolerance, ratings…). Undefined when nothing survives.
function trimProps(props: Record<string, any>): Record<string, any> | undefined {
	const out: Record<string, any> = {};
	for (const [k, v] of Object.entries(props)) {
		if (NOISE_PROPS.has(k)) continue;
		if (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length > 0 && v.length <= 200)) out[k] = v;
	}
	return Object.keys(out).length ? out : undefined;
}

// The component's custom-parameter bag. The SDK exposes it as
// `otherProperty` ({[key]: string | number | boolean}, see
// IPCB_PrimitiveComponent.getState_OtherProperty); `properties`/`props` are
// kept for other shapes. There is deliberately NO fallback to the raw
// primitive: that leaked SDK bookkeeping (async, primitiveType, nested
// component/footprint objects…) into otherProperties — ~85% of the payload.
function propertyBag(raw: any): Record<string, any> | undefined {
	let bag: any;
	try {
		if (typeof raw?.getState_OtherProperty === 'function') bag = raw.getState_OtherProperty();
	} catch {/* getter threw — fall back to the plain field */}
	if (bag == null) bag = getProp(raw, 'otherProperty', 'properties', 'props');
	return bag && typeof bag === 'object' && !Array.isArray(bag) ? bag : undefined;
}

type NetFilter = Record<string, string | number | boolean | string[]>;

// `filter` on this tool means "restrict to these nets" — the snapshot is a
// keyed object, not an array, so the generic ws-client array filter can't do
// it. Accepted keys are net/netName/name; anything else is ignored here and
// left to the generic post-processing.
function netFilterPredicate(filter: unknown): ((name: string) => boolean) | null {
	if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return null;
	const conditions: Array<string | number | boolean | string[]> = [];
	for (const [key, condition] of Object.entries(filter as NetFilter)) {
		if (['net', 'netname', 'name'].includes(key.toLowerCase())) conditions.push(condition);
	}
	if (conditions.length === 0) return null;
	return (name: string): boolean => {
		for (const condition of conditions) {
			if (Array.isArray(condition)) {
				if (!condition.map(String).includes(name)) return false;
			} else if (typeof condition === 'string' && condition.endsWith('*')) {
				if (!name.startsWith(condition.slice(0, -1))) return false;
			} else if (name !== String(condition)) {
				return false;
			}
		}
		return true;
	};
}

function projectSnapshot(snapshot: PcbDesignSnapshot, fields: unknown): PcbDesignSnapshot | Record<string, any> {
	if (!Array.isArray(fields) || fields.length === 0) return snapshot;
	const out: Record<string, any> = {};
	for (const f of fields) {
		const key = String(f);
		if (key in snapshot) out[key] = (snapshot as unknown as Record<string, any>)[key];
	}
	out._availableFields = Object.keys(snapshot);
	return out;
}

export const pcbExtractHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'pcb.extract.design': async (params): Promise<PcbDesignSnapshot | Record<string, any>> => {
		const includeNetLengths: boolean = params?.includeNetLengths === true;
		// Only gates the flat pad LISTING — net membership and pinCount are
		// always computed, otherwise every net reports pinCount 0.
		const includeAllPads: boolean = params?.includeAllPads === true;
		const netMatches = netFilterPredicate(params?.filter);

		const [projectInfo, docInfo, layers, allComponents] = await Promise.all([
			(eda as any).dmt_Project?.getCurrentProjectInfo?.()?.catch(() => null) ?? null,
			(eda as any).dmt_SelectControl?.getCurrentDocumentInfo?.()?.catch(() => null) ?? null,
			(eda as any).pcb_Layer?.getAllLayers?.()?.catch(() => []) ?? [],
			(eda as any).pcb_PrimitiveComponent?.getAll?.()?.catch(() => []) ?? [],
		]);

		const project: ProjectInfo = {
			name: getProp(projectInfo, 'name', 'projectName'),
			uuid: getProp(projectInfo, 'uuid', 'projectUuid'),
		};
		const document: DocumentInfo = {
			uuid: getProp(docInfo, 'uuid', 'documentUuid', 'currentDocument'),
			name: getProp(docInfo, 'name', 'title'),
			type: getProp(docInfo, 'type', 'documentType'),
		};

		const layerInfos: LayerInfo[] = (Array.isArray(layers) ? layers : []).map((l: any) => ({
			name: strField(getProp(l, 'name', 'layerName')) ?? 'unknown',
			id: strField(getProp(l, 'id', 'layerId')),
			type: strField(getProp(l, 'type', 'layerType')),
			visible: l?.visible === true || l?.isVisible === true,
		}));

		// Build component info with pads (concurrency-limited)
		const components: Record<string, ComponentInfo> = {};
		const pads: PadInfo[] = [];
		const netMembers = new Map<string, Array<{ designator: string; padNumber: string }>>();
		// Counted for every pin regardless of includeAllPads, so padCount is
		// real even when the flat listing is suppressed.
		let padTotal = 0;

		const compArray: any[] = Array.isArray(allComponents) ? allComponents : [];
		const pinScale = await componentPinScale();

		await mapWithConcurrency(compArray, PCB_FETCH_CONCURRENCY, async (raw: any) => {
			const primitiveId = getProp(raw, 'primitiveId', 'id', 'uuid');
			if (!primitiveId) return;
			const designator = getProp(raw, 'designator', 'name', 'reference') ?? '';
			const bag = propertyBag(raw);

			// Pull identity from every plausible source — SDK fields first
			// (manufacturerId is the SDK's MPN), then the parameter bag, then
			// custom-field shapes from other part sources.
			const fields = getProp(raw, 'customizedFields', 'attributes', 'params', 'fields');
			const pick = (rawKeys: string[], bagKeys: string[]): any =>
				getProp(raw, ...rawKeys) ?? getProp(bag, ...bagKeys) ?? getProp(fields, ...bagKeys);

			const c: ComponentInfo = {
				primitiveId,
				designator,
				name: strField(pick(['name', 'description'], ['name', 'Name', 'description'])),
				mpn: strField(pick(
					['mpn', 'partNumber', 'manufacturerPartNumber', 'manufacturerId'],
					['Manufacturer Part', 'mpn', 'MPN', 'manufacturerPartNumber', 'partNumber', 'PartNumber'],
				)),
				manufacturer: strField(pick(['manufacturer', 'mfg'], ['Manufacturer', 'manufacturer', 'mfg'])),
				supplier: strField(pick(['supplier'], ['Supplier', 'supplier'])),
				supplierId: strField(pick(['supplierId', 'supplier_part'], ['Supplier Part', 'supplierId', 'supplierPart', 'lcsc', 'LCSC', 'supplier_part'])),
				footprint: strField(getProp(raw, 'footprint', 'package') ?? getProp(bag, 'footprint', 'package') ?? getProp(fields, 'footprint', 'package')),
				layer: strField(getProp(raw, 'layer', 'layerName')),
				position: {
					x: Number(getProp(raw, 'x', 'centerX') ?? 0),
					y: Number(getProp(raw, 'y', 'centerY') ?? 0),
					rotation: Number(getProp(raw, 'rotation', 'angle') ?? 0),
					mirror: getProp(raw, 'mirror', 'flipped') === true,
				},
				pinCount: 0,
				// Default: short scalar props from the bag. `verbose: true` keeps
				// the bag intact (or, for a part without one, the raw primitive as
				// before) — mirrors sch-extract.
				otherProperties: params?.verbose ? (bag ?? raw) : (bag ? trimProps(bag) : undefined),
			};

			try {
				const pins: any[] = (await (eda as any).pcb_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId)) ?? [];
				c.pinCount = pins.length;
				for (const p of pins) {
					const padNumber = String(getProp(p, 'padNumber', 'pinNumber', 'pin') ?? '');
					const net = String(getProp(p, 'net', 'netName') ?? '');
					if (net && (!netMatches || netMatches(net))) {
						if (!netMembers.has(net)) netMembers.set(net, []);
						netMembers.get(net)!.push({ designator, padNumber });
					}
					padTotal += 1;
					if (includeAllPads && (!netMatches || (net && netMatches(net)))) {
						pads.push({
							designator,
							padNumber,
							net,
							layer: getProp(p, 'layer', 'layerName'),
							x: componentPadCoordToMil(p, pinScale, 'x', 'centerX'),
							y: componentPadCoordToMil(p, pinScale, 'y', 'centerY'),
							pad: componentPadShapeToMil(p, 'Pad', 'pad'),
							hole: componentPadShapeToMil(p, 'Hole', 'hole'),
						});
					}
				}
			} catch {
				// best-effort — pad fetch failures don't kill the snapshot
			}

			components[primitiveId] = c;
		});

		// Build nets: prefer the canonical list; fall back to whatever appeared in pads
		const netNamesRaw: string[] = (await ((eda as any).pcb_Net?.getAllNetsName?.().catch?.(() => []) ?? [])) || [];
		const netNames = new Set<string>(
			[...netNamesRaw, ...netMembers.keys()].filter(Boolean).filter((n) => !netMatches || netMatches(n)),
		);

		const nets: Record<string, NetInfo> = {};

		// Optional net length lookups (slow — gated)
		const netLengthLookup = async (n: string): Promise<number | undefined> => {
			try {
				const v = await (eda as any).pcb_Net.getNetLength(n);
				return typeof v === 'number' ? v : undefined;
			} catch { return undefined; }
		};

		const netsArray = [...netNames];
		const lengths: Record<string, number | undefined> = {};
		if (includeNetLengths) {
			await mapWithConcurrency(netsArray, PCB_FETCH_CONCURRENCY, async (n) => {
				lengths[n] = await netLengthLookup(n);
			});
		}

		let pNet = 0, gNet = 0, sNet = 0, autoN = 0;
		for (const name of netsArray) {
			const cls = classifyNet(name);
			if (cls.isPower) pNet++;
			else if (cls.isGround) gNet++;
			else sNet++;
			if (cls.autoNamed) autoN++;

			const members = netMembers.get(name) ?? [];
			nets[name] = {
				name,
				pinCount: members.length,
				isPower: cls.isPower,
				isGround: cls.isGround,
				autoNamed: cls.autoNamed,
				members,
				netLengthMil: lengths[name],
			};
		}

		// By-layer stats (best-effort lookups; failures don't kill snapshot)
		const byLayer: Record<string, { components: number; pads: number; tracks: number; vias: number; pours: number }> = {};
		const ensure = (layer: string) => {
			if (!byLayer[layer]) byLayer[layer] = { components: 0, pads: 0, tracks: 0, vias: 0, pours: 0 };
			return byLayer[layer];
		};
		for (const c of Object.values(components)) {
			if (c.layer) ensure(c.layer).components += 1;
		}
		for (const p of pads) {
			if (p.layer) ensure(p.layer).pads += 1;
		}

		// Vias (count only — full list cheap but not necessary)
		let viaCount = 0;
		try {
			const vias: any[] = (await (eda as any).pcb_PrimitiveVia?.getAll?.()) ?? [];
			viaCount = vias.length;
			for (const v of vias) {
				const layer = getProp(v, 'layer', 'topLayer') ?? 'unknown';
				ensure(String(layer)).vias += 1;
			}
		} catch {}

		// Tracks per layer (count only)
		let trackCount = 0;
		try {
			const lines: any[] = (await (eda as any).pcb_PrimitiveLine?.getAll?.()) ?? [];
			trackCount = lines.length;
			for (const l of lines) {
				const layer = getProp(l, 'layer', 'layerName') ?? 'unknown';
				ensure(String(layer)).tracks += 1;
			}
		} catch {}

		// Pours/regions per layer
		let pourCount = 0;
		try {
			const regions: any[] = (await (eda as any).pcb_PrimitiveRegion?.getAll?.()) ?? [];
			pourCount = regions.length;
			for (const r of regions) {
				const layer = getProp(r, 'layer', 'layerName') ?? 'unknown';
				ensure(String(layer)).pours += 1;
			}
		} catch {}

		// Passive counts via designator prefix
		let resistors = 0, capacitors = 0, inductors = 0;
		for (const c of Object.values(components)) {
			const cls = inferDeviceClass(c);
			if (cls === 'resistor') resistors++;
			else if (cls === 'capacitor') capacitors++;
			else if (cls === 'inductor') inductors++;
		}

		const snapshot: PcbDesignSnapshot = {
			project,
			document,
			componentCount: Object.keys(components).length,
			netCount: netsArray.length,
			padCount: padTotal,
			components,
			nets,
			pads,
			// Component-pad coordinates arrive in 10-mil units and are scaled
			// above; stated once here rather than on every pad.
			...(includeAllPads ? { padUnits: 'mil' as const } : {}),
			layers: layerInfos,
			stats: {
				byLayer,
				nets: { power: pNet, ground: gNet, signal: sNet, autoNamed: autoN },
				passives: { resistors, capacitors, inductors },
				viaCount,
				trackCount,
				pourCount,
			},
		};

		return projectSnapshot(snapshot, params?.fields);
	},
};
