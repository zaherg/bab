import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  downloadAndInstall,
  fetchLatestRelease,
  isBinaryInstall,
  isBrewInstall,
  isNewerVersion,
  type ReleaseAsset,
  resolveAssetUrl,
  runSelfUpdate,
  type SelfupdateDeps,
  verifyChecksum,
  type WritableLike,
} from "../src/commands/selfupdate";

/** Create a mock fetch that satisfies the typeof fetch signature */
function mockFetch(
  impl: (...args: Parameters<typeof fetch>) => Promise<Response>,
): typeof globalThis.fetch {
  const fn = mock(impl) as unknown as typeof globalThis.fetch;
  return fn;
}

/* ------------------------------------------------------------------ */
/*  Version comparison                                                 */
/* ------------------------------------------------------------------ */

describe("isNewerVersion", () => {
  test("returns true when latest is newer (patch)", () => {
    expect(isNewerVersion("0.2.1", "0.2.0")).toBe(true);
  });

  test("returns true when latest is newer (minor)", () => {
    expect(isNewerVersion("0.3.0", "0.2.5")).toBe(true);
  });

  test("returns true when latest is newer (major)", () => {
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
  });

  test("returns false when versions are equal", () => {
    expect(isNewerVersion("0.2.0", "0.2.0")).toBe(false);
  });

  test("returns false when current is newer", () => {
    expect(isNewerVersion("0.1.0", "0.2.0")).toBe(false);
  });

  test("handles v prefix", () => {
    expect(isNewerVersion("v1.0.0", "v0.9.0")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  Platform asset resolution                                          */
/* ------------------------------------------------------------------ */

describe("resolveAssetUrl", () => {
  const assets: ReleaseAsset[] = [
    {
      browser_download_url:
        "https://github.com/zaherg/bab/releases/download/v0.1.0/bab-darwin-arm64",
      name: "bab-darwin-arm64",
    },
    {
      browser_download_url:
        "https://github.com/zaherg/bab/releases/download/v0.1.0/bab-darwin-x64",
      name: "bab-darwin-x64",
    },
    {
      browser_download_url:
        "https://github.com/zaherg/bab/releases/download/v0.1.0/bab-linux-x64",
      name: "bab-linux-x64",
    },
    {
      browser_download_url:
        "https://github.com/zaherg/bab/releases/download/v0.1.0/bab-linux-arm64",
      name: "bab-linux-arm64",
    },
    {
      browser_download_url:
        "https://github.com/zaherg/bab/releases/download/v0.1.0/checksums.sha256",
      name: "checksums.sha256",
    },
  ];

  test("resolves darwin-arm64 asset", () => {
    const result = resolveAssetUrl(assets, "darwin", "arm64");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.asset.name).toBe("bab-darwin-arm64");
      expect(result.value.checksumAsset?.name).toBe("checksums.sha256");
    }
  });

  test("resolves linux-x64 asset", () => {
    const result = resolveAssetUrl(assets, "linux", "x64");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.asset.name).toBe("bab-linux-x64");
    }
  });

  test("returns error for unsupported platform", () => {
    const result = resolveAssetUrl(assets, "win32", "x64");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("No binary available for win32-x64");
      expect(result.error).toContain("Supported:");
    }
  });

  test("returns error for unsupported arch", () => {
    const result = resolveAssetUrl(assets, "darwin", "ia32");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("No binary available for darwin-ia32");
    }
  });

  test("handles missing checksums asset gracefully", () => {
    const noChecksums = assets.filter((a) => a.name !== "checksums.sha256");
    const result = resolveAssetUrl(noChecksums, "darwin", "arm64");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.checksumAsset).toBeUndefined();
    }
  });

  test("rejects unexpected download origin", () => {
    const badAssets: ReleaseAsset[] = [
      {
        browser_download_url: "https://evil.com/bab-darwin-arm64",
        name: "bab-darwin-arm64",
      },
    ];
    const result = resolveAssetUrl(badAssets, "darwin", "arm64");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Unexpected download origin");
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Binary detection                                                   */
/* ------------------------------------------------------------------ */

describe("isBinaryInstall", () => {
  test("returns false in development (no embedded files)", () => {
    expect(isBinaryInstall()).toBe(false);
  });
});

describe("isBrewInstall", () => {
  test("returns true for Cellar paths", () => {
    expect(isBrewInstall("/opt/homebrew/Cellar/bab/0.1.0/bin/bab")).toBe(true);
  });

  test("returns false for normal paths", () => {
    expect(isBrewInstall("/usr/local/bin/bab")).toBe(false);
  });

  test("returns false for home directory paths", () => {
    expect(isBrewInstall("/home/user/.local/bin/bab")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Checksum verification                                              */
/* ------------------------------------------------------------------ */

describe("verifyChecksum", () => {
  test("succeeds when checksum matches", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bab-checksum-"));
    const filePath = join(tmpDir, "bab-test");
    const content = "hello world binary content";
    await writeFile(filePath, content);

    const hash = new Bun.CryptoHasher("sha256")
      .update(new TextEncoder().encode(content))
      .digest("hex");

    const checksumContent = `${hash}  bab-test\n`;
    const result = await verifyChecksum(filePath, checksumContent, "bab-test");

    expect(result.ok).toBe(true);
  });

  test("fails when checksum does not match", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bab-checksum-"));
    const filePath = join(tmpDir, "bab-test");
    await writeFile(filePath, "actual content");

    const checksumContent =
      "0000000000000000000000000000000000000000000000000000000000000000  bab-test\n";
    const result = await verifyChecksum(filePath, checksumContent, "bab-test");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Checksum mismatch");
    }
  });

  test("fails when asset name not found in checksum file", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bab-checksum-"));
    const filePath = join(tmpDir, "bab-test");
    await writeFile(filePath, "content");

    const checksumContent = "abc123  bab-other\n";
    const result = await verifyChecksum(filePath, checksumContent, "bab-test");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("No checksum entry found");
    }
  });
});

/* ------------------------------------------------------------------ */
/*  fetchLatestRelease (mock fetch)                                    */
/* ------------------------------------------------------------------ */

describe("fetchLatestRelease", () => {
  test("parses a valid GitHub release response", async () => {
    const fakeFetch = mockFetch(
      async () =>
        new Response(
          JSON.stringify([
            {
              tag_name: "v0.2.0",
              assets: [
                {
                  name: "bab-darwin-arm64",
                  browser_download_url:
                    "https://github.com/zaherg/bab/releases/download/v0.2.0/bab-darwin-arm64",
                },
                {
                  name: "checksums.sha256",
                  browser_download_url:
                    "https://github.com/zaherg/bab/releases/download/v0.2.0/checksums.sha256",
                },
              ],
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const result = await fetchLatestRelease("babmcp", "bab", fakeFetch);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.version).toBe("0.2.0");
      expect(result.value.assets).toHaveLength(2);
      expect(result.value.assets[0]?.name).toBe("bab-darwin-arm64");
    }
  });

  test("returns error on network failure", async () => {
    const fakeFetch = mockFetch(async () => {
      throw new Error("network error");
    });

    const result = await fetchLatestRelease("babmcp", "bab", fakeFetch);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Failed to reach GitHub");
    }
  });

  test("returns error on non-200 response", async () => {
    const fakeFetch = mockFetch(
      async () =>
        new Response("Not Found", { status: 404, statusText: "Not Found" }),
    );

    const result = await fetchLatestRelease("babmcp", "bab", fakeFetch);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("404");
    }
  });
});

/* ------------------------------------------------------------------ */
/*  downloadAndInstall                                                 */
/* ------------------------------------------------------------------ */

describe("downloadAndInstall", () => {
  test("downloads, verifies checksum, and installs binary", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bab-install-"));
    const targetPath = join(tmpDir, "bab");
    await writeFile(targetPath, "old binary");

    // Use a real shell script so Bun.spawnSync verification passes
    const binaryContent = "#!/bin/sh\necho 1.0.0\n";
    const hash = new Bun.CryptoHasher("sha256")
      .update(new TextEncoder().encode(binaryContent))
      .digest("hex");
    const checksumContent = `${hash}  bab-darwin-arm64\n`;

    let callCount = 0;
    const fakeFetch = mockFetch(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(binaryContent, {
          status: 200,
          headers: { "Content-Length": String(binaryContent.length) },
        });
      }
      return new Response(checksumContent, { status: 200 });
    });

    const stderr = {
      output: "",
      write(s: string) {
        this.output += s;
      },
    };

    const result = await downloadAndInstall({
      assetName: "bab-darwin-arm64",
      checksumUrl:
        "https://github.com/zaherg/bab/releases/download/v1.0.0/checksums.sha256",
      fetch: fakeFetch,
      stderr,
      targetPath,
      url: "https://github.com/zaherg/bab/releases/download/v1.0.0/bab-darwin-arm64",
      version: "1.0.0",
    });

    expect(result.ok).toBe(true);
    const content = await Bun.file(targetPath).text();
    expect(content).toBe(binaryContent);
    expect(stderr.output).toContain("Downloading bab v1.0.0");
  });

  test("rejects on checksum mismatch", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bab-install-"));
    const targetPath = join(tmpDir, "bab");
    await writeFile(targetPath, "old binary");

    let callCount = 0;
    const fakeFetch = mockFetch(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("binary data", { status: 200 });
      }
      return new Response("badhash  bab-darwin-arm64\n", { status: 200 });
    });

    const stderr = {
      output: "",
      write(s: string) {
        this.output += s;
      },
    };

    const result = await downloadAndInstall({
      assetName: "bab-darwin-arm64",
      checksumUrl:
        "https://github.com/zaherg/bab/releases/download/v1.0.0/checksums.sha256",
      fetch: fakeFetch,
      stderr,
      targetPath,
      url: "https://github.com/zaherg/bab/releases/download/v1.0.0/bab-darwin-arm64",
      version: "1.0.0",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Checksum mismatch");
    }
    // Old binary should still be there
    const content = await Bun.file(targetPath).text();
    expect(content).toBe("old binary");
  });

  test("rolls back when installed binary fails version check", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bab-install-"));
    const targetPath = join(tmpDir, "bab");
    const originalContent = "#!/bin/sh\necho original\n";
    await writeFile(targetPath, originalContent);

    // Binary that fails --version (exit 1)
    const badBinary = "#!/bin/sh\nexit 1\n";
    const hash = new Bun.CryptoHasher("sha256")
      .update(new TextEncoder().encode(badBinary))
      .digest("hex");
    const checksumContent = `${hash}  bab-darwin-arm64\n`;

    let callCount = 0;
    const fakeFetch = mockFetch(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(badBinary, {
          status: 200,
          headers: { "Content-Length": String(badBinary.length) },
        });
      }
      return new Response(checksumContent, { status: 200 });
    });

    const stderr = {
      output: "",
      write(s: string) {
        this.output += s;
      },
    };

    const result = await downloadAndInstall({
      assetName: "bab-darwin-arm64",
      checksumUrl:
        "https://github.com/zaherg/bab/releases/download/v1.0.0/checksums.sha256",
      fetch: fakeFetch,
      stderr,
      targetPath,
      url: "https://github.com/zaherg/bab/releases/download/v1.0.0/bab-darwin-arm64",
      version: "1.0.0",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("failed verification");
    }

    // Original binary should be restored via rollback
    const content = await Bun.file(targetPath).text();
    expect(content).toBe(originalContent);
  });

  test("aborts when no checksum available", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bab-install-"));
    const targetPath = join(tmpDir, "bab");
    await writeFile(targetPath, "old binary");

    const fakeFetch = mockFetch(
      async () => new Response("#!/bin/sh\necho 1.0.0\n", { status: 200 }),
    );

    const stderr = {
      output: "",
      write(s: string) {
        this.output += s;
      },
    };

    const result = await downloadAndInstall({
      assetName: "bab-darwin-arm64",
      checksumUrl: undefined,
      fetch: fakeFetch,
      stderr,
      targetPath,
      url: "https://github.com/zaherg/bab/releases/download/v1.0.0/bab-darwin-arm64",
      version: "1.0.0",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("cannot verify binary integrity");
    }
  });
});

