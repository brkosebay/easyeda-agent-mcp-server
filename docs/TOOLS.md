# EasyEDA Agent MCP — Tool Reference

This server bridges Claude (or any MCP client) to the EasyEDA Pro extension running inside the editor. The MCP server is a Node process; the extension runs in EasyEDA's JS sandbox. They talk over a local WebSocket.

```
Claude  ──MCP stdio──▶  mcp-server  ──WebSocket──▶  EasyEDA extension  ──▶  eda.* APIs
```

## Setup

1. Build: `npm run build` — produces `dist/` and a packaged extension archive.
2. Install the extension in EasyEDA Pro (Extensions → Load).
3. Start a Claude session with this MCP server configured (`npm run start`).
4. In EasyEDA Pro, click **Claude → Connect Claude**. The extension connects to the active MCP server (single-primary; new sessions auto-promote).

## Conventions

| Concept | Detail |
|---|---|
| Units | All PCB coordinates and lengths are in **mil** (1 mil = 0.0254 mm). Schematic uses 0.01 inch. Use `pcb_create_via_mm` for mm input. |
| Layers | Numeric IDs (1=Top, 2=Bottom, 11=BoardOutline, 15..44=Inner1..30, 71..100=Custom1..30) or names ("TopLayer", "Inner1", "BoardOutline"). Case-insensitive. |
| Polygon | Pours/fills/regions accept `{points:[{x,y},...]}`, `[{x,y},...]`, `["L",x1,y1,...,x1,y1]`, or `["R",cx,cy,w,h,rot,radius]`. Auto-closes the ring. |
| viaType | Number (`0`/`1`/`2`) or string (`"Through"`/`"BlindBuried"`/`"Suture"`). |
| Documents | Most pcb_* / sch_* tools take `document` (UUID). Use `editor_get_open_tabs` to discover. |
| Multi-instance | When >1 EasyEDA window is open, pass `instance_id` (8-hex). Single window auto-selects. |
| Compact mode | All `getAll`-style read tools default to `compact:true` — identity + key geometry only. Pass `compact:false` for full data including geometry source. |
| Field projection | `fields:["a","b"]` projects to those keys. `filter:{net:"GND"}` filters items. `limit:N` truncates. |
| Timeout | Default 45 s per call. Override per call with `_timeoutMs:300000` (5 min). Global default via `EDA_WS_TIMEOUT_MS` env. |
| Help inline | `pcb_help(topic)` returns long-form docs on demand for `polygon`, `layer`, `viaType`, `compact`, `units`, `primitives`, `timeout`. |

## Server / instance

| Tool | What |
|---|---|
| `server_info` | WebSocket port, connection state, allowed origins. |
| `list_instances` | All connected EasyEDA instances with active document and tab list. |

## Editor / project

| Tool | What |
|---|---|
| `project_get_structure` | Boards, schematics, PCBs, panels, focused doc. |
| `editor_get_current_document` | Active doc with parent context. |
| `editor_open_document` | Open a doc by UUID. |
| `editor_get_open_tabs` | Open tabs and split-screen tree. |
| `editor_screenshot` | PNG of current canvas (desktop Electron only — web app returns undefined). |
| `editor_zoom_to_region` | Zoom to a rectangle. |
| `editor_zoom_to` | Center on (x,y) with optional scale. |
| `editor_zoom_to_all` | Fit all primitives. |
| `editor_zoom_to_selected` | Fit selection. |
| `editor_add_markers` | Draw arrows/boxes on canvas. |
| `editor_clear_markers` | Remove all markers. |

## PCB read

