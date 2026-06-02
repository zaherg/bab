---
title: Report Persistence
layout: default
nav_order: 8
---

# Report Persistence

Workflow tools (`thinkdeep`, `codereview`, `debug`, `analyze`, `refactor`, `secaudit`, `testgen`, `docgen`, `precommit`, `tracer`, `consensus`, `planner`, `challenge`) can write structured markdown reports to disk so users can read, share, and re-read results after the MCP response returns.

Persistence is enabled by default for every workflow tool.

## Output Paths

- **Primary:** `<projectRoot>/.bab/<toolName>/`
- **Fallback:** `~/.config/bab/reports/.bab/<toolName>/`

`<projectRoot>` is the bab-resolved project root (the directory the MCP server was launched from, when available). When bab cannot determine a project root — for example, when launched outside a git checkout or a writable working directory — reports fall back to `~/.config/bab/reports/`.

`<toolName>` is the bare tool name (for example, `thinkdeep`), not the `bab:<toolName>` identifier used in JSON payloads.

## File Naming

A new report gets a filename of the form `<YYYY-MM-DD-HH-MM>-<slug>.md`, where `<slug>` is derived from the first 50 characters of the request (lowercase, non-alphanumerics collapsed to `-`).

Continuation IDs (multi-step investigations) append a new `## Step N:` section to the existing file instead of creating a new one, so a single report contains the full investigation history.

## Document Format

Reports are markdown files with YAML frontmatter:

```markdown
---
schema_version: 1
tool: bab:thinkdeep
models:
  - id: gemini-2.5-pro
    provider: google
    role: primary
continuation_id: 7c8a-1234-5678-9abc-def012345678
timestamp: 2026-06-02T10:00:00.000Z
---

**Summary:** <one-paragraph summary extracted from the response>

# thinkdeep: <first 80 chars of the request>

## Request
> <first 200 chars of the request>

## Analysis
<full response body>

## Expert Validation
<expert model output, when `use_assistant_model: true`>
```

If the response contains a `<SUMMARY>...</SUMMARY>` block, the summary at the top of the report is taken from there. Otherwise, bab falls back to the first three sentences of the response.

## Configuration

| Variable | Type | Default | Effect |
|----------|------|---------|--------|
| `BAB_PERSIST` | boolean | `true` | Master switch. Set to `false` to disable report persistence globally. |
| `BAB_PERSIST_TOOLS` | comma-separated | _(unset)_ | If set, only the listed tool names are persisted. |
| `BAB_DISABLED_PERSIST_TOOLS` | comma-separated | _(unset)_ | Persist everything except the listed tool names. Applied after `BAB_PERSIST_TOOLS`. |

Examples:

```bash
# Disable persistence entirely
BAB_PERSIST=false

# Only persist codereview and secaudit reports
BAB_PERSIST_TOOLS=codereview,secaudit

# Persist everything except chat responses
BAB_DISABLED_PERSIST_TOOLS=chat
```

Persistence errors never propagate to the MCP client — they are logged as warnings and the tool response is returned normally.

## Finding Your Reports

The fastest way to locate reports for the current project is to look in `<projectRoot>/.bab/`. From the bab docs:

```bash
# All reports in the current project
ls .bab/

# All thinkdeep reports
ls .bab/thinkdeep/

# Most recent report (filename is timestamp-prefixed)
ls -t .bab/thinkdeep/*.md | head -1
```

For reports written outside a project root, check `~/.config/bab/reports/.bab/<toolName>/`.
