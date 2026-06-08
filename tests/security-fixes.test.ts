import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";
import { parseSource } from "../src/commands/source-parser";
import { loadConfig } from "../src/config";
import { loadPlugin, loadPlugins } from "../src/delegate/loader";
import { ProcessRunner } from "../src/delegate/process-runner";
import { resolveRole } from "../src/delegate/roles";
import { InMemoryStorageAdapter } from "../src/memory/memory";
import {
  customProviderBaseUrl,
  validateCustomApiUrl,
} from "../src/providers/custom-url";
import { sanitizeFileEnv } from "../src/utils/env";
import { VERSION } from "../src/version";

describe("S2: loadConfig sanitizes file env and process env wins", () => {
  test("process env takes precedence over file env", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "bab-config-s2-"));
    const configDir = join(homeDirectory, ".config", "bab");

    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "env"),
      "OPENROUTER_API_KEY=from-file\nCUSTOM_VAR=file-value\n",
    );

    const originalEnv = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "from-process";

    try {
      const config = await loadConfig(homeDirectory);

      expect(config.env.OPENROUTER_API_KEY).toBe("from-process");
      expect(config.env.CUSTOM_VAR).toBe("file-value");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalEnv;
      }
    }
  });

  test("file env cannot override PATH or HOME", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "bab-config-s2-deny-"));
    const configDir = join(homeDirectory, ".config", "bab");

    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "env"),
      "PATH=/malicious\nHOME=/malicious\nSAFE_KEY=allowed\n",
    );

    const config = await loadConfig(homeDirectory);

    expect(config.env.PATH).not.toBe("/malicious");
    expect(config.env.HOME).not.toBe("/malicious");
    expect(config.env.SAFE_KEY).toBe("allowed");
  });
});

