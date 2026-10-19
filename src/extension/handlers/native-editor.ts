// Native editor actions — undo / redo / cancel-current-command and an
// offscreen board render, driven through EasyEDA's own editor bus (the same
// host bridge as native-copper.ts). None of these exist in the public SDK on
// EasyEDA Pro 2.2.47; agents used the GUI (Ctrl+Z ×43, Escape ×400+) instead.
//
//   undo / redo   pcb.js subscribes 'undo'/'redo' on the TOP bus; the active
//                 PCB editor applies one history step (only in select mode).
//   cancel        pcb.js subscribes 'userCancelCurrentCommand' on its own
//                 frame bus → back to the select tool (= pressing Escape).
//   render        frame rpcService 'exportPCBPng' {width,height} renders the
//                 whole design offscreen (black background, current layer
//                 visibility) and restores the camera — the user's view never
//                 moves. Returns raw RGBA ImageData; encoded to PNG here.

import { didTimeOut, flattenStateArray, readWithTimeout } from './_utils';
import { readCopperSource, resolveNativePcbTab, type NativePcbTab } from './native-copper';

const STEP_GAP_MS = 150;
const CHANGE_WAIT_MS = 3_000;
const RENDER_RPC_MS = 20_000;
const MAX_RENDER_PX = 8192;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function activeDocumentUuid(): Promise<string | undefined> {
	const doc = await readWithTimeout(() => eda.dmt_SelectControl.getCurrentDocumentInfo(), 3_000).catch(() => undefined);
	if (!doc || didTimeOut(doc)) return undefined;
	return (doc as any)?.uuid ? String((doc as any).uuid) : undefined;
}

async function nativeTab(): Promise<NativePcbTab> {
	const resolved = await resolveNativePcbTab(await activeDocumentUuid());
	if (!resolved.tab) throw new Error(`${resolved.error} (nativeHost: ${JSON.stringify(resolved.status)}) — GUI fallback: Ctrl+Z / Ctrl+Y / Esc.`);
	return resolved.tab;
}

function cancelCommand(tab: NativePcbTab): void {
	tab.host.windowBridge.publish('userCancelCurrentCommand', { command: 'cancel' }, tab.target);
}

/** Cheap board fingerprint: did an undo/redo actually change anything? */
async function boardFingerprint(tab?: NativePcbTab): Promise<string> {
	const [lines, vias, comps, pours] = await Promise.all([
		eda.pcb_PrimitiveLine.getAll(undefined, undefined, undefined).catch(() => []),
		eda.pcb_PrimitiveVia.getAll(undefined, undefined).catch(() => []),
		eda.pcb_PrimitiveComponent.getAll().catch(() => []),
		eda.pcb_PrimitivePour.getAll(undefined, undefined, undefined).catch(() => []),
	]);
	const parts: string[] = [];
	for (const l of flattenStateArray(lines as any[])) parts.push(`L${l.primitiveId}:${l.net}:${l.layer}:${l.startX},${l.startY},${l.endX},${l.endY},${l.lineWidth}`);
	for (const v of flattenStateArray(vias as any[])) parts.push(`V${v.primitiveId}:${v.net}:${v.x},${v.y},${v.diameter}`);
	for (const c of flattenStateArray(comps as any[])) parts.push(`C${c.primitiveId}:${c.x},${c.y},${c.rotation},${c.layer}`);
	for (const p of flattenStateArray(pours as any[])) parts.push(`P${p.primitiveId}:${p.net}:${p.layer}:${p.pourName}`);
	// Poured copper (a repour, or undoing one) is invisible to the SDK reads.
	if (tab) {
		const copper = await readCopperSource(tab);
		if (!('error' in copper)) for (const [pour, c] of copper.byPour) parts.push(`F${pour}:${c.fillIds.join(',')}`);
	}
	parts.sort();
	let h = 0;
	for (const s of parts) for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return `${parts.length}:${h}`;
}

