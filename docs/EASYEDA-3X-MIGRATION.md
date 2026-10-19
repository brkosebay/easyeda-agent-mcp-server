# EasyEDA Pro 3.x migration (2026-10-19)

EasyEDA Pro updated from 2.2.x to **3.2.206** (`client.pro.easyeda.com` 3.2.206.715d940d, Electron 36.3.2). Its bundled
extension API runtime is **pro-api 0.3.50**. npm never published 0.3.50 (the 0.3.x line stops at 0.3.13; 0.4.x is
next), so the authoritative types are the runtime's own
`/Applications/EasyEDA-Pro.app/Contents/Resources/app/assets/pro-api/0.3.50.*/api-types.d.ts`.

Method: a static diff of 0.2.34 against the runtime's 0.3.50 types, covering every `eda.*` member we call (212 unique,
529 sites); a read of the runtime `api.js` to find stubbed methods; and live tests on a routed 4-layer production board (76 nets, 103 parts).

## Breaking changes: fixed in extension 2.1.17 / 2.1.18

| # | Change on 3.x | Symptom | Fix |
|---|---|---|---|
| 1 | Extensions get `crypto.getRandomValues` but **no `crypto.subtle`** | Handshake failed: `Cannot read properties of undefined (reading 'importKey')`, plus a misleading "different token" hint | Pure-JS HMAC-SHA256 fallback (`src/shared/hmac-sha256.ts`, used by `nativeMac`). The hint now appears only on a real MAC mismatch (`native-peer.ts`). Test: `scripts/hmac-sha256-smoke.ts` |
| 2 | **`pcb_PrimitiveComponent.getAllPinsByPrimitiveId` x/y are now mil** (were 10-mil). `pad` tuple still mil, `hole` tuple still 10-mil | Every pad position was 10× off. `pcb_connectivity_status` reported 0/76 nets connected on a routed board. Routing and obstacle tools aimed at the wrong coordinates | Runtime probe `componentPinScale()` (`handlers/pin-units.ts`) compares pins to their component origin (mil on both versions) and caches 10 or 1. Threaded through net, routing, component, pcb-primitive, placement, board-context, drc, pcb-extract and trace-obstacles. Verified live: J3.1 = (400.6, −1321), 72/72 nets connected. Test: `scripts/pin-units-smoke.ts` |
| 3 | `pcb_Document.save(uuid)` became `save()`: it **ignores the uuid** and saves the active PCB | Could silently save the wrong board | `pcb.document.save` now resolves the active PCB and refuses if a passed uuid doesn't match it (`document.ts`) |
| 4 | Stackup getters are typed but **stubbed** (`getCurrentPhysicalStackingConfiguration` → undefined, `overwrite…` → false) | `pcb.layer.physical.get` threw | Returns `supported:false` with a reason (`layer.ts`) |
| 5 | `engines.eda "^2.3.0"` excludes 3.x | Store update check offers no updates; version list marks the extension out of range (no install gate found) | `">=2.3.0"` |
| 6 | (pre-existing, exposed by the upgrade) a stale 4 s probe timer closed a live socket sharing the same WebSocket id | Connected and then dropped 1.2 s later (code 1005) after reinstalling | `dropConnection` clears the probe timer; the timer only fires if it is still the current probe (`ws-client.ts`) |
| 7 | **`sch_Netlist.getNetlist('JLCEDA')` takes minutes**: 3.x awaits one `/PrjDB/footprint/getDisplayTitleById` RPC per component (more than 120 s on 103 parts; PADS is instant). The **netlist format changed to `"version": "2.0.0"`**: the map is wrapped as `{version, components}` and the flat `pins: {number: net}` became `pinInfoMap: {key: {number, name, net, props}}` | Pins, pin positions, connectivity, trace-net and BOM hung for 30–120 s. Once fast, every pin net came back `""` | `fetchNetlistText()` reads `sch_ManufactureData.getNetlistFile` first, a single fast RPC (verified) that keeps `Footprint` as the UUID `sch-extract` expects. It falls back to `getNetlist` (ungated `readWithTimeout`, 20 s each). `parseJlcedaNetlist()` handles both formats, tested against a real 3.x export: 103/103 components with nets (`scripts/netlist-format-smoke.ts`). **Verified on 2.1.21**: U10 pins carry nets instantly, and `sch_trace_net +5V_FILTERED` returns the same 13 members as the PADS netlist |
| 8 | `sch_PrimitiveWire.getAll(net)` returns `[]` for nets its own wires report | `sch_get_all_wires net:"+3.3V"` was empty | Fetch all wires and filter client-side (`sch-wire.ts`). **Verified on 2.1.20** (returns e375, e2155) |
| 9 | (our bug) `BRIDGE_GENERATION` was hand-maintained and stuck at `2026-10-05.v2.1.16`. Socket state lives on `globalThis`, so an upgraded bundle with the *same* generation inherits the old sockets, and their callbacks keep running the **old** handlers | 2.1.19 installed but its fixes never ran (the wire filter still returned `[]`) | The generation is now the packaged version via an esbuild define (`__EXTENSION_VERSION__`, `config/esbuild.prod.ts`). Check `server_info → instances[].bridgeGeneration` after every install. The netlist reads also switched to the ungated `readWithTimeout`, because a gated timeout would quarantine the document for a read. **2.1.20** |

