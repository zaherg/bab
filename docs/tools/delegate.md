---
title: Delegate
layout: default
parent: Tool Reference
nav_order: 8
---

# Delegate Tool - Run Prompts Through External CLI Plugins

**Bridge bab to external AI coding assistants like Claude Code, Codex, Copilot, and OpenCode**

The `delegate` tool sends prompts to external CLI tools through bab's plugin adapter system. Each plugin wraps a specific CLI (Claude Code, Codex, Copilot, OpenCode, etc.) and parses its output back into a unified format.

## Example Prompts

**Delegate to a Specific Plugin:**
```
Use bab delegate to ask opencode to analyze the authentication module in this project
```

**Use a Role Preset:**
```
Delegate to claude with the "architect" role and ask it to review the database schema design
```

**Run in a Specific Directory:**
```
Use delegate to have codex fix the failing tests in /Users/me/projects/api
```

**Quick Task Handoff:**
```
Delegate to copilot and ask it to generate unit tests for the UserService class
```

## How It Works

The delegate tool discovers and invokes external CLI tools through a plugin system:

1. **Plugin discovery**: Plugins are loaded from bundled plugins (`plugins/`) and user plugins (`~/.config/bab/plugins/`)
2. **Role resolution**: The requested role is resolved from plugin-specific roles, then built-in roles, then defaults
3. **CLI invocation**: The plugin's adapter spawns the CLI process with the prompt and role
4. **Output parsing**: Each plugin's `adapter.ts` parses CLI-specific output into a standard format
5. **Summary extraction**: If the response contains `<SUMMARY>` tags, the concise summary is extracted
6. **Truncation**: Output is capped at 20,000 characters to stay within protocol limits

## Key Features

- **Multi-CLI support**: Works with Claude Code, Codex, Copilot, OpenCode, and any CLI with a plugin adapter
- **Plugin ecosystem**: Bundled plugins ship with bab; external plugins installable via `bab add <git-url>`
- **Role presets**: Named role configurations that customize the prompt behavior per plugin
- **Working directory validation**: Run CLI tools in any directory within project root, home, or tmp
- **Summary extraction**: Automatically extracts `<SUMMARY>` tags for concise output
- **Output truncation**: Caps response at 20,000 characters to prevent protocol overflow
- **Per-plugin logging**: Each plugin logs to `~/.config/bab/logs/<plugin-id>.log`
- **Configurable timeout**: Set via `BAB_CLI_TIMEOUT_MS` environment variable (default: 5 minutes)
- **Plugin caching**: 5-second TTL cache for plugin discovery to avoid repeated filesystem scans

## Tool Parameters

- `prompt` (string, required): The prompt to send to the external CLI tool
- `role` (string, optional, default "default"): Role preset name that customizes prompt behavior
- `cli_name` (string, optional): Plugin identifier to use (required when multiple plugins are loaded or none is set as default)
- `working_directory` (string, optional): Absolute path to use as the working directory for the CLI process. Must be within the project root, home directory, or tmp.

## Plugin Management

**Install a plugin from git:**
```bash
bab add https://github.com/user/bab-plugin-claude.git
```

Local directory installation is not supported by `bab add`; use `bab test-plugin /path/to/my-plugin` for local validation before publishing to git.

**Available plugins:**
- `opencode` - Bundled with bab
- `claude` - Claude Code CLI (external, via bab-plugins)
- `codex` - OpenAI Codex CLI (external, via bab-plugins)
- `copilot` - GitHub Copilot CLI (external, via bab-plugins)

**Plugin locations:**
- Bundled: `<bab-root>/plugins/`
- User-installed: `~/.config/bab/plugins/`

## Usage Examples

**Basic Delegation:**
```
"Delegate to opencode and ask it to explain the error handling patterns in this codebase"
```

**With Role:**
```
"Use delegate with the reviewer role to have claude review the latest changes"
```

**Targeted Directory:**
```
"Delegate to codex in /Users/me/frontend to refactor the component library"
```

**Multi-Tool Workflow:**
```
"Ask opencode to generate a migration script, then use claude to review it"
```

## Best Practices

- **Specify `cli_name` explicitly** when you have multiple plugins installed to avoid ambiguity
- **Use roles** to get consistent behavior for common tasks (review, architect, default)
- **Set `working_directory`** when the target project differs from your current working directory
- **Keep prompts focused**: Each delegation is a single CLI invocation; break complex tasks into multiple calls
- **Check plugin availability**: Ensure the target CLI is installed and accessible in your PATH
- **Use `<SUMMARY>` tags** in plugin prompts when you want concise output back
- **Adjust timeout** via `BAB_CLI_TIMEOUT_MS` for long-running tasks (default is 5 minutes)

## When to Use Delegate vs Other Tools

- **Use `delegate`** for: Leveraging external CLI tools, running prompts through specialized coding assistants, tasks that benefit from a specific CLI's capabilities
- **Use `chat`** for: Direct AI provider conversations without CLI overhead
- **Use `consensus`** for: Multi-model structured debate and decision-making
