// sch.extract.design — produce a normalized snapshot of the active design
// (or whole project, if `allPages:true`). One round-trip yields everything
// the analyzer suite (power tree, decoupling, EMC, etc.) needs without a
// dozen separate API calls.

import { fetchParsedNetlist, fetchPinNames } from './sch-netlist-utils';

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
	page: { uuid?: string; name?: string };
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

const REG_LDO_RE = /\b(LDO|RT\d{4}|AP\d{4}|TLV\d{2,}|MIC\d{4}|LP\d{4}|TPS7|MCP170\d|XC6\d{3})\b/i;
const REG_BUCK_RE = /\b(BUCK|TPS54|TPS61|TPS6\d{4}|MP\d{4}|AP6\d{3,}|LM\d{4}-ADJ|LMR\d|RT\d{4}A?B?|MAX1\d{3}|TPS5\d{3}|SY8\d{3}|MP1\d{3,}|MP2\d{3,}|MP4\d{3,}|MP8\d{3,})\b/i;
const REG_BOOST_RE = /\b(BOOST|TPS61\d{2}|MAX17\d{2}|MIC2\d{3}|LM\d{4}-BOOST|TPS6101\d|TPS6111\d|MP3\d{3,}|SX\d{4})\b/i;

function classifyDevice(designator: string, mpn: string | undefined, name: string | undefined, footprint: string | undefined): DeviceClass {
	const tag = `${mpn ?? ''} ${name ?? ''} ${footprint ?? ''}`;
	if (REG_BUCK_RE.test(tag)) return 'regulator_buck';
	if (REG_BOOST_RE.test(tag)) return 'regulator_boost';
	if (REG_LDO_RE.test(tag)) return 'regulator_ldo';

	for (const [re, cls] of DESIGNATOR_TO_CLASS) {
		if (re.test(designator)) return cls;
	}
	return 'unknown';
}

const SI_PREFIX: Record<string, number> = {
	p: 1e-12, n: 1e-9, u: 1e-6, μ: 1e-6, m: 1e-3,
	'': 1, k: 1e3, M: 1e6, G: 1e9,
};

