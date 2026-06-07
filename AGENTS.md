# AGENTS.md — Bab

You are a concise technical expert.

## Project Overview

Bab (باب) — TypeScript MCP server (Bun runtime) replacing pal-mcp-server.

## Task Execution Rules

### Dependency enforcement
- **NEVER start a task before ALL its dependencies are marked `completed`** in the milestone file and `./claude/tasks/index.md`.
- Before beginning any task, read its milestone file (`./claude/tasks/m<N>_*.md`) and verify every listed dep is done.
- If a dep is not completed, stop and report what is blocking.

### Status tracking
- When starting a task: set status to `in_progress` in both the milestone file and `./claude/tasks/index.md`.
- When finishing a task: set status to `completed`, increment progress counter, update `last_task` and `last_updated`.
- If a milestone's tasks are all completed, set the milestone status to `completed`.

### Git workflow
- Work on a feature branch per milestone: `m<N>/<short-description>` (e.g. `m1/scaffold`, `m2/claude-plugin`).
- Commit after each task completes with message: `M<N>-T<NN>: <short description>`.
- Merge to `main` only when the full milestone passes its exit criteria.
- After a branch is merged into `main`, delete the merged branch locally and on the remote unless the user explicitly asks to keep it.
- **Co-authorship**: Every commit must include a `Co-authored-by` trailer for each AI agent that contributed. This includes:
  - Direct code authorship
  - Work delegated via bab tools (`delegate`, `chat`, `consensus`, `codereview`, `thinkdeep`, etc.)
  - Reviews or analysis routed through a plugin model (e.g. `copilot/gpt-4`, `codex/o3`)
  - **Before every commit**, review which bab tools (or any MCP tools) were called in the session and which agents/models they routed through. Add a trailer only for agents that **actually produced output** — not for models that failed, were unavailable, or didn't exist.
  - Use the agent's name and official email. If the agent is not listed above, use `<agent-name> <agent-name>@<provider-domain>`.

### Git worktrees for parallel work
- **Use `wt`** when working on two independent tasks simultaneously (tasks with no shared dependencies).
- **Use `wt --help`** when you need to know more about the tool.
- Example: M4-T01 (Copilot research) and M5-T01 (OpenCode research) can run in parallel worktrees.
- Worktree location: `/Users/zaher/Code/worktree/bab`.
- Create: `wt switch <branch> --create`
- Merge: `wt merge <branch>`
- Remove after merge: `wt remove <branch>`
- **Do NOT use worktrees for tasks that share deps or modify the same files** — use sequential branches instead.

## Code Conventions (remove after M1 — infer from codebase)

- **Bun-first**: Use Bun APIs over `node:` equivalents. `Bun.file().text()` not `readFile`, `Bun.write()` not `writeFile`, `Bun.which()` not manual PATH lookup, `Bun.spawn()`/`Bun.spawnSync()` over `node:child_process` where practical, `crypto.randomUUID()` (global) not `node:crypto`. Only use `node:` when Bun has no equivalent (e.g. `node:path`, `node:os`, `node:readline`, `mkdir`, `readdir`, `realpath`, `rename`, `rm`).
- Runtime: Bun (not Node)
- Package manager: bun
- Linting: biome
- Validation: Zod schemas, `zod-to-json-schema` for MCP
- Error handling: `Result<T, E>` discriminated unions — no thrown exceptions for control flow
- Composition over inheritance — no mixins
- All logs to stderr (stdout reserved for MCP protocol) + file logs at `~/.config/bab/logs/` (`mcp.log`, `error.log`, per-plugin `<id>.log`)
- Tests: `bun test`


## Testing Rules

- **Every milestone must have all tests green before moving to the next milestone.** No exceptions.
- Tests must provide real value — they validate actual behavior, edge cases, and integration points.
- **Do NOT write tests for the sake of coverage.** No testing trivial getters, no mocking everything into oblivion, no asserting that a constructor sets a property.
- **DO test**: schema validation with invalid input, error handling paths, process runner timeout/signal behavior, role resolution edge cases, output limiting/truncation, conversation thread limits, provider env-gating, e2e tool call round-trips.
- Use `bun test`. Prefer integration tests over unit tests when the boundary is thin.
- E2e plugin tests require the actual CLI binary installed — skip gracefully if not available.

## Security

- Never commit API keys, credentials, or `.env` files.
- Use environment variables loaded from `~/.config/bab/env`.
- Do not commit `CLAUDE.md`, `CLAUDE.local.md`, or `.agent-os/`.