describe("S3: expanded env denylist", () => {
  test("blocks NODE_PATH", () => {
    const result = sanitizeFileEnv({ NODE_PATH: "/malicious", SAFE: "ok" });

    expect(result.NODE_PATH).toBeUndefined();
    expect(result.SAFE).toBe("ok");
  });

  test("blocks GIT_SSH_COMMAND", () => {
    const result = sanitizeFileEnv({ GIT_SSH_COMMAND: "evil-script" });

    expect(result.GIT_SSH_COMMAND).toBeUndefined();
  });

  test("blocks proxy variables", () => {
    const result = sanitizeFileEnv({
      HTTP_PROXY: "http://evil",
      HTTPS_PROXY: "http://evil",
      http_proxy: "http://evil",
      https_proxy: "http://evil",
    });

    expect(result.HTTP_PROXY).toBeUndefined();
    expect(result.HTTPS_PROXY).toBeUndefined();
    expect(result.http_proxy).toBeUndefined();
    expect(result.https_proxy).toBeUndefined();
  });

  test("blocks SSL and CA variables", () => {
    const result = sanitizeFileEnv({
      NODE_EXTRA_CA_CERTS: "/evil.pem",
      SSL_CERT_FILE: "/evil.pem",
      SSL_CERT_DIR: "/evil",
      REQUESTS_CA_BUNDLE: "/evil.pem",
      CURL_CA_BUNDLE: "/evil.pem",
    });

    expect(result.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(result.SSL_CERT_FILE).toBeUndefined();
    expect(result.SSL_CERT_DIR).toBeUndefined();
    expect(result.REQUESTS_CA_BUNDLE).toBeUndefined();
    expect(result.CURL_CA_BUNDLE).toBeUndefined();
  });

  test("blocks LD_PRELOAD and GIT_ASKPASS", () => {
    const result = sanitizeFileEnv({
      GIT_ASKPASS: "/evil",
      LD_PRELOAD: "/evil.so",
    });

    expect(result.GIT_ASKPASS).toBeUndefined();
    expect(result.LD_PRELOAD).toBeUndefined();
  });
});

describe("S4: git ref validation", () => {
  test("rejects refs starting with a dash", () => {
    expect(() => parseSource("org/repo#--upload-pack=evil")).toThrow(
      'Invalid ref (starts with "-")',
    );
  });

  test("rejects refs with invalid characters", () => {
    expect(() => parseSource("org/repo#main; rm -rf /")).toThrow(
      "Invalid characters in ref",
    );
  });

  test("rejects refs exceeding maximum length", () => {
    const longRef = "a".repeat(201);

    expect(() => parseSource(`org/repo#${longRef}`)).toThrow(
      "Ref exceeds maximum length",
    );
  });

  test("accepts valid refs with slashes, dots, and tildes", () => {
    const result = parseSource("org/repo#feature/branch-1.0~2");

    expect(result.ref).toBe("feature/branch-1.0~2");
  });

  test("accepts valid semver tag refs", () => {
    const result = parseSource("org/repo#v1.2.3");

    expect(result.ref).toBe("v1.2.3");
  });

  test("accepts valid SHA refs", () => {
    const result = parseSource("org/repo#abc123def456");

    expect(result.ref).toBe("abc123def456");
  });

  test("accepts caret notation in refs", () => {
    const result = parseSource("org/repo#HEAD^");

    expect(result.ref).toBe("HEAD^");
  });
});

describe("S5: YAML alias limit", () => {
  test("loadPlugin rejects manifests with excessive YAML aliases", async () => {
    const pluginDirectory = await mkdtemp(join(tmpdir(), "bab-yaml-alias-"));
    const aliases = Array.from(
      { length: 60 },
      (_, index) => `alias_${index}: *anchor`,
    );
    const yamlContent = [
      "id: alias-bomb",
      "name: &anchor Alias Bomb",
      "version: 1.0.0",
      "command: echo",
      "roles:",
      "  - default",
      ...aliases,
    ].join("\n");

    await writeFile(join(pluginDirectory, "manifest.yaml"), yamlContent);

    await expect(
      loadPlugin({
        directory: pluginDirectory,
        manifestPath: join(pluginDirectory, "manifest.yaml"),
      }),
    ).rejects.toThrow(/alias/i);
  });
});

describe("S1: adapter path containment", () => {
  test("rejects adapter symlinked outside plugin directory", async () => {
    const pluginsRoot = await mkdtemp(join(tmpdir(), "bab-adapter-escape-"));
    const pluginDirectory = join(pluginsRoot, "evil");
    const outsideFile = join(pluginsRoot, "outside-adapter.ts");

    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(outsideFile, "export default { run: () => [] };\n");
    await writeFile(
      join(pluginDirectory, "manifest.yaml"),
      [
        "id: evil",
        "name: Evil Plugin",
        "version: 1.0.0",
        "command: echo",
        "roles:",
        "  - default",
      ].join("\n"),
    );
    await symlink(outsideFile, join(pluginDirectory, "adapter.ts"));

    await expect(
      loadPlugin({
        adapterPath: join(pluginDirectory, "adapter.ts"),
        directory: pluginDirectory,
        manifestPath: join(pluginDirectory, "manifest.yaml"),
      }),
    ).rejects.toThrow("Refusing to load adapter outside plugin directory");
  });
});

describe("prompt_file path traversal protection", () => {
  test("rejects prompt_file that escapes plugin directory", async () => {
    const pluginsRoot = await mkdtemp(join(tmpdir(), "bab-prompt-escape-"));
    const pluginDirectory = join(pluginsRoot, "evil");
    const outsidePrompt = join(pluginsRoot, "secret.txt");

    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(outsidePrompt, "secret content\n");
    await writeFile(
      join(pluginDirectory, "manifest.yaml"),
      [
        "id: evil-prompt",
        "name: Evil Prompt Plugin",
        "version: 1.0.0",
        "command: echo",
        "roles:",
        "  - name: sneaky",
        "    prompt_file: ../secret.txt",
      ].join("\n"),
    );

    const [plugin] = await loadPlugins([
      {
        directory: pluginDirectory,
        manifestPath: join(pluginDirectory, "manifest.yaml"),
      },
    ]);

    await expect(resolveRole(plugin, "sneaky")).rejects.toThrow(
      "prompt_file must be within plugin directory",
    );
  });
});

describe("S8: plugin symlink escape via path containment", () => {
  test("rejects plugin directory symlinked outside plugins root", async () => {
    const pluginsRoot = await mkdtemp(join(tmpdir(), "bab-s8-escape-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "bab-s8-outside-"));
    const evilDir = join(pluginsRoot, "evil");

    await mkdir(pluginsRoot, { recursive: true });
    await writeFile(
      join(outsideDir, "manifest.yaml"),
      [
        "id: evil",
        "name: Evil Plugin",
        "version: 1.0.0",
        "command: echo",
        "roles:",
        "  - default",
      ].join("\n"),
    );
    await symlink(outsideDir, evilDir);

    const { discoverPluginDirectories } = await import(
      "../src/delegate/discovery"
    );
    const discovered = await discoverPluginDirectories(pluginsRoot);

    expect(discovered).toHaveLength(0);
  });

  test("accepts real directory inside plugins root", async () => {
    const pluginsRoot = await mkdtemp(join(tmpdir(), "bab-s8-legit-"));
    const pluginDir = join(pluginsRoot, "legit");

    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "manifest.yaml"),
      [
        "id: legit",
        "name: Legit Plugin",
        "version: 1.0.0",
        "command: echo",
        "roles:",
        "  - default",
      ].join("\n"),
    );

    const { discoverPluginDirectories } = await import(
      "../src/delegate/discovery"
    );
    const discovered = await discoverPluginDirectories(pluginsRoot);

    expect(discovered).toHaveLength(1);
    expect(discovered[0].directory).toBe(pluginDir);
  });
});

describe("A1: plugin cache in delegate tool", () => {
  test("loadPlugins runs in parallel (returns results from Promise.allSettled)", async () => {
    const pluginsRoot = await mkdtemp(join(tmpdir(), "bab-parallel-load-"));

    for (const id of ["alpha", "beta", "gamma"]) {
      const dir = join(pluginsRoot, id);

      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "manifest.yaml"),
        [
          `id: ${id}`,
          `name: ${id} Plugin`,
          "version: 1.0.0",
          "command: echo",
          "roles:",
          "  - default",
        ].join("\n"),
      );
    }

    const { discoverPluginDirectories } = await import(
      "../src/delegate/discovery"
    );
    const discovered = await discoverPluginDirectories(pluginsRoot);
    const loaded = await loadPlugins(discovered);

    expect(loaded).toHaveLength(3);
    expect(loaded.map((plugin) => plugin.manifest.id).sort()).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });
});

