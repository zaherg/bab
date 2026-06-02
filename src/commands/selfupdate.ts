import { copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VERSION } from "../version";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface WritableLike {
  write(chunk: string): unknown;
}

export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export interface ReleaseAsset {
  browser_download_url: string;
  name: string;
}

export interface ReleaseInfo {
  assets: ReleaseAsset[];
  version: string;
}

export interface SelfupdateDeps {
  arch: string;
  execPath: string;
  fetch: typeof globalThis.fetch;
  isBinaryInstall: () => boolean;
  platform: string;
  stderr: WritableLike;
}

export interface DownloadOptions {
  assetName: string;
  checksumUrl: string | undefined;
  fetch: typeof globalThis.fetch;
  stderr: WritableLike;
  targetPath: string;
  url: string;
  version: string;
}

const OWNER = "babmcp";
const REPO = "bab";
const GITHUB_ORIGIN = "https://github.com/";
const GH_OBJECTS_ORIGIN = "https://objects.githubusercontent.com/";

const SUPPORTED_PLATFORMS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
];

/* ------------------------------------------------------------------ */
/*  Detection helpers                                                  */
/* ------------------------------------------------------------------ */

export function isBinaryInstall(): boolean {
  // biome-ignore lint/suspicious/noExplicitAny: Bun.embeddedFiles is only present in compiled binaries
  return ((globalThis as any).Bun?.embeddedFiles?.length ?? 0) > 0;
}

export function isBrewInstall(execPath: string): boolean {
  return execPath.includes("Cellar");
}

/* ------------------------------------------------------------------ */
/*  Version comparison                                                 */
/* ------------------------------------------------------------------ */

export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [lMajor = 0, lMinor = 0, lPatch = 0] = parse(latest);
  const [cMajor = 0, cMinor = 0, cPatch = 0] = parse(current);

  if (lMajor !== cMajor) return lMajor > cMajor;
  if (lMinor !== cMinor) return lMinor > cMinor;
  return lPatch > cPatch;
}

/* ------------------------------------------------------------------ */
/*  GitHub API                                                         */
/* ------------------------------------------------------------------ */

export async function fetchLatestRelease(
  owner: string,
  repo: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<Result<ReleaseInfo>> {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
  };

  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetchFn(url, { headers });
  } catch {
    return err("Failed to reach GitHub. Check your connection.");
  }

  if (!response.ok) {
    return err(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    assets: Array<{ browser_download_url: string; name: string }>;
    tag_name: string;
  };

  return ok({
    assets: data.assets.map((a) => ({
      browser_download_url: a.browser_download_url,
      name: a.name,
    })),
    version: data.tag_name.replace(/^v/, ""),
  });
}

/* ------------------------------------------------------------------ */
/*  Asset resolution                                                   */
/* ------------------------------------------------------------------ */

export function resolveAssetUrl(
  assets: ReleaseAsset[],
  platform: string,
  arch: string,
): Result<{ asset: ReleaseAsset; checksumAsset: ReleaseAsset | undefined }> {
  const expectedName = `bab-${platform}-${arch}`;
  const target = `${platform}-${arch}`;

  const asset = assets.find((a) => a.name === expectedName);
  if (!asset) {
    return err(
      `No binary available for ${target}. Supported: ${SUPPORTED_PLATFORMS.join(", ")}`,
    );
  }

  if (
    !asset.browser_download_url.startsWith(GITHUB_ORIGIN) &&
    !asset.browser_download_url.startsWith(GH_OBJECTS_ORIGIN)
  ) {
    return err(
      `Unexpected download origin for ${expectedName}. Aborting for safety.`,
    );
  }

  const checksumAsset = assets.find((a) => a.name === "checksums.sha256");

  return ok({ asset, checksumAsset });
}

/* ------------------------------------------------------------------ */
/*  Checksum verification                                              */
/* ------------------------------------------------------------------ */

export async function verifyChecksum(
  filePath: string,
  checksumFileContent: string,
  assetName: string,
): Promise<Result<true>> {
  const line = checksumFileContent
    .split("\n")
    .find((l) => l.includes(assetName));

  if (!line) {
    return err(`No checksum entry found for ${assetName}`);
  }

  const expectedHash = line.split(/\s+/)[0];
  if (!expectedHash) {
    return err(`Malformed checksum line for ${assetName}`);
  }

  const fileContent = Bun.file(filePath);
  const buffer = await fileContent.arrayBuffer();
  const hashBuffer = new Bun.CryptoHasher("sha256")
    .update(new Uint8Array(buffer))
    .digest("hex");

  if (hashBuffer !== expectedHash) {
    return err("Checksum mismatch — download may be corrupted. Aborting.");
  }

  return ok(true);
}

