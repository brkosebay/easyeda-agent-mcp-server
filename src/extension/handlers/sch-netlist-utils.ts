import { didTimeOut, readWithTimeout } from './_utils';

export interface ParsedNetlistComponent {
	designator: string;
	part: string;
	manufacturerPart: string;
	pins: Record<string, string>; // pinNumber → netName
}

// Keyed by component uniqueId
export type ParsedNetlist = Record<string, ParsedNetlistComponent>;

// Raw netlist exposes everything EasyEDA's project-wide netlist gives us:
// every component on every page, with its full props bag (Manufacturer,
// LCSC Part Name, Footprint, Resistance, Capacitance, Datasheet, …).
// This is the source of truth for cross-page aggregation since the
// per-tab `sch_PrimitiveComponent.getAll` call only returns the active
// page's primitives in current EasyEDA Pro builds.
export interface RawNetlistEntry {
	props: Record<string, any>;
	pins: Record<string, string>;
}
export type RawNetlist = Record<string, RawNetlistEntry>;

const NETLIST_TIMEOUT_MS = 20_000;

async function blobText(file: Blob): Promise<string> {
	if (typeof (file as any).text === 'function') return (file as any).text();
	return new TextDecoder().decode(await file.arrayBuffer());
}

/**
 * The project-wide JLCEDA netlist as text. EasyEDA Pro 3.x's
 * `sch_Netlist.getNetlist('JLCEDA')` awaits one project-DB footprint lookup per
 * component and takes many minutes (>120 s on a ~120-part project, 3.2.206), so
 * read the manufacture export first — a single editor RPC that also keeps
 * `Footprint` as the UUID — and fall back to getNetlist for builds without it.
 * Both are read-only, so they use the ungated readWithTimeout: the gated
 * callWithTimeout would queue behind the handler that is already running.
 */
export async function fetchNetlistText(type: string = ESYS_NetlistType.JLCEDA_PRO): Promise<string> {
	const exporter = (eda as any).sch_ManufactureData?.getNetlistFile;
	if (typeof exporter === 'function') {
		const file = await readWithTimeout<Blob | undefined>(() => exporter.call((eda as any).sch_ManufactureData, 'Netlist', type), NETLIST_TIMEOUT_MS);
		if (!didTimeOut(file) && file) {
			const text = await blobText(file);
			if (text.trim()) return text;
		}
	}
	const raw = await readWithTimeout(() => eda.sch_Netlist.getNetlist(type as any), NETLIST_TIMEOUT_MS);
	if (didTimeOut(raw)) throw new Error(`EasyEDA did not return the ${type} schematic netlist within ${NETLIST_TIMEOUT_MS / 1000} s (sch_ManufactureData.getNetlistFile and sch_Netlist.getNetlist both failed).`);
	return typeof raw === 'string' ? raw : JSON.stringify(raw);
}

/**
 * Parse a JLCEDA netlist. EasyEDA Pro 2.x returned `{uniqueId: {props, pins:
 * {pinNumber: net}}}`; 3.x (netlist "version": "2.0.0") wraps that map as
 * `{version, components}` and replaces `pins` with `pinInfoMap: {key: {number,
 * name, net, props}}`.
 */
export function parseJlcedaNetlist(text: string): RawNetlist {
	const parsed: Record<string, any> = JSON.parse(text);
	const data: Record<string, any> = parsed?.version && parsed.components && typeof parsed.components === 'object' ? parsed.components : parsed;
	const result: RawNetlist = {};
	for (const [uniqueId, entry] of Object.entries(data)) {
		if (!entry || typeof entry !== 'object') continue;
		let pins: Record<string, string> = entry.pins || {};
		if (!entry.pins && entry.pinInfoMap && typeof entry.pinInfoMap === 'object') {
			pins = {};
			for (const [key, info] of Object.entries<any>(entry.pinInfoMap)) {
				pins[String(info?.number ?? key)] = String(info?.net ?? '');
			}
		}
		result[uniqueId] = { props: entry.props || {}, pins };
	}
	return result;
}

export async function fetchRawNetlist(): Promise<RawNetlist> {
	return parseJlcedaNetlist(await fetchNetlistText());
}

export async function fetchParsedNetlist(): Promise<ParsedNetlist> {
	const raw = await fetchRawNetlist();
	const result: ParsedNetlist = {};
	for (const [uniqueId, entry] of Object.entries(raw)) {
		const props = entry.props;
		result[uniqueId] = {
			designator: props.Designator || '',
			part: props.Name || '',
			manufacturerPart: props['Manufacturer Part'] || '',
			pins: entry.pins,
		};
	}
	return result;
}

export async function fetchPinNames(primitiveId: string): Promise<Record<string, string>> {
	const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId);
	const result: Record<string, string> = {};
	if (Array.isArray(pins)) {
		for (const pin of pins) {
			const p = pin as any;
			if (p.pinNumber != null) {
				result[String(p.pinNumber)] = p.pinName || '';
			}
		}
	}
	return result;
}
