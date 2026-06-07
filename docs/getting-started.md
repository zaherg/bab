---
title: Getting Started
layout: default
nav_order: 2
---

# Getting Started

## Install

### Homebrew (macOS / Linux)

```bash
brew install babmcp/tap/bab
```

### Install script (macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/zaherg/bab/main/scripts/install.sh | bash
```

### Binary download

Grab the latest from the [releases page](https://github.com/zaherg/bab/releases), then `chmod +x` and move to a directory on your PATH.

### From source

Requires [Bun](https://bun.sh) 1.3.9 or newer.

```bash
git clone https://github.com/zaherg/bab.git && cd bab
bun install
bun run build:binary   # compiled binary at dist/bab
```

### Self-update

```bash
bab selfupdate
```

## Configuration

Bab creates and uses `~/.config/bab/`:

- `~/.config/bab/env` — dotenv-style environment file
- `~/.config/bab/plugins/` — delegate plugins (one directory per plugin)
- `~/.config/bab/plugins/<plugin-id>/env` — per-plugin environment overrides (merged on top of the global env file)
- `~/.config/bab/prompts/` — prompt overrides
- `~/.config/bab/logs/` — log files (`mcp.log`, `error.log`, per-plugin logs)
- `~/.config/bab/reports/` — fallback directory for persisted workflow reports (see [Report Persistence](./report-persistence.md))

### Provider API Keys

Set these in `~/.config/bab/env` or in your MCP client config:

- `GOOGLE_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `OPENROUTER_API_KEY`
- `CUSTOM_API_KEY` + `CUSTOM_API_URL`

### Bab Environment Variables

| Variable | Type | Description |
|---|---|---|
| `BAB_DISABLED_TOOLS` | comma-separated | Tool names to exclude |
| `BAB_ENABLED_TOOLS` | comma-separated | If set, only these tools are registered (takes priority over `BAB_DISABLED_TOOLS`) |
| `BAB_EAGER_TOOLS` | boolean | Set to `1` to disable lazy tool loading |
| `BAB_PERSIST` | boolean | Set to `false` to disable report persistence |
| `BAB_PERSIST_TOOLS` | comma-separated | Only persist reports for these tools |
| `BAB_DISABLED_PERSIST_TOOLS` | comma-separated | Disable persistence for these tools |
| `BAB_CLI_TIMEOUT_MS` | integer | Override delegate CLI timeout (default: 5 minutes) |
| `BAB_MAX_CONCURRENT_PROCESSES` | integer | Max concurrent delegate processes (default: 5) |
| `BAB_LOG_LEVEL` | string | `debug`, `info`, `warn`, or `error` (default: `info`). `debug` can include stack traces in MCP tool error responses; use it only with trusted local clients. |

### Logging

Log files are stored in `~/.config/bab/logs/`:

- `mcp.log` — all server events
- `error.log` — warnings and errors only
- `<pluginId>.log` — per-plugin delegate I/O

`BAB_LOG_LEVEL=debug` is intended for local troubleshooting. It may expose stack traces, file paths, and stack frames to the connected MCP client in tool error responses.

## Common Commands

Start the MCP server:

```bash
bab serve
```

Install the first-party external plugins:

```bash
bab add zaherg/bab-plugins
```

> **Security note:** Plugin adapters run as trusted code with full access to your filesystem and network. Bab prompts for confirmation before installing unless you pass `--yes`. Only install plugins from sources you trust.

List bundled and installed plugins:

```bash
bab list
```

View current Bab configuration:

```bash
bab config
```

This shows your Bab version, installed plugins, configured AI providers, and environment variables. Pass `--json` for machine-readable output.

Validate a plugin directory:

```bash
bab test-plugin ~/.config/bab/plugins/my-plugin
```

Build the distributable bundle:

```bash
bun run build
```

Optional single-binary build:

```bash
bun run build:binary
```