async function historyStep(kind: 'undo' | 'redo', params: Record<string, any>): Promise<any> {
	const tab = await nativeTab();
	const bus = tab.host.messageBus as any;
	if (typeof bus.publish !== 'function') throw new Error('The editor message bus has no publish(); GUI fallback: Ctrl+Z / Ctrl+Y.');
	const steps = Math.max(1, Math.min(20, Math.floor(Number(params.steps ?? 1))));
	// The editor ignores undo/redo while a drawing/routing tool is active.
	if (params.cancelFirst !== false) { cancelCommand(tab); await sleep(STEP_GAP_MS); }
	const before = await boardFingerprint(tab);
	for (let i = 0; i < steps; i++) {
		bus.publish(kind, '');
		await sleep(STEP_GAP_MS);
	}
	let after = await boardFingerprint(tab);
	const deadline = Date.now() + CHANGE_WAIT_MS;
	while (after === before && Date.now() < deadline) {
		await sleep(250);
		after = await boardFingerprint(tab);
	}
	const changed = after !== before;
	return {
		status: changed ? 'applied' : 'no-change',
		action: kind,
		steps,
		changed,
		note: changed
			? `${kind} applied on the active PCB (EasyEDA history; affects the whole document, including other agents' edits). Cached board reads refresh on the next call.`
			: `No change detected in tracks, vias, component placement, pour outlines or poured copper: there was nothing to ${kind}, the editor was busy (dialog open), or the step touched something this check cannot see (text, dimensions, pour settings). Check with a read or pcb_render_image before retrying.`,
	};
}

// ---------------------------------------------------------------------------
// Offscreen render
// ---------------------------------------------------------------------------

interface Box { minX: number; minY: number; maxX: number; maxY: number }

/** Approximation of the editor's design bbox (all copper/outline/components), in API mil. */
async function designBounds(): Promise<Box | undefined> {
	const [lines, vias, comps, pads] = await Promise.all([
		eda.pcb_PrimitiveLine.getAll(undefined, undefined, undefined).catch(() => []),
		eda.pcb_PrimitiveVia.getAll(undefined, undefined).catch(() => []),
		eda.pcb_PrimitiveComponent.getAll().catch(() => []),
		eda.pcb_PrimitivePad.getAll(undefined, undefined, undefined).catch(() => []),
	]);
	const b: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
	const add = (x: any, y: any) => {
		const X = Number(x), Y = Number(y);
		if (!Number.isFinite(X) || !Number.isFinite(Y)) return;
		b.minX = Math.min(b.minX, X); b.maxX = Math.max(b.maxX, X); b.minY = Math.min(b.minY, Y); b.maxY = Math.max(b.maxY, Y);
	};
	for (const l of flattenStateArray(lines as any[])) { add(l.startX, l.startY); add(l.endX, l.endY); }
	for (const v of flattenStateArray(vias as any[])) add(v.x, v.y);
	for (const c of flattenStateArray(comps as any[])) add(c.x, c.y);
	for (const p of flattenStateArray(pads as any[])) add(p.x, p.y);
	return Number.isFinite(b.minX) && b.maxX > b.minX && b.maxY > b.minY ? b : undefined;
}

function makeCanvas(w: number, h: number): any {
	const g = globalThis as any;
	if (typeof g.OffscreenCanvas === 'function') return new g.OffscreenCanvas(w, h);
	const c = g.document.createElement('canvas');
	c.width = w; c.height = h;
	return c;
}