## Return-value changes that do not break us

- **`lib_Device` search items**: the types dropped `manufacturer/manufacturerId/supplier/supplierId` and
  `lcscPrice/lcscInventory/jlcPrice/jlcInventory/jlcLibraryCategory`. Live, `getByLcscIds(['C1523'])` still returns
  manufacturer/MPN/supplier/supplierId but **no price or stock**. We don't read those fields: BOM/sourcing uses component
  properties and jlcsearch/wmsc.
- `lib_Device.getByLcscIds` conditional overload flipped; we pass an array and get an array.
- `IDMT_SchematicItem.parentBoardUuid` → `parentBoardName` (not read anywhere).
- SCH Circle/Polygon/Rectangle `.done()` now returns a Promise. We already await every `.done()`.
- `pcb_Net.getAllPrimitivesByNet` now **includes component pads** (`pcbItemPrimitiveType:"Pad"`, internal shape:
  `center` in mil, `topWidth/topHeight` in 10-mil). `net.ts` still says it "never returns component pads". Check that
  `pcb_get_net_primitives` with `types:["Pad"]` doesn't double-count once that path merges `padsOnNet`.
- `sch_Drc.check` verbose is typed `ISCH_DrcError[]` (was `any[]`). `pcb_run_drc` non-verbose still returns a bare boolean.
- `ISCH_PrimitiveComponentPin` lost `get/setState_NoConnected`; it moved to the `ISCH_PrimitivePin` base.
- `EPCB_PrimitiveRegionRuleType.NO_VIAS` (3) was removed. It only appears in readers that classify existing keepouts.
- New optional params: `pcb_Document.importChanges(uuid?, force?)`, `sch_Document.importChanges(force?)`,
  `sys_Environment.getEditorCurrentVersion(onlySemantic?)`, and `sch_PrimitiveComponent.create` now accepts symbols.

## Stubbed in the 3.2.206 runtime (exist, do nothing)

`pcb_Layer` stackup family + `getCurrentLayer`; `pcb_Drc` real-time DRC start/stop/status; `pcb_Primitive.getPrimitiveByPrimitiveId/
getPrimitiveTypeByPrimitiveId/getPrimitiveBoardLine`; `pcb_PrimitivePoured.create/modify`; `sch_Document` navigate/region/filter
queries; `dmt_EditorControl.zoom`; `dmt_Project` rename/move/copy/delete; `sys_FileSystem.openReadFolderDialog`.
None of these are on any path we use. Our PCB-side equivalents are still implemented.

## New APIs worth adopting (implemented in the runtime, verified by reading `api.js`)

Ranked by value to this project:

1. **`pcb_Document.autoRouting(props?)` / `autoLayout()`** (β, "since 3.2.150"). A native autorouter, which earlier
   notes said the SDK didn't have. Untested live, so it needs a fire-and-verify harness (the long promise may never
   settle; see the SDK promise-deadlock note). It is a candidate fallback behind the model-planned routing path.
2. **`sch_ManufactureData.getPngFile/getSvgFile`**: schematic images without screenshots, a direct lever on the
   screenshot token cost in the token-budget work.
3. **`sys_Math`**: native polygon `union/subtract/intersection/xor`, `containsPoint`, `distanceToPoint`, `intersects`,
   `getBBox`, `calculateArea/Perimeter`, `getCentroid`, `translate/rotate/scale`. It could replace hand-rolled geometry in
   trace-obstacles, pour-fill and split-pour code with EasyEDA's own math.
