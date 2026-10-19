// Who a DRC leaf blames. Shared by the extension (drc.ts, route-path.ts,
// sch-document.ts) and the MCP process (pcb_run_drc annotation) so both read
// EasyEDA DRC leaves identically.

function stringOrUndefined(value: any): string | undefined {
	if (value === undefined || value === null) return undefined;
	const s = String(value).trim();
	return s ? s : undefined;
}

function firstDefined(...values: any[]): any {
	for (const value of values) if (value !== undefined && value !== null) return value;
	return undefined;
}

// EasyEDA DRC violations rarely populate `component`/`designator`/`refDes`
// directly, but pad labels (e.g. "R21_1", "U12_6", "Q2_3") leak through the
// `obj1`/`obj2` suffixes, which read "(GND): C1_1" — net in parentheses, then
// the pad label or, for tracks/vias, the primitive id ("(GND): e25457").
// Reverse-map pad labels back to component refs so groupBy='component'
// produces useful buckets instead of "unknown-component".
//
// Designator pattern: 1-4 letters + digits, optionally followed by `_<pin>`
// (e.g. "R21", "R21_1", "U12_GND"). We accept the common KiCad/EasyEDA forms.
const REF_FROM_PAD_ID = /^([A-Za-z]{1,4}\d+)(?:[_/].*)?$/;
const PAD_LABEL = /^([A-Za-z]{1,4}\d+)[_./](.+)$/;
// DRC error ids ("err397") name the violation itself, never copper.
const DRC_ERROR_ID = /^err\d+$/i;
// EasyEDA Pro primitive ids: "e25457" (track), "e6e8" (pad e8 of component e6).
// Lowercase `e` + digits — never a designator, even though "e2463" would
// otherwise match REF_FROM_PAD_ID.
const EASYEDA_PRIMITIVE_ID = /^e\d+(?:e\d+)*$/;
const ID_TOKEN = /^[A-Za-z0-9_-]+$/;

// "(GND): C1_1" → "C1_1"; "(No Net): e25457" → "e25457"; "C1_1" → "C1_1".
function suffixLabel(value: any): string | undefined {
	const s = stringOrUndefined(value);
	if (!s) return undefined;
	const label = s.replace(/^\([^)]*\)\s*:?\s*/, '').trim();
	return label.split(/\s+/)[0] || undefined;
}

function extractRef(candidate: any): string | undefined {
	const label = suffixLabel(candidate);
	if (!label || EASYEDA_PRIMITIVE_ID.test(label) || DRC_ERROR_ID.test(label)) return undefined;
	const m = label.match(REF_FROM_PAD_ID);
	return m ? m[1].toUpperCase() : undefined;
}

export type DrcPadRef = { component: string; pad: string };
export type DrcOffenders = {
	/** DRC error id (`globalIndex`, e.g. "err397") — names the violation, not copper. */
	errorId?: string;
	/** Offending primitive ids ("e6e8", "e25457") — what an agent edits/deletes/moves. */
	primitiveIds: string[];
	/** Component designators involved ("C1", "U3"). */
	componentRefs: string[];
	/** Pads named by the violation ("C1_1" → {component:"C1", pad:"1"}). */
	pads: DrcPadRef[];
};

// The DRC error id of a leaf. `globalIndex` is "err<n>" for violations but
// can carry a net name (`globalIndexIsNet`), so only the err-shape counts.
export function drcErrorId(v: any): string | undefined {
	if (!v || typeof v !== 'object') return undefined;
	for (const c of [v.errId, v.errorId, v.globalIndexIsNet ? undefined : v.globalIndex]) {
		const s = stringOrUndefined(c);
		if (s && DRC_ERROR_ID.test(s)) return s;
	}
	return undefined;
}

// Who a DRC leaf blames. EasyEDA names the offending primitives in `objs`;
// obj1/obj2 add pad labels / primitive ids through `suffix` (and sometimes
// id fields). Unlike collectIds() — which reads *id/*index keys and so yields
// DRC error ids ("err397") — primitiveIds never contains an error id.
export function extractDrcOffenders(v: any): DrcOffenders {
	const out: DrcOffenders = { primitiveIds: [], componentRefs: [], pads: [] };
	if (!v || typeof v !== 'object') return out;
	out.errorId = drcErrorId(v);

	const ids = new Set<string>();
	const refs = new Set<string>();
	const pads = new Map<string, DrcPadRef>();
	const addId = (value: any): void => {
		const s = stringOrUndefined(value);
		if (s && ID_TOKEN.test(s) && !DRC_ERROR_ID.test(s)) ids.add(s);
	};
	const addRef = (value: any): void => {
		const s = stringOrUndefined(value);
		if (s) refs.add(s.toUpperCase());
	};
	const addPad = (label: string): boolean => {
		if (EASYEDA_PRIMITIVE_ID.test(label)) return false;
		const m = label.match(PAD_LABEL);
		if (!m) return false;
		const component = m[1].toUpperCase();
		refs.add(component);
		pads.set(`${component}_${m[2]}`, { component, pad: m[2] });
		return true;
	};

	for (const d of [v.component, v.designator, v.refDes]) addRef(d);

	// 1. objs — EasyEDA's own list of offending primitives.
	const objs: any[] = Array.isArray(v.objs) ? v.objs : [];
	for (const o of objs) {
		if (o && typeof o === 'object') addId(firstDefined(o.primitiveId, o.id, o.globalIndex));
		else {
			addId(o);
			const s = stringOrUndefined(o);
			if (s) addPad(s);
		}
	}
	const fromObjs = new Set(ids);

	// 2. obj1/obj2 — suffix "(NET): label" is a pad label or a primitive id.
	// `fallback` decides what an unclassifiable label is: id fields → id,
	// suffix/name → component ref (e.g. "(GND): C1" for a component body).
	const classify = (raw: any, fallback: 'id' | 'ref'): void => {
		const label = suffixLabel(raw);
		if (!label || DRC_ERROR_ID.test(label)) return;
		if (fromObjs.has(label) || EASYEDA_PRIMITIVE_ID.test(label)) { addId(label); return; }
		if (addPad(label)) return;
		if (fallback === 'id') { if (/\d/.test(label)) addId(label); return; }
		const ref = extractRef(label);
		if (ref) refs.add(ref);
	};
	for (const o of [v.obj1, v.obj2]) {
		if (!o) continue;
		if (typeof o !== 'object') { classify(o, 'ref'); continue; }
		addId(o.primitiveId);
		classify(o.id, 'id');
		classify(o.globalIndex, 'id');
		classify(o.suffix, 'ref');
		classify(o.name, 'ref');
		addRef(o.designator);
		addRef(o.refDes);
	}

	// 3. Top-level primitive id fields, when a build provides them.
	addId(v.primitiveId);
	for (const key of ['primitiveIds', 'objIds']) {
		if (Array.isArray(v[key])) for (const id of v[key]) addId(id);
	}

	out.primitiveIds = Array.from(ids);
	out.componentRefs = Array.from(refs);
	out.pads = Array.from(pads.values());
	return out;
}