function parsePassiveValue(name: string | undefined, mpn: string | undefined, deviceClass: DeviceClass): { value?: string; unit?: string } {
	if (deviceClass !== 'resistor' && deviceClass !== 'capacitor' && deviceClass !== 'inductor') {
		return {};
	}
	const expectedUnit = deviceClass === 'resistor' ? 'Ω' : deviceClass === 'capacitor' ? 'F' : 'H';
	const candidates = [name, mpn].filter((s): s is string => typeof s === 'string' && s.length > 0);

	// Look for forms like "10k", "4.7uF", "100nH", "0.1uF"
	const re = /(\d+(?:\.\d+)?)\s*([pnuμmkMG]?)\s*(Ω|ohm|F|H)?\b/i;
	for (const cand of candidates) {
		const m = cand.match(re);
		if (!m) continue;
		const num = parseFloat(m[1]);
		const prefix = m[2] || '';
		if (Number.isFinite(num)) {
			const scale = SI_PREFIX[prefix] ?? 1;
			const value = num * scale;
			return { value: formatValue(value, expectedUnit), unit: expectedUnit };
		}
	}
	return {};
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

export const schExtractHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'sch.extract.design': async (params) => {
		const allPages: boolean = params?.allPages ?? true;

		const [project, currentDoc, allComponents, parsedNetlist] = await Promise.all([
			eda.dmt_Project.getCurrentProjectInfo().catch(() => null),
			eda.dmt_SelectControl.getCurrentDocumentInfo().catch(() => null),
			(eda.sch_PrimitiveComponent as any).getAll('part', allPages),
			fetchParsedNetlist(),
		]);

		// Build uniqueId → primitiveId map for cross-referencing the netlist.
		const uniqueToPrimitive: Record<string, string> = {};
		const primitiveToUnique: Record<string, string> = {};
		for (const c of allComponents || []) {
			const ci: any = c;
			const primId = ci.getState_PrimitiveId?.() ?? ci.primitiveId;
			const uniqueId = ci.getState_UniqueId?.() ?? ci.uniqueId;
			if (primId && uniqueId) {
				uniqueToPrimitive[uniqueId] = primId;
				primitiveToUnique[primId] = uniqueId;
			}
		}

		// Pull pin names per component in parallel — needed for human-readable nets.
		const pinNamePromises = (allComponents || []).map(async (c: any) => {
			const primId = c.getState_PrimitiveId?.() ?? c.primitiveId;
			if (!primId) return null;
			const names = await fetchPinNames(primId).catch(() => ({} as Record<string, string>));
			return { primId, names };
		});
		const pinNameResults = await Promise.all(pinNamePromises);
		const pinNamesByPrimId: Record<string, Record<string, string>> = {};
		for (const r of pinNameResults) if (r) pinNamesByPrimId[r.primId] = r.names;

		// Build component records.
		const components: Record<string, ComponentInfo> = {};
		const pinIndex: PinRef[] = [];
		const netMembers: Record<string, PinRef[]> = {};
		const byClass: Record<string, number> = {};
		let resistors = 0, capacitors = 0, inductors = 0;

		for (const c of allComponents || []) {
			const ci: any = c;
			const designator = ci.getState_Designator?.() ?? '';
			if (!designator) continue;

			const primitiveId = ci.getState_PrimitiveId?.() ?? '';
			const uniqueId = ci.getState_UniqueId?.();
			const name = ci.getState_Name?.();
			const mpn = ci.getState_ManufacturerId?.();
			const manufacturer = ci.getState_Manufacturer?.();
			const supplier = ci.getState_Supplier?.();
			const supplierId = ci.getState_SupplierId?.();
			const footprintRef = ci.getState_Footprint?.();
			const symbolRef = ci.getState_Symbol?.();
			const otherProperty = ci.getState_OtherProperty?.() ?? {};
			const x = ci.getState_X?.() ?? 0;
			const y = ci.getState_Y?.() ?? 0;
			const rotation = ci.getState_Rotation?.() ?? 0;
			const mirror = ci.getState_Mirror?.() ?? false;
			const addIntoBom = ci.getState_AddIntoBom?.() ?? true;
			const addIntoPcb = ci.getState_AddIntoPcb?.() ?? true;

			const deviceClass = classifyDevice(designator, mpn, name, footprintRef?.uuid);
			const { value, unit } = parsePassiveValue(name, mpn, deviceClass);

			// Build pins map: pinNumber → {name, net}
			const pinNames = pinNamesByPrimId[primitiveId] || {};
			const netlistEntry = uniqueId ? parsedNetlist[uniqueId] : undefined;
			const netlistPins = netlistEntry?.pins || {};
			const pins: Record<string, { name: string; net: string }> = {};
			for (const [pinNumber, netName] of Object.entries(netlistPins)) {
				const pinName = pinNames[pinNumber] || '';
				pins[pinNumber] = { name: pinName, net: String(netName) };

				const ref: PinRef = { designator, pinNumber, pinName };
				pinIndex.push({ ...ref });
				if (netName) {
					if (!netMembers[netName]) netMembers[netName] = [];
					netMembers[netName].push(ref);
				}
			}

			components[designator] = {
				designator,
				primitiveId,
				uniqueId,
				name,
				mpn,
				manufacturer,
				supplier,
				supplierId,
				value,
				unit,
				footprint: footprintRef?.name || footprintRef?.uuid,
				libraryUuid: symbolRef?.libraryUuid,
				deviceUuid: symbolRef?.uuid,
				position: { x, y, rotation, mirror },
				pins,
				deviceClass,
				addIntoBom,
				addIntoPcb,
				otherProperties: otherProperty,
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

		return {
			project: proj ? { name: proj.name ?? proj.title, uuid: proj.uuid } : undefined,
			page: doc ? { uuid: doc.tabId, name: doc.title } : { },
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
};