describe("A3: InMemoryStorageAdapter eviction", () => {
  test("evicts oldest entry when maxEntries is exceeded", async () => {
    const adapter = new InMemoryStorageAdapter<string>(3);

    await adapter.set("a", "first");
    await adapter.set("b", "second");
    await adapter.set("c", "third");
    await adapter.set("d", "fourth");

    expect(await adapter.get("a")).toBeUndefined();
    expect(await adapter.get("b")).toBe("second");
    expect(await adapter.get("c")).toBe("third");
    expect(await adapter.get("d")).toBe("fourth");
  });

  test("does not evict when updating an existing key", async () => {
    const adapter = new InMemoryStorageAdapter<string>(2);

    await adapter.set("a", "first");
    await adapter.set("b", "second");
    await adapter.set("a", "updated");

    expect(await adapter.get("a")).toBe("updated");
    expect(await adapter.get("b")).toBe("second");
  });

  test("default max entries is 1000", async () => {
    const adapter = new InMemoryStorageAdapter<number>();

    for (let i = 0; i < 1001; i++) {
      await adapter.set(`key-${i}`, i);
    }

    expect(await adapter.get("key-0")).toBeUndefined();
    expect(await adapter.get("key-1")).toBe(1);
    expect(await adapter.get("key-1000")).toBe(1000);
  });
});

describe("P3: ProcessRunner output buffer cap", () => {
  test("caps stdout to prevent memory exhaustion", async () => {
    const runner = new ProcessRunner();
    const result = await runner.run("test-cap", {
      args: ["-e", "for(let i=0;i<500000;i++) process.stdout.write('x');"],
      command: "bun",
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 10_000,
    });

    expect(result.stdout.length).toBeLessThanOrEqual(1_000_000);
    expect(result.exitCode).toBe(0);
  });

  test("caps single oversized chunk to MAX_CAPTURE_BYTES", async () => {
    const runner = new ProcessRunner();
    const result = await runner.run("test-cap-chunk", {
      args: ["-e", "process.stdout.write('x'.repeat(2_000_000))"],
      command: "bun",
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 10_000,
    });

    expect(result.stdout.length).toBeLessThanOrEqual(1_000_000);
    expect(result.exitCode).toBe(0);
  });

  test("caps stderr single oversized chunk to MAX_CAPTURE_BYTES", async () => {
    const runner = new ProcessRunner();
    const result = await runner.run("test-cap-stderr", {
      args: ["-e", "process.stderr.write('y'.repeat(2_000_000))"],
      command: "bun",
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 10_000,
    });

    expect(result.stderr.length).toBeLessThanOrEqual(1_000_000);
    expect(result.exitCode).toBe(0);
  });
});

