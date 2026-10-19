// Pure BOM analyzer — consumes a sch.extract.design snapshot, produces
// normalized BOM rows + gap audit + distributor classification.
//
// Pure module: no bridge calls, no IO, no side effects. All async work
// (LCSC enrichment, datasheet fetch) lives in the tool wrappers, not here.
//
// kicad-happy reference: skills/bom/scripts/bom_manager.py

export interface DesignSnapshotMinimal {
	components: Record<string, ComponentLike>;
	stats?: { byClass?: Record<string, number> };
	project?: { name?: string };
}

export interface ComponentLike {
	designator: string;
	mpn?: string;
	manufacturer?: string;
	supplier?: string;
	supplierId?: string;
	value?: string;
	unit?: string;
	footprint?: string;
	deviceClass?: string;
	addIntoBom?: boolean;
	otherProperties?: Record<string, any>;
}

export type Population = 'fitted' | 'dnp' | 'unknown';

export interface BomRow {
	id: string;
	population: Population;
	excluded: boolean;
	conflicts: string[];
	sources: Array<{ id: string; component: ComponentLike }>;
	designators: string[];     // collapsed: ["R1","R2","R3"]
	qty: number;
	mpn: string;
	manufacturer: string;
	value: string;
	footprint: string;
	deviceClass: string;
	distributor: string;        // 'lcsc' | 'digikey' | 'mouser' | 'unknown'
	distributorId: string;      // C12345 / 296-1234-1-ND / etc.
	dnp: boolean;
	gaps: BomGap[];
}

export type BomGap = 'mpn' | 'manufacturer' | 'value' | 'footprint' | 'distributor';

export interface BomReport {
	project: string;
	rowCount: number;
	componentCount: number;
	rows: BomRow[];
	gapsSummary: Record<BomGap, number>;
	distributorBreakdown: Record<string, number>;
	dnpCount: number;
	excludedCount: number;
	unknownPopulationCount: number;
	groupingPolicy: string;
}

// ---------------------------------------------------------------------------
// Distributor detection — supplier IDs follow predictable patterns.

const DISTRIBUTOR_PATTERNS: Array<{ name: string; re: RegExp }> = [
	{ name: 'lcsc', re: /^C\d{4,}$/i },                // C12345
	{ name: 'digikey', re: /^[A-Z0-9]+-[A-Z0-9-]+(-ND)?$/i }, // 296-1234-1-ND
	{ name: 'mouser', re: /^\d{3}-[A-Z0-9]+$/i },     // 595-LM358N
	{ name: 'arrow', re: /^[A-Z0-9]+\s*\(.*\)$/i },
	{ name: 'farnell', re: /^\d{6,}$/ },               // 1234567
];

export function classifyDistributor(supplier?: string, supplierId?: string): { distributor: string; distributorId: string } {
	const id = (supplierId || '').trim();
	const sup = (supplier || '').trim().toLowerCase();
	if (sup === 'lcsc' || /^c\d{4,}$/i.test(id)) return { distributor: 'lcsc', distributorId: id };
	if (sup === 'digikey') return { distributor: 'digikey', distributorId: id };
	if (sup === 'mouser') return { distributor: 'mouser', distributorId: id };
	for (const { name, re } of DISTRIBUTOR_PATTERNS) {
		if (re.test(id)) return { distributor: name, distributorId: id };
	}
	if (id) return { distributor: 'other', distributorId: id };
	return { distributor: 'unknown', distributorId: '' };
}

// ---------------------------------------------------------------------------
// Preserve the complete part number; packaging suffixes are manufacturer-specific.
export function normalizeMpn(mpn: string): string {
	return (mpn || '').trim().toUpperCase();
}

const DNP_KEYS = new Set(['dnp', 'donotpopulate', 'noinstall', 'unmounted']);
const FITTED_KEYS = new Set(['place', 'populate', 'fitted', 'mounted']);

export function componentPopulation(c: ComponentLike): { population: Population; conflicts: string[] } {
	const evidence: boolean[] = [];
	const conflicts: string[] = [];
	for (const [key, value] of Object.entries(c.otherProperties || {})) {
		const normalized = key.toLowerCase().replace(/[\s_-]/g, '');
		if (!DNP_KEYS.has(normalized) && !FITTED_KEYS.has(normalized)) continue;
		const token = String(value).trim().toLowerCase();
		const yes = ['true', 'yes', '1'].includes(token);
		const no = ['false', 'no', '0'].includes(token);
		if (token === 'dnp') evidence.push(true);
		else if (yes || no) evidence.push(DNP_KEYS.has(normalized) ? yes : no);
		else if (token) conflicts.push(`Unrecognized population field: ${key}`);
	}
	if (evidence.includes(true) && evidence.includes(false)) conflicts.push('Contradictory population fields');
	return {
		population: conflicts.length || !evidence.length ? 'unknown' : evidence[0] ? 'dnp' : 'fitted',
		conflicts,
	};
}

