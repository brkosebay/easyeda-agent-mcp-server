import { componentYSign } from './sch-frame';
import { parsePhysicalValue } from './passive-value';
// sch.extract.design — produce a normalized snapshot of the active design
// (or whole project, if `allPages:true`). One round-trip yields everything
// the analyzer suite (power tree, decoupling, EMC, etc.) needs without a
// dozen separate API calls.

import { fetchPinNames, fetchRawNetlist, type RawNetlist } from './sch-netlist-utils';
import { mapWithConcurrency } from './_utils';

// Cap concurrent EasyEDA API calls when fanning out per-component fetches.
// Firing 500+ pin-name lookups in parallel saturates the runtime and can hang
// the schematic editor; 16 is plenty fast and keeps the event loop responsive.
const SCH_FETCH_CONCURRENCY = 16;

interface PinRef {
	designator: string;
	pinNumber: string;
	pinName: string;
}

interface NetInfo {
	name: string;
	pinCount: number;
	members: PinRef[];
	isPower: boolean;
	isGround: boolean;
	autoNamed: boolean; // true for $-prefixed nets (auto-generated single-link)
}

interface ComponentInfo {
	designator: string;
	primitiveId: string;
	uniqueId?: string;
	name?: string;
	mpn?: string;            // manufacturer part number
	manufacturer?: string;
	supplier?: string;       // typically "LCSC"
	supplierId?: string;     // C12345
	value?: string;          // best-effort extracted resistance/capacitance/inductance
	unit?: string;           // ohm/F/H — only set when value parses
	footprint?: string;
	libraryUuid?: string;
	deviceUuid?: string;
	position: { x: number; y: number; rotation: number; mirror: boolean };
	pins: Record<string, { name: string; net: string }>;
	deviceClass: DeviceClass;
	addIntoBom: boolean;
	addIntoPcb: boolean;
	otherProperties: Record<string, any>;
}

type DeviceClass =
	| 'resistor' | 'capacitor' | 'inductor' | 'ferrite_bead'
	| 'diode' | 'led' | 'tvs' | 'zener'
	| 'transistor_bjt' | 'transistor_fet'
	| 'ic' | 'regulator_ldo' | 'regulator_buck' | 'regulator_boost'
	| 'connector' | 'header' | 'usb_connector'
	| 'crystal' | 'oscillator'
	| 'fuse' | 'ptc'
	| 'switch' | 'relay'
	| 'transformer'
	| 'mounting_hole' | 'test_point' | 'net_label'
	| 'unknown';

interface DesignSnapshot {
	project?: { name?: string; uuid?: string };
	page: { uuid?: string; name?: string; schematicUuid?: string };
	pageCount?: number;
	componentCount: number;
	netCount: number;
	components: Record<string, ComponentInfo>;
	nets: Record<string, NetInfo>;
	pinIndex: PinRef[];
	stats: {
		byClass: Record<string, number>;
		passiveByValue: { resistors: number; capacitors: number; inductors: number };
		nets: { power: number; ground: number; signal: number; autoNamed: number };
	};
}

const POWER_RE = /^(\+?\d+\.?\d*v|vcc|vdd|vbus|vbat|vin|vout|v\+|v-|3v3|5v|12v|24v|usb_v|vee|vss?_)/i;
const GROUND_RE = /^(gnd|ground|agnd|dgnd|pgnd|earth|chasis|chassis)$/i;

const DESIGNATOR_TO_CLASS: Array<[RegExp, DeviceClass]> = [
	[/^R\d+/i, 'resistor'],
	[/^C\d+/i, 'capacitor'],
	[/^L\d+/i, 'inductor'],
	[/^FB\d+/i, 'ferrite_bead'],
	[/^D\d+/i, 'diode'],
	[/^LED\d+/i, 'led'],
	[/^TVS\d+/i, 'tvs'],
	[/^Z\d+/i, 'zener'],
	[/^Q\d+/i, 'transistor_bjt'],
	[/^M\d+/i, 'transistor_fet'],
	[/^U\d+/i, 'ic'],
	[/^J\d+|^CN\d+|^P\d+/i, 'connector'],
	[/^USB\d+/i, 'usb_connector'],
	[/^Y\d+|^X\d+/i, 'crystal'],
	[/^F\d+/i, 'fuse'],
	[/^PTC\d+/i, 'ptc'],
	[/^SW\d+|^S\d+/i, 'switch'],
	[/^K\d+|^RY\d+/i, 'relay'],
	[/^T\d+|^TR\d+/i, 'transformer'],
	[/^MH\d+|^H\d+/i, 'mounting_hole'],
	[/^TP\d+/i, 'test_point'],
	[/^NL\d+/i, 'net_label'],
];

