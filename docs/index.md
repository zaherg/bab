---
title: Home
layout: default
nav_order: 1
---

# Bab Documentation

## Setup

| Document | Description |
|----------|-------------|
| [Getting Started](./getting-started.md) | Installation, configuration, common commands |
| [Slash Commands](./slash-commands.md) | `/bab:chat`, `/bab:review`, and other slash commands |
| [Provider Setup](./provider-setup.md) | API keys, AI providers, environment variables, model selection |
| [Plugin Authoring](./plugin-authoring.md) | Manifest, directory layout, SDK, plugin installation |
| [Adapter Tutorial](./adapter-tutorial.md) | Plugin interface, parsing patterns, extending tools |
| [Report Persistence](./report-persistence.md) | Where workflow reports are written and how to configure persistence |

## Tool Reference

| Tool | Type | Description |
|------|------|-------------|
| [chat](./tools/chat.md) | Simple | Collaborative thinking partner for brainstorming and development discussion |
| [thinkdeep](./tools/thinkdeep.md) | Workflow | Multi-stage investigation and deep reasoning for complex problems |
| [debug](./tools/debug.md) | Workflow | Systematic debugging and root cause analysis |
| [analyze](./tools/analyze.md) | Workflow | Comprehensive code analysis (architecture, performance, quality) |
| [codereview](./tools/codereview.md) | Workflow | Systematic code review with expert validation |
| [planner](./tools/planner.md) | Workflow | Interactive task planning with branching and revision |
| [consensus](./tools/consensus.md) | Specialized | Multi-model consensus through structured debate |
| [delegate](./tools/delegate.md) | Specialized | Run prompts through CLI plugin adapters (Claude, Codex, Copilot, OpenCode) |
| [refactor](./tools/refactor.md) | Workflow | Code smell detection, decomposition, modernization analysis |
| [secaudit](./tools/secaudit.md) | Workflow | Security audit with OWASP, compliance, and threat modeling |
| [testgen](./tools/testgen.md) | Workflow | Test suite generation with edge case coverage |
| [docgen](./tools/docgen.md) | Workflow | Code documentation generation with complexity analysis |
| [precommit](./tools/precommit.md) | Workflow | Pre-commit validation for git changes |
| [tracer](./tools/tracer.md) | Workflow | Code tracing for execution flow and dependency mapping |
| [challenge](./tools/challenge.md) | Specialized | Critical thinking — forces scrutiny of claims |
| [list_models](./tools/list_models.md) | Utility | Lists available models from providers and plugins |
| [version](./tools/version.md) | Utility | Returns bab and runtime version information |

## Tool Types

- **Simple**: Single-pass tools — send a prompt, get a response. Direct AI provider call.
- **Workflow**: Multi-step investigation tools. Claude performs structured research across multiple steps, then optionally sends findings to an AI model for expert validation.
- **Specialized**: Custom implementations with unique behavior (multi-model debate, CLI bridging, critical thinking).
- **Utility**: Information tools with no AI model calls.