| Tool | What |
|---|---|
| `pcb_get_all_primitives` | List by type (`component`/`track`/`polyline`/`via`/`pad`/`pour`/`fill`/`arc`/`region`) with net/layer filters. |
| `pcb_get_primitives_by_id` | Look up by ID. |
| `pcb_get_all_nets` | Every net name. |
| `pcb_get_net_primitives` | Primitives belonging to a net. |
| `pcb_get_net_length` | Total routed mil length. |
| `pcb_get_design_rules` / `pcb_get_net_rules` | Active DRC config. |
| `pcb_get_pad` | Lookup by `reference` + `padNumber` → `{x,y,layer,net}`. |
| `pcb_get_component_pins` | Every pin of a component. |
| `pcb_run_drc` | Run DRC; verbose:true returns violation list. |
| `pcb_get_selected` | Currently selected primitives. |
| `pcb_help(topic)` | Inline reference for tool conventions. |
| `pcb_get_layer_status` | Per-layer visibility/lock/transparency. |
| `pcb_get_canvas_filter` | Current canvas primitive-type filter. |

## PCB write

| Tool | What |
|---|---|
| `pcb_create_track` | Single Line track between two points (mil). |
| `pcb_create_polyline_track` | **LEGACY** Polyline graphic; doesn't carry a net. Prefer pcb_create_track. |
| `pcb_create_via` | Via in mil. |
| `pcb_create_via_mm` | Via in mm. Returns resolved mil values. |
| `pcb_create_arc` | Arc track. |
| `pcb_create_pad` | Standalone pad. |
| `pcb_create_pour` | Copper pour. polygon: see `pcb_help("polygon")`. |
| `pcb_create_fill` | Fill region. |
| `pcb_create_region` | DRC region (keepout/constraint). |
| `pcb_route_orthogonal` | Manhattan path with real Line primitives (1/2/3 segments + jog). |
| `pcb_delete_tracks_by_filter` | Bulk-delete tracks by net/layer. preserveLocked option. |
| `pcb_move_component` | Move/rotate/flip/lock/rename a component. |
| `pcb_modify_track` | Modify a Line; returns `{modified, persisted, after, attempted}` (re-fetches to verify). |
| `pcb_modify_primitive` | Generic modify — type-tagged. |
| `pcb_delete_primitives` | Generic delete by type + IDs. |
| `pcb_save` | Save the PCB document. |

## PCB DRC / rules

| Tool | What |
|---|---|
| `pcb_drc_summarize` | Top-N violation groups by category/net/component. |
| `pcb_repour_all` | Rebuild every pour; scope to net/layer; skip locked. |
| `pcb_connectivity_status` | Per-net audit: routed / pour_only / unrouted / single_pad. |
| `pcb_manage_rule_config` | Get/save/rename/delete DRC rule configs. |
| `pcb_manage_net_rules` | Net-rules / net-by-net / region rules. |
| `pcb_manage_net_classes` | Net classes (CRUD + add/remove members). |
| `pcb_manage_diff_pairs` | Differential pair definitions. |
| `pcb_manage_equal_length_groups` | Equal-length net groups. |
| `pcb_manage_pad_pair_groups` | Pad-pair length constraints. |

## PCB layer / canvas

| Tool | What |
|---|---|
| `pcb_manage_layers` | Get all / select / show / hide / lock / unlock / set copper count / modify color etc. |
| `pcb_zoom_to_board` | Fit to board outline. |
| `pcb_refresh_canvas` | Cycle ratline calc + zoom — forces visual redraw when canvas seems stale after batch routing. |
| `pcb_navigate_to` | Center canvas on (x,y). |
| `pcb_navigate_to_region` | Pan to region. |
| `pcb_get_primitive_at_point` | Hit-test a coordinate. |
| `pcb_get_primitives_in_region` | All primitives inside a rect. |
| `pcb_canvas_origin` | Get/set the canvas/data origin offset. |
| `pcb_convert_coordinates` | Canvas↔data coordinate conversion. |
| `pcb_clear_selection` | Deselect all. |

## Schematic

