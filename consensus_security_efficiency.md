# Consensus Review: Security & Efficiency

**Participants:** `google/gemini-3.5-flash`, `deepseek/deepseek-v4-pro`, validated by `codex`
**Scope:** `/Users/zaher/Code/bab/src` — Bab TypeScript/Bun MCP server
**Date:** 2026-06-28

## Executive Summary

Initial consensus identified four priorities. Codex validation confirms the broad themes but revises severity and remediation. The highest-value immediate work is: (1) add execution boundaries around direct plugin-adapter calls, (2) cap consensus inputs and fanout, and (3) tighten the typed env boundary. Broad branch-cluster flattening and blanket replacement of `process.env` reads are overstated.

## Validated Findings

### P0 — Centralize environment-variable access

**Status:** Partially confirmed.

**Confirmed:** Direct `process.env` reads remain outside the config boundary in:
- `src/delegate/process-runner.ts:5`
- `src/commands/selfupdate.ts:57,111`
- `src/tools/delegate/index.ts:228`
- `src/providers/model-gateway.ts:141`
- `src/utils/logger.ts:40`

**Already mitigated:** `src/config.ts` validates known `BAB_*` variables via `BabEnvSchema`, and `src/utils/env.ts` sanitizes delegate environment (strips secrets, preload/runtime vars). Tests cover this in `tests/env-utils.test.ts`.

**Corrected remediation:**
- Freeze typed `BAB_*` config at startup.
- Make `mergeEnv()` the only path used to build `Bun.spawn` env.
- Do not replace every boundary `process.env` read indiscriminately.

### P1 — Standardize error handling

**Status:** Partially confirmed.

**Confirmed:** Error styles are mixed:
- `selfupdate.ts` returns `Result<T, E>` helpers.
- `commands/add.ts` throws `CommandError` and cleans up in `catch/finally`.
- `tools/consensus/index.ts` broadly catches and wraps failures.

**Already mitigated:** `ProcessRunner` already applies timeout, SIGKILL escalation, and active-state cleanup on `error`/`close` (`src/delegate/process-runner.ts:108,131,191`). Tests pass.

**Critical gap:** Direct plugin `adapter.run()` calls bypass `ProcessRunner` and currently have no timeout/cancellation wrapper:
- `src/tools/delegate/index.ts:227`
- `src/providers/model-gateway.ts:140`

### P2 — Bound consensus and delegate fanout

**Status:** Partially confirmed; original remediation mostly wrong.

**Disputed:** Provider/model lookups in `src/providers/registry.ts` are not a proven algorithmic hot path. Flattening nested branches there is low-value.

**Confirmed risk:** `ConsensusInputSchema` lacks caps:
- No maximum `models` count.
- No maximum `model_responses` length.
- No maximum string lengths (prompts, findings, responses).
- No upper-bound validation of `current_model_index` against `models.length`.

Parallel consensus can launch every remaining model via `Promise.allSettled` (`src/tools/consensus/index.ts:187`).

**Corrected remediation:**
- Add schema caps: max models, max prior responses, max embedded-file count/size, max prompt length.
- Reject inconsistent `current_model_index` immediately.
- Keep branch structure as-is where it is not a proven bottleneck.

### P3 — Harden update and install paths

**Status:** Partially confirmed.

**Self-update:** Already well-hardened. `commands/selfupdate.ts` checks asset origin, requires a checksum asset, verifies SHA-256, installs to a temp dir, verifies `--version`, rolls back, and cleans up (`src/commands/selfupdate.ts:189,207,329,399`). Tests cover checksum success/mismatch/missing and rollback.

**Remaining gap:** Checksum asset origin shares the same GitHub release trust root as the binary, so it does not protect against a compromised release. Stronger fix is signed provenance or detached signatures, not checksums alone.

**Plugin install:** `commands/add.ts` clones arbitrary HTTPS/SSH Git sources and trusts the repo after confirmation (`src/commands/add.ts:120,296`). It records resolved commit and adapter hash in metadata, but does not verify signed commits/tags (`src/commands/add.ts:415`, `src/delegate/loader.ts:56`).

## Additional Issues Found by Codex

| ID | Issue | Severity |
|----|-------|----------|
| CX-01 | Plugin adapters can hang indefinitely when not using the `buildCommand`/`ProcessRunner` path | Medium |
| CX-02 | Consensus lacks tests for parallel partial failure and maliciously large inputs | Medium |

## Risk Registry

| ID | Concern | Severity | Primary Mitigation |
|----|---------|----------|--------------------|
| CR-01 | Local-privilege / path injection via uncentralized env reads | **Medium** | Freeze typed `BAB_*` config; route delegate env through `mergeEnv()` |
| CR-02 | Hung or resource-starved plugin adapters outside `ProcessRunner` | **Medium-High** | Timeout-wrap all `adapter.run()` calls, including async-iterable consumption |
| CR-03 | Unbounded consensus fanout / oversized inputs | **Medium** | Schema caps on models, responses, prompt length, embedded files |
| CR-04 | Supply-chain compromise during plugin install / release update | **Medium** | Signed tags/provenance for plugins; signed releases beyond checksums |

## Validation Plan

1. Static inventory: `rg 'process\.env'` across `src/` and group by boundary vs. hot path.
2. Add tests: adapter-run timeout, consensus oversized-input rejection, parallel partial failure.
3. Profile consensus under large `models` arrays to confirm fanout cost.
4. Verify `ProcessRunner` is the only async execution path for external commands.

## Verification Run

```sh
bun test tests/consensus-tool.test.ts tests/env-utils.test.ts tests/selfupdate.test.ts tests/delegate.test.ts
# Result: 61 pass, 0 fail
```

## Confidence

**Medium-High** after Codex validation. Core gaps are confirmed with specific lines and tests. Severity of branch-cluster flattening was downgraded.
