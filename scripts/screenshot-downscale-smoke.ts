// Screenshot downscale: editor.screenshot / pcb.screenshot.board /
// pcb.screenshot.closeup shrink captures wider than maxWidth (default 1280)
// before base64-encoding, keep small captures and maxWidth:0 untouched, and
// fall back to the original on any canvas/decoder failure.
// Run: npx ts-node --transpile-only scripts/screenshot-downscale-smoke.ts
import assert from 'node:assert/strict';
import { z } from 'zod';

const g: any = globalThis;
// Fake "PNG": the header carries the dimensions, padding sets the byte size.
const png = (w: number, h: number, bytes: number) => new Blob([`IMG:${w}x${h};`.padEnd(bytes, '.')], { type: 'image/png' });
const dimsOf = async (blob: Blob) => {
	const m = (await blob.text()).match(/^IMG:(\d+)x(\d+);/);
	if (!m) throw new Error('undecodable');
	return { width: Number(m[1]), height: Number(m[2]) };
};

if (typeof g.FileReader !== 'function') {
	g.FileReader = class {
		result: string | null = null;
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		readAsDataURL(blob: Blob) {
			blob.arrayBuffer().then((buf) => {
				this.result = `data:${blob.type};base64,${Buffer.from(buf).toString('base64')}`;
				this.onload?.();
			}, () => this.onerror?.());
		}
	};
}
let closed = 0;
const draws: any[] = [];
const createImageBitmap = async (blob: Blob) => ({ ...(await dimsOf(blob)), close: () => { closed++; } });
// Re-encoded output is ~1/4 of the original bytes unless `inflate` is set.
let inflate = false;
const encode = (w: number, h: number, type: string, original: number) => png(w, h, inflate ? original * 2 : Math.max(64, Math.round(original / 4)));
let lastOriginalSize = 0;
class OffscreenCanvas {
	constructor(public width: number, public height: number) {}
	getContext() { return { drawImage: (...args: any[]) => draws.push(args) }; }
	async convertToBlob(opts: { type: string }) { return encode(this.width, this.height, opts.type, lastOriginalSize); }
}
const domCanvas = () => {
	const c: any = { width: 0, height: 0 };
	c.getContext = () => ({ drawImage: (...args: any[]) => draws.push(args) });
	c.toBlob = (cb: (b: Blob) => void, type: string) => cb(encode(c.width, c.height, type, lastOriginalSize));
	return c;
};

let capture = png(2560, 1440, 40_000);
g.eda = {
	dmt_EditorControl: { getCurrentRenderedAreaImage: async () => { lastOriginalSize = capture.size; return capture; } },
	dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3 }) },
	pcb_Document: {
		stopCalculatingRatline: async () => {}, startCalculatingRatline: async () => {}, zoomToBoardOutline: async () => {},
		navigateToCoordinates: async () => true,
	},
};
const decode = async (b64: string) => dimsOf(new Blob([Buffer.from(b64, 'base64')]));