/* ------------------------------------------------------------------ */
/*  Progress bar                                                       */
/* ------------------------------------------------------------------ */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function renderProgress(
  stderr: WritableLike,
  version: string,
  received: number,
  total: number | null,
): void {
  if (total) {
    const pct = Math.min(100, Math.round((received / total) * 100));
    const filled = Math.round(pct / 5);
    const empty = 20 - filled;
    const bar = "\u2588".repeat(filled) + "\u2591".repeat(empty);
    stderr.write(
      `\rDownloading bab v${version}... [${bar}] ${pct}% ${formatBytes(received)}/${formatBytes(total)}`,
    );
  } else {
    stderr.write(`\rDownloading bab v${version}... ${formatBytes(received)}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Download and install                                               */
/* ------------------------------------------------------------------ */

export async function downloadAndInstall(
  opts: DownloadOptions,
): Promise<Result<true>> {
  const { url, checksumUrl, assetName, targetPath, version, stderr } = opts;
  const fetchFn = opts.fetch;

  // Download binary
  let response: Response;
  try {
    response = await fetchFn(url);
  } catch {
    return err("Failed to download binary. Check your connection.");
  }

  if (!response.ok || !response.body) {
    return err(`Download failed: ${response.status} ${response.statusText}`);
  }

  const contentLength = response.headers.get("content-length");
  const total = contentLength ? Number.parseInt(contentLength, 10) : null;

  const secureTmpDir = await mkdtemp(join(tmpdir(), "bab-update-"));
  const tmpPath = join(secureTmpDir, assetName);
  const backupPath = join(secureTmpDir, `${assetName}.bak`);

  try {
    // Stream download with progress
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      renderProgress(stderr, version, received, total);
    }

    stderr.write("\n");

    // Write temp file
    const fullBuffer = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      fullBuffer.set(chunk, offset);
      offset += chunk.length;
    }

    await Bun.write(tmpPath, fullBuffer);

    // Verify checksum if available
    if (checksumUrl) {
      let checksumResponse: Response;
      try {
        checksumResponse = await fetchFn(checksumUrl);
      } catch {
        return err("Failed to download checksums file.");
      }

      if (!checksumResponse.ok) {
        return err("Failed to download checksums file.");
      }

      const checksumContent = await checksumResponse.text();
      const checksumResult = await verifyChecksum(
        tmpPath,
        checksumContent,
        assetName,
      );

      if (!checksumResult.ok) {
        return err(checksumResult.error);
      }
    } else {
      return err(
        "Checksum file not found in release — cannot verify binary integrity. Aborting update.",
      );
    }

    // Strip macOS quarantine attribute
    if (process.platform === "darwin") {
      Bun.spawnSync(["xattr", "-d", "com.apple.quarantine", tmpPath], {
        stderr: "ignore",
        stdout: "ignore",
      });
    }

    // Make executable
    const chmodResult = Bun.spawnSync(["chmod", "+x", tmpPath], {
      stderr: "pipe",
      stdout: "pipe",
    });

    if (chmodResult.exitCode !== 0) {
      return err("Failed to set executable permission on downloaded binary.");
    }

    // Backup current binary for rollback
    try {
      await copyFile(targetPath, backupPath);
    } catch {
      // No existing binary to back up — fresh install
    }

    // Replace binary (copyFile handles cross-filesystem; rename may fail across mounts)
    try {
      await copyFile(tmpPath, targetPath);
    } catch (error) {
      const msg =
        error instanceof Error && error.message.includes("EACCES")
          ? "Permission denied. Try: sudo bab selfupdate"
          : `Failed to replace binary: ${error instanceof Error ? error.message : String(error)}`;
      return err(msg);
    }

    // Verify new binary works
    const verifyResult = Bun.spawnSync([targetPath, "--version"], {
      stderr: "pipe",
      stdout: "pipe",
    });

    if (verifyResult.exitCode !== 0) {
      // Rollback: restore backup
      try {
        await copyFile(backupPath, targetPath);
        return err(
          "Updated binary failed verification. Rolled back to previous version.",
        );
      } catch {
        return err(
          "Updated binary failed verification and rollback failed. Manual reinstall may be needed.",
        );
      }
    }

    return ok(true);
  } finally {
    await rm(secureTmpDir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/*  Entry point                                                        */
/* ------------------------------------------------------------------ */

export async function runSelfUpdate(
  args: string[],
  deps: SelfupdateDeps,
): Promise<number> {
  const { stderr } = deps;

  const checkOnly = args.includes("--check");
  const force = args.includes("--force");

  // Guard: binary install check
  if (!deps.isBinaryInstall()) {
    stderr.write(
      "selfupdate only works with the compiled binary. Use your package manager to update.\n",
    );
    return 1;
  }

  // Guard: Homebrew install check
  if (isBrewInstall(deps.execPath)) {
    stderr.write(
      "You installed via Homebrew. Run `brew upgrade bab` instead.\n",
    );
    return 1;
  }

  // Fetch latest release
  const releaseResult = await fetchLatestRelease(OWNER, REPO, deps.fetch);
  if (!releaseResult.ok) {
    stderr.write(`${releaseResult.error}\n`);
    return 1;
  }

  const { version: latestVersion, assets } = releaseResult.value;
  const currentVersion = VERSION;

  // Compare versions
  const updateAvailable = isNewerVersion(latestVersion, currentVersion);

  if (checkOnly) {
    if (updateAvailable) {
      stderr.write(
        `Update available: v${currentVersion} -> v${latestVersion}\n`,
      );
      return 80;
    }
    stderr.write(`Already up to date (v${currentVersion})\n`);
    return 0;
  }

  if (!updateAvailable && !force) {
    stderr.write(`Already up to date (v${currentVersion})\n`);
    return 0;
  }

  // Resolve platform asset
  const assetResult = resolveAssetUrl(assets, deps.platform, deps.arch);
  if (!assetResult.ok) {
    stderr.write(`${assetResult.error}\n`);
    return 1;
  }

  const { asset, checksumAsset } = assetResult.value;

  // Resolve real binary path (follow symlinks)
  let targetPath: string;
  try {
    targetPath = await realpath(deps.execPath);
  } catch {
    targetPath = deps.execPath;
  }

  // Download and install
  const installResult = await downloadAndInstall({
    assetName: asset.name,
    checksumUrl: checksumAsset?.browser_download_url,
    fetch: deps.fetch,
    stderr,
    targetPath,
    url: asset.browser_download_url,
    version: latestVersion,
  });

  if (!installResult.ok) {
    stderr.write(`${installResult.error}\n`);
    return 1;
  }

  stderr.write(`Updated bab v${currentVersion} -> v${latestVersion}\n`);
  return 0;
}
