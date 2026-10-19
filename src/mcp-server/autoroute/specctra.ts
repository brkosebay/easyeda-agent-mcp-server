// Specctra DSN / SES as a small S-expression tree, plus the EasyEDA <-> micron
// unit conversion fastroute needs.
//
// EasyEDA's DSN says `(resolution mil 1000)` but writes every coordinate in
// 10-mil canvas units (a 52 mm board outline reads 0..204.72). Routing itself
// is scale-free, so FreeRouting never noticed. fastroute's length-tuning and
// diff-pair code does not: it converts mm with `resolution * 1000`, i.e. it
// assumes KiCad's `(resolution um 10)`, and its meander amplitudes, pair piece
// lengths and safety margins are hardcoded in mm/um. On a raw EasyEDA DSN every
// one of those is off by 254x. So before fastroute sees the board we rewrite it
// in real microns (`(resolution um 10)`, every geometric number x254), and the
// SES it writes is scaled back to EasyEDA's units, which keeps pcb_import_file,
// EasyEDA's own SES importer and analyzeRoutingCompletion unchanged.
//
// Which numbers are geometry is decided by a positional whitelist per keyword.
// Anything numeric under a keyword the whitelist does not know is reported in
// `unhandledNumericKeywords`, so an unfamiliar construct on another board shows
// up in the tool result instead of silently keeping the wrong scale.

export type SNode = SAtom | SList;
export interface SAtom { kind: 'atom'; text: string; quoted: boolean }
export interface SList { kind: 'list'; items: SNode[] }

/** Microns per EasyEDA DSN unit (10 mil). */
export const EASYEDA_DSN_UNIT_UM = 254;
/** Resolution written into the normalized DSN: 0.1 um board units, as KiCad does. */
export const NORMALIZED_RESOLUTION = 10;

const NUMBER_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

export function isNumberAtom(node: SNode | undefined): node is SAtom {
	return !!node && node.kind === 'atom' && !node.quoted && NUMBER_RE.test(node.text);
}

export function atom(text: string, quoted = false): SAtom {
	return { kind: 'atom', text, quoted };
}

export function list(head: string, ...rest: SNode[]): SList {
	return { kind: 'list', items: [atom(head), ...rest] };
}

export function headOf(node: SNode | undefined): string | undefined {
	if (!node || node.kind !== 'list') return undefined;
	const first = node.items[0];
	return first && first.kind === 'atom' ? first.text.toLowerCase() : undefined;
}

export function childLists(node: SList, head?: string): SList[] {
	return node.items.filter((n): n is SList => n.kind === 'list' && (head === undefined || headOf(n) === head));
}

export function firstChild(node: SList, head: string): SList | undefined {
	return childLists(node, head)[0];
}

export function atomText(node: SNode | undefined): string | undefined {
	return node && node.kind === 'atom' ? node.text : undefined;
}

// ---------------------------------------------------------------------------
// Reader / writer
// ---------------------------------------------------------------------------

/**
 * Parse one top-level S-expression. Strings use `"` (Specctra's default
 * string_quote) with `""` as a literal quote; the token right after a
 * `string_quote` keyword is read raw so `(string_quote ")` does not open a
 * string. Single quotes are ordinary characters, as in Freerouting.
 */
