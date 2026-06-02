---
title: Tool Reference
layout: default
nav_order: 7
has_children: true
---

# Tool Reference

Quick reference for all bab MCP tools. See individual tool docs in [tools/](./tools/) for detailed usage, examples, and best practices.

## Utility

- **`list_models`**: Lists available models from configured AI providers and delegate plugins. No parameters.
- **`version`**: Returns bab and runtime version information. No parameters.

## Delegate

- **`delegate`**: Runs a prompt through a configured CLI plugin adapter. Bridges bab to external CLIs (Claude Code, Codex, Copilot, OpenCode).

## Simple Tools

- **`chat`**: General-purpose collaborative thinking partner for brainstorming, development discussion, second opinions, and exploring ideas.

## Workflow Tools (Multi-Step Investigation + Expert Validation)

- **`thinkdeep`**: Multi-stage investigation and deep reasoning for complex problems, architecture decisions, and performance challenges.
- **`debug`**: Systematic debugging with hypothesis testing, evidence collection, and root cause analysis.
- **`analyze`**: Comprehensive code analysis for architecture, performance, security, quality, and pattern understanding.
- **`codereview`**: Systematic code review covering quality, security, performance, and architecture.
- **`planner`**: Interactive task planning with branching, revision, and incremental refinement.
- **`refactor`**: Code smell detection, decomposition planning, modernization, and organization analysis.
- **`secaudit`**: Security audit with OWASP Top 10, compliance evaluation, and threat modeling.
- **`testgen`**: Test suite generation with edge case coverage and failure mode analysis.
- **`docgen`**: Code documentation generation with complexity analysis and call flow mapping.
- **`precommit`**: Pre-commit validation for git changes with security review and impact assessment.
- **`tracer`**: Code tracing in precision mode (execution flow) or dependencies mode (structural relationships).

## Specialized Tools

- **`consensus`**: Multi-model consensus through structured debate. Consults multiple AI models (SDK or plugin via `pluginId/modelName`) with different stances, per-model temperature and thinking mode, optional parallel execution, and a synthesized recommendation.
- **`challenge`**: Forces critical thinking by scrutinizing claims. No AI model call — pure prompt-based.

## Common Parameters

Most workflow tools share these parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `step` | string | Current investigation step content |
| `step_number` | number | Current step number (>= 1) |
| `total_steps` | number | Estimated total steps (>= 1) |
| `next_step_required` | boolean | Whether more steps are needed |
| `findings` | string | Discoveries and evidence collected |
| `confidence` | enum | exploring, low, medium, high, very_high, almost_certain, certain |
| `continuation_id` | string | Resume previous conversation thread |
| `model` | string | Specific model ID or alias |
| `temperature` | number | Response creativity (0-1) |
| `thinking_mode` | enum | minimal, low, medium, high, max |
| `files_checked` | string[] | All files examined during investigation |
| `relevant_files` | string[] | Files directly relevant to the task |
| `relevant_context` | string[] | Methods/functions involved |
| `issues_found` | object[] | Issues with `description` and `severity` |
| `images` | string[] | Absolute paths to screenshots/diagrams |
| `use_assistant_model` | boolean | Whether to run expert validation phase |

## Conversation Threading

- Max **20 total turns** per thread before requiring a new continuation
- Only the most recent **8 turns** are injected into the prompt context
- Use `continuation_id` to maintain context across multiple tool calls

## File Embedding

- Max file size: **50,000 tokens** per file
- Max total: **40% of model context window** (min 4,000, max 50,000 tokens)
- Must be **absolute paths**
- Non-files are skipped with reason
