import { schComponentHandlers } from './sch-component';
import { normalizeWireLine, wireEndpoints } from './sch-geometry';
import { flattenState } from './_utils';

function withSdkTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`SDK call "${label}" did not return within ${ms}ms — likely a network conflict, modal dialog, or runtime stall.`)), ms);
		promise.then(
			(v) => { clearTimeout(t); resolve(v); },
			(e) => { clearTimeout(t); reject(e); },
		);
	});
}

export const schWireHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	// `line` accepts a flat polyline, point pairs, or several flat polylines
	// (see normalizeWireLine — point pairs used to reach EasyEDA as one-point
	// polylines and fail with "create failed!").
	'sch.wire.create': async (params) => {
		const line = normalizeWireLine(params.line);
		const net = typeof params.net === 'string' && params.net ? params.net : undefined;
		const create = (withNet: string | undefined) => withSdkTimeout(
			eda.sch_PrimitiveWire.create(line, withNet, params.color, params.lineWidth, params.lineType),
			15_000,
			'sch_PrimitiveWire.create',
		);
		let result: any;
		let firstError: string | undefined;
		try { result = await create(net); } catch (err: any) { firstError = err?.message ?? String(err); }
		if (!result && net) {
			// EasyEDA can refuse to create a wire *with* a net name that it would
			// accept unnamed. Create it plain, then name it through the wire
			// object (same path as sch_modify_wire), and roll back if naming fails.
			let plain: any;
			try { plain = await create(undefined); } catch { /* reported below */ }
			if (plain) {
				try {
					plain.setState_Net(net);
					await withSdkTimeout(plain.done(), 10_000, 'sch wire done()');
					result = plain;
				} catch (err: any) {
					try { await eda.sch_PrimitiveWire.delete(plain); } catch { /* best effort */ }
					firstError = `${firstError ?? 'create with net failed'}; naming an unnamed wire "${net}" also failed: ${err?.message ?? err}`;
				}
			}
		}
		if (!result) {
			throw new Error(`sch.wire.create failed${firstError ? ` (${firstError})` : ''}. Endpoints ${JSON.stringify(wireEndpoints(line))}. Common causes: (1) the endpoints land on pins/wires already on a different net than "${net ?? '(auto)'}", (2) the path crosses a wire on a conflicting net, (3) off-grid coordinates. Check with sch_get_pin_position / sch_get_all_wires.`);
		}
		// EasyEDA merges a stub that touches an existing wire end into that
		// wire; the returned object can then carry net "" even though the
		// net name survives on the merged wire. Say so instead of implying the
		// requested name was dropped.
		const flat = flattenState(result);
		const gotNet = String(flat.net ?? '');
		if (net && gotNet.toUpperCase() !== net.toUpperCase()) {
			flat.warnings = [`EasyEDA returned net "${gotNet}" instead of "${net.toUpperCase()}" (usually because the new segment was merged into an existing wire). Verify with sch_get_all_wires {net:"${net}"} before renaming anything.`];
		}
		return flat;
	},

	// Wire two pins by reference. Resolves both pins to coordinates, picks
	// a Manhattan path (single-corner: horizontal-then-vertical, or
	// vertical-then-horizontal — caller can override via `cornerAxis`),
	// and emits one wire primitive per leg.
	//
	// from / to: {designator, pinNumber} or "U3.3" string shorthand.
	// net: optional — if both pins already share a non-empty net the wire
	//      inherits it; otherwise the caller's `net` wins.
	// cornerAxis: 'h' (default — horizontal first, then vertical),
	//             'v' (vertical first, then horizontal),
	//             'auto' (pick whichever produces shorter total length).
	'sch.wire.pins': async (params) => {
		const parseRef = (ref: any): { designator: string; pinNumber: string } => {
			if (typeof ref === 'string') {
				const m = ref.match(/^([^.]+)\.(.+)$/);
				if (!m) throw new Error(`Invalid pin reference "${ref}". Use "U3.3", "U3.EN", or {designator, pinNumber}.`);
				return { designator: m[1], pinNumber: m[2] };
			}
			if (ref && typeof ref === 'object' && ref.designator) {
				return { designator: String(ref.designator), pinNumber: String(ref.pinNumber ?? ref.pin) };
			}
			throw new Error('Pin reference must be a string "U3.3" or {designator, pinNumber}.');
		};

		const fromRef = parseRef(params.from);
		const toRef = parseRef(params.to);

		// Resolve both pins via the existing find-pin helper.
		const findPin = schComponentHandlers['sch.component.findPin'];
		const [fromPin, toPin] = await Promise.all([
			findPin({ designator: fromRef.designator, pinNumber: fromRef.pinNumber }),
			findPin({ designator: toRef.designator, pinNumber: toRef.pinNumber }),
		]);

		// Decide net.
		let net: string | undefined = params.net;
		if (!net) {
			if (fromPin.net && toPin.net && fromPin.net === toPin.net) net = fromPin.net;
			else if (fromPin.net && !toPin.net) net = fromPin.net;
			else if (toPin.net && !fromPin.net) net = toPin.net;
		}

		// Build path. Single-corner Manhattan when the pins differ in both
		// axes; otherwise straight line.
		const x1 = fromPin.x, y1 = fromPin.y;
		const x2 = toPin.x, y2 = toPin.y;

		let segments: number[][];
		if (x1 === x2 || y1 === y2) {
			segments = [[x1, y1], [x2, y2]];
		} else {
			const cornerAxis: 'h' | 'v' | 'auto' = (params.cornerAxis === 'v' || params.cornerAxis === 'auto') ? params.cornerAxis : 'h';
			let useH: boolean;
			if (cornerAxis === 'auto') {
				// Pick whichever corner makes a shorter total (rare for true
				// Manhattan since both are equal — kept for symmetry).
				useH = Math.abs(x2 - x1) <= Math.abs(y2 - y1);
			} else {
				useH = cornerAxis === 'h';
			}
			const corner = useH ? [x2, y1] : [x1, y2];
			segments = [[x1, y1], corner, [x2, y2]];
		}

		// EasyEDA's create takes a flat number array.
		const flat: number[] = segments.flat();
		const wire = await withSdkTimeout(
			eda.sch_PrimitiveWire.create(flat, net, params.color, params.lineWidth, params.lineType),
			15_000,
			'sch_PrimitiveWire.create (sch.wire.pins)',
		);
		if (!wire) {
			throw new Error(`sch.wire.pins: SDK returned null. Likely the path between ${fromRef.designator}.${fromRef.pinNumber} (${x1},${y1}) and ${toRef.designator}.${toRef.pinNumber} (${x2},${y2}) crosses a different net. Verify both pins are on the same target net, or pass an explicit \`net\`.`);
		}

		const w: any = wire;
		return {
			created: !!wire,
			primitiveId: w?.getState_PrimitiveId?.() ?? w?.primitiveId,
			net,
			path: segments,
			from: { designator: fromRef.designator, pin: fromRef.pinNumber, x: x1, y: y1 },
			to: { designator: toRef.designator, pin: toRef.pinNumber, x: x2, y: y2 },
		};
	},

	'sch.wire.delete': async (params) => {
		return withSdkTimeout(eda.sch_PrimitiveWire.delete(params.ids), 10_000, 'sch_PrimitiveWire.delete');
	},

	// EasyEDA's modify(id, property) rebuilds the wire from `property` alone,
	// so an omitted `net` became "" and silently renamed the net design-wide.
	// Fetch the live wire and change only the fields the caller supplied.
	'sch.wire.modify': async (params) => {
		const property: Record<string, any> = params.property ?? {};
		const found: any = await withSdkTimeout<any>(eda.sch_PrimitiveWire.get(params.primitiveId) as Promise<any>, 10_000, 'sch_PrimitiveWire.get');
		const wire = Array.isArray(found) ? found[0] : found;
		if (!wire) throw new Error(`Schematic wire ${params.primitiveId} not found on the active page.`);
		const netBefore = wire.getState_Net?.();
		if (property.line !== undefined) wire.setState_Line(normalizeWireLine(property.line));
		if (property.net !== undefined) wire.setState_Net(property.net);
		if (property.color !== undefined) wire.setState_Color(property.color);
		if (property.lineWidth !== undefined) wire.setState_LineWidth(property.lineWidth);
		if (property.lineType !== undefined) wire.setState_LineType(property.lineType);
		const result: any = await withSdkTimeout<any>(wire.done(), 10_000, 'sch wire done()');
		const netAfter = result?.getState_Net?.() ?? wire.getState_Net?.();
		return {
			primitiveId: params.primitiveId,
			line: result?.getState_Line?.() ?? wire.getState_Line?.(),
			net: netAfter,
			netBefore,
			color: result?.getState_Color?.(),
			lineWidth: result?.getState_LineWidth?.(),
			lineType: result?.getState_LineType?.(),
			modified: true,
		};
	},

	'sch.wire.get': async (params) => {
		return eda.sch_PrimitiveWire.get(params.primitiveIds);
	},

	'sch.wire.getAll': async (params) => {
		// EasyEDA Pro 3.x's getAll(net) returns [] even for nets its own wires
		// report (verified on 3.2.206), so fetch everything and filter here.
		const wires = (await eda.sch_PrimitiveWire.getAll()) ?? [];
		if (params.net == null || params.net === '') return wires;
		const wanted = new Set((Array.isArray(params.net) ? params.net : [params.net]).map(String));
		return wires.filter((wire: any) => wanted.has(String(flattenState(wire)?.net ?? '')));
	},
};