/** BOM exclusion alone says nothing about whether a component is physically fitted. */
export function isDnp(c: ComponentLike): boolean {
	return componentPopulation(c).population === 'dnp';
}

// ---------------------------------------------------------------------------
// Designator collapsing — natural-sort and group by base prefix.
//   ["R1","R2","R3","R10"] → "R1-R3, R10" handled by export, not here.
//   This module keeps the array — formatting is a CSV concern.

function sortDesignators(designators: string[]): string[] {
	return [...designators].sort((a, b) => {
		const m1 = a.match(/^([A-Za-z]+)(\d+)/);
		const m2 = b.match(/^([A-Za-z]+)(\d+)/);
		if (m1 && m2 && m1[1] === m2[1]) return Number(m1[2]) - Number(m2[2]);
		return a.localeCompare(b);
	});
}

// ---------------------------------------------------------------------------
// Main: snapshot → BOM rows.

export function buildBom(snapshot: DesignSnapshotMinimal): BomReport {
	const components = Object.entries(snapshot.components || {});
	const rowsByKey = new Map<string, BomRow>();

	for (const [id, c] of components) {
		// Always include in BOM unless explicitly excluded — DNP rows are kept
		// with dnp=true so the user can see them, matching kicad-happy behavior.
		const { population, conflicts } = componentPopulation(c);
		const dnp = population === 'dnp';
		const excluded = c.addIntoBom === false;
		const mpnNorm = normalizeMpn(c.mpn || '');
		const value = (c.value || '').trim();
		const footprint = (c.footprint || '').trim();

		const dist = classifyDistributor(c.supplier, c.supplierId);
		// Missing identity does not establish interchangeability. Include all source
		// properties so differences in ratings/tolerance cannot disappear in grouping.
		const identityComplete = mpnNorm && c.manufacturer?.trim() && footprint;
		const groupKey = JSON.stringify([
			identityComplete ? null : id, mpnNorm, c.manufacturer?.trim() || '',
			value, c.unit || '', footprint, c.deviceClass || '', dist.distributor,
			dist.distributorId, population, excluded,
			Object.entries(c.otherProperties || {}).sort(([a], [b]) => a.localeCompare(b)),
		]);

		const gaps: BomGap[] = [];
		if (!c.mpn && !['resistor', 'capacitor', 'inductor', 'ferrite_bead'].includes(c.deviceClass || '')) gaps.push('mpn');
		if (!c.manufacturer && c.mpn) gaps.push('manufacturer');
		if (!value && ['resistor', 'capacitor', 'inductor'].includes(c.deviceClass || '')) gaps.push('value');
		if (!footprint) gaps.push('footprint');
		if (dist.distributor === 'unknown' && c.mpn) gaps.push('distributor');

		const existing = rowsByKey.get(groupKey);
		if (existing && existing.dnp === dnp) {
			existing.designators.push(c.designator);
			existing.qty += 1;
			existing.sources.push({ id, component: c });
		} else {
			rowsByKey.set(groupKey, {
				id: '', population, excluded, conflicts,
				sources: [{ id, component: c }],
				designators: [c.designator],
				qty: 1,
				mpn: c.mpn || '',
				manufacturer: c.manufacturer || '',
				value,
				footprint,
				deviceClass: c.deviceClass || 'unknown',
				distributor: dist.distributor,
				distributorId: dist.distributorId,
				dnp,
				gaps,
			});
		}
	}

	const rows = [...rowsByKey.values()];
	for (const r of rows) {
		r.designators = sortDesignators(r.designators);
		r.id = JSON.stringify(r.sources.map(source => source.id).sort());
		if (r.mpn && rows.some(other => other !== r && normalizeMpn(other.mpn) === normalizeMpn(r.mpn)
			&& (other.manufacturer !== r.manufacturer || other.footprint !== r.footprint || other.value !== r.value))) {
			r.conflicts.push('Same MPN has conflicting manufacturer, footprint or value metadata');
		}
	}
	rows.sort((a, b) => {
		// DNPs to the bottom, then by deviceClass, then by designator
		if (a.dnp !== b.dnp) return a.dnp ? 1 : -1;
		if (a.deviceClass !== b.deviceClass) return a.deviceClass.localeCompare(b.deviceClass);
		return a.designators[0].localeCompare(b.designators[0]);
	});

	const gapsSummary: Record<BomGap, number> = { mpn: 0, manufacturer: 0, value: 0, footprint: 0, distributor: 0 };
	const distBreakdown: Record<string, number> = {};
	let dnpCount = 0;
	for (const r of rows) {
		for (const g of r.gaps) gapsSummary[g] += 1;
		distBreakdown[r.distributor] = (distBreakdown[r.distributor] || 0) + 1;
		if (r.dnp) dnpCount += r.qty;
	}

	return {
		project: snapshot.project?.name || '',
		rowCount: rows.length,
		componentCount: components.length,
		rows,
		gapsSummary,
		distributorBreakdown: distBreakdown,
		dnpCount,
		excludedCount: rows.filter(r => r.excluded).reduce((sum, r) => sum + r.qty, 0),
		unknownPopulationCount: rows.filter(r => r.population === 'unknown').reduce((sum, r) => sum + r.qty, 0),
		groupingPolicy: 'complete-identity-and-metadata-v2',
	};
}