export function parseSexpr(text: string): SList {
	let i = 0;
	const len = text.length;
	let quote = '"';
	let rawNext = false;
	const stack: SList[] = [];
	let root: SList | undefined;

	const isDelim = (c: string) => c === '(' || c === ')' || c === ' ' || c === '\t' || c === '\n' || c === '\r';
	const push = (node: SNode) => {
		const top = stack[stack.length - 1];
		if (!top) throw new Error(`Specctra parse error at ${i}: content outside the top-level list`);
		top.items.push(node);
	};

	while (i < len) {
		const c = text[i];
		if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
		if (c === '(') {
			const node: SList = { kind: 'list', items: [] };
			if (stack.length) push(node);
			else if (root) throw new Error(`Specctra parse error at ${i}: more than one top-level list`);
			else root = node;
			stack.push(node);
			i++;
			continue;
		}
		if (c === ')') {
			if (!stack.length) throw new Error(`Specctra parse error at ${i}: unbalanced ")"`);
			stack.pop();
			i++;
			continue;
		}
		if (rawNext) {
			let j = i;
			while (j < len && !isDelim(text[j])) j++;
			const raw = text.slice(i, j);
			push(atom(raw));
			quote = raw[0] ?? quote;
			rawNext = false;
			i = j;
			continue;
		}
		if (c === quote) {
			let j = i + 1;
			let buf = '';
			for (;;) {
				if (j >= len) throw new Error(`Specctra parse error at ${i}: unterminated string`);
				if (text[j] === quote) {
					if (text[j + 1] === quote) { buf += quote; j += 2; continue; }
					j++;
					break;
				}
				buf += text[j++];
			}
			push(atom(buf, true));
			i = j;
			continue;
		}
		let j = i;
		while (j < len && !isDelim(text[j])) j++;
		const word = text.slice(i, j);
		push(atom(word));
		const parent = stack[stack.length - 1];
		if (parent && parent.items.length === 1 && word.toLowerCase() === 'string_quote') rawNext = true;
		i = j;
	}
	if (stack.length) throw new Error('Specctra parse error: unbalanced "(" at end of input');
	if (!root) throw new Error('Specctra parse error: empty input');
	return root;
}