async function canvasToBase64Png(canvas: any): Promise<{ base64: string; size: number }> {
	const blob: Blob = typeof canvas.convertToBlob === 'function'
		? await canvas.convertToBlob({ type: 'image/png' })
		: await new Promise<Blob>((resolve, reject) => canvas.toBlob((b: Blob | null) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png'));
	const buf = new Uint8Array(await blob.arrayBuffer());
	let bin = '';
	for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
	return { base64: btoa(bin), size: buf.length };
}

async function renderImage(params: Record<string, any>): Promise<any> {
	const tab = await nativeTab();
	const rpc = tab.host.windowBridge.rpcCall;
	if (typeof rpc !== 'function') throw new Error('The editor message bridge has no rpcCall; use pcb_screenshot_board.');
	const bounds = await designBounds();
	if (!bounds) throw new Error('The PCB has no geometry to render.');
	const bw = bounds.maxX - bounds.minX, bh = bounds.maxY - bounds.minY;
	const outWidth = Math.max(200, Math.min(4096, Math.floor(Number(params.width ?? 1600))));

	const region: Box | undefined = ['left', 'right', 'top', 'bottom'].every((k) => Number.isFinite(Number(params[k])))
		? { minX: Math.min(+params.left, +params.right), maxX: Math.max(+params.left, +params.right), minY: Math.min(+params.top, +params.bottom), maxY: Math.max(+params.top, +params.bottom) }
		: undefined;
	// Pixels per mil needed so the requested area (or the whole board) gets outWidth px.
	const wantPxPerMil = outWidth / (region ? region.maxX - region.minX : bw);
	let W = Math.ceil((bw * wantPxPerMil) / 0.99), H = Math.ceil((bh * wantPxPerMil) / 0.99);
	const cap = Math.max(W, H) > MAX_RENDER_PX ? MAX_RENDER_PX / Math.max(W, H) : 1;
	W = Math.max(64, Math.floor(W * cap)); H = Math.max(64, Math.floor(H * cap));

	const reply = await readWithTimeout(() => rpc.call(tab.host.windowBridge, 'exportPCBPng', { width: W, height: H }, tab.target, RENDER_RPC_MS), RENDER_RPC_MS + 1_000)
		.catch((err: any) => ({ __error: err?.message ?? String(err) }));
	if (didTimeOut(reply)) throw new Error(`The editor did not return a render within ${RENDER_RPC_MS} ms; use pcb_screenshot_board.`);
	if ((reply as any)?.__error) throw new Error(`exportPCBPng failed: ${(reply as any).__error}`);
	const img = (reply as any)?.message;
	if (!img?.data || !img.width || !img.height) throw new Error('exportPCBPng returned no pixels.');

	const full = makeCanvas(img.width, img.height);
	full.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);

	// The editor centres its design bbox and fits it at 0.99 scale. Our bbox is
	// an approximation of the editor's (texts/body outlines may extend it), so
	// region crops are approximate; a full render is exact.
	const n = 0.99 * Math.min(img.width / bw, img.height / bh);
	const cx = (bounds.minX + bounds.maxX) / 2, cy = (bounds.minY + bounds.maxY) / 2;
	const toPx = (x: number, y: number) => ({ x: img.width / 2 + (x - cx) * n, y: img.height / 2 - (y - cy) * n });
	let out = full;
	let crop: any;
	if (region) {
		const margin = Math.max(10, 0.15 * Math.max(region.maxX - region.minX, region.maxY - region.minY));
		const a = toPx(region.minX - margin, region.maxY + margin), b = toPx(region.maxX + margin, region.minY - margin);
		const sx = Math.max(0, Math.floor(Math.min(a.x, b.x))), sy = Math.max(0, Math.floor(Math.min(a.y, b.y)));
		const sw = Math.min(img.width - sx, Math.ceil(Math.abs(b.x - a.x))), sh = Math.min(img.height - sy, Math.ceil(Math.abs(b.y - a.y)));
		if (sw < 4 || sh < 4) throw new Error('The requested region lies outside the board render.');
		const scale = Math.min(1, outWidth / sw);
		out = makeCanvas(Math.round(sw * scale), Math.round(sh * scale));
		out.getContext('2d').drawImage(full, sx, sy, sw, sh, 0, 0, out.width, out.height);
		crop = { region, marginMil: Math.round(margin), approximate: true, pxPerMil: Math.round(n * scale * 100) / 100 };
	} else if (img.width > outWidth) {
		const scale = outWidth / img.width;
		out = makeCanvas(outWidth, Math.round(img.height * scale));
		out.getContext('2d').drawImage(full, 0, 0, out.width, out.height);
	}
	const png = await canvasToBase64Png(out);
	return {
		mimeType: 'image/png',
		size: png.size,
		base64: png.base64,
		width: out.width,
		height: out.height,
		renderedPx: [img.width, img.height],
		crop,
		note: region
			? 'Offscreen render (your view did not move). The crop is placed from an approximate design bbox — check the frame shows what you expect.'
			: 'Offscreen render of the whole design (your view did not move); black background, current layer visibility.',
	};
}

export const nativeEditorHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'editor.native.undo': (params) => historyStep('undo', params),
	'editor.native.redo': (params) => historyStep('redo', params),
	'editor.native.cancelCommand': async () => {
		const tab = await nativeTab();
		cancelCommand(tab);
		return { status: 'dispatched', note: 'Sent the editor back to the select tool (same as Esc). Open dialogs are not closed by this.' };
	},
	'pcb.native.renderImage': (params) => renderImage(params),
};