(async () => {
	const { editorHandlers } = await import('../src/extension/handlers/editor');

	// Decoder + OffscreenCanvas available; no maxWidth → default 1280.
	g.createImageBitmap = createImageBitmap;
	g.OffscreenCanvas = OffscreenCanvas;
	let r: any = await editorHandlers['pcb.screenshot.board']({});
	assert.equal(r.width, 1280);
	assert.equal(r.height, 720);
	assert.deepEqual(r.scaledFrom, { width: 2560, height: 1440, size: 40_000 });
	assert.equal(r.size, 10_000);
	assert.equal(r.mimeType, 'image/png');
	assert.deepEqual(await decode(r.base64), { width: 1280, height: 720 }, 'base64 is the scaled image');
	assert.deepEqual(draws.at(-1).slice(1), [0, 0, 1280, 720]);
	assert.equal(closed, 1, 'bitmap released');

	// Explicit maxWidth, odd aspect ratio.
	r = await editorHandlers['editor.screenshot']({ maxWidth: 1000 });
	assert.equal(r.width, 1000);
	assert.equal(r.height, 563);

	// maxWidth:0 → untouched full resolution, no decode.
	r = await editorHandlers['editor.screenshot']({ maxWidth: 0 });
	assert.equal(r.size, 40_000);
	assert.equal(r.scaledFrom, undefined);
	assert.equal(r.width, undefined);

	// Already narrow → original kept, dimensions reported.
	capture = png(800, 600, 5_000);
	r = await editorHandlers['editor.screenshot']({});
	assert.equal(r.size, 5_000);
	assert.equal(r.width, 800);
	assert.equal(r.scaledFrom, undefined);

	// Re-encode not smaller → original kept.
	capture = png(2000, 1000, 8_000);
	inflate = true;
	r = await editorHandlers['editor.screenshot']({});
	assert.equal(r.size, 8_000);
	assert.equal(r.scaledFrom, undefined);
	inflate = false;

	// No OffscreenCanvas → DOM canvas path.
	delete g.OffscreenCanvas;
	g.document = { createElement: (tag: string) => { assert.equal(tag, 'canvas'); return domCanvas(); } };
	r = await editorHandlers['editor.screenshot']({ maxWidth: 500 });
	assert.equal(r.width, 500);
	assert.equal(r.height, 250);
	assert.deepEqual(await decode(r.base64), { width: 500, height: 250 });
	delete g.document;

	// No canvas at all → original + reason, never an error.
	r = await editorHandlers['editor.screenshot']({});
	assert.equal(r.size, 8_000);
	assert.match(r.downscaleError, /no canvas/);

	// No decoder → original + reason.
	delete g.createImageBitmap;
	r = await editorHandlers['editor.screenshot']({});
	assert.equal(r.size, 8_000);
	assert.match(r.downscaleError, /createImageBitmap/);

	// Closeup keeps its region metadata and is downscaled too.
	g.createImageBitmap = createImageBitmap;
	g.OffscreenCanvas = OffscreenCanvas;
	capture = png(2560, 1440, 40_000);
	r = await editorHandlers['pcb.screenshot.closeup']({ x: 100, y: -50, radiusMil: 80, settleMs: 0 });
	assert.equal(r.width, 1280);
	assert.equal(r.regionApplied, 'centered');
	assert.deepEqual(r.region, { left: 20, right: 180, top: 30, bottom: -130 });

	// MCP tools: maxWidth declared (default 1280), forwarded, summarized.
	const { registerEditorTools } = await import('../src/mcp-server/tools/editor-tools');
	const tools: Record<string, any> = {};
	const schemas: Record<string, any> = {};
	const sent: any[] = [];
	registerEditorTools({ tool: (n: string, _d: string, s: any, h: any) => { tools[n] = h; schemas[n] = s; } } as any,
		{ send: async (method: string, p: any) => { sent.push(p); return editorHandlers[method](p); } } as any);
	const call = (n: string, a: any) => tools[n](z.object(schemas[n]).parse(a));
	for (const name of ['pcb_screenshot_board', 'pcb_screenshot_closeup', 'editor_screenshot']) assert.ok(schemas[name].maxWidth, `${name} declares maxWidth`);
	let out = await call('pcb_screenshot_board', {});
	assert.equal(sent.at(-1).maxWidth, 1280);
	assert.equal(out.content[0].type, 'image');
	assert.equal(out.content[1].text, 'Captured 10000 bytes (image/png, 1280x720; downscaled from 2560x1440, 40000 bytes).');
	out = await call('editor_screenshot', { maxWidth: 0 });
	assert.equal(sent.at(-1).maxWidth, 0);
	assert.match(out.content[1].text, /^Captured 40000 bytes \(image\/png\)\.$/);
	out = await call('pcb_screenshot_closeup', { document: 'd', x: 0, y: 0, settleMs: 0 });
	const meta = JSON.parse(out.content[1].text);
	assert.equal(meta.width, 1280);
	assert.deepEqual(meta.scaledFrom, { width: 2560, height: 1440, size: 40_000 });
	assert.ok(meta.region);

	console.log('screenshot-downscale smoke: OK');
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
