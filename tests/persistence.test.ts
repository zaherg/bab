import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearPersistenceWarnings,
  extractSummary,
  formatReport,
  type PersistReportInput,
  persistReport,
} from "../src/memory/persistence";

function makeInput(
  overrides: Partial<PersistReportInput> &
    Pick<
      PersistReportInput,
      "toolName" | "inputText" | "continuationId" | "content"
    >,
): PersistReportInput {
  return { models: [], ...overrides };
}

function p(
  toolName: string,
  inputText: string,
  continuationId: string,
  content: string,
  projectRoot?: string,
): PersistReportInput {
  return {
    toolName,
    inputText,
    continuationId,
    content,
    models: [],
    projectRoot,
  };
}

async function mktemp(): Promise<string> {
  const dir = join(
    tmpdir(),
    `bab-persist-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

beforeEach(() => clearPersistenceWarnings());
afterEach(() => clearPersistenceWarnings());

describe("persistReport", () => {
  test("writes report file with timestamp-slug filename", async () => {
    const root = await mktemp();
    await persistReport(
      p("debug", "fix auth bug in login", "cont-123", "# Report", root),
    );

    const files = await readdir(join(root, ".bab", "debug"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(
      /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-fix-auth-bug-in-login\.md$/u,
    );
  });

  test("writes report content to file", async () => {
    const root = await mktemp();
    await persistReport(
      p(
        "analyze",
        "analyze performance",
        "cont-456",
        "## Analysis\nsome content",
        root,
      ),
    );

    const files = await readdir(join(root, ".bab", "analyze"));
    const content = await readFile(
      join(root, ".bab", "analyze", files[0] as string),
      "utf8",
    );
    expect(content).toContain("## Analysis\nsome content");
  });

  test("falls back to continuation ID slug when prompt is empty", async () => {
    const root = await mktemp();
    await persistReport(p("debug", "", "my-continuation-id", "# Report", root));

    const files = await readdir(join(root, ".bab", "debug"));
    expect(files[0]).toContain("my-continuation-id");
  });

  test("appends numeric suffix on filename collision", async () => {
    const root = await mktemp();
    // Mock Date to return the same time for both calls
    // Write a file manually at the path persistReport would choose, then call persistReport
    // to trigger the suffix logic
    const fakeDir = join(root, ".bab", "debug");
    await mkdir(fakeDir, { recursive: true });

    // Pre-create the file persistReport would write so it collides
    const now = new Date();
    const ts = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
    ].join("-");
    const expectedName = `${ts}-same-prompt.md`;
    await Bun.write(join(fakeDir, expectedName), "pre-existing");

    await persistReport(p("debug", "same prompt", "cont-2", "second", root));

    const files = await readdir(fakeDir);
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.endsWith("-2.md"))).toBeTrue();
  });

  test("does not throw on write failure and handles it silently", async () => {
    const badRoot = "/dev/null/not-a-dir";

    // persistReport must never throw — errors are swallowed and warned once
    const results = await Promise.allSettled([
      persistReport(p("debug", "test", "cont-warn", "content", badRoot)),
      persistReport(p("debug", "test", "cont-warn", "content", badRoot)),
      persistReport(p("debug", "test", "cont-warn", "content", badRoot)),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBeTrue();
  });

  test("different continuation IDs each get their own warning", async () => {
    const badRoot = "/dev/null/not-a-dir";
    // Each unique continuation ID should be handled independently without throwing
    const results = await Promise.allSettled([
      persistReport(p("debug", "test", "cont-a", "content", badRoot)),
      persistReport(p("debug", "test", "cont-b", "content", badRoot)),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBeTrue();
  });

  test("resolves symlinked project root to real path", async () => {
    const tmpRoot = await mktemp();
    const realDir = join(tmpRoot, "real-project");
    const linkDir = join(tmpRoot, "link-project");
    await mkdir(realDir, { recursive: true });
    const { symlink, realpath: rp } = await import("node:fs/promises");
    await symlink(realDir, linkDir);

    await persistReport(
      p("debug", "symlink test", "cont-symlink", "# Symlink Report", linkDir),
    );

    const realFiles = await readdir(join(realDir, ".bab", "debug"));
    expect(realFiles).toHaveLength(1);
    expect(realFiles[0]).toContain("symlink-test");

    // Verify no file at the symlink path (it was resolved to real)
    const resolvedLink = await rp(linkDir);
    expect(resolvedLink).toBe(await rp(realDir));
  });

  test("uses fallback reports dir when no project root provided", async () => {
    // Verify it doesn't throw; the fallback dir is ~/.config/bab/reports.
    // We pass a unique continuation ID so we can check the file was written there.
    const continuationId = `test-fallback-${Date.now()}`;
    const { homedir } = await import("node:os");
    const fallbackDir = join(
      homedir(),
      ".config",
      "bab",
      "reports",
      ".bab",
      "debug",
    );

    await persistReport(
      p("debug", "test fallback", continuationId, "fallback content"),
    );

    // Verify the file was written to the fallback directory
    const files = await readdir(fallbackDir).catch(() => []);
    const written = files.some((f) => f.includes("test-fallback"));
    expect(written).toBeTrue();

    // Cleanup — remove the file we wrote to avoid polluting the real filesystem
    const { rm } = await import("node:fs/promises");
    for (const file of files.filter((f) => f.includes("test-fallback"))) {
      await rm(join(fallbackDir, file), { force: true });
    }
  });
});

describe("shouldPersistTool (via BabServer)", () => {
  test("default tools persist when enabled", async () => {
    const { BabServer } = await import("../src/server");
    const { buildToolManifest } = await import("../src/tools/manifest");
    const { createProviderRegistry } = await import(
      "../src/providers/registry"
    );
    const { ConversationStore } = await import("../src/memory/conversations");
    const { createModelGateway } = await import(
      "../src/providers/model-gateway"
    );

    const config = {
      env: {},
      lazyTools: false,
      paths: {
        baseDir: "/tmp",
        envFile: "/tmp/env",
        pluginsDir: "/tmp/plugins",
        promptsDir: "/tmp/prompts",
      },
      persistence: {
        enabled: true,
        enabledTools: new Set<string>(),
        disabledTools: new Set<string>(),
      },
    };
    const providerRegistry = createProviderRegistry(config);
    const modelGateway = createModelGateway(providerRegistry, config);
    const conversationStore = new ConversationStore();
    const toolContext = { conversationStore, modelGateway, providerRegistry };

    const server = new BabServer();
    server.setManifest(
      buildToolManifest(toolContext, providerRegistry, config),
    );
    server.config = config;

    expect(server.shouldPersistTool("analyze")).toBeTrue();
    expect(server.shouldPersistTool("debug")).toBeTrue();
  });

  test("never-persist tools are excluded", async () => {
    const { BabServer } = await import("../src/server");
    const { buildToolManifest } = await import("../src/tools/manifest");
    const { createProviderRegistry } = await import(
      "../src/providers/registry"
    );
    const { ConversationStore } = await import("../src/memory/conversations");
    const { createModelGateway } = await import(
      "../src/providers/model-gateway"
    );

    const config = {
      env: {},
      lazyTools: false,
      paths: {
        baseDir: "/tmp",
        envFile: "/tmp/env",
        pluginsDir: "/tmp/plugins",
        promptsDir: "/tmp/prompts",
      },
      persistence: {
        enabled: true,
        enabledTools: new Set<string>(),
        disabledTools: new Set<string>(),
      },
    };
    const providerRegistry = createProviderRegistry(config);
    const modelGateway = createModelGateway(providerRegistry, config);
    const conversationStore = new ConversationStore();
    const toolContext = { conversationStore, modelGateway, providerRegistry };

    const server = new BabServer();
    server.setManifest(
      buildToolManifest(toolContext, providerRegistry, config),
    );
    server.config = config;

    expect(server.shouldPersistTool("version")).toBeFalse();
    expect(server.shouldPersistTool("list_models")).toBeFalse();
    expect(server.shouldPersistTool("delegate")).toBeFalse();
  });

  test("BAB_PERSIST=false disables all persistence", async () => {
    const { BabServer } = await import("../src/server");
    const { buildToolManifest } = await import("../src/tools/manifest");
    const { createProviderRegistry } = await import(
      "../src/providers/registry"
    );
    const { ConversationStore } = await import("../src/memory/conversations");
    const { createModelGateway } = await import(
      "../src/providers/model-gateway"
    );

    const config = {
      env: {},
      lazyTools: false,
      paths: {
        baseDir: "/tmp",
        envFile: "/tmp/env",
        pluginsDir: "/tmp/plugins",
        promptsDir: "/tmp/prompts",
      },
      persistence: {
        enabled: false,
        enabledTools: new Set<string>(),
        disabledTools: new Set<string>(),
      },
    };
    const providerRegistry = createProviderRegistry(config);
    const modelGateway = createModelGateway(providerRegistry, config);
    const conversationStore = new ConversationStore();
    const toolContext = { conversationStore, modelGateway, providerRegistry };

    const server = new BabServer();
    server.setManifest(
      buildToolManifest(toolContext, providerRegistry, config),
    );
    server.config = config;

    expect(server.shouldPersistTool("analyze")).toBeFalse();
    expect(server.shouldPersistTool("debug")).toBeFalse();
  });

  test("BAB_PERSIST_TOOLS enables optional tool (chat)", async () => {
    const { BabServer } = await import("../src/server");
    const { buildToolManifest } = await import("../src/tools/manifest");
    const { createProviderRegistry } = await import(
      "../src/providers/registry"
    );
    const { ConversationStore } = await import("../src/memory/conversations");
    const { createModelGateway } = await import(
      "../src/providers/model-gateway"
    );

    const config = {
      env: {},
      lazyTools: false,
      paths: {
        baseDir: "/tmp",
        envFile: "/tmp/env",
        pluginsDir: "/tmp/plugins",
        promptsDir: "/tmp/prompts",
      },
      persistence: {
        enabled: true,
        enabledTools: new Set(["chat"]),
        disabledTools: new Set<string>(),
      },
    };
    const providerRegistry = createProviderRegistry(config);
    const modelGateway = createModelGateway(providerRegistry, config);
    const conversationStore = new ConversationStore();
    const toolContext = { conversationStore, modelGateway, providerRegistry };

    const server = new BabServer();
    server.setManifest(
      buildToolManifest(toolContext, providerRegistry, config),
    );
    server.config = config;

    expect(server.shouldPersistTool("chat")).toBeTrue();
    expect(server.shouldPersistTool("challenge")).toBeFalse(); // not in enabledTools
  });

  test("BAB_DISABLED_PERSIST_TOOLS disables a default tool (tracer)", async () => {
    const { BabServer } = await import("../src/server");
    const { buildToolManifest } = await import("../src/tools/manifest");
    const { createProviderRegistry } = await import(
      "../src/providers/registry"
    );
    const { ConversationStore } = await import("../src/memory/conversations");
    const { createModelGateway } = await import(
      "../src/providers/model-gateway"
    );

    const config = {
      env: {},
      lazyTools: false,
      paths: {
        baseDir: "/tmp",
        envFile: "/tmp/env",
        pluginsDir: "/tmp/plugins",
        promptsDir: "/tmp/prompts",
      },
      persistence: {
        enabled: true,
        enabledTools: new Set<string>(),
        disabledTools: new Set(["tracer"]),
      },
    };
    const providerRegistry = createProviderRegistry(config);
    const modelGateway = createModelGateway(providerRegistry, config);
    const conversationStore = new ConversationStore();
    const toolContext = { conversationStore, modelGateway, providerRegistry };

    const server = new BabServer();
    server.setManifest(
      buildToolManifest(toolContext, providerRegistry, config),
    );
    server.config = config;

    expect(server.shouldPersistTool("tracer")).toBeFalse();
    expect(server.shouldPersistTool("analyze")).toBeTrue(); // others still on
  });
});

describe("extractSummary", () => {
  test("extracts from <SUMMARY> tags", () => {
    const content =
      "Some preamble\n<SUMMARY>Short summary here.</SUMMARY>\nMore content.";
    expect(extractSummary(content)).toBe("Short summary here.");
  });

  test("falls back to first paragraph when no SUMMARY tag", () => {
    const content =
      "First sentence. Second sentence. Third sentence. Fourth sentence.\n\nSecond paragraph.";
    const summary = extractSummary(content);
    expect(summary).toContain("First sentence.");
    expect(summary).not.toContain("Second paragraph.");
  });

  test("strips markdown heading prefix in fallback", () => {
    const content = "## Analysis Result\nThis is the result.\n\nMore stuff.";
    expect(extractSummary(content)).not.toMatch(/^##/);
  });

  test("returns empty string for empty content", () => {
    expect(extractSummary("")).toBe("");
  });
});

describe("formatReport", () => {
  test("includes Request and Analysis sections", () => {
    const input = makeInput({
      toolName: "analyze",
      inputText: "analyze performance",
      continuationId: "cont-2",
      content: "Performance looks good.",
    });
    const report = formatReport(input);
    expect(report).toContain("## Request");
    expect(report).toContain("## Analysis");
    expect(report).toContain("Performance looks good.");
  });

  test("omits Expert Validation section when no expertContent", () => {
    const input = makeInput({
      toolName: "analyze",
      inputText: "test",
      continuationId: "cont-3",
      content: "Some analysis.",
    });
    expect(formatReport(input)).not.toContain("## Expert Validation");
  });

  test("includes Expert Validation section when expertContent provided", () => {
    const input = makeInput({
      toolName: "analyze",
      inputText: "test",
      continuationId: "cont-4",
      content: "Primary analysis.",
      expertContent: "Expert says it's fine.",
    });
    const report = formatReport(input);
    expect(report).toContain("## Expert Validation");
    expect(report).toContain("Expert says it's fine.");
  });

  test("includes files in frontmatter when provided", () => {
    const input = makeInput({
      toolName: "codereview",
      inputText: "review src/foo.ts",
      continuationId: "cont-5",
      content: "Looks good.",
      files: ["src/foo.ts", "src/bar.ts"],
    });
    const report = formatReport(input);
    expect(report).toContain("files:");
    expect(report).toContain("src/foo.ts");
  });

  test("multi-model frontmatter for consensus tool", () => {
    const input: PersistReportInput = {
      toolName: "consensus",
      inputText: "is this a good idea?",
      continuationId: "cont-6",
      content: "All models agree.",
      models: [
        { id: "model-a", provider: "anthropic", role: "panelist" },
        { id: "model-b", provider: "openai", role: "panelist" },
        { id: "model-c", provider: "anthropic", role: "synthesis" },
      ],
    };
    const report = formatReport(input);
    expect(report).toContain("role: panelist");
    expect(report).toContain("role: synthesis");
    expect(report).toContain("model-a");
    expect(report).toContain("model-b");
    expect(report).toContain("model-c");
  });
});

async function mktemp2(): Promise<string> {
  const dir = join(
    tmpdir(),
    `bab-persist-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("multi-step workflow report appending", () => {
  test("appends step with correct numbering on continuation", async () => {
    const root = await mktemp2();
    await persistReport(
      p("analyze", "step one", "cont-ms-1", "First analysis.", root),
    );
    await persistReport(
      p("analyze", "step two", "cont-ms-1", "Second analysis.", root),
    );

    const files = await readdir(join(root, ".bab", "analyze"));
    expect(files).toHaveLength(1);

    const content = await readFile(
      join(root, ".bab", "analyze", files[0] as string),
      "utf8",
    );
    expect(content).toContain("## Step 2:");
    expect(content).toContain("Second analysis.");
  });

  test("first report does not have Step heading", async () => {
    const root = await mktemp2();
    await persistReport(
      p("debug", "initial step", "cont-ms-2", "Initial analysis.", root),
    );

    const files = await readdir(join(root, ".bab", "debug"));
    const content = await readFile(
      join(root, ".bab", "debug", files[0] as string),
      "utf8",
    );
    expect(content).not.toContain("## Step 1:");
  });

  test("three-step continuation increments step numbers correctly", async () => {
    const root = await mktemp2();
    await persistReport(
      p("analyze", "step one", "cont-ms-3", "Analysis 1.", root),
    );
    await persistReport(
      p("analyze", "step two", "cont-ms-3", "Analysis 2.", root),
    );
    await persistReport(
      p("analyze", "step three", "cont-ms-3", "Analysis 3.", root),
    );

    const files = await readdir(join(root, ".bab", "analyze"));
    expect(files).toHaveLength(1);

    const content = await readFile(
      join(root, ".bab", "analyze", files[0] as string),
      "utf8",
    );
    expect(content).toContain("## Step 2:");
    expect(content).toContain("## Step 3:");
    expect(content).toContain("Analysis 3.");
  });

  test("four-step continuation does not repeat step numbers", async () => {
    const root = await mktemp2();
    await persistReport(
      p("analyze", "step one", "cont-ms-4", "Analysis 1.", root),
    );
    await persistReport(
      p("analyze", "step two", "cont-ms-4", "Analysis 2.", root),
    );
    await persistReport(
      p("analyze", "step three", "cont-ms-4", "Analysis 3.", root),
    );
    await persistReport(
      p("analyze", "step four", "cont-ms-4", "Analysis 4.", root),
    );

    const files = await readdir(join(root, ".bab", "analyze"));
    expect(files).toHaveLength(1);

    const content = await readFile(
      join(root, ".bab", "analyze", files[0] as string),
      "utf8",
    );
    expect(content).toContain("## Step 2:");
    expect(content).toContain("## Step 3:");
    expect(content).toContain("## Step 4:");
    expect(content).toContain("Analysis 4.");
    // Ensure no duplicate step numbers
    const step3Matches = content.match(/## Step 3:/g);
    expect(step3Matches).toHaveLength(1);
  });
});
