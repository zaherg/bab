# Security Policy

## Supported Versions

Bab is currently in pre-release. Security fixes are applied to the latest version only.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report vulnerabilities by emailing the maintainer directly or opening a [GitHub Security Advisory](https://github.com/zaherg/bab/security/advisories/new) (private disclosure).

Include:
- Description of the vulnerability and its potential impact
- Steps to reproduce
- Any suggested fix (optional)

You can expect an acknowledgement within 48 hours and a resolution timeline within 7 days for critical issues.

## Security Model

### Plugin Trust

Bab plugins (adapter.ts files) run as **trusted code** in the same process with full access to your filesystem and network. This is equivalent to installing an npm package that runs at startup.

- Only install plugins from sources you trust
- Review adapter.ts before installing third-party plugins
- `bab add` will always prompt for confirmation before installing

### Environment Variables

Bab strips sensitive environment variables (PATH, LD_PRELOAD, NODE_OPTIONS, HOME, BAB_INTERNAL_SECRET, and others) before passing env to plugin adapters. Plugins receive only variables explicitly configured in their `env` file plus variables from the global bab env file.

### Process Spawning

CLI tools are spawned using array-based arguments (no shell interpolation), preventing command injection from user-supplied input.

### AI Review Disclosure

The security controls in this codebase were designed and reviewed with AI assistance (Claude). No independent human security audit has been performed as of the initial release. Community review is welcome.

## Known Limitations

- Plugin adapters are not sandboxed — they run with full process privileges
- No plugin signing or hash pinning is enforced for third-party plugins
- Prompts passed to CLI tools are visible in the OS process table (`ps`)
