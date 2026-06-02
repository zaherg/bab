import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { logger } from "../utils/logger";

const FALLBACK_REPORTS_DIR = join(homedir(), ".config", "bab", "reports");

/** Continuation IDs for which a persistence warning has already been emitted. */
const MAX_WARNED_IDS = 500;
const warnedIds = new Set<string>();

export interface PersistReportModel {
  id: string;
  provider: string;
  role: "primary" | "expert" | "panelist" | "synthesis";
}

export interface PersistReportInput {
  toolName: string;
  continuationId: string;
  inputText: string;
  content: string;
  expertContent?: string;
  models: PersistReportModel[];
  files?: string[];
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 50);
}

function buildFilename(inputText: string, continuationId: string): string {
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
  ].join("-");

  const slug = toSlug(inputText) || toSlug(continuationId) || "report";
  return `${timestamp}-${slug}.md`;
}

/** Extract summary from <SUMMARY>...</SUMMARY> tags, or fall back to first paragraph. */
export function extractSummary(content: string): string {
  const tagMatch = /<SUMMARY>([\s\S]*?)<\/SUMMARY>/u.exec(content);
  if (tagMatch?.[1]) {
    return tagMatch[1].trim();
  }

  // First paragraph heuristic: take up to 3 sentences from the first non-empty paragraph
  const firstPara =
    content.split(/\n\n+/u).find((p) => p.trim().length > 0) ?? "";
  const cleaned = firstPara
    .replace(/^#+\s*/u, "")
    .replace(/\*\*/gu, "")
    .trim();
  const sentences = cleaned.match(/[^.!?]+[.!?]+/gu) ?? [];
  return sentences.slice(0, 3).join(" ").trim() || cleaned.slice(0, 200);
}

function buildFrontmatter(input: PersistReportInput): string {
  const modelLines = input.models
    .map(
      (m) =>
        `  - id: ${m.id}\n    provider: ${m.provider}\n    role: ${m.role}`,
    )
    .join("\n");

  const filesLine =
    input.files && input.files.length > 0
      ? `files: [${input.files.join(", ")}]\n`
      : "";

  return [
    "---",
    "schema_version: 1",
    `tool: bab:${input.toolName}`,
    `models:\n${modelLines}`,
    `continuation_id: ${input.continuationId}`,
    `timestamp: ${new Date().toISOString()}`,
    filesLine.trimEnd(),
    "---",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Format a full report markdown document. */
export function formatReport(input: PersistReportInput): string {
  const frontmatter = buildFrontmatter(input);
  const summary = extractSummary(input.content);
  const title = input.inputText.slice(0, 80).trim() || input.toolName;
  const requestExcerpt = input.inputText.slice(0, 200).trim();

  const sections: string[] = [
    frontmatter,
    "",
    `**Summary:** ${summary}`,
    "",
    `# ${input.toolName}: ${title}`,
    "",
    "## Request",
    `> ${requestExcerpt}`,
    "",
    "## Analysis",
    "",
    input.content.trim(),
  ];

  if (input.expertContent) {
    sections.push("", "## Expert Validation", "", input.expertContent.trim());
  }

  return sections.join("\n");
}

async function resolveTargetPath(
  toolName: string,
  filename: string,
  projectRoot?: string,
): Promise<string> {
  const base = projectRoot ?? FALLBACK_REPORTS_DIR;
  const dir = join(base, ".bab", toolName);
  await mkdir(dir, { recursive: true });

  const target = join(dir, filename);

  // Avoid overwriting existing files — append numeric suffix
  let candidate = target;
  let suffix = 2;
  while (await Bun.file(candidate).exists()) {
    const baseName = target.replace(/\.md$/u, "");
    candidate = `${baseName}-${suffix}.md`;
    suffix++;
  }

  return candidate;
}

/** Find existing report file for a continuation ID by scanning the tool directory. */
async function findExistingReport(
  toolName: string,
  continuationId: string,
  projectRoot?: string,
): Promise<string | undefined> {
  const base = projectRoot ?? FALLBACK_REPORTS_DIR;
  const dir = join(base, ".bab", toolName);

  try {
    const files = await readdir(dir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const filePath = join(dir, file);
      const content = await Bun.file(filePath).text();
      if (content.includes(`continuation_id: ${continuationId}`)) {
        return filePath;
      }
    }
  } catch {
    // Directory doesn't exist yet — no existing report
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist a tool result report to <projectRoot>/.bab/<toolName>/<timestamp>-<slug>.md.
 * For workflow tools with an existing continuation_id, appends a new step to the report.
 * Falls back to ~/.config/bab/reports/ when no project root is available.
 * Never throws — all errors are logged as warnings (once per continuation ID).
 */
export async function persistReport(input: PersistReportInput): Promise<void> {
  const { continuationId, toolName } = input;

  try {
    // Check for existing report (continuation of a multi-step workflow)
    const existingPath = await findExistingReport(
      toolName,
      continuationId,
      input.projectRoot,
    );

    if (existingPath) {
      const existing = await Bun.file(existingPath).text();
      let maxStep = 1;
      for (const m of existing.matchAll(/^## Step (\d+):/gmu)) {
        const n = Number(m[1]);
        if (n > maxStep) maxStep = n;
      }
      const nextStep = maxStep + 1;
      const stepHeading = `## Step ${nextStep}: ${input.inputText.slice(0, 80).trim()}`;
      const appended = [
        existing.trimEnd(),
        "",
        stepHeading,
        "",
        input.content.trim(),
      ];
      if (input.expertContent) {
        appended.push(
          "",
          "### Expert Validation",
          "",
          input.expertContent.trim(),
        );
      }
      await Bun.write(existingPath, appended.join("\n"));
      logger.debug("Persistence report step appended", {
        continuationId,
        path: existingPath,
        step: nextStep,
        tool: toolName,
      });
    } else {
      const reportContent = formatReport(input);
      const filename = buildFilename(input.inputText, continuationId);
      const targetPath = await resolveTargetPath(
        toolName,
        filename,
        input.projectRoot,
      );
      await Bun.write(targetPath, reportContent);
      logger.debug("Persistence report written", {
        continuationId,
        path: targetPath,
        tool: toolName,
      });
    }
  } catch (error) {
    if (!warnedIds.has(continuationId)) {
      if (warnedIds.size >= MAX_WARNED_IDS) {
        const oldest = warnedIds.values().next().value;
        if (oldest !== undefined) warnedIds.delete(oldest);
      }
      warnedIds.add(continuationId);
      logger.warn("Failed to persist report", {
        continuationId,
        error: error instanceof Error ? error.message : String(error),
        tool: toolName,
      });
    }
  }
}

/** Clear the warned IDs set — exposed for testing only. */
export function clearPersistenceWarnings(): void {
  warnedIds.clear();
}