/* ------------------------------------------------------------------ */
/*  runSelfUpdate integration (mock all I/O)                           */
/* ------------------------------------------------------------------ */

describe("runSelfUpdate", () => {
  function createStderr(): WritableLike & { output: string } {
    let output = "";
    return {
      get output() {
        return output;
      },
      write(chunk: string) {
        output += chunk;
        return true;
      },
    };
  }

  function createDeps(
    overrides: Partial<SelfupdateDeps> = {},
  ): SelfupdateDeps & { stderr: WritableLike & { output: string } } {
    const stderr = overrides.stderr
      ? (overrides.stderr as WritableLike & { output: string })
      : createStderr();
    return {
      arch: "arm64",
      execPath: "/usr/local/bin/bab",
      fetch: mockFetch(async () => new Response("", { status: 200 })),
      isBinaryInstall: () => true,
      platform: "darwin",
      ...overrides,
      stderr,
    };
  }

  test("rejects non-binary installs", async () => {
    const deps = createDeps({ isBinaryInstall: () => false });
    const exitCode = await runSelfUpdate([], deps);

    expect(exitCode).toBe(1);
    expect(deps.stderr.output).toContain("compiled binary");
  });

  test("rejects Homebrew installs", async () => {
    const deps = createDeps({
      execPath: "/opt/homebrew/Cellar/bab/0.1.0/bin/bab",
    });
    const exitCode = await runSelfUpdate([], deps);

    expect(exitCode).toBe(1);
    expect(deps.stderr.output).toContain("Homebrew");
  });

  test("--check returns 0 when up to date", async () => {
    const VERSION = (await import("../src/version")).VERSION;
    const fakeFetch = mockFetch(
      async () =>
        new Response(
          JSON.stringify([
            {
              tag_name: `v${VERSION}`,
              assets: [
                {
                  name: "bab-darwin-arm64",
                  browser_download_url:
                    "https://github.com/zaherg/bab/releases/download/v0.1.0/bab-darwin-arm64",
                },
              ],
            },
          ]),
          { status: 200 },
        ),
    );

    const deps = createDeps({ fetch: fakeFetch });
    const exitCode = await runSelfUpdate(["--check"], deps);

    expect(exitCode).toBe(0);
    expect(deps.stderr.output).toContain("Already up to date");
  });

  test("--check returns 80 when update is available", async () => {
    const fakeFetch = mockFetch(
      async () =>
        new Response(
          JSON.stringify([
            {
              tag_name: "v99.99.99",
              assets: [
                {
                  name: "bab-darwin-arm64",
                  browser_download_url:
                    "https://github.com/zaherg/bab/releases/download/v99.99.99/bab-darwin-arm64",
                },
              ],
            },
          ]),
          { status: 200 },
        ),
    );

    const deps = createDeps({ fetch: fakeFetch });
    const exitCode = await runSelfUpdate(["--check"], deps);

    expect(exitCode).toBe(80);
    expect(deps.stderr.output).toContain("Update available");
  });

  test("--force proceeds even when up to date", async () => {
    const VERSION = (await import("../src/version")).VERSION;
    const tmpDir = await mkdtemp(join(tmpdir(), "bab-force-"));
    const tmpExecPath = join(tmpDir, "bab");
    await writeFile(tmpExecPath, "old");

    const fakeFetch = mockFetch(
      async () =>
        new Response(
          JSON.stringify([
            {
              tag_name: `v${VERSION}`,
              assets: [
                {
                  name: "bab-darwin-arm64",
                  browser_download_url:
                    "https://github.com/zaherg/bab/releases/download/v0.1.0/bab-darwin-arm64",
                },
                {
                  name: "checksums.sha256",
                  browser_download_url:
                    "https://github.com/zaherg/bab/releases/download/v0.1.0/checksums.sha256",
                },
              ],
            },
          ]),
          { status: 200 },
        ),
    );

    const deps = createDeps({ fetch: fakeFetch, execPath: tmpExecPath });
    await runSelfUpdate(["--force"], deps);

    // Will fail at the download step since mock returns JSON for all calls,
    // but it should NOT return "Already up to date"
    expect(deps.stderr.output).not.toContain("Already up to date");
  });

  test("reports network error gracefully", async () => {
    const fakeFetch = mockFetch(async () => {
      throw new Error("network down");
    });

    const deps = createDeps({ fetch: fakeFetch });
    const exitCode = await runSelfUpdate([], deps);

    expect(exitCode).toBe(1);
    expect(deps.stderr.output).toContain("Failed to reach GitHub");
  });
});
