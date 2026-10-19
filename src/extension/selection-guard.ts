// Selection guard for document writes.
//
// EasyEDA's Property panel caches the values of the selected primitive. An
// API write (move, rename, delete, ...) updates the model but not that panel,
// and the next canvas click commits the panel's stale values back — e.g. a
// part renamed U16→U5 and moved by the agent snapped back to U16 at its old
// position. So: deselect everything before a schematic/PCB write, and after
// it re-select what the user had selected, which makes the panel reload the
// fresh values.
//
// Schematic: sch_SelectControl.clearSelected() is a no-op on EasyEDA Pro 2.2,
// but doSelectPrimitives([]) goes through the editor's selectById, which
// releases the current selection before selecting the (empty) list. Its ids
// are editor-internal ("e4008"), not the "$4I4008" ids the API reports.

type Kind = 'sch' | 'pcb';

const SKIP_PATTERN = /\.(select|screenshot|zoom|navigate)|^(sch|pcb)\.document\.(navigate|zoom|getCanvas|convert|getPrimitive)/i;

export function selectionGuardKind(method: string, isRead: boolean): Kind | undefined {
	if (isRead || SKIP_PATTERN.test(method)) return undefined;
	if (method.startsWith('sch.')) return 'sch';
	if (method.startsWith('pcb.')) return 'pcb';
	return undefined;
}

/** "$4I4008" / "e4008" → "e4008" (the id form the schematic editor's selectById accepts). */
export function schEditorId(id: string): string | undefined {
	const m = String(id).match(/(\d+)$/);
	return m ? `e${m[1]}` : undefined;
}

function settle<T>(p: Promise<T> | T, ms: number): Promise<T | undefined> {
	return new Promise((resolve) => {
		const t = setTimeout(() => resolve(undefined), ms);
		Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(undefined); });
	});
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function selectedIds(kind: Kind): Promise<string[]> {
	const ids = kind === 'sch'
		? await settle(eda.sch_SelectControl.getAllSelectedPrimitives_PrimitiveId(), 3_000)
		: await settle(eda.pcb_SelectControl.getAllSelectedPrimitives_PrimitiveId(), 3_000);
	return Array.isArray(ids) ? ids.filter((i) => typeof i === 'string') : [];
}

async function clearSelection(kind: Kind): Promise<void> {
	if (kind === 'sch') await settle(eda.sch_SelectControl.doSelectPrimitives([]), 3_000);
	else await settle(eda.pcb_SelectControl.clearSelected(), 3_000);
	// The editor applies selection changes asynchronously.
	await pause(50);
}

async function restoreSelection(kind: Kind, ids: string[]): Promise<void> {
	if (kind === 'sch') {
		const editorIds = ids.map(schEditorId).filter((i): i is string => !!i);
		// selectById skips ids that no longer exist (deleted by the write).
		if (editorIds.length) await settle(eda.sch_SelectControl.doSelectPrimitives(editorIds), 3_000);
	} else {
		await settle(eda.pcb_SelectControl.doSelectPrimitives(ids), 3_000);
	}
}

export async function withSelectionGuard<T>(kind: Kind | undefined, write: () => Promise<T>): Promise<T> {
	if (!kind) return write();
	let previous: string[] = [];
	try { previous = await selectedIds(kind); } catch { /* guard is best effort */ }
	if (previous.length === 0) return write();
	try { await clearSelection(kind); } catch { /* best effort */ }
	try {
		return await write();
	} finally {
		try { await restoreSelection(kind, previous); } catch { /* best effort */ }
	}
}
