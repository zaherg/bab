import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "install.sh");
const source = readFileSync(SCRIPT, "utf8");

type RunResult = { exit: number; stdout: string; stderr: string };

async function run(cmd: string[]): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exit: exitCode, stdout, stderr };
}

async function runScript(args: string[]): Promise<RunResult> {
  return run(["bash", SCRIPT, ...args]);
}

const hasShellcheck = (() => {
  try {
    return Bun.spawnSync(["which", "shellcheck"]).exitCode === 0;
  } catch {
    return false;
  }
})();

/* ────────────────────────────────────────────────────────────────── */
/*  Script must exist at the new path                                */
/* ────────────────────────────────────────────────────────────────── */

describe("scripts/install.sh — file presence", () => {
  test("lives at scripts/install.sh (post-rename)", () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────── */
/*  CLI surface (subprocess tests)                                    */
/* ────────────────────────────────────────────────────────────────── */

describe("scripts/install.sh — CLI surface", () => {
  test("--help exits 0 and documents the canonical path", async () => {
    const out = await runScript(["--help"]);
    expect(out.exit).toBe(0);
    expect(out.stdout).toContain(
      "raw.githubusercontent.com/zaherg/bab/main/scripts/install.sh",
    );
    expect(out.stdout).toContain("--prefix");
    expect(out.stdout).toContain("--no-verify");
    expect(out.stdout).toContain("--prerelease");
    expect(out.stdout).toContain("--force");
  });

  test("-h is an alias for --help", async () => {
    const out = await runScript(["-h"]);
    expect(out.exit).toBe(0);
    expect(out.stdout).toContain("Bab Installer");
  });

  test("unknown flag exits 1 with usage hint", async () => {
    const out = await runScript(["--bogus"]);
    expect(out.exit).toBe(1);
    expect(out.stderr).toContain("Unknown option");
    expect(out.stderr).toContain("--help");
  });

  test("--prefix without value exits 1", async () => {
    const out = await runScript(["--prefix"]);
    expect(out.exit).toBe(1);
    expect(out.stderr).toContain("--prefix requires a directory argument");
  });

  test("--prefix= with empty value exits 1", async () => {
    const out = await runScript(["--prefix="]);
    expect(out.exit).toBe(1);
    expect(out.stderr).toContain(
      "--prefix requires a non-empty directory argument",
    );
  });
});

/* ────────────────────────────────────────────────────────────────── */
/*  Repo identity (matches git remote)                                */
/* ────────────────────────────────────────────────────────────────── */

describe("scripts/install.sh — repo identity", () => {
  test("OWNER is zaherg, not babmcp", () => {
    expect(source).toMatch(/^OWNER="zaherg"$/m);
    expect(source).not.toMatch(/babmcp/);
  });

  test("REPO is bab", () => {
    expect(source).toMatch(/^REPO="bab"$/m);
  });

  test("self-referential curl URL lives at scripts/install.sh", () => {
    expect(source).toMatch(
      /raw\.githubusercontent\.com\/\$\{OWNER\}\/\$\{REPO\}\/main\/scripts\/install\.sh/,
    );
  });
});

/* ────────────────────────────────────────────────────────────────── */
/*  Safety hardening                                                  */
/* ────────────────────────────────────────────────────────────────── */

describe("scripts/install.sh — safety hardening", () => {
  test("enables set -euo pipefail", () => {
    expect(source).toMatch(/^set -euo pipefail$/m);
  });

  test("validates HOME is set under set -u", () => {
    expect(source).toMatch(/^: "\$\{HOME:\?/m);
  });

  test("cleanup trap preserves exit status and covers INT/TERM", () => {
    expect(source).toMatch(/trap cleanup_download EXIT INT TERM/);
    expect(source).toMatch(/cleanup_download\(\)\s*\{/);
    expect(source).toMatch(/local status=\$\?/);
  });

  test("atomic install stages to .bab.tmp.$$ before mv -f", () => {
    expect(source).toContain(".bab.tmp.$$");
    expect(source).toMatch(/\bmv -f\b/);
    expect(source).toMatch(/\binstall -m 755\b/);
  });

  test("symlinked destination is rejected before any write", () => {
    expect(source).toMatch(/\[ -L "\$INSTALL_PATH" \]/);
    expect(source).toMatch(
      /is a symlink; remove it or pass a different --prefix/,
    );
  });

  test("binary is smoke-tested with --version before install", () => {
    expect(source).toMatch(/\$\{TMPDIR_DL\}\/bab.*--version/s);
    expect(source).toContain("failed smoke test");
  });

  test("sudo is gated by a y/N confirmation prompt", () => {
    expect(source).toContain("confirm_sudo");
    expect(source).toMatch(/\[y\/N\]/);
    expect(source).toMatch(/Need sudo to .* but stdin is not interactive/);
  });
});

/* ────────────────────────────────────────────────────────────────── */
/*  Network + version resolution                                      */
/* ────────────────────────────────────────────────────────────────── */

describe("scripts/install.sh — network and version resolution", () => {
  test("curl_dl helper has retry, connect-timeout, and max-time", () => {
    expect(source).toMatch(/curl_dl\(\)\s*\{/);
    expect(source).toMatch(/--retry 3/);
    expect(source).toMatch(/--retry-delay 1/);
    expect(source).toMatch(/--connect-timeout 10/);
    expect(source).toMatch(/--max-time 300/);
  });

  test("jq tag query uses // empty to handle missing field", () => {
    expect(source).toMatch(/jq -r.*tag_name \/\/ empty/s);
  });

  test("version tag is validated against ^v?[0-9] regex", () => {
    expect(source).toMatch(/\[\[ "\$VERSION" =~ \^v\?\[0-9\] \]\]/);
  });

  test("Homebrew fallback is suppressed when --prefix is set", () => {
    expect(source).toContain('if [ -n "$PREFIX" ]; then');
    expect(source).toContain("Not falling back to Homebrew");
  });
});

/* ────────────────────────────────────────────────────────────────── */
/*  Checksum verification                                             */
/* ────────────────────────────────────────────────────────────────── */

describe("scripts/install.sh — checksum verification", () => {
  test("parses checksums with awk, not grep+grep+sed", () => {
    expect(source).toMatch(/awk -v asset="\$asset"/);
    expect(source).not.toMatch(/grep -F " \$\{asset\}".*grep "\$\{asset\}\$"/s);
  });

  test("pre-checks sha256sum / shasum availability", () => {
    expect(source).toMatch(/command -v sha256sum/);
    expect(source).toMatch(/command -v shasum/);
  });
});

/* ────────────────────────────────────────────────────────────────── */
/*  Homebrew detection                                                */
/* ────────────────────────────────────────────────────────────────── */

describe("scripts/install.sh — Homebrew detection", () => {
  test("uses realpath and matches Cellar/Homebrew/linuxbrew", () => {
    expect(source).toContain('realpath "$INSTALL_PATH"');
    expect(source).toMatch(/\*\/Cellar\/\*/);
    expect(source).toMatch(/\*\/Homebrew\/\*/);
    expect(source).toMatch(/\*\/linuxbrew\/\*/);
  });
});

/* ────────────────────────────────────────────────────────────────── */
/*  PATH detection                                                    */
/* ────────────────────────────────────────────────────────────────── */

describe("scripts/install.sh — PATH detection", () => {
  test("splits PATH on ':' for literal comparison (no glob)", () => {
    expect(source).not.toMatch(
      /case ":\${PATH}:" in \*":\${INSTALL_DIR}:"\*\)/,
    );
    expect(source).toMatch(/IFS=':'/);
    expect(source).toMatch(/for entry in \$PATH/);
  });

  test("zsh advice mentions ~/.zprofile for login shells", () => {
    expect(source).toContain("~/.zprofile");
  });
});

/* ────────────────────────────────────────────────────────────────── */
/*  Version reporting                                                 */
/* ────────────────────────────────────────────────────────────────── */

describe("scripts/install.sh — version reporting", () => {
  test("reports version via $INSTALL_PATH, not via $PATH", () => {
    expect(source).toMatch(/"\$INSTALL_PATH" --version/);
    expect(source).not.toMatch(/\$\(\s*bab --version/);
  });
});

/* ────────────────────────────────────────────────────────────────── */
/*  Lint + parse                                                      */
/* ────────────────────────────────────────────────────────────────── */

describe("scripts/install.sh — lint and parse", () => {
  test("bash -n parses without errors", async () => {
    const out = await run(["bash", "-n", SCRIPT]);
    expect(out.exit).toBe(0);
  });

  test.skipIf(!hasShellcheck)(
    "shellcheck at default severity is clean",
    async () => {
      const out = await run(["shellcheck", SCRIPT]);
      expect(out.exit).toBe(0);
    },
  );
});
