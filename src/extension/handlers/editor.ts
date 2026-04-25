/**
 * Recursively strip keys that are useless to LLMs (e.g. titleBlockData, showTitleBlock).
 * Mutates in place for efficiency — callers should pass a fresh copy if needed.
 */
function stripBloat(obj: any): any {
	if (obj == null || typeof obj !== 'object') return obj;
	if (Array.isArray(obj)) {
		for (const item of obj) stripBloat(item);
		return obj;
	}
	delete obj.titleBlockData;
	delete obj.showTitleBlock;
	for (const val of Object.values(obj)) {
		if (val && typeof val === 'object') stripBloat(val);
	}
	return obj;
}

// Screenshot caveat: as of 2026-03-15 all three candidate EasyEDA Pro
// screenshot APIs return undefined / hang in the web app. They MAY work on
// desktop Electron. The handler below tries getCurrentRenderedAreaImage
// (the simplest path) and returns a structured error if it fails so callers
// know it's a runtime limitation, not a tool bug.

async function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = reader.result as string;
			resolve(dataUrl.split(',')[1] || '');
		};
		reader.onerror = () => reject(new Error('Failed to read blob'));
		reader.readAsDataURL(blob);
	});
}

export const editorHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'editor.project.getStructure': async () => {
		const [project, currentDoc] = await Promise.all([
			eda.dmt_Project.getCurrentProjectInfo(),
			eda.dmt_SelectControl.getCurrentDocumentInfo(),
		]);
		return { project: stripBloat(project), currentDocument: currentDoc };
	},

	'editor.getCurrentDocument': async () => {
		const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
		if (!doc) {
			return { document: undefined };
		}

		const result: Record<string, any> = { document: doc };

		// Schematic page (documentType 1)
		if (doc.documentType === 1) {
			const [page, schematic] = await Promise.all([
				eda.dmt_Schematic.getCurrentSchematicPageInfo(),
				eda.dmt_Schematic.getCurrentSchematicInfo(),
			]);
			result.schematicPage = page;
			result.schematic = schematic;
		}

		// PCB (documentType 3)
		if (doc.documentType === 3) {
			const [pcb, board] = await Promise.all([
				eda.dmt_Pcb.getCurrentPcbInfo(),
				eda.dmt_Board.getCurrentBoardInfo(),
			]);
			result.pcb = pcb;
			result.board = board;
		}

		return result;
	},

	'editor.openDocument': async (params) => {
		return eda.dmt_EditorControl.openDocument(params.documentUuid);
	},

	// Screenshot the current canvas rendered area. Works on desktop Electron
	// (returns Blob); typically returns undefined on the EasyEDA web app.
	'editor.screenshot': async (params) => {
		const blob = await eda.dmt_EditorControl.getCurrentRenderedAreaImage(params?.tabId);
		if (!blob) {
			throw new Error(
				'Screenshot returned undefined. EasyEDA Pro web app does not currently expose canvas screenshots; ' +
				'this typically works only on the desktop Electron build. (Reported to EasyEDA engineering.)',
			);
		}
		const base64 = await blobToBase64(blob);
		return {
			mimeType: blob.type || 'image/png',
			size: blob.size,
			base64,
		};
	},

	// One-shot "show me the board": refresh ratlines + zoom-fit + capture.
	// Avoids three round-trips when an agent just wants a clean PCB image.
	'pcb.screenshot.board': async (params) => {
		await eda.pcb_Document.stopCalculatingRatline().catch(() => {});
		await eda.pcb_Document.startCalculatingRatline().catch(() => {});
		await eda.pcb_Document.zoomToBoardOutline().catch(() => {});
		const blob = await eda.dmt_EditorControl.getCurrentRenderedAreaImage(params?.tabId);
		if (!blob) {
			throw new Error(
				'Screenshot returned undefined. EasyEDA Pro web app does not currently expose canvas screenshots; ' +
				'this typically works only on the desktop Electron build.',
			);
		}
		const base64 = await blobToBase64(blob);
		return { mimeType: blob.type || 'image/png', size: blob.size, base64 };
	},

	// Canvas viewport control — pan/zoom that the agent can trigger.
	'editor.zoomToRegion': async (params) => {
		return eda.dmt_EditorControl.zoomToRegion(params.left, params.right, params.top, params.bottom, params.tabId);
	},
	'editor.zoomTo': async (params) => {
		return eda.dmt_EditorControl.zoomTo(params.x, params.y, params.scaleRatio, params.tabId);
	},
	'editor.zoomToAllPrimitives': async (params) => {
		return eda.dmt_EditorControl.zoomToAllPrimitives(params?.tabId);
	},
	'editor.zoomToSelected': async (params) => {
		return eda.dmt_EditorControl.zoomToSelectedPrimitives(params?.tabId);
	},

	// Visual indicator markers — draw arrows / boxes on the canvas to point
	// at things the agent wants the user to notice.
	'editor.addMarkers': async (params) => {
		return eda.dmt_EditorControl.generateIndicatorMarkers(
			params.markers,
			params.color,
			params.lineWidth,
			params.zoom,
			params.tabId,
		);
	},
	'editor.clearMarkers': async (params) => {
		return eda.dmt_EditorControl.removeIndicatorMarkers(params?.tabId);
	},

	'editor.getOpenTabs': async () => {
		const [tree, currentDoc] = await Promise.all([
			eda.dmt_EditorControl.getSplitScreenTree(),
			eda.dmt_SelectControl.getCurrentDocumentInfo(),
		]);

		const tabs: Array<{ title: string; tabId: string; isActive: boolean }> = [];
		const activeUuid = currentDoc?.uuid;

		function collectTabs(node: any): void {
			if (node.tabs) {
				for (const tab of node.tabs) {
					tabs.push({
						title: tab.title,
						tabId: tab.tabId,
						isActive: activeUuid ? tab.tabId.startsWith(activeUuid) : false,
					});
				}
			}
			if (node.children) {
				for (const child of node.children) {
					collectTabs(child);
				}
			}
		}

		if (tree) {
			collectTabs(tree);
		}

		return { tabs, splitScreenTree: tree };
	},
};
