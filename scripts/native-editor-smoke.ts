// Native editor actions (undo / redo / cancel / offscreen render) through a
// mocked EasyEDA host UI. Run: npx ts-node --transpile-only scripts/native-editor-smoke.ts
import assert from 'node:assert/strict';

const g = globalThis as any;
let lines = [{ primitiveId: 'L1', net: 'A', layer: 1, startX: 0, startY: 0, endX: 100, endY: 0, lineWidth: 10 }];
const history: any[] = [];
let toolMode = 'route';
const framePublished: string[] = [];
let renderArgs: any;
g.eda = {
	dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: 'doc1', documentType: 3 }) },
	pcb_PrimitiveLine: { getAll: async () => lines },
	pcb_PrimitiveVia: { getAll: async () => [] },
	pcb_PrimitiveComponent: { getAll: async () => [{ primitiveId: 'C1', x: 1000, y: -500 }] },
	pcb_PrimitivePour: { getAll: async () => [] },
	pcb_PrimitivePad: { getAll: async () => [] },
};
g.UI = {
	tabBar: { getActiveTab: () => 'doc1@proj', getTabIFrame: async () => ({ contentWindow: { frame: 'pcb' } }) },
	gVars: {
		messageBus: {
			subscribe: () => ({ cancel() {} }),
			publish: (topic: string) => {
				if (toolMode !== 'select') return; // the editor ignores history while a tool is active
				if (topic === 'undo' && lines.length) history.push(lines.pop());
				if (topic === 'redo' && history.length) lines.push(history.pop());
			},
		},
		windowBridge: {
			publish: (topic: string, _m: any, target: any) => { assert.equal(target.frame, 'pcb'); framePublished.push(topic); if (topic === 'userCancelCurrentCommand') toolMode = 'select'; },
			rpcCall: async (topic: string, args: any, target: any) => {
				assert.equal(topic, 'exportPCBPng'); assert.equal(target.frame, 'pcb');
				renderArgs = args;
				return { message: { width: args.width, height: args.height, data: new Uint8ClampedArray(args.width * args.height * 4), colorSpace: 'srgb' } };
			},
		},
	},
};
// Minimal canvas stand-ins (Node has none).
g.ImageData = class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} };
const drawn: any[] = [];
g.OffscreenCanvas = class {
	constructor(public width: number, public height: number) {}
	getContext() { return { putImageData: () => {}, drawImage: (...a: any[]) => drawn.push(a) }; }
	async convertToBlob() { return new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }); }
};

(async () => {
	const { nativeEditorHandlers: h } = await import('../src/extension/handlers/native-editor');

	// Undo while a routing tool is active: cancelFirst puts the editor in select mode first.
	let r = await h['editor.native.undo']({});
	assert.equal(r.status, 'applied', JSON.stringify(r));
	assert.equal(lines.length, 0);
	assert.ok(framePublished.includes('userCancelCurrentCommand'));
	r = await h['editor.native.redo']({});
	assert.equal(r.status, 'applied');
	assert.equal(lines.length, 1);

	// Nothing to redo → honest no-change, not "applied".
	r = await h['editor.native.redo']({});
	assert.equal(r.status, 'no-change');

	// Cancel command is delivered into the PCB frame.
	toolMode = 'route'; framePublished.length = 0;
	r = await h['editor.native.cancelCommand']({});
	assert.deepEqual(framePublished, ['userCancelCurrentCommand']);

	// Whole-board render: sized from the design bbox, downscaled to width.
	r = await h['pcb.native.renderImage']({ width: 800 });
	assert.equal(r.mimeType, 'image/png');
	assert.ok(r.base64.length > 0);
	assert.equal(r.width, 800);
	assert.equal(r.crop, undefined);

	// Close-up: a 200-mil area gets ~width px, so the full render is scaled up (capped at 8192).
	r = await h['pcb.native.renderImage']({ width: 600, left: 0, right: 200, top: -100, bottom: 100 });
	assert.ok(renderArgs.width >= 3000, JSON.stringify(renderArgs));
	assert.ok(Math.max(renderArgs.width, renderArgs.height) <= 8192);
	assert.equal(r.crop.approximate, true);
	assert.ok(r.width <= 600);

	// Wrong tab active → refuses rather than acting on the wrong document.
	g.UI.tabBar.getActiveTab = () => 'other@proj';
	await assert.rejects(() => h['editor.native.undo']({}), /not the requested document/);

	console.log('Native editor: undo/redo with change detection, cancel into the PCB frame, offscreen render + crop, wrong-tab refusal — passed.');
})().catch((e) => { console.error(e); process.exit(1); });