| Tool | What |
|---|---|
| `sch_get_all_components` / `sch_get_component` | Component listing / lookup. |
| `sch_get_all_wires` / `sch_get_wire` | Wires. |
| `sch_get_component_pins` | Pins of a component (with current net assignment). |
| `sch_get_netlist` | Full netlist. |
| `sch_set_netlist` | Push a netlist (e.g. after refactoring). |
| `sch_get_connectivity` | Net-by-net connectivity tree. |
| `sch_get_primitive` / `sch_get_primitive_type` / `sch_get_primitive_bbox` | Generic primitive ops. |
| `sch_get_selected` / `sch_get_selected_ids` / `sch_select_primitives` | Selection. |
| `sch_create_component` | Place a component from library. |
| `sch_modify_component` / `sch_delete_component` | Edit / remove. |
| `sch_create_wire` / `sch_modify_wire` / `sch_delete_wire` | Wires. |
| `sch_create_net_flag` / `sch_create_net_port` | Net flags & ports (batch supported). |
| `sch_run_drc` | Schematic ERC. |
| `sch_save` | Save schematic. |
| `sch_import_changes` / `pcb_import_changes` | Cross-import schematic ↔ PCB. |

## Library

| Tool | What |
|---|---|
| `lib_get_all_libraries` | All libraries (system + user). |
| `lib_get_system_library_uuid` | Resolve "system" library UUID. |
| `lib_search_device` | Search by keyword/MPN. |
| `lib_get_device` / `lib_get_device_by_lcsc` | Device lookup. |

## Manufacture

| Tool | What |
|---|---|
| `pcb_export` | Export gerber / bom / pick-and-place / 3D / pdf / netlist / dxf / altium / pads / autoroute_json / autolayout_json / dsn. Returns `{fileName, data (base64), size}`. |
| `pcb_import` | Import autoroute_json / autolayout_json / autoroute_ses (FreeRouting result). |
| `pcb_autoroute` | DSN export → `java -jar vendor/freerouting.jar` → SES import. Requires Java 11+ and a FreeRouting jar at `vendor/freerouting.jar` (or `FREEROUTING_JAR` env). |

## Help and discovery

- `pcb_help("polygon" | "layer" | "viaType" | "compact" | "units" | "primitives" | "timeout")` — inline reference.
- `editor_get_open_tabs` — discover document UUIDs.
- `list_instances` — discover instance IDs when multiple EasyEDA windows are connected.

## Token-saving tips

1. Default to compact responses — for full polygon source or rare fields, opt in with `compact:false`.
2. `fields:["primitiveId","net"]` projects further when you only need one or two keys.
3. `filter:{net:"GND"}` + `limit:50` keep `getAll` calls bounded.
4. Use `pcb_get_pad` instead of `pcb_get_all_primitives` + filter when looking up a known reference.
5. `pcb_drc_summarize` instead of `pcb_run_drc` when you only need the count and top categories.
6. `pcb_connectivity_status` summarises hundreds of nets in one call.

## Connection model

- Extension keeps **one** open WebSocket to an MCP server (the *primary*).
- Other discovered ports go on a standby list; new MCP sessions auto-promote (matches "I just opened a new terminal, use that one").
- Heartbeat: 20 s ping interval, 25 s quiet → ping, 45 s silence → drop.
- Reset state: click **Claude → Disconnect Claude**, then **Connect Claude**.

## Environment

| Var | Default | Effect |
|---|---|---|
| `EDA_WS_PORT` | 15168 | First port the MCP server tries to bind. |
| `EDA_WS_PORT_RANGE` | 40 | Number of ports to try (15168..15207). |
| `EDA_WS_TIMEOUT_MS` | 45000 | Default per-call bridge timeout (overridable per-call with `_timeoutMs`). |
| `EDA_WS_ALLOW_ALL_ORIGINS` | unset | Set `1` to allow non-EasyEDA WS origins (dev only). |
| `JAVA_BIN` | `java` | Java binary used by `pcb_autoroute`. |
| `FREEROUTING_JAR` | `vendor/freerouting.jar` | Path to the FreeRouting jar. |
