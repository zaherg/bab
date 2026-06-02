---
title: Provider Setup
layout: default
nav_order: 3
---

# Provider Setup - Configuring AI Models and API Keys

**Connect bab to AI providers for model-backed tools like chat, thinkdeep, consensus, and all workflow tools**

Bab's provider registry manages connections to AI providers. Tools like `chat`, `thinkdeep`, `codereview`, `consensus`, and all workflow tools use the provider registry to call AI models directly. The `delegate` tool uses CLI plugins instead — see [Plugin Authoring](./plugin-authoring.md) for that.

## Supported Providers

| Provider | Env Variable | Models | Notes |
|----------|-------------|--------|-------|
| **Google** | `GOOGLE_API_KEY` | Gemini 2.5 Pro (1M context) | Highest context window, thinking support |
| **OpenAI** | `OPENAI_API_KEY` | GPT-5.2 (400K context) | General-purpose flagship |
| **Anthropic** | `ANTHROPIC_API_KEY` | Claude Sonnet 4 (200K context) | Balanced coding and reasoning |
| **OpenRouter** | `OPENROUTER_API_KEY` | OpenRouter GPT-5.2 (400K context) | Access multiple providers through one API |
| **Custom** | `CUSTOM_API_KEY` + `CUSTOM_API_URL` | Custom Default (128K context) | Any OpenAI-compatible endpoint |

## Where to Add Environment Variables

Bab reads environment variables from two sources, in order of priority:

### 1. Process Environment (Highest Priority)

Set variables in your shell profile (`~/.zshrc`, `~/.bashrc`) or export them before starting bab:

```bash
export GOOGLE_API_KEY="your-google-api-key"
export OPENAI_API_KEY="your-openai-api-key"
```

### 2. Config Env File

Create `~/.config/bab/env` with your API keys:

```bash
# ~/.config/bab/env
GOOGLE_API_KEY=your-google-api-key
OPENAI_API_KEY=your-openai-api-key
ANTHROPIC_API_KEY=your-anthropic-api-key
OPENROUTER_API_KEY=your-openrouter-api-key
```

The file supports:
- `KEY=VALUE` format (one per line)
- `export KEY=VALUE` format
- Quoted values (`KEY="value"` or `KEY='value'`)
- Comments starting with `#`
- Empty lines (ignored)

**Security note:** The env file filters out dangerous keys like `PATH`, `HOME`, `LD_PRELOAD`, proxy settings, and anything prefixed with `BAB_` to prevent injection.

### Priority Order

When the same variable exists in both sources:

```
Process environment  →  wins (highest priority)
~/.config/bab/env    →  fallback
```

## Setting Up Each Provider

### Google (Gemini)

