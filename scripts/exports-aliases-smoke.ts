// Exports folder sweep (pcb_export / sch_get_netlist) and via/track argument
// aliases (pcb_create_via_mm called with diameter/holeDiameter, etc.).
// Run: npx ts-node --transpile-only scripts/exports-aliases-smoke.ts
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

// Every export lands under a throwaway HOME — never the real ~/.easyeda-mcp.
const home = mkdtempSync(join(tmpdir(), 'eda-exports-smoke-'));
process.env.HOME = home;
const exportsPath = join(home, '.easyeda-mcp', 'exports');
const DAY = 24 * 60 * 60 * 1000;
const touch = (dir: string, name: string, ageMs: number) => {
	const p = join(dir, name);
	writeFileSync(p, name);
	const t = (Date.now() - ageMs) / 1000;
	utimesSync(p, t, t);
	return p;
};

function fakeServer(bridge: any, register: (s: any, b: any) => void) {
	const tools: Record<string, any> = {};
	const schemas: Record<string, any> = {};
	register({ tool: (n: string, _d: string, s: any, h: any) => { tools[n] = h; schemas[n] = s; } }, bridge);
	return (name: string, args: any) => tools[name](z.object(schemas[name]).parse(args));
}

(async () => {
	const { exportsDir, defaultExportsDir } = await import('../src/mcp-server/exports-dir');
	assert.equal(defaultExportsDir(), exportsPath, 'resolved lazily from HOME');

	// --- sweep: age, then count; dirs untouched ---
	mkdirSync(join(exportsPath, 'keep-me-dir'), { recursive: true });
	touch(exportsPath, 'old.zip', 8 * DAY);
	for (let i = 0; i < 5; i++) touch(exportsPath, `f${i}.txt`, i * 60_000); // f0 newest
	assert.equal(await exportsDir({ maxFiles: 3 }), exportsPath);
	assert.deepEqual(readdirSync(exportsPath).sort(), ['f0.txt', 'f1.txt', 'keep-me-dir'], 'old file + all but newest maxFiles-1 removed');
	await exportsDir(); // defaults: nothing young is removed
	assert.deepEqual(readdirSync(exportsPath).sort(), ['f0.txt', 'f1.txt', 'keep-me-dir']);

	// --- never throws: HOME pointing at a file ---
	const fileHome = join(home, 'not-a-dir');
	writeFileSync(fileHome, 'x');
	process.env.HOME = fileHome;
	assert.equal(await exportsDir(), join(fileHome, '.easyeda-mcp', 'exports'));
	process.env.HOME = home;

	// --- pcb_export: default dir is swept, a caller's outputDir never is ---
	touch(exportsPath, 'stale-gerber.zip', 9 * DAY);
	const { registerManufactureTools } = await import('../src/mcp-server/tools/manufacture-tools');
	const exportCall = fakeServer({ send: async () => ({ fileName: 'gerber.zip', data: Buffer.from('GERBER').toString('base64') }) }, registerManufactureTools);
	let res = JSON.parse((await exportCall('pcb_export', { document: 'd', format: 'gerber' })).content[0].text);
	assert.ok(res.path.startsWith(exportsPath), res.path);
	assert.equal(readFileSync(res.path, 'utf8'), 'GERBER');
	assert.equal(res.data, undefined);
	assert.ok(!existsSync(join(exportsPath, 'stale-gerber.zip')), 'stale export swept');
	const userDir = join(home, 'my-exports');
	mkdirSync(userDir);
	const userOld = touch(userDir, 'precious.zip', 30 * DAY);
	res = JSON.parse((await exportCall('pcb_export', { document: 'd', format: 'gerber', outputDir: userDir })).content[0].text);
	assert.ok(res.path.startsWith(userDir));
	assert.ok(existsSync(userOld), 'outputDir is never pruned');

	// --- sch_get_netlist uses the same swept folder ---
	touch(exportsPath, 'stale-netlist.txt', 10 * DAY);
	const { registerSchReadTools } = await import('../src/mcp-server/tools/sch-read-tools');
	const schCall = fakeServer({ send: async () => 'NETLIST-BODY' }, registerSchReadTools);
	const netText: string = (await schCall('sch_get_netlist', { document: 'd', type: 'PADS' })).content[0].text;
	const saved = netText.match(/saved to (\S+) /)?.[1];
	assert.ok(saved && saved.startsWith(exportsPath), netText);
	assert.equal(readFileSync(saved!, 'utf8'), 'NETLIST-BODY');
	assert.ok(!existsSync(join(exportsPath, 'stale-netlist.txt')), 'stale netlist swept');

	// --- via / track aliases (parsed through the real zod shapes) ---
	const sent: Array<{ method: string; p: any }> = [];
	const { registerWriteTools } = await import('../src/mcp-server/tools/write-tools');
	const write = fakeServer({ send: async (method: string, p: any) => { sent.push({ method, p }); return { ok: true }; } }, registerWriteTools);
	const base = { document: 'd', net: 'GND', x: 10, y: 20 };

	await write('pcb_create_via_mm', { ...base, diameter: 0.6, holeDiameter: 0.3 });
	assert.equal(sent.at(-1)!.method, 'pcb.create.via.mm');
	assert.deepEqual(sent.at(-1)!.p, { document: 'd', net: 'GND', x: 10, y: 20, drill_mm: 0.3, diameter_mm: 0.6 }, 'aliases mapped, not forwarded');
	await write('pcb_create_via_mm', { ...base, diameter_mm: 0.6, drill: 0.3 });
	assert.equal(sent.at(-1)!.p.drill_mm, 0.3);
	await write('pcb_create_via_mm', { ...base, drill_mm: 0.3, diameter_mm: 0.6, viaType: 'Suture' });
	assert.equal(sent.at(-1)!.p.viaType, 'Suture');
	await assert.rejects(write('pcb_create_via_mm', { ...base, diameter: 24, holeDiameter: 12 }), /looks like mil/);
	await assert.rejects(write('pcb_create_via_mm', { ...base, diameter: 0.6 }), /needs drill_mm and diameter_mm/);
	await assert.rejects(write('pcb_create_via_mm', { ...base, diameter_mm: 0.3, drill_mm: 0.3 }), /annular ring/);

	await write('pcb_create_via', { ...base, holeDiameter: 12, diameter: 24 });
	assert.deepEqual(sent.at(-1)!.p, { document: 'd', net: 'GND', x: 10, y: 20, holeDiameter: 12, diameter: 24 });
	await write('pcb_create_via', { ...base, drill_mm: 0.3, diameter_mm: 0.6 });
	assert.equal(sent.at(-1)!.method, 'pcb.create.via');
	assert.deepEqual([sent.at(-1)!.p.holeDiameter, sent.at(-1)!.p.diameter], [11.811, 23.622], 'mm converted to mil');
	await write('pcb_create_via', { ...base, drill: 10, diameter: 20 });
	assert.equal(sent.at(-1)!.p.holeDiameter, 10);
	await assert.rejects(write('pcb_create_via', { ...base, diameter: 24 }), /needs holeDiameter and diameter/);

	const track = { document: 'd', net: 'GND', layer: 'Top', startX: 0, startY: 0, endX: 100, endY: 0 };
	await write('pcb_create_track', { ...track, width: 12 });
	assert.equal(sent.at(-1)!.method, 'pcb.create.line');
	assert.equal(sent.at(-1)!.p.lineWidth, 12);
	assert.equal(sent.at(-1)!.p.width, undefined);
	assert.equal(sent.at(-1)!.p.layer, 'Top', 'layer passed through; normalizeLayer resolves Top/Bottom');
	await write('pcb_create_track', { ...track, width_mil: 8 });
	assert.equal(sent.at(-1)!.p.lineWidth, 8);
	await write('pcb_create_track', { ...track, lineWidth: 6, width: 99 });
	assert.equal(sent.at(-1)!.p.lineWidth, 6, 'canonical name wins');
	await write('pcb_create_track', track);
	assert.equal(sent.at(-1)!.p.lineWidth, undefined, 'design-rule width when omitted');

	const { normalizeLayer } = await import('../src/extension/handlers/_utils');
	assert.equal(normalizeLayer('Top'), 1);
	assert.equal(normalizeLayer('Bottom'), 2);

	rmSync(home, { recursive: true, force: true });
	console.log('exports-aliases smoke: OK');
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