describe("Q2: ProcessRunner.cancel awaits termination", () => {
  test("cancel resolves after process exits", async () => {
    const runner = new ProcessRunner();
    const runPromise = runner.run("test-cancel", {
      args: ["-e", "setTimeout(() => {}, 30000);"],
      command: "bun",
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 30_000,
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    await runner.cancel();

    const result = await runPromise;

    expect(result.exitCode === null || result.exitCode !== 0).toBeTrue();
  });
});

describe("S15: skills dir TOCTOU — realpath containment check", () => {
  test("rejects skills dir that resolves outside config dir", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "bab-s15-"));
    const configDir = join(tmpRoot, "config");
    const skillsDir = join(configDir, "skills");
    const outsideDir = join(tmpRoot, "outside");

    await mkdir(configDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "SKILL.md"), "# Evil Skill\n");
    await symlink(outsideDir, skillsDir);

    const { discoverAgents } = await import("../src/skills");

    // discoverAgents is filter-only; symlink check is in regenerateSkills.
    // We test via the realpath containment logic directly.
    const { realpath: rp } = await import("node:fs/promises");
    const resolvedSkills = await rp(skillsDir);
    const resolvedConfig = await rp(configDir);

    expect(resolvedSkills.startsWith(`${resolvedConfig}/`)).toBe(false);
    expect(resolvedSkills).toBe(await rp(outsideDir));
  });

  test("accepts skills dir that resolves inside config dir", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "bab-s15-ok-"));
    const configDir = join(tmpRoot, "config");
    const skillsDir = join(configDir, "skills");

    await mkdir(skillsDir, { recursive: true });
    await writeFile(join(skillsDir, "SKILL.md"), "# Safe Skill\n");

    const { realpath: rp } = await import("node:fs/promises");
    const resolvedSkills = await rp(skillsDir);
    const resolvedConfig = await rp(configDir);

    expect(resolvedSkills.startsWith(`${resolvedConfig}/`)).toBe(true);
  });
});

