# Bab

[Bab Showcase](https://github.com/user-attachments/assets/c00243eb-d0a0-4db5-87d5-bc1d84ff244d)


> [!IMPORTANT]
> This project is under heavy active development. Expect frequent breaking changes, new features, and reworked internals. Lock to a specific version if you depend on it in production.

Bab is a TypeScript MCP server built on Bun. It was inspired by the [PAL MCP Server](https://github.com/BeehiveInnovations/pal-mcp-server) and focuses on delegate CLI plugins, a thin Vercel AI SDK provider layer, and reusable MCP tooling.

## Why "Bab"?

`Bab` comes from the Arabic word `باب`, which means `door` or `gateway`.

That name fits the project because Bab acts as a gateway between MCP clients and the systems behind them:

- CLI delegate tools
- AI providers
- local project context
- future plugin integrations

## Features

- MCP server over stdio using `@modelcontextprotocol/sdk`
- Delegate plugin system with manifest discovery and optional `adapter.ts`
- Built-in delegate roles: `default`, `planner`, `codereviewer`, `coding`
- Provider registry backed by the Vercel AI SDK with per-provider thinking mode mapping
- ModelGateway for unified model routing: SDK models by ID/alias or plugin models via `pluginId/modelName`
- Multi-model consensus with parallel execution, per-model temperature and thinking mode
- Slash commands via MCP prompts protocol (`/bab:chat`, `/bab:review`, `/bab:think`, etc.)
- In-memory conversation storage with continuation support and a 20-turn limit
- Full core and specialized workflow tool suite
- Lazy tool loading by default (5 tools at startup vs 17), with on-demand auto-load
- CLI entrypoint with `serve`, `add`, `remove`, `list`, `config`, `selfupdate`, and `test-plugin` commands
- Plugin SDK export surface via `@zaherg/bab/sdk`
- Delegate environment hardening: API keys and `BAB_*` internal vars are never leaked to subprocesses
- Dedicated error log at `~/.config/bab/logs/error.log` for quick debugging

## Install

### Install script (macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/zaherg/bab/main/scripts/install.sh | bash
```

Options:

```bash
# custom install directory
curl -fsSL https://raw.githubusercontent.com/zaherg/bab/main/scripts/install.sh | bash -s -- --prefix /usr/local/bin

# skip checksum verification (not recommended)
curl -fsSL https://raw.githubusercontent.com/zaherg/bab/main/scripts/install.sh | bash -s -- --no-verify

# install the latest pre-release (beta, rc, or dated builds)
curl -fsSL https://raw.githubusercontent.com/zaherg/bab/main/scripts/install.sh | bash -s -- --prerelease
```

The script downloads the binary to a temp dir, verifies its SHA-256 against `checksums.sha256`, strips the macOS quarantine xattr on the final install path, and then `mv`s it to `--prefix` (default `~/.local/bin`).

### Binary download

Grab the latest binary for your platform from the [releases page](https://github.com/zaherg/bab/releases):

| Platform | Architecture | Asset |
|----------|-------------|-------|
| macOS | Apple Silicon | `bab-darwin-arm64` |
| macOS | Intel | `bab-darwin-x64` |
| Linux | x64 | `bab-linux-x64` |
| Linux | ARM64 | `bab-linux-arm64` |

```bash
chmod +x bab-*
mv bab-* /usr/local/bin/bab
```

> On macOS, downloaded binaries carry the `com.apple.quarantine` xattr and Gatekeeper will block execution. Either re-download via the install script (which strips the xattr) or run `xattr -d com.apple.quarantine /usr/local/bin/bab` once.

### From source

Requires [Bun](https://bun.sh) 1.3.9 or newer.

```bash
git clone https://github.com/zaherg/bab.git && cd bab
bun install
bun run build:binary   # compiled binary at dist/bab
```

### Self-update

Once installed, update to the latest release:

```bash
bab selfupdate
```

## Quick Start

Start the MCP server:

```bash
bab serve
```

Install first-party plugins:

```bash
bab add https://github.com/zaherg/bab-plugins

# OR

bab add zaherg/bab-plugins

```

Run the test suite:

```bash
bun test
```

## Connect Bab To MCP Clients

Use the installed `bab` binary as a local stdio MCP server. Replace `/absolute/path/to/bab` with the output of:

```bash
which bab
```

### Codex

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.bab]
command = "/absolute/path/to/bab"
args = ["serve"]
startup_timeout_sec = 300.0
tool_timeout_sec = 1200.0
```

Then restart Codex or reload MCP servers.

### Claude Code

Add Bab as a user-scoped stdio MCP server:

```bash
claude mcp add-json --scope user bab \
  '{"type":"stdio","command":"/absolute/path/to/bab","args":["serve"]}'
```

Verify with:

```bash
claude mcp get bab
```

### GitHub Copilot CLI

Add this to `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "bab": {
      "type": "local",
      "command": "/absolute/path/to/bab",
      "args": ["serve"],
      "tools": ["*"]
    }
  }
}
```

You can also add it interactively from Copilot CLI with `/mcp add`.

## Configuration

Bab creates and uses `~/.config/bab/` on first run:

- `~/.config/bab/env`
  dotenv-style environment file
- `~/.config/bab/plugins/`
  delegate plugins, one directory per plugin
- `~/.config/bab/plugins/<plugin-id>/env`
  optional per-plugin env overrides merged over the global env file
- `~/.config/bab/prompts/`
  prompt overrides or additional prompt assets

> **Note:** Environment variables set in your MCP client config take priority over
> the `~/.config/bab/env` file. For example, if you set `OPENAI_API_KEY` in both
> places, the MCP config value wins.
>
> ```json
> {
>   "mcpServers": {
>     "bab": {
>       "command": "/absolute/path/to/bab",
>       "args": ["serve"],
>       "env": {
>         "OPENAI_API_KEY": "sk-mcp-value"
>       }
>     }
>   }
> }
> ```
>
> ```bash
> # ~/.config/bab/env
> OPENAI_API_KEY=sk-file-value   # overridden by the MCP config above
> ```

Supported provider environment variables:

- `GOOGLE_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `OPENROUTER_API_KEY`
- `CUSTOM_API_KEY`
- `CUSTOM_API_URL`

### Environment Variables

All `BAB_*` variables are validated through a Zod schema on startup. Invalid values produce clear error messages.

| Variable | Type | Description |
|---|---|---|
| `BAB_DISABLED_TOOLS` | comma-separated | Tool names to exclude from `tools/list` (case-insensitive) |
| `BAB_ENABLED_TOOLS` | comma-separated | If set, only these tools are registered |
| `BAB_EAGER_TOOLS` | boolean | Set to `1` to register all tools at startup instead of lazy loading |
| `BAB_PERSIST` | boolean | Set to `false` to disable report persistence (default: `true`) |
| `BAB_PERSIST_TOOLS` | comma-separated | Only persist reports for these tools |
| `BAB_DISABLED_PERSIST_TOOLS` | comma-separated | Disable persistence for these tools |
| `BAB_CLI_TIMEOUT_MS` | integer | Override delegate CLI timeout (default: 5 minutes) |
| `BAB_MAX_CONCURRENT_PROCESSES` | integer | Max concurrent delegate processes (default: 5) |
| `BAB_LOG_LEVEL` | string | Logging level: `debug`, `info`, `warn`, `error` (default: `info`). `debug` can include stack traces in MCP tool error responses; do not enable it with untrusted MCP clients. |

Example:

```bash
# ~/.config/bab/env
BAB_DISABLED_TOOLS=delegate,tracer
BAB_LOG_LEVEL=debug
```

Or via your MCP client config:

```json
{
  "mcpServers": {
    "bab": {
      "command": "/absolute/path/to/bab",
      "args": ["serve"],
      "env": {
        "BAB_DISABLED_TOOLS": "delegate,tracer"
      }
    }
  }
}
```

### Logging

Log files are stored in `~/.config/bab/logs/`:

| File | Contents |
|---|---|
| `mcp.log` | Server lifecycle, tool calls, protocol events (all levels) |
| `error.log` | Warnings and errors only — quick debugging |
| `<pluginId>.log` | Per-plugin delegate I/O (e.g. `copilot.log`, `opencode.log`) |

Set `BAB_LOG_LEVEL=debug` only for local troubleshooting. Debug mode adds stack traces to MCP tool error responses, so the connected MCP client can see file paths and stack frames.

### Security

Delegate subprocesses receive a sanitized environment:

- **API keys stripped**: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `GITHUB_TOKEN`, `GH_TOKEN`
- **Internal vars stripped**: All `BAB_*`, `CLAUDE_*`, and `CLAUDECODE*` prefixed variables
- **Runtime injection vars stripped**: `LD_PRELOAD`, `NODE_OPTIONS`, `DYLD_INSERT_LIBRARIES`, etc.
- **Stack traces**: Included in MCP tool error responses only when `BAB_LOG_LEVEL=debug`; leave debug mode off for untrusted MCP clients
- **Working directory**: Validated to be within project root, home, or tmp

Plugins that need an API key must declare it in their own `env` file (`~/.config/bab/plugins/<id>/env`).

## Delegate Plugins

Each plugin lives under `~/.config/bab/plugins/<plugin-id>/` and is discovered by `manifest.yaml`.

Bab keeps `opencode` bundled as the built-in reference plugin. Install the external first-party plugins:

```bash
# Install all first-party plugins (claude, codex, copilot)
bab add zaherg/bab-plugins

# List installed plugins
bab list

# Remove a specific plugin
bab remove <plugin-id>
```

Minimal manifest shape:

```yaml
id: echo
name: Echo Plugin
version: 1.0.0
command: echo
roles:
  - default
delegate_api_version: 1
```

Plugins can also provide custom system prompts for workflow tools via `tool_prompts`:

```yaml
tool_prompts:
  codereview: prompts/codereview.txt
  secaudit: prompts/secaudit.txt
```

When a tool routes through a plugin model, bab uses the plugin's prompt instead of the built-in default. See [Plugin Authoring](https://zaherg.github.io/bab/plugin-authoring/) for details.

Optional `adapter.ts` files can implement runtime behavior for CLI parsing, validation, and cancellation. Plugins without adapters can still be discovered, but the `delegate` tool requires an adapter to execute them.

## Built-in Tools

- `delegate`
  Runs a prompt through a configured CLI plugin
- `chat`, `thinkdeep`, `codereview`, `planner`, `consensus`
  Core workflow tools
- `debug`, `analyze`, `tracer`, `refactor`, `testgen`, `docgen`, `secaudit`, `precommit`, `challenge`
  Specialized workflow tools
- `list_models`
  Lists models available from configured providers
- `version`
  Returns Bab and runtime version details

## Docs

Full documentation is available at **[zaherg.github.io/bab](https://zaherg.github.io/bab/)** or in [`docs/`](./docs/index.md):

- [Getting Started](https://zaherg.github.io/bab/getting-started/)
- [Provider Setup](https://zaherg.github.io/bab/provider-setup/)
- [Plugin Authoring](https://zaherg.github.io/bab/plugin-authoring/)
- [Adapter Tutorial](https://zaherg.github.io/bab/adapter-tutorial/)
- [Tool Reference](https://zaherg.github.io/bab/tool-reference/)

## Project Layout

```text
src/
  config.ts           # BAB_* env validation, config loading
  server.ts           # MCP server setup, tool registration
  version.ts          # Centralized version constant
  bootstrap.ts        # Core tool names, startup wiring
  delegate/           # Plugin discovery, loading, caching, process runner
  memory/             # Conversation store, report persistence
  prompts/            # Built-in tool and role prompts
  providers/          # Vercel AI SDK registry, model gateway
  tools/              # 17 built-in tools (lazy-loaded by default)
  sdk/                # Plugin author SDK (@zaherg/bab/sdk)
  commands/           # CLI commands (serve, add, remove, list, selfupdate)
  types/              # Shared type definitions
  utils/              # Env sanitization, path containment, logging, tokens
plugins/              # Bundled plugins (opencode)
tests/                # bun:test test suite
docs/                 # GitHub Pages documentation
```

## Development

Useful commands:

```bash
bun test
bun run build
bun run build:binary
bunx tsc -p tsconfig.json --noEmit
bun run src/cli.ts serve
bun run src/cli.ts add git@github.com:zaherg/bab-plugins.git --yes
bun run src/cli.ts list
bun run src/cli.ts config
bun run src/cli.ts test-plugin ../bab-plugins/claude
```

The repo currently uses:

- Bun for runtime and package management
- TypeScript with ES modules
- Zod v4 for validation
- Biome for linting and formatting

## Disclaimer

See [DISCLAIMER.md](./DISCLAIMER.md).