function writeAtom(a: SAtom): string {
	if (a.quoted || a.text === '' || /[\s()"]/.test(a.text)) return `"${a.text.replace(/"/g, '""')}"`;
	return a.text;
}

/** Serialize with one child list per line; lists of atoms only stay on one line. */
export function writeSexpr(node: SNode, indent = ''): string {
	if (node.kind === 'atom') return writeAtom(node);
	const atomsOnly = node.items.every((n) => n.kind === 'atom');
	if (atomsOnly) return `(${node.items.map((n) => writeAtom(n as SAtom)).join(' ')})`;
	const inner = indent + '  ';
	let out = '(';
	let first = true;
	for (const item of node.items) {
		if (item.kind === 'atom') {
			out += (first ? '' : ' ') + writeAtom(item);
		} else {
			out += `\n${inner}${writeSexpr(item, inner)}`;
		}
		first = false;
	}
	return `${out}\n${indent})`;
}

// ---------------------------------------------------------------------------
// Geometry scaling
// ---------------------------------------------------------------------------

/** Keywords whose numeric arguments are not geometry (names, ids, angles, counts). */
const NON_GEOMETRIC = new Set([
	'pcb', 'session', 'base_design', 'parser', 'host_cad', 'host_version', 'string_quote', 'space_in_quoted_tokens',
	'structure', 'layer', 'type', 'property', 'index', 'direction', 'cost', 'control', 'via_at_smd', 'snap_angle',
	'library', 'image', 'padstack', 'shape', 'attach', 'rotate', 'side', 'component', 'placement', 'network', 'net',
	'pins', 'class', 'circuit', 'use_via', 'use_layer', 'rule', 'wiring', 'routes', 'library_out', 'network_out',
	'was_is', 'boundary', 'plane', 'keepout', 'via_keepout', 'wire', 'outline', 'window', 'resolution', 'unit',
	'clearance_class', 'via_rule', 'layer_rule', 'fix', 'pn', 'mirror', 'status', 'lock_type', 'net_number',
	'autoroute_settings', 'fanout', 'autoroute', 'postroute', 'vias', 'via_costs', 'plane_via_costs',
	'start_ripup_costs', 'start_pass_no', 'active', 'preferred_direction', 'preferred_direction_trace_costs',
	'against_preferred_direction_trace_costs',
]);

type Scaler = (node: SList, scale: (n: SAtom) => void) => void;

/** Scale every numeric atom from index `from` on. */
const fromIndex = (from: number): Scaler => (node, scale) => {
	for (let k = from; k < node.items.length; k++) {
		const it = node.items[k];
		if (isNumberAtom(it)) scale(it);
	}
};

/** Scale the numeric atoms at the given argument positions (1-based after the head). */
const atPositions = (...positions: number[]): Scaler => (node, scale) => {
	for (const p of positions) {
		const it = node.items[p];
		if (isNumberAtom(it)) scale(it);
	}
};

/** `(pin <padstack> [(rotate r)] <pin_id> <x> <y>)`: pin ids are often numeric, so only the last two atoms. */
const pinVertex: Scaler = (node, scale) => {
	const atoms = node.items.slice(1).filter((n): n is SAtom => n.kind === 'atom');
	const tail = atoms.slice(-2);
	if (tail.length === 2 && tail.every(isNumberAtom)) tail.forEach(scale);
};

const SCALERS: Record<string, Scaler> = {
	// shapes: (<shape> <layer> <numbers...>)
	path: fromIndex(2),
	polygon: fromIndex(2),
	polyline_path: fromIndex(2),
	rect: fromIndex(2),
	circle: fromIndex(2),
	qarc: fromIndex(2),
	// rule values
	width: fromIndex(1),
	clearance: fromIndex(1),
	clear: fromIndex(1),
	grid: fromIndex(1),
	// placed objects
	via: atPositions(2, 3),
	place: atPositions(2, 3),
	pin: pinVertex,
};

function formatNumber(v: number, decimals: number): string {
	if (!Number.isFinite(v)) return '0';
	const fixed = v.toFixed(decimals);
	const trimmed = decimals > 0 ? fixed.replace(/\.?0+$/, '') : fixed;
	return trimmed === '-0' ? '0' : trimmed;
}

/**
 * Multiply every geometric number in `root` by `factor` (in place). Returns
 * the keywords that carried numbers but are neither scaled nor known to be
 * non-geometric.
 */
export function scaleGeometry(root: SList, factor: number, decimals: number): string[] {
	const unhandled = new Set<string>();
	const scale = (a: SAtom) => { a.text = formatNumber(Number(a.text) * factor, decimals); };
	const walk = (node: SList) => {
		const head = headOf(node);
		const scaler = head ? SCALERS[head] : undefined;
		if (scaler) scaler(node, scale);
		else if (head && !NON_GEOMETRIC.has(head) && node.items.slice(1).some(isNumberAtom)) unhandled.add(head);
		for (const child of node.items) if (child.kind === 'list') walk(child);
	};
	walk(root);
	return Array.from(unhandled).sort();
}

export interface ResolutionInfo { unit: string; value: number }

export function readResolution(root: SList): ResolutionInfo | undefined {
	let found: ResolutionInfo | undefined;
	const walk = (node: SList) => {
		if (found) return;
		if (headOf(node) === 'resolution') {
			const unit = atomText(node.items[1]);
			const value = Number(atomText(node.items[2]));
			if (unit && Number.isFinite(value) && value > 0) found = { unit: unit.toLowerCase(), value };
			return;
		}
		for (const child of node.items) if (child.kind === 'list') walk(child);
	};
	walk(root);
	return found;
}

function setResolutions(root: SList, unit: string, value: number): number {
	let n = 0;
	const walk = (node: SList) => {
		const head = headOf(node);
		if (head === 'resolution') {
			node.items = [atom('resolution'), atom(unit), atom(String(value))];
			n++;
			return;
		}
		if (head === 'unit') {
			node.items = [atom('unit'), atom(unit)];
			return;
		}
		for (const child of node.items) if (child.kind === 'list') walk(child);
	};
	walk(root);
	return n;
}

export interface NormalizeResult {
	root: SList;
	/** Microns per original DSN unit. */
	umPerUnit: number;
	original: ResolutionInfo;
	unhandledNumericKeywords: string[];
}

/**
 * Rewrite an EasyEDA DSN tree into real microns, in place. `umPerUnit` is the
 * size of one DSN coordinate unit; EasyEDA writes 10-mil units under a `mil`
 * label, hence the 254 default.
 */
export function normalizeDsnToMicrons(root: SList, umPerUnit = EASYEDA_DSN_UNIT_UM): NormalizeResult {
	const original = readResolution(root) ?? { unit: 'mil', value: 1000 };
	const unhandledNumericKeywords = scaleGeometry(root, umPerUnit, 4);
	if (setResolutions(root, 'um', NORMALIZED_RESOLUTION) === 0) {
		root.items.splice(1, 0, list('resolution', atom('um'), atom(String(NORMALIZED_RESOLUTION))));
	}
	return { root, umPerUnit, original, unhandledNumericKeywords };
}

/**
 * Scale a SES written for the normalized DSN back to the original DSN's units
 * and resolution, in place. SES numbers are integers in board units
 * (coordinate x resolution), so they are rounded back to integers.
 */
export function denormalizeSes(root: SList, umPerUnit: number, original: ResolutionInfo): { unhandledNumericKeywords: string[]; sesResolution?: ResolutionInfo } {
	const sesResolution = readResolution(root);
	const sesRes = sesResolution?.value ?? NORMALIZED_RESOLUTION;
	if (sesResolution && sesResolution.unit !== 'um') {
		throw new Error(`fastroute SES uses (resolution ${sesResolution.unit} ${sesResolution.value}); expected um for a normalized DSN`);
	}
	// board units -> um -> original DSN units -> original board units
	const factor = (1 / sesRes) / umPerUnit * original.value;
	const unhandledNumericKeywords = scaleGeometry(root, factor, 0);
	setResolutions(root, original.unit, original.value);
	return { unhandledNumericKeywords, sesResolution };
}

// ---------------------------------------------------------------------------
// DSN structure / network access
// ---------------------------------------------------------------------------

export interface DsnNetwork {
	nets: string[];
	/** Original class name -> member nets (EasyEDA wraps member names in single quotes; stripped here). */
	classes: Array<{ name: string; nets: string[]; useVia?: string }>;
	/** Copper layer names in DSN order (index = fastroute layer number). */
	layers: string[];
	/** Padstack names listed in the structure `(via ...)` statement. */
	viaPadstacks: string[];
}

export function stripSingleQuotes(name: string): string {
	return name.length >= 2 && name.startsWith("'") && name.endsWith("'") ? name.slice(1, -1) : name;
}

export function readDsnNetwork(root: SList): DsnNetwork {
	const structure = firstChild(root, 'structure');
	const network = firstChild(root, 'network');
	const layers = structure
		? childLists(structure, 'layer').map((l) => atomText(l.items[1]) ?? '').filter(Boolean)
		: [];
	const viaStmt = structure ? firstChild(structure, 'via') : undefined;
	const viaPadstacks = viaStmt ? viaStmt.items.slice(1).map(atomText).filter((s): s is string => !!s) : [];
	const nets = network ? childLists(network, 'net').map((n) => atomText(n.items[1]) ?? '').filter(Boolean) : [];
	const classes = network
		? childLists(network, 'class').map((c) => {
			const name = atomText(c.items[1]) ?? '';
			const members = c.items.slice(2).filter((n): n is SAtom => n.kind === 'atom').map((a) => stripSingleQuotes(a.text)).filter(Boolean);
			const circuit = firstChild(c, 'circuit');
			const useVia = circuit ? atomText(firstChild(circuit, 'use_via')?.items[1]) : undefined;
			return { name: stripSingleQuotes(name), nets: members, ...(useVia ? { useVia } : {}) };
		})
		: [];
	return { nets, classes, layers, viaPadstacks };
}

// ---------------------------------------------------------------------------
// Wiring: lock state per net, copper metrics per net
// ---------------------------------------------------------------------------

export function cloneTree<T extends SNode>(node: T): T {
	return JSON.parse(JSON.stringify(node));
}

function itemNet(node: SList): string | undefined {
	return atomText(firstChild(node, 'net')?.items[1]);
}

const FIXED_TYPES = new Set(['protect', 'fix']);

function isFixed(node: SList): boolean {
	const t = atomText(firstChild(node, 'type')?.items[1]);
	return !!t && FIXED_TYPES.has(t.toLowerCase());
}

export type WiringDecision = 'keep' | 'unlock' | 'remove';

/**
 * Rewrite the DSN `(wiring ...)` per net: keep as exported (EasyEDA marks all
 * existing copper `(type protect)`), unlock (drop the protect so the router may
 * rip up and improve it), or remove it entirely.
 */
export function setDsnWiring(root: SList, decide: (net: string | undefined) => WiringDecision): Record<WiringDecision, number> {
	const counts: Record<WiringDecision, number> = { keep: 0, unlock: 0, remove: 0 };
	const wiring = firstChild(root, 'wiring');
	if (!wiring) return counts;
	wiring.items = wiring.items.filter((n) => {
		if (n.kind !== 'list') return true;
		const head = headOf(n);
		if (head !== 'wire' && head !== 'via') return true;
		const d = decide(itemNet(n));
		counts[d]++;
		if (d === 'remove') return false;
		if (d === 'unlock' && isFixed(n)) n.items = n.items.filter((c) => headOf(c) !== 'type');
		return true;
	});
	return counts;
}

/**
 * EasyEDA's DSN export lists every via twice: as a wiring `(via ...)` and as a
 * through-hole pin of the board image on the via's net. As a pin the via is a
 * fixed point its net must reach, so a reroute routes through every old via
 * position and changes layers there, and that copper is lost once the old vias
 * are deleted. Remove the numeric-id image pins that sit exactly on a wiring
 * via of the same net (the wiring via stays). Only images placed once at
 * 0 0 front 0, as EasyEDA writes its single board image, are touched.
 * Returns the pins removed.
 */
export function stripViaPins(root: SList): number {
	const key = (x: number, y: number) => `${Math.round(x * 1000)}|${Math.round(y * 1000)}`;
	const viaAt = new Map<string, Set<string>>();
	const wiring = firstChild(root, 'wiring');
	for (const v of wiring ? childLists(wiring, 'via') : []) {
		const net = itemNet(v);
		const x = Number(atomText(v.items[2]));
		const y = Number(atomText(v.items[3]));
		if (!net || !Number.isFinite(x) || !Number.isFinite(y)) continue;
		const s = viaAt.get(net) ?? new Set<string>();
		s.add(key(x, y));
		viaAt.set(net, s);
	}
	const placement = firstChild(root, 'placement');
	const library = firstChild(root, 'library');
	const network = firstChild(root, 'network');
	if (!viaAt.size || !placement || !library || !network) return 0;

	// component ref -> image, for images placed exactly once at the origin, unrotated.
	const imageOf = new Map<string, string>();
	for (const c of childLists(placement, 'component')) {
		const image = atomText(c.items[1]);
		const places = childLists(c, 'place');
		if (!image || places.length !== 1) continue;
		const [ref, x, y, side, rot] = places[0].items.slice(1, 6).map(atomText);
		if (ref && Number(x) === 0 && Number(y) === 0 && side === 'front' && Number(rot ?? 0) === 0) imageOf.set(ref, image);
	}
	// (pin PADSTACK [(rotate R)] ID X Y)
	const pinsOf = new Map<string, Map<string, { node: SNode; x: number; y: number }>>();
	for (const img of childLists(library, 'image')) {
		const name = atomText(img.items[1]);
		if (!name || ![...imageOf.values()].includes(name)) continue;
		const pins = new Map<string, { node: SNode; x: number; y: number }>();
		for (const p of childLists(img, 'pin')) {
			const [id, x, y] = p.items.slice(2).filter((n) => n.kind === 'atom').map(atomText);
			if (id && Number.isFinite(Number(x)) && Number.isFinite(Number(y))) pins.set(id, { node: p, x: Number(x), y: Number(y) });
		}
		pinsOf.set(name, pins);
	}

	const drop = new Map<string, Set<SNode>>();
	let removed = 0;
	for (const net of childLists(network, 'net')) {
		const vias = viaAt.get(atomText(net.items[1]) ?? '');
		const pins = firstChild(net, 'pins');
		if (!vias || !pins) continue;
		pins.items = pins.items.filter((ref, i) => {
			if (i === 0 || ref.kind !== 'atom') return true;
			const comp = [...imageOf.keys()].find((r) => ref.text.startsWith(`${r}-`));
			const image = comp ? imageOf.get(comp) : undefined;
			const pinId = comp ? ref.text.slice(comp.length + 1) : '';
			const pin = image ? pinsOf.get(image)?.get(pinId) : undefined;
			// Via pins carry the via's numeric primitive id; component pads look like "107e7".
			if (!image || !pin || !/^\d+$/.test(pinId) || !vias.has(key(pin.x, pin.y))) return true;
			const set = drop.get(image) ?? new Set<SNode>();
			set.add(pin.node);
			drop.set(image, set);
			removed++;
			return false;
		});
	}
	for (const img of childLists(library, 'image')) {
		const set = drop.get(atomText(img.items[1]) ?? '');
		if (set) img.items = img.items.filter((n) => !set.has(n));
	}
	return removed;
}

/**
 * Shrink every pad shape of the padstacks component pins use by `inset` (tree
 * units) on each side. fastroute counts same-net pads that merely touch as
 * connected and routes nothing between them; EasyEDA does not, so a pair of
 * abutting pads (e.g. USB-C VBUS pins) ends up unconnected on the board. With
 * a hairline gap the router joins them with a track. Via padstacks are left
 * alone. Returns the padstacks changed.
 */
export function shrinkPinPadstacks(root: SList, inset: number): number {
	const library = firstChild(root, 'library');
	if (!library || !(inset > 0)) return 0;
	const structure = firstChild(root, 'structure');
	const viaStmt = structure ? firstChild(structure, 'via') : undefined;
	const viaNames = new Set(viaStmt ? viaStmt.items.slice(1).map(atomText).filter((s): s is string => !!s) : []);
	const used = new Set<string>();
	for (const img of childLists(library, 'image')) {
		for (const p of childLists(img, 'pin')) {
			const name = atomText(p.items[1]);
			if (name && !viaNames.has(name)) used.add(name);
		}
	}
	const num = (n: SNode | undefined) => (isNumberAtom(n) ? Number(n.text) : Number.NaN);
	const put = (node: SList, i: number, v: number) => { node.items[i] = atom(formatNumber(v, 4)); };
	let changed = 0;
	for (const ps of childLists(library, 'padstack')) {
		if (!used.has(atomText(ps.items[1]) ?? '')) continue;
		let touched = false;
		for (const sh of childLists(ps, 'shape')) {
			for (const g of childLists(sh)) {
				const head = headOf(g);
				if (head === 'circle') {
					const d = num(g.items[2]);
					if (d > 4 * inset) { put(g, 2, d - 2 * inset); touched = true; }
				} else if (head === 'path') {
					const w = num(g.items[2]);
					if (w > 4 * inset) { put(g, 2, w - 2 * inset); touched = true; }
				} else if (head === 'rect') {
					// (rect LAYER x1 y1 x2 y2)
					const [x1, y1, x2, y2] = [2, 3, 4, 5].map((i) => num(g.items[i]));
					if ([x1, y1, x2, y2].every(Number.isFinite) && Math.abs(x2 - x1) > 4 * inset && Math.abs(y2 - y1) > 4 * inset) {
						const sx = Math.sign(x2 - x1), sy = Math.sign(y2 - y1);
						put(g, 2, x1 + sx * inset); put(g, 4, x2 - sx * inset);
						put(g, 3, y1 + sy * inset); put(g, 5, y2 - sy * inset);
						touched = true;
					}
				} else if (head === 'polygon') {
					const aperture = num(g.items[2]);
					if (aperture > 4 * inset) { put(g, 2, aperture - 2 * inset); touched = true; continue; }
					// A hairline aperture (EasyEDA writes 0.01) only grows the outline; drop it.
					if (aperture > 0) put(g, 2, 0);
					const coords = g.items.slice(3).map(num);
					if (coords.length < 6 || coords.some((v) => !Number.isFinite(v))) continue;
					const pts: Array<{ x: number; y: number }> = [];
					for (let i = 0; i + 1 < coords.length; i += 2) pts.push({ x: coords[i], y: coords[i + 1] });
					const closed = pts.length > 3 && pts[0].x === pts[pts.length - 1].x && pts[0].y === pts[pts.length - 1].y;
					const ring = closed ? pts.slice(0, -1) : pts;
					const inner = insetPolygon(ring, inset);
					if (!inner) continue;
					if (closed) inner.push({ ...inner[0] });
					g.items = [g.items[0], g.items[1], g.items[2], ...inner.flatMap((p) => [atom(formatNumber(p.x, 4)), atom(formatNumber(p.y, 4))])];
					touched = true;
				}
			}
		}
		if (touched) changed++;
	}
	return changed;
}

/** Move every edge of a simple polygon inward by `d` (miter joins); undefined if it would collapse. */
function insetPolygon(pts: Array<{ x: number; y: number }>, d: number): Array<{ x: number; y: number }> | undefined {
	const n = pts.length;
	if (n < 3) return undefined;
	let area2 = 0;
	for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; area2 += a.x * b.y - b.x * a.y; }
	if (Math.abs(area2) < 1e-9) return undefined;
	const ccw = area2 > 0;
	// inward unit normal of edge i (pts[i] -> pts[i+1])
	const normals = pts.map((a, i) => {
		const b = pts[(i + 1) % n];
		const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
		const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len; // left normal
		return ccw ? { x: nx, y: ny } : { x: -nx, y: -ny };
	});
	// Miter: the offset m with m.n1 = m.n2 = d is (n1 + n2) * d / (1 + n1.n2),
	// capped at 4d where the edges nearly reverse.
	return pts.map((p, i) => {
		const n1 = normals[(i - 1 + n) % n], n2 = normals[i];
		const dot = n1.x * n2.x + n1.y * n2.y;
		if (1 + dot < 1e-6) return { x: p.x + n2.x * d, y: p.y + n2.y * d };
		let mx = ((n1.x + n2.x) * d) / (1 + dot);
		let my = ((n1.y + n2.y) * d) / (1 + dot);
		const len = Math.hypot(mx, my);
		if (len > 4 * d) { mx *= (4 * d) / len; my *= (4 * d) / len; }
		return { x: p.x + mx, y: p.y + my };
	});
}

export interface NetCopper { lengthMm: number; vias: number; wires: number }

function pathLength(shape: SList): number {
	const nums = shape.items.slice(3).filter(isNumberAtom).map((a) => Number(a.text));
	let len = 0;
	for (let i = 2; i + 1 < nums.length; i += 2) len += Math.hypot(nums[i] - nums[i - 2], nums[i + 1] - nums[i - 1]);
	return len;
}

function addCopper(out: Map<string, NetCopper>, net: string, node: SList, mmPerUnit: number) {
	const m = out.get(net) ?? { lengthMm: 0, vias: 0, wires: 0 };
	if (headOf(node) === 'via') m.vias++;
	else {
		m.wires++;
		for (const s of node.items) if (s.kind === 'list' && headOf(s) === 'path') m.lengthMm += pathLength(s) * mmPerUnit;
	}
	out.set(net, m);
}

/** Copper per net in a DSN `(wiring ...)`; `mmPerUnit` is the size of one coordinate unit. */
export function dsnNetCopper(root: SList, mmPerUnit: number): Map<string, NetCopper> {
	const out = new Map<string, NetCopper>();
	const wiring = firstChild(root, 'wiring');
	if (!wiring) return out;
	for (const n of childLists(wiring)) {
		const head = headOf(n);
		const net = itemNet(n);
		if ((head === 'wire' || head === 'via') && net) addCopper(out, net, n, mmPerUnit);
	}
	return out;
}

/** Copper per net in a SES `(network_out ...)`; `mmPerUnit` is the size of one board unit. */
export function sesNetCopper(root: SList, mmPerUnit: number): Map<string, NetCopper> {
	const out = new Map<string, NetCopper>();
	const routes = firstChild(root, 'routes');
	const networkOut = routes ? firstChild(routes, 'network_out') : undefined;
	if (!networkOut) return out;
	for (const net of childLists(networkOut, 'net')) {
		const name = atomText(net.items[1]);
		if (!name) continue;
		for (const n of childLists(net)) {
			const head = headOf(n);
			if (head === 'wire' || head === 'via') addCopper(out, name, n, mmPerUnit);
		}
	}
	return out;
}

export interface DsnClassSpec {
	name: string;
	nets: string[];
	widthUm: number;
	clearanceUm: number;
	useVia?: string;
}

/** Replace every `(class ...)` in the network with `classes` (values already in the tree's units). */
export function replaceNetClasses(root: SList, classes: DsnClassSpec[]): void {
	const network = firstChild(root, 'network');
	if (!network) throw new Error('DSN has no (network ...) section');
	network.items = network.items.filter((n) => headOf(n) !== 'class');
	for (const c of classes) {
		const items: SNode[] = [atom('class'), atom(c.name), ...c.nets.map((n) => atom(n, /[\s()"]/.test(n)))];
		if (c.useVia) items.push(list('circuit', list('use_via', atom(c.useVia))));
		items.push(list('rule', list('width', atom(formatNumber(c.widthUm, 1))), list('clearance', atom(formatNumber(c.clearanceUm, 1)))));
		network.items.push({ kind: 'list', items });
	}
}