const REG_LDO_RE = /\b(LDO|RT\d{4}|AP\d{4}|TLV\d{2,}|MIC\d{4}|LP\d{4}|TPS7|MCP170\d|XC6\d{3}|AMS1117|LM1117|LM317|NCP\d{3,}|HT\d{4}|SPX\d{3,}|TPS76\d|TPS78\d|RT9\d{3}|ME6\d{3}|ME6211)\b/i;
// LT8608 / LT8500x / LTC388x / etc. — Linear Tech (now ADI) buck family.
const REG_BUCK_RE = /\b(BUCK|TPS54|TPS61|TPS6\d{4}|MP\d{4}|AP6\d{3,}|LM\d{4}-ADJ|LMR\d|RT\d{4}A?B?|MAX1\d{3}|TPS5\d{3}|SY8\d{3}|MP1\d{3,}|MP2\d{3,}|MP4\d{3,}|MP8\d{3,}|LT[CM]?\d{4}|LT8\d{3}|LTC\d{3,4}|TPS62|TPS564|MIC22\d{3}|MIC23\d{3}|TLV62|RT8\d{3})\b/i;
const REG_BOOST_RE = /\b(BOOST|TPS61\d{2}|MAX17\d{2}|MIC2\d{3}|LM\d{4}-BOOST|TPS6101\d|TPS6111\d|MP3\d{3,}|SX\d{4}|LT8\d{2}5|LTC3108|MT3608|FP6291)\b/i;

// TVS clamps (Transient Voltage Suppressor). EE always designates them as
// D* even though they're functionally protection — match by MPN family.
const TVS_RE = /\b(SMDJ|SMBJ|SMAJ|SMCJ|SMA6J|SMC6\.|ESDA?\d|TVS\d|PESD\d|USBLC6|SP\d{4}|SLVU\d|RCLAMP|SR05|SRV05|UCLAMP)\b/i;
// True zeners (constant-voltage diodes used for regulation/bias).
const ZENER_RE = /\b(MMBZ|BZX|BZV|MM3Z|1N47\d{2}|1N52\d{2}|MM5Z)\b/i;
// MOSFET indicators in MPN — beats the bare designator-only Q heuristic
// (Q is also used for BJTs).
const FET_RE = /\b(AON\d{4}|AOD\d{3,}|SI\d{4}|SI[A-Z]{2}\d{3,}|IRLR?\d|FDS\d|FDC\d|BSS\d{3}|2N7002|AO\d{4})\b/i;
const BJT_RE = /\b(MMBT|BC\d{2,3}|2N\d{4}|S8050|S8550|2SC|2SA|BC817|BC807|MMBTH|MMBT\d{4})\b/i;

function classifyDevice(designator: string, mpn: string | undefined, name: string | undefined, footprint: string | undefined): DeviceClass {
	const tag = `${mpn ?? ''} ${name ?? ''} ${footprint ?? ''}`;
	if (REG_BUCK_RE.test(tag)) return 'regulator_buck';
	if (REG_BOOST_RE.test(tag)) return 'regulator_boost';
	if (REG_LDO_RE.test(tag)) return 'regulator_ldo';
	if (TVS_RE.test(tag)) return 'tvs';
	if (ZENER_RE.test(tag)) return 'zener';
	if (FET_RE.test(tag)) return 'transistor_fet';
	if (BJT_RE.test(tag)) return 'transistor_bjt';

	for (const [re, cls] of DESIGNATOR_TO_CLASS) {
		if (re.test(designator)) return cls;
	}
	return 'unknown';
}

function parsePassiveValue(name: string | undefined, mpn: string | undefined, deviceClass: DeviceClass): {value?:string;unit?:string} {
  if (!['resistor','capacitor','inductor'].includes(deviceClass)) return {};
  const unit = deviceClass === 'resistor' ? 'Ω' : deviceClass === 'capacitor' ? 'F' : 'H';
  const value = parsePhysicalValue(name,unit,true) ?? parsePhysicalValue(mpn,unit);
  return value === undefined ? {} : {value:formatValue(value,unit),unit};
}

