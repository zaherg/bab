# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [Unreleased]

### Added

- Update README, getting-started, plugin-authoring, and tool docs for v0.1.3.

### Changed

- Rename BAB_OPENCODE_CAPTURE_DIR to OPENCODE_CAPTURE_DIR to avoid BAB_* env stripping.

### Other

- Update .gitignore.
- S8 — plugin symlink escape via path containment.
- S10 — expand env denylist with pattern-based secret stripping.
- S9 — adapter hash pinning for install integrity.
- S11-S14 — process-runner hardening.
- S15-S17 — skills TOCTOU, log secret redaction, env quote edge case.

## [0.1.3-20260326] - 2026-03-26

### Added

- Add MCP prompts for slash commands (/bab:chat, /bab:review, etc.).
- Add slash commands reference.
- Add all installation methods to README and getting-started.
- Add MCP client setup examples.
- Document tool_prompts and update plugin installation guide.
- Add changelog script and generate CHANGELOG.md.
- Add model ID format guidance to all tool schemas.
- Add .describe() to 8 schema fields that cause LLM misuse.
- Add persistence layer for tool report storage.
- Test script, Google API key leak, and persistence step counter.
- Implement HIGH priority items from code review plan.
- Implement MEDIUM priority items from code review plan.

### Changed

- Update release workflow — replace macos-13 with macos-15-intel, fix shellcheck SC2129.
- Rename docs/README.md to docs/index.md to fix GitHub Pages root 404.
- Auto-generate changelog on tag push, mark rc/beta as pre-release.
- Rename changelog script to changelog:update.
- Update changelog with unreleased changes.
- Update changelog with M16 lazy tool loading and schema improvements.
- Update changelog for v0.1.2-20260325.
- H1/H2/H3 — delegate env hardening and plugin cache recovery.

### Fixed

- Fix TOCTOU race, harden plugin reads, secure selfupdate temp files.
- Fix no-op assertions and tighten test accuracy.

### Other

- Bab MCP server — initial release.
- File embedding allowlist, reject http:// plugins, increase delegate timeout.
- Auto-resolve relative file paths and fallback on unknown models.
- Prefer exact model id over alias to prevent cross-provider collision.
- Deduplicate env denylists, centralize containment, simplify selfupdate cleanup.
- Move assertPathContainment to utils, rename embedFiles, add selectModel warning.
- Resolve tsc errors — widen DELEGATE_ENV_DENYLIST type, add modelGateway to test fixtures.
- Bump version to 0.1.2-rc1.
- Resolve duplicate nav_order in docs (provider-setup and slash-commands both had 3).
- Initial plan.
- Add GitHub Pages deployment workflow.
- Initial plan.
- Refresh CLI help banner.
- Manifest schema + loader caching for plugin tool prompts.
- ModelGateway toolName + prompt resolution.
- Wire toolName through workflow, simple, and consensus tools.
- Tests for plugin tool prompts.
- Increase default delegate timeout to 3 hours.
- Address consensus review issues for plugin tool prompts.
- List available tool prompt names in a table.
- Harden tool prompts with allowlist, null prototype, and debug logging.
- Strengthen co-authorship rules for bab tool usage.
- Strip Co-authored-by trailers from changelog output.
- Use only commit subject line in changelog entries.
- Note that MCP client env vars override the bab env file.
- Support BAB_DISABLED_TOOLS env var to blocklist tools.
- Lazy tool loading via BAB_LAZY_TOOLS=1.
- Include available SDK models in model-not-found error.
- Bump version to 0.1.2-20260316.
- Treat date-based version tags as pre-release.
- Finalize changelog for v0.1.2-20260316.
- Gracefully skip missing files in embedFiles and clarify delegate role description.
- Dynamic model inference in ProviderRegistry.
- Dynamic model discovery via provider APIs.
- Structured report format with frontmatter, summary, and multi-step appending.
- Bump version to 0.1.2-20260325.
- Resolve CI type errors — optional BabConfig fields and fetch mock cast.
- Move plans/tasks outside the project.
- Accept single string for relevant_files and add error.log.
- Medium priority review items — M1/M2/M3/M5/M6 + L2 promoted.
- Bump version to 0.1.3-20260326.