1. Get an API key from [Google AI Studio](https://aistudio.google.com/apikey)
2. Add to your env:

```bash
GOOGLE_API_KEY=your-key-here
```

Available model: `gemini-2.5-pro` (1M context, thinking, vision)

### OpenAI

1. Get an API key from [OpenAI Platform](https://platform.openai.com/api-keys)
2. Add to your env:

```bash
OPENAI_API_KEY=your-key-here
```

Available model: `gpt-5.2` (400K context, thinking, vision)

### Anthropic

1. Get an API key from [Anthropic Console](https://console.anthropic.com/)
2. Add to your env:

```bash
ANTHROPIC_API_KEY=your-key-here
```

Available model: `claude-sonnet-4-20250514` (200K context, thinking, vision)

### OpenRouter

1. Get an API key from [OpenRouter](https://openrouter.ai/keys)
2. Add to your env:

```bash
OPENROUTER_API_KEY=your-key-here
```

Available model: `openai/gpt-5.2` (400K context, thinking, vision)

### Custom (OpenAI-Compatible)

Connect to any OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, etc.):

```bash
CUSTOM_API_URL=http://localhost:11434/v1
CUSTOM_API_KEY=optional-key-if-needed
```

If `CUSTOM_API_URL` is set without `CUSTOM_API_KEY`, bab uses the URL with no authentication. The default URL if not set is `http://localhost:11434/v1` (Ollama).

Available model: `custom/default` (128K context assumed)

## Verifying Configuration

After setting up your API keys, verify which providers are active:

```bash
# List all available models (only shows providers with valid API keys)
# Use the list_models MCP tool, or:
bab serve
# Then call the list_models tool from your MCP client
```

The `list_models` tool returns:
- **Provider models**: Models from configured AI providers (Google, OpenAI, etc.)
- **Plugin models**: Models from delegate plugins that implement `listModels()`

Only providers with a valid API key configured will appear in the results.

## Model Selection in Tools

Most bab tools accept an optional `model` parameter. When specified, bab resolves the model ID (or alias) against the static model registry:

```
# Direct model ID
model: "gemini-2.5-pro"

# Alias
model: "google/gemini-2.5-pro"
model: "anthropic/claude-sonnet-4"
model: "openai/gpt-5.2"
```

When `model` is omitted, tools use the server's default model selection (typically the highest-scored available model).

### Model Scores

Models are ranked by an internal score used for automatic selection:

| Model | Score |
|-------|-------|
| Gemini 2.5 Pro | 100 |
| GPT-5.2 | 100 |
| Claude Sonnet 4 | 95 |
| OpenRouter GPT-5.2 | 100 |
| Custom Default | 50 |

## Delegate Plugins vs Provider Registry

Bab has two ways to call AI models:

| | Provider Registry | Delegate Plugins |
|---|---|---|
| **Used by** | Direct provider models for `chat`, `thinkdeep`, `codereview`, `consensus`, and workflow tools | `delegate`, plus model-backed tools when a model ID uses `<plugin-id>/<model>` |
| **How it works** | Direct API calls via AI SDK | Spawns external CLI process |
| **Configuration** | API keys in env | Plugin adapter.ts + manifest.yaml |
| **Models** | Static registry (Gemini, GPT, Claude, etc.) + dynamic discovery for providers that support it | CLI-specific (whatever the CLI supports) |
| **Example** | `chat` with `model: "gemini-2.5-pro"` | `delegate` with `cli_name: "copilot"` |

### Dynamic Model Discovery

For supported providers (Google, OpenAI, OpenRouter), bab calls the provider's `GET /models` API at startup and caches the result. Discovered models are merged with the static registry and exposed through `list_models`, so users see the full current catalog without code changes. Custom providers also discover models when `CUSTOM_API_URL` points to an OpenAI-compatible endpoint that exposes `/models`. Discovery is cached per process and re-runs the next time `list_models` is called.

## File Paths Reference

| Path | Purpose |
|------|---------|
| `~/.config/bab/` | Config root directory |
| `~/.config/bab/env` | API keys and global environment variables |
| `~/.config/bab/plugins/` | Installed delegate plugins |
| `~/.config/bab/plugins/<plugin-id>/env` | Per-plugin environment overrides (merged on top of the global env file) |
| `~/.config/bab/logs/mcp.log` | Main server log (lifecycle, tool calls, protocol events, all levels) |
| `~/.config/bab/logs/error.log` | Warnings and errors only |
| `~/.config/bab/logs/<plugin-id>.log` | Per-plugin delegate I/O (e.g. `copilot.log`, `opencode.log`) |
| `~/.config/bab/reports/` | Fallback directory for persisted workflow reports (see [Report Persistence](./report-persistence.md)) |

`BAB_LOG_LEVEL=debug` is intended for local troubleshooting. It may expose stack traces, file paths, and stack frames to the connected MCP client in tool error responses.

## Other Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BAB_CLI_TIMEOUT_MS` | Timeout for delegate CLI processes | `300000` (5 minutes) |

## Troubleshooting

**"Provider not configured" error:**
- Check that the API key is set in either process environment or `~/.config/bab/env`
- Verify the key is not empty or whitespace-only
- For custom providers, ensure `CUSTOM_API_URL` is set (not just `CUSTOM_API_KEY`)

**"Unknown model" error:**
- Use `list_models` to see available model IDs and aliases
- Check spelling — model IDs are case-sensitive

**No models showing in list_models:**
- No API keys configured — add at least one provider's API key
- Env file syntax error — check for missing `=` or invalid characters

**Custom endpoint not working:**
- Verify the URL is reachable: `curl http://localhost:11434/v1/models`
- Ensure the endpoint is OpenAI-compatible (accepts `/v1/chat/completions`)
- Check if the endpoint requires authentication (`CUSTOM_API_KEY`)