function formatValue(v: number, unit: string): string {
	const PRE: Array<[number, string]> = [
		[1e9, 'G'], [1e6, 'M'], [1e3, 'k'],
		[1, ''],
		[1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'],
	];
	for (const [scale, prefix] of PRE) {
		if (Math.abs(v) >= scale) {
			const n = v / scale;
			const s = Number.isInteger(n) ? n.toString() : n.toFixed(3).replace(/\.?0+$/, '');
			return `${s}${prefix}${unit}`;
		}
	}
	return `${v}${unit}`;
}

function classifyNet(name: string): { isPower: boolean; isGround: boolean; autoNamed: boolean } {
	const autoNamed = name.startsWith('$');
	const isGround = GROUND_RE.test(name);
	const isPower = !isGround && POWER_RE.test(name);
	return { isPower, isGround, autoNamed };
}

// Drop noisy fields from the LCSC props bag. Datasheet URLs, full text
// descriptions, 3D model UUIDs, and the various Supplier/JLCPCB
// classification fields collectively account for roughly 60% of a
// snapshot's bytes and almost never feed an analyzer. The fields we DO
// keep below are the ones our analyzers (or curious agents) reach for:
// resistance/capacitance/inductance, tolerance, voltage rating, current
// rating, temperature coefficient, package, type.
const NOISE_PROPS = new Set([
	'Datasheet', 'Description', '3D Model', '3D Model Title', '3D Model Transform',
	'JLCPCB Part Class', 'Add into BOM', 'Convert to PCB',
	'Symbol', 'Footprint', 'Supplier Footprint',
	'Designator', 'Manufacturer', 'Manufacturer Part', 'Supplier', 'Supplier Part',
	'LCSC Part Name', 'Name', 'Value',
]);
function trimProps(props: Record<string, any>): Record<string, any> {
	const out: Record<string, any> = {};
	for (const [k, v] of Object.entries(props)) {
		if (NOISE_PROPS.has(k)) continue;
		out[k] = v;
	}
	return out;
}

// Try the LCSC props bag first (Resistance, Capacitance, Inductance,
// Value) — that's the actual datasheet figure. Only fall back to
// regex-parsing name/MPN if the props bag lacks a usable number.
function valueFromProps(
	props: Record<string, any>,
	deviceClass: DeviceClass,
): { value?: string; unit?: string } {
	if (deviceClass !== 'resistor' && deviceClass !== 'capacitor' && deviceClass !== 'inductor') {
		return {};
	}
	const expectedUnit = deviceClass === 'resistor' ? 'Ω' : deviceClass === 'capacitor' ? 'F' : 'H';
	const candidateKeys = deviceClass === 'resistor'
		? ['Resistance', 'Value']
		: deviceClass === 'capacitor'
			? ['Capacitance', 'Value']
			: ['Inductance', 'Value'];

	for (const key of candidateKeys) {
		const raw = props[key];
		if (typeof raw !== 'string' || !raw.length) continue;
        const num = parsePhysicalValue(raw, expectedUnit, true, key !== 'Value');
        if (num === undefined) continue;
        return {value:formatValue(num,expectedUnit),unit:expectedUnit};
	}
	return {};
}

interface PrimitiveLookupEntry {
	primitiveId: string;
	pinNames: Record<string, string>;
	position?: { x: number; y: number; rotation: number; mirror: boolean };
	libraryUuid?: string;
	deviceUuid?: string;
	footprintName?: string;
	footprintUuid?: string;
}

export const schExtractHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'sch.extract.design': async (params) => {
		const allPages: boolean = params?.allPages ?? true;

		// `getAll('part', true)` is documented to return every page's components,
		// but in current EasyEDA Pro builds it silently returns just the active
		// page. We therefore use the project-wide netlist as the source of
		// truth for component identity (designator, MPN, props, pin→net) and
		// enrich with active-page state where it's available (position,
		// pinNames, footprint UUIDs). Net data is reconstructed from the
		// netlist and is always project-wide.
		const [project, currentDoc, page, allComponents, rawNetlist] = await Promise.all([
			eda.dmt_Project.getCurrentProjectInfo().catch(() => null),
			eda.dmt_SelectControl.getCurrentDocumentInfo().catch(() => null),
			eda.dmt_Schematic?.getCurrentSchematicPageInfo?.().catch(() => null) ?? null,
			(eda.sch_PrimitiveComponent as any).getAll('part', allPages).catch(() => []),
			fetchRawNetlist(),
		]);

		// Build active-page primitive lookup keyed by uniqueId.
		const lookupByUnique: Record<string, PrimitiveLookupEntry> = {};
		// Report component positions in the same frame as wires and pins.
		const ySign = (allComponents || []).length ? await componentYSign(params?.coordinateFrame === 'api') : 1;
		const pinFetchTargets: Array<{ entry: PrimitiveLookupEntry; primitiveId: string }> = [];
		for (const c of allComponents || []) {
			const ci: any = c;
			const uniqueId = ci.getState_UniqueId?.() ?? ci.uniqueId;
			const primitiveId = ci.getState_PrimitiveId?.() ?? ci.primitiveId;
			if (!uniqueId || !primitiveId) continue;

			const symbolRef = ci.getState_Symbol?.();
			const footprintRef = ci.getState_Footprint?.();
			const x = ci.getState_X?.() ?? 0;
			const y = ySign * (ci.getState_Y?.() ?? 0);
			const rotation = ci.getState_Rotation?.() ?? 0;
			const mirror = ci.getState_Mirror?.() ?? false;

			const entry: PrimitiveLookupEntry = {
				primitiveId,
				pinNames: {},
				position: { x, y, rotation, mirror },
				libraryUuid: symbolRef?.libraryUuid,
				deviceUuid: symbolRef?.uuid,
				footprintName: footprintRef?.name,
				footprintUuid: footprintRef?.uuid,
			};
			lookupByUnique[uniqueId] = entry;
			pinFetchTargets.push({ entry, primitiveId });
		}
		// Bounded concurrency: a 500-component schematic used to spawn 500
		// concurrent fetchPinNames calls, which routinely wedged EasyEDA's
		// runtime. Capping at SCH_FETCH_CONCURRENCY keeps the event loop
		// responsive and is no slower in practice (EasyEDA serializes most
		// of these internally anyway).
		await mapWithConcurrency(pinFetchTargets, SCH_FETCH_CONCURRENCY, async ({ entry, primitiveId }) => {
			try {
				entry.pinNames = await fetchPinNames(primitiveId);
			} catch { /* leave empty — pin names will fall back to pinNumber */ }
		});

		// Build component records from the netlist (project-wide).
		const components: Record<string, ComponentInfo> = {};
		const pinIndex: PinRef[] = [];
		const netMembers: Record<string, PinRef[]> = {};
		const byClass: Record<string, number> = {};
		let resistors = 0, capacitors = 0, inductors = 0;

		for (const [uniqueId, netEntry] of Object.entries(rawNetlist)) {
			const props: Record<string, any> = netEntry.props || {};
			const designator: string = props.Designator || '';
			if (!designator) continue;

			const primitiveEntry = lookupByUnique[uniqueId];
			const mpn: string | undefined = props['Manufacturer Part'] || undefined;
			const manufacturer: string | undefined = props.Manufacturer || undefined;
			const supplier: string | undefined = props.Supplier || undefined;
			const supplierId: string | undefined = props['Supplier Part'] || undefined;
			const name: string | undefined = props.Name || undefined;
			const footprintName: string | undefined = primitiveEntry?.footprintName || props.FootprintName || props['Footprint Name'] || props['Supplier Footprint'];
			const footprintUuid: string | undefined = primitiveEntry?.footprintUuid || props.Footprint;

			const deviceClass = classifyDevice(designator, mpn, name, footprintUuid);
			// Try the LCSC props bag first (real datasheet value), then fall
			// back to the regex parser scanning name/MPN.
			let { value, unit } = valueFromProps(props, deviceClass);
			if (!value) ({ value, unit } = parsePassiveValue(name, mpn, deviceClass));

			const pinNames = primitiveEntry?.pinNames ?? {};
			const pins: Record<string, { name: string; net: string }> = {};
			for (const [pinNumber, netName] of Object.entries(netEntry.pins || {})) {
				const pinName = pinNames[pinNumber] || '';
				pins[pinNumber] = { name: pinName, net: String(netName) };

				const ref: PinRef = { designator, pinNumber, pinName };
				pinIndex.push({ ...ref });
				if (netName) {
					if (!netMembers[netName]) netMembers[netName] = [];
					netMembers[netName].push(ref);
				}
			}

			// Trim the props bag for default extracts — datasheet URLs, full
			// LCSC descriptions, 3D model UUIDs, and supplier-class metadata
			// inflate the snapshot by ~60% and rarely matter for analysis.
			// Pass `verbose: true` to keep the raw props bag intact.
			const otherProperties = params?.verbose ? props : trimProps(props);

			components[designator] = {
				designator,
				primitiveId: primitiveEntry?.primitiveId ?? '',
				uniqueId,
				name,
				mpn,
				manufacturer,
				supplier,
				supplierId,
				value,
				unit,
				footprint: footprintName ?? footprintUuid,
				libraryUuid: primitiveEntry?.libraryUuid,
				deviceUuid: primitiveEntry?.deviceUuid,
				position: primitiveEntry?.position ?? { x: 0, y: 0, rotation: 0, mirror: false },
				pins,
				deviceClass,
				addIntoBom: props['Add into BOM'] !== 'no',
				addIntoPcb: props['Convert to PCB'] !== 'no',
				otherProperties,
			};

			byClass[deviceClass] = (byClass[deviceClass] ?? 0) + 1;
			if (deviceClass === 'resistor' && value) resistors++;
			else if (deviceClass === 'capacitor' && value) capacitors++;
			else if (deviceClass === 'inductor' && value) inductors++;
		}

		// Build net records.
		const nets: Record<string, NetInfo> = {};
		let powerNets = 0, groundNets = 0, signalNets = 0, autoNamedNets = 0;
		for (const [name, members] of Object.entries(netMembers)) {
			const cls = classifyNet(name);
			nets[name] = {
				name,
				pinCount: members.length,
				members,
				...cls,
			};
			if (cls.autoNamed) autoNamedNets++;
			else if (cls.isGround) groundNets++;
			else if (cls.isPower) powerNets++;
			else signalNets++;
		}

		const proj: any = project;
		const doc: any = currentDoc;
		const pg: any = page;

		return {
			project: proj ? { name: proj.name ?? proj.title, uuid: proj.uuid } : undefined,
			page: {
				uuid: pg?.uuid ?? doc?.tabId,
				name: pg?.name ?? pg?.title ?? doc?.title,
				schematicUuid: pg?.schematicUuid,
			},
			componentCount: Object.keys(components).length,
			netCount: Object.keys(nets).length,
			components,
			nets,
			pinIndex,
			stats: {
				byClass,
				passiveByValue: { resistors, capacitors, inductors },
				nets: { power: powerNets, ground: groundNets, signal: signalNets, autoNamed: autoNamedNets },
			},
		} satisfies DesignSnapshot;
	},

	// Lightweight orientation tool: list every schematic page in the
	// project (filtered from the editor's split-screen tree) so an agent
	// can pick the right page UUID before drilling in. Way cheaper than
	// extract_design — no netlist fetch, no per-component pin lookup.
	// Lives under the editor.* namespace so it doesn't go through
	// requireDocumentType — listing pages should work even when a PCB is
	// the currently-active tab.
	'editor.sch.pages': async () => {
		const [tree, currentDoc] = await Promise.all([
			eda.dmt_EditorControl.getSplitScreenTree().catch(() => null),
			eda.dmt_SelectControl.getCurrentDocumentInfo().catch(() => null),
		]);
		const activeUuid = (currentDoc as any)?.tabId as string | undefined;

		const pages: Array<{
			pageUuid: string;
			title: string;
			isActive: boolean;
			doctype: number;
			schematicName?: string;
			sheetOrderId?: number;
		}> = [];

		(function walk(node: any): void {
			if (!node) return;
			if (Array.isArray(node.tabs)) {
				for (const tab of node.tabs) {
					const data = tab?.data ?? {};
					const dt = Number(data.doctype);
					// 1 = schematic page. Skip PCBs, start page, library views.
					if (dt !== 1) continue;
					pages.push({
						pageUuid: tab.tabId,
						title: tab.title,
						isActive: !!activeUuid && tab.tabId === activeUuid,
						doctype: dt,
						schematicName: data.schematicName,
						sheetOrderId: typeof data.sheet_order_id === 'number' ? data.sheet_order_id : undefined,
					});
				}
			}
			if (Array.isArray(node.children)) for (const c of node.children) walk(c);
		})(tree);

		// Sort by sheet order (the order the user laid them out in EasyEDA);
		// fall back to title for pages without sheet_order_id.
		pages.sort((a, b) => {
			if (a.sheetOrderId != null && b.sheetOrderId != null) return a.sheetOrderId - b.sheetOrderId;
			if (a.sheetOrderId != null) return -1;
			if (b.sheetOrderId != null) return 1;
			return a.title.localeCompare(b.title);
		});

		return { pageCount: pages.length, pages };
	},
};