// ---------------------------------------------------------------------------
// CSV export — kicad-happy produces a tracking sheet that's easy to merge
// with later runs. Distributor columns are conditional.

export interface CsvOptions {
	/** Existing CSV content — if provided, preserve user-edited columns
	 *  (Chosen_Distributor, Notes, etc.) by joining on Designators. */
	existingCsv?: string;
	includeColumns?: Array<'lcsc' | 'digikey' | 'mouser'>;
}

const BASE_COLUMNS = [
	'Designators',
	'Qty',
	'MPN',
	'Manufacturer',
	'Value',
	'Footprint',
	'DeviceClass',
	'Distributor',
	'DistributorID',
	'DNP',
	'Gaps',
	'RowID',
	'Population',
	'ExcludedFromBOM',
	'Conflicts',
] as const;

function csvEscape(v: any): string {
	let s = v == null ? '' : String(v);
	// Spreadsheet-safe text export. Existing escaped values remain escaped.
	if (/^[\s]*[=+@-]/.test(s)) s = "'" + s;
	if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
	return s;
}

export function bomToCsv(report: BomReport, opts: CsvOptions = {}): string {
	const extraCols = (opts.includeColumns || []).flatMap((c) => [`${c}_PN`, `${c}_Stock`]);
	const header = [...BASE_COLUMNS, 'Chosen_Distributor', 'Notes', ...extraCols];

	const userColsByKey: Record<string, Record<string, string>> = {};
	if (opts.existingCsv) {
		// Best-effort merge: parse header, find Designators column, preserve user fields.
		const lines = parseCsv(opts.existingCsv);
		if (lines.length > 1) {
			const hdr = lines[0];
			const idIdx = hdr.indexOf('RowID');
			const designatorIdx = hdr.indexOf('Designators');
			const preservedCols = ['Chosen_Distributor', 'Notes'];
			for (let i = 1; i < lines.length; i++) {
				const cells = lines[i];
				const key = cells[idIdx] || cells[designatorIdx] || '';
				const obj: Record<string, string> = {};
				for (const c of preservedCols) {
					const idx = hdr.indexOf(c);
					if (idx >= 0) obj[c] = cells[idx] ?? '';
				}
				if (key) userColsByKey[key] = obj;
			}
		}
	}

	const out: string[] = [header.map(csvEscape).join(',')];
	for (const r of report.rows) {
		const key = r.designators.join(', ');
		const preserved = userColsByKey[r.id] || userColsByKey[key] || {};
		const row: any[] = [
			key,
			r.qty,
			r.mpn,
			r.manufacturer,
			r.value,
			r.footprint,
			r.deviceClass,
			r.distributor,
			r.distributorId,
			r.dnp ? 'DNP' : '',
			r.gaps.join(';'),
			r.id,
			r.population,
			r.excluded ? 'yes' : 'no',
			r.conflicts.join('; '),
			preserved.Chosen_Distributor || r.distributor,
			preserved.Notes || '',
			...(opts.includeColumns || []).flatMap(() => ['', '']),
		];
		out.push(row.map(csvEscape).join(','));
	}
	return out.join('\n') + '\n';
}

function parseCsv(csv: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [], cell = '', quoted = false;
	for (let i = 0; i < csv.length; i++) {
		const c = csv[i];
		if (quoted) {
			if (c === '"' && csv[i + 1] === '"') { cell += '"'; i++; }
			else if (c === '"') quoted = false;
			else cell += c;
		} else if (c === '"' && !cell) quoted = true;
		else if (c === ',') { row.push(cell); cell = ''; }
		else if (c === '\n' || c === '\r') {
			if (c === '\r' && csv[i + 1] === '\n') i++;
			row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = '';
		} else cell += c;
	}
	if (quoted) throw new Error('Unterminated quoted CSV field');
	row.push(cell); if (row.some(Boolean)) rows.push(row);
	return rows;
}
