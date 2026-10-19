# EasyEDA Agent MCP

Connect Claude (or any [MCP](https://modelcontextprotocol.io) client) to **EasyEDA Pro**. An AI agent can then read,
review, route and edit real PCB and schematic designs inside the editor, and verify what it changed.

```
Claude ──MCP stdio──▶ mcp-server ──▶ daemon ──WebSocket (localhost, HMAC)──▶ EasyEDA Pro extension ──▶ eda.* APIs
```

- **mcp-server** (`src/mcp-server`): the MCP server your client starts. It holds the tool catalog, the analyzers and
  the routing engine.
- **daemon** (`src/daemon`): a single local process, started on demand, that owns the extension connection. All agents
  share it, and it serialises writes through document locks and work leases.
- **extension** (`src/extension`): runs inside EasyEDA Pro and executes requests against the editor's extension API.

## What it can do

- **Read the design:** board context, footprints, pads, nets, connectivity from the real copper graph, DRC rules,
  layers, schematic pages, netlists and BOM.
- **Route and edit:** the model plans each route and `pcb_route_path` executes it exactly. Results are checked for
  clearance and verified to connect, with transactional batch edits, vias, pours (including split pours), placement
  moves and schematic wiring.
- **Review:** functional (intent-aware pin contracts), EMC, power and decoupling, thermal, placement, impedance and
  DFM checks, plus DRC summaries.
- **Manufacture:** Gerber, BOM, pick-and-place, PDF, DXF and DSN/SES export and import.
- **Small tool footprint:** in the default *dynamic toolsets* mode the client sees three meta-tools (`search_tools`,
  `describe_tools`, `execute_tool`) instead of 200+ tool schemas.
- **Multi-agent:** several agents can work on one design under daemon-enforced work leases
  ([docs/MULTI-AGENT.md](docs/MULTI-AGENT.md)).

The full tool reference is in [docs/TOOLS.md](docs/TOOLS.md).

## Compatibility

| | |
|---|---|
| EasyEDA Pro | **3.2.206 verified** (desktop client). 2.2.x / 2.3.x are supported through runtime detection but have not been re-tested since the 3.x changes ([docs/EASYEDA-3X-MIGRATION.md](docs/EASYEDA-3X-MIGRATION.md)). |
| Client | The EasyEDA Pro **desktop** client. The bridge reads a local token file, which the browser version cannot do. |
| Node.js | ≥ 20.5 |
| OS | Developed on macOS. Windows and Linux paths are handled but less tested. |

## Install

### 1. Build the MCP server

```bash
git clone https://github.com/brkosebay/easyeda-agent-mcp-server.git
cd easyeda-agent-mcp-server
npm ci
npm run build
```

`npm run build` writes the server to `dist/` and an extension package to `build/dist/easyeda-agent-mcp-server_v<version>.eext`.

### 2. Install the extension in EasyEDA Pro

1. Get the `.eext`: download it from the [Releases](https://github.com/brkosebay/easyeda-agent-mcp-server/releases)
   page, or use the one you just built.
2. In EasyEDA Pro, open the **Extension Manager**, import the `.eext` file, and make sure the extension is enabled.
3. In Extension Manager, enable **External Interactions** for *EasyEDA Agent*. The extension needs it to read the
   bridge token file.

### 3. Register the MCP server with your client

Claude Code:

```bash
claude mcp add easyeda-agent -- node /absolute/path/to/easyeda-agent-mcp-server/dist/mcp-server/index.js
```

Claude Desktop (`claude_desktop_config.json`) or any other MCP client:

```json
{
  "mcpServers": {
    "easyeda-agent": {
      "command": "node",
      "args": ["/absolute/path/to/easyeda-agent-mcp-server/dist/mcp-server/index.js"]
    }
  }
}
```

### 4. Connect

In EasyEDA Pro, open a project and click **Claude → Connect Claude**. The first MCP request starts the daemon, which
creates a random token at `~/.easyeda-mcp/token`. The extension locates that file through your Documents folder and
authenticates.

If the handshake reports that it cannot find or read the token (for example with a custom `EDA_DAEMON_DIR`, or a
relocated Documents folder), use **Claude → Configure protected bridge…** and enter the token's absolute path, e.g.
`/Users/you/.easyeda-mcp/token` or `C:\Users\you\.easyeda-mcp\token`.

## Using it

Ask your agent for EasyEDA work directly, e.g. "review the power tree on this board" or "route the CAN pair on the top
layer". In dynamic mode it discovers tools on its own:

```
search_tools({query: "route a net"})  →  describe_tools({names: [...]})  →  execute_tool({name, args})
```

Good starting points:

- `list_instances` / `server_info`: check that the extension is connected.
- `pcb_get_routing_context`, `pcb_connectivity_status`, `pcb_drc_summarize`: understand a board.
- `docs/TOOLS.md` → *Recommended PCB agent workflow*: sense → plan → dry-run → commit → verify.

Claude Code users get two ready-made subagents (`.claude/agents/eda-worker.md`, `eda-reviewer.md`) and an
`eda-parallel` skill for parallel reviews and partitioned edits.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `EDA_DYNAMIC_TOOLSETS` | `1` | `0` exposes every tool individually instead of the three meta-tools. |
| `EDA_DAEMON` | `1` | `0` runs the legacy in-process WebSocket bridge (one MCP server per extension connection). |
| `EDA_DAEMON_DIR` | `~/.easyeda-mcp` | Daemon socket, lock, log, token and export directory. |
| `EDA_WS_PORT` | `15168` | First port of the extension WebSocket range. |
| `EDA_WS_TIMEOUT_MS` / `EDA_WS_QUICK_TIMEOUT_MS` | 120000 / 5000 | Default request timeouts for long and quick tools. |

Exports land in `~/.easyeda-mcp/exports/`. The daemon log is `~/.easyeda-mcp/daemon.log`.

### Optional: external autorouter

`pcb_autoroute` can drive an external Specctra router through DSN/SES. `scripts/install-fastroute.sh` installs the
fastroute binary, and `FASTROUTE_BIN` points at a custom one. EasyEDA's own autorouter
(`pcb_native_autoroute`, EasyEDA Pro 3.2.150+) is wired up but **experimental and not yet live-tested**.

## Security

- The extension only connects to `localhost`. Every frame on the bridge is HMAC-authenticated with the per-machine
  token in `~/.easyeda-mcp/token` (mode 600), and messages are sequence-numbered against replay.
- The token never leaves your machine. Release builds of the extension embed no paths, and the token location is
  resolved at runtime.

## Development

```bash
npm run typecheck      # MCP server + extension
npm run test:smoke     # offline smoke tests (no EasyEDA needed)
npm run build          # dist/ + local .eext (embeds your token path for convenience)
npm run build:release  # dist/ + publishable .eext (embeds no local paths)
```

Layout: `src/mcp-server` (tools, analyzers, routing), `src/daemon`, `src/extension` (EasyEDA-side handlers),
`src/shared` (code used on both sides), `scripts/` (smoke tests and helpers), `docs/` (reference and design notes).

### Releasing

1. Bump `version` in `extension.json` and `package.json`, and add an entry to [CHANGELOG.md](CHANGELOG.md).
2. Tag and push: `git tag v<version> && git push origin v<version>`.
3. The *Release* workflow builds with `build:release` and attaches the `.eext` to a GitHub release.

After installing a new `.eext`, `server_info` → `instances[].bridgeGeneration` should show the new version.

## Credits

Originally created by [Alex Boyd](https://github.com/javawizard) ([javawizard/easyeda-agent-mcp-server](https://github.com/javawizard/easyeda-agent-mcp-server))
with contributions from QuincySx, and extended by Berkay Kösebay. MIT licensed, see [LICENSE](LICENSE).

EasyEDA is a trademark of its respective owners. This project is not affiliated with or endorsed by EasyEDA/JLC.