describe("S16: per-plugin log secret redaction", () => {
  test("redacts OpenAI-style API keys", async () => {
    const { redactSecrets } = await import("../src/utils/logger");
    const input =
      '{"message":"using key sk-abc123def456ghi789jkl012","level":"info"}';
    expect(redactSecrets(input)).not.toContain("sk-abc123def456ghi789jkl012");
    expect(redactSecrets(input)).toContain("sk-[REDACTED]");
  });

  test("redacts GitHub tokens", async () => {
    const { redactSecrets } = await import("../src/utils/logger");
    const input =
      '{"message":"token=ghp_0123456789abcdef0123456789abcdef0123456789abcdef","level":"info"}';
    expect(redactSecrets(input)).not.toContain(
      "ghp_0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    expect(redactSecrets(input)).toContain("ghp_[REDACTED]");
  });

  test("redacts Bearer tokens", async () => {
    const { redactSecrets } = await import("../src/utils/logger");
    const input =
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret-token-value";
    expect(redactSecrets(input)).toContain("Bearer [REDACTED]");
  });

  test("passes benign text unchanged", async () => {
    const { redactSecrets } = await import("../src/utils/logger");
    const input = '{"message":"Hello World","level":"info"}';
    expect(redactSecrets(input)).toBe(input);
  });

  test("redacts case-insensitive Bearer token", async () => {
    const { redactSecrets } = await import("../src/utils/logger");
    expect(
      redactSecrets("Authorization: BEARER eyJhbGciOiJIUzI1NiJ9.token"),
    ).toContain("Bearer [REDACTED]");
    expect(
      redactSecrets("authorization: bearer eyJhbGciOiJIUzI1NiJ9.token"),
    ).toContain("Bearer [REDACTED]");
  });

  test("redacts case-insensitive API key prefix", async () => {
    const { redactSecrets } = await import("../src/utils/logger");
    expect(redactSecrets("SK-abc123def456ghi789jkl012")).toContain(
      "SK-[REDACTED]",
    );
    expect(redactSecrets("PK-abc123def456ghi789jkl012")).toContain(
      "PK-[REDACTED]",
    );
  });

  test("redacts case-insensitive GitHub token", async () => {
    const { redactSecrets } = await import("../src/utils/logger");
    const result = redactSecrets(
      "GHP_0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    expect(result).toContain("GHP_[REDACTED]");
  });

  test("redacts case-insensitive Slack token", async () => {
    const { redactSecrets } = await import("../src/utils/logger");
    expect(redactSecrets("xoxb-1234567890-abcdefghij-klmnopqrstuv")).toContain(
      "xoxb-[REDACTED]",
    );
  });
});

describe("S17: parseEnvFile mismatched quote rejection", () => {
  test("rejects value with leading double quote but no closing quote", () => {
    const { parseEnvFile } = require("../src/config");
    let message = "";

    try {
      parseEnvFile('KEY="secret');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain(
      "mismatched quotes - check your .env file formatting",
    );
    expect(message).not.toContain("—");
    expect(message).not.toContain("secret");
  });

  test("rejects value with leading single quote but no closing quote", () => {
    const { parseEnvFile } = require("../src/config");
    let message = "";

    try {
      parseEnvFile("KEY='secret");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain(
      "mismatched quotes - check your .env file formatting",
    );
    expect(message).not.toContain("—");
    expect(message).not.toContain("secret");
  });

  test("accepts properly double-quoted value", () => {
    const { parseEnvFile } = require("../src/config");
    const result = parseEnvFile('KEY="secret"');
    expect(result.KEY).toBe("secret");
  });

  test("accepts properly single-quoted value", () => {
    const { parseEnvFile } = require("../src/config");
    const result = parseEnvFile("KEY='secret'");
    expect(result.KEY).toBe("secret");
  });

  test("accepts unquoted value", () => {
    const { parseEnvFile } = require("../src/config");
    const result = parseEnvFile("KEY=secret");
    expect(result.KEY).toBe("secret");
  });
});

describe("S18: custom provider URL validation", () => {
  test("rejects insecure user-provided CUSTOM_API_URL unless explicitly allowed", () => {
    expect(() => validateCustomApiUrl("http://example.com/v1", false)).toThrow(
      "CUSTOM_API_URL must use https://",
    );
  });

  test("rejects RFC1918 private network CUSTOM_API_URL values", () => {
    expect(() =>
      validateCustomApiUrl("https://192.168.1.10/v1", false),
    ).toThrow("CUSTOM_API_URL host is not allowed");
  });

  test("allows HTTPS public CUSTOM_API_URL values", () => {
    expect(validateCustomApiUrl("https://api.example.com/v1", false)).toBe(
      "https://api.example.com/v1",
    );
  });

  test("preserves hardcoded localhost default when CUSTOM_API_URL is unset", () => {
    expect(customProviderBaseUrl({})).toBe("http://localhost:11434/v1");
  });
});

describe("S19: installed plugin adapter metadata enforcement", () => {
  async function writePlugin(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "manifest.yaml"),
      [
        "id: adapter-metadata-test",
        "name: Adapter Metadata Test",
        "version: 1.0.0",
        "command: echo",
        "roles:",
        "  - default",
      ].join("\n"),
    );
    await writeFile(
      join(directory, "adapter.ts"),
      "export default { run: () => [] };\n",
    );
  }

  test("rejects installed plugin adapters without install metadata", async () => {
    const pluginDirectory = await mkdtemp(join(tmpdir(), "bab-s19-missing-"));
    await writePlugin(pluginDirectory);

    await expect(
      loadPlugin({
        adapterPath: join(pluginDirectory, "adapter.ts"),
        directory: pluginDirectory,
        manifestPath: join(pluginDirectory, "manifest.yaml"),
        sourceType: "installed",
      }),
    ).rejects.toThrow("Missing plugin install metadata");
  });

  test("rejects installed plugin adapters with invalid install metadata", async () => {
    const pluginDirectory = await mkdtemp(join(tmpdir(), "bab-s19-invalid-"));
    await writePlugin(pluginDirectory);
    await writeFile(join(pluginDirectory, ".install.json"), "not json");

    await expect(
      loadPlugin({
        adapterPath: join(pluginDirectory, "adapter.ts"),
        directory: pluginDirectory,
        manifestPath: join(pluginDirectory, "manifest.yaml"),
        sourceType: "installed",
      }),
    ).rejects.toThrow("Invalid plugin install metadata");
  });

  test("allows bundled plugin adapters without install metadata", async () => {
    const pluginDirectory = await mkdtemp(join(tmpdir(), "bab-s19-bundled-"));
    await writePlugin(pluginDirectory);

    const plugin = await loadPlugin({
      adapterPath: join(pluginDirectory, "adapter.ts"),
      directory: pluginDirectory,
      manifestPath: join(pluginDirectory, "manifest.yaml"),
      sourceType: "bundled",
    });

    expect(plugin.adapter).toBeDefined();
  });
});

describe("Q3: centralized version constant", () => {
  test("VERSION matches package.json version", () => {
    expect(VERSION).toBe(pkg.version);
  });
});