4. **`dmt_Event.addEditorTabEventListener`**: tab-change events instead of polling `getCurrentDocumentInfo`. This
   strengthens document binding, the same failure class as #3 above.
5. **`pcb_Document.importChanges(uuid, force=true)`**: sync the schematic to the PCB without the dialog. The test board
   currently has a "PCB and schematic netlist does not match" DRC error.
6. **`sys_FileSystem.existsPathInFileSystem/createDirectoryInFileSystem`**: precise "token file missing" errors in
   the native handshake, and export directory creation.
7. **`IPCB_Polygon.discretize`, `IPCB_ComplexPolygon.toPolygon`, `pcb_MathPolygon.discretize`**: arc→segment
   flattening for pour and outline polygons.
8. `sys_Environment.isEditorCurrentVersionGreaterThanOrEqual/LessThanOrEqual`: version gates.
9. `lib_Footprint/lib_Symbol.searchByProperties` + `getDocumentSource` (β), and `lib_Classification` tree.
10. `lib_SimulationModel` CRUD: relevant to reusing EasyEDA's simulator (kicad-happy port).
11. `sys_ExternalApi.register/unregister` (extensions exposing APIs to each other), `sys_Dialog.createDesignPortal`,
    `sys_Window.getViewportSize`.

### Coming in npm 0.4.27, not yet in this runtime

- **`pcb_PrimitivePour.rebuildCopperRegions(ids?)`** (α): the official batch copper rebuild, replacing the
  internal-messageBus `rebuildCopper` workaround.
- **Auto job API**: `pcb_Document.startAutoRouting/startAutoLayout/getAutoJobStatus/cancelAutoJob/getAutoJobLog`.
  It is pollable, so it fits fire-and-verify better than awaiting `autoRouting()`.
- `sys_Window.removeEventsForExtension` (extension unload cleanup).

Gate both on `isEditorCurrentVersionGreaterThanOrEqual` plus a result probe once the runtime reaches 0.4.x.

## Not verified yet

- ~~Schematic pin coordinates~~ **verified on 2.1.20**: `sch_get_component_pins e2097` returns instantly, and every pin
  lands on a wire end (OUT pin 1 at (335, 485) = `+3.3V` wire e2155, GND pin 3 at (335, 465) = GND wire e2158). Units
  are unchanged. Pin nets verified on 2.1.21 (#7).
- **DRC violation coordinates**: `drc.ts` still multiplies them by 10. The only live violation had no coordinates.
  It is marked in code.
- `pcb_Document.autoRouting` behaviour and promise settlement.
- The running daemon (pid from 2026-10-14) predates this build. MACs are byte-identical, so it works, but restart it
  at a convenient time.

## Follow-up

- Type-check against the runtime's `api-types.d.ts` (vendor it) instead of npm `@jlceda/pro-api-types@0.2.34`. No
  npm release matches 3.2.206.

## Reference: EasyEDA's official FreeRouting extension

Open source: <https://github.com/easyeda/eext-freerouting-intergration> (Apache-2.0, v1.7.1).

- **How it reaches FreeRouting.** The user starts FreeRouting ≥2.2.3 headless as a REST server on `127.0.0.1:37864`.
  The extension cannot start processes; the store text saying it does is stale. It talks to the server through
  `eda.sys_ClientUrl.request`, which needs "External Interaction" enabled.
- **Job flow.** session → job → base64 DSN input → start → poll `/jobs/{id}/output` (202 = partial result for live
  preview, 200 = final).
- **Native calls** (all public in 0.3.50):
  - `pcb_ManufactureData.getDsnFile`
  - `pcb_Document.importAutoRouteSesFile(File)` (β)
  - `stopCalculatingRatline` / `startCalculatingRatline`, plus hiding layer 57 (ratsnest)
  - `pcb_Drc.check`
  - Before each import it **deletes every unlocked track, arc and via**.
- **Contradicts our assumption.** It awaits `importAutoRouteSesFile` repeatedly without hangs, while our SES import
  defaults to `strategy:'direct'` on the belief that the importer hangs. Worth an A/B test with ratsnest paused. It also
  does no unit scaling; the SES goes straight to EasyEDA's importer.
- **Worth adopting.** Pause ratsnest recalculation around bulk writes. Consider FreeRouting's REST mode (partial results,
  cancel, statistics) over the one-shot CLI.
