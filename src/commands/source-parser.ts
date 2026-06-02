import { CommandError } from "./errors";

const GITHUB_SHORTHAND_PATTERN =
  /^(?<org>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+?)(?:\.git)?$/u;
const SCP_STYLE_GIT_PATTERN = /^[^@\s]+@[^:\s]+:.+$/u;
const SAFE_REF_PATTERN = /^[0-9A-Za-z_./@^~-]+$/u;
const MAX_REF_LENGTH = 200;

export interface ParsedSource {
  kind: "github_shorthand" | "git_url";
  original: string;
  ref?: string;
  url: string;
}

function assertSafeGitRef(ref: string): void {
  if (ref.startsWith("-")) {
    throw new CommandError(`Invalid ref (starts with "-"): ${ref}`);
  }

  if (ref.length > MAX_REF_LENGTH) {
    throw new CommandError(`Ref exceeds maximum length of ${MAX_REF_LENGTH}`);
  }

  if (!SAFE_REF_PATTERN.test(ref)) {
    throw new CommandError(`Invalid characters in ref: ${ref}`);
  }
}

function assertSafeGitUrl(source: string): void {
  if (source.startsWith("-")) {
    throw new CommandError('Plugin source URL must not start with "-"');
  }
}

function splitRef(value: string): { ref?: string; source: string } {
  const hashIndex = value.indexOf("#");

  if (hashIndex < 0) {
    return { source: value };
  }

  const ref = value.slice(hashIndex + 1) || undefined;

  if (ref) {
    assertSafeGitRef(ref);
  }

  return {
    ref,
    source: value.slice(0, hashIndex),
  };
}

function looksLikeLocalPath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value === "." ||
    value === ".." ||
    value.startsWith("file://")
  );
}

export function parseSource(input: string): ParsedSource {
  const original = input.trim();

  if (!original) {
    throw new CommandError("Plugin source must not be empty");
  }

  if (looksLikeLocalPath(original)) {
    throw new CommandError("Local plugin sources are not supported");
  }

  const { ref, source } = splitRef(original);

  if (!source) {
    throw new CommandError("Plugin source must not be empty");
  }

  assertSafeGitUrl(source);

  const shorthandMatch = source.match(GITHUB_SHORTHAND_PATTERN);

  if (shorthandMatch?.groups) {
    const org = shorthandMatch.groups.org;
    const repo = shorthandMatch.groups.repo;

    return {
      kind: "github_shorthand",
      original,
      ref,
      url: `https://github.com/${org}/${repo}.git`,
    };
  }

  if (SCP_STYLE_GIT_PATTERN.test(source)) {
    return {
      kind: "git_url",
      original,
      ref,
      url: source,
    };
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(source);
  } catch {
    throw new CommandError(`Unsupported plugin source format: ${original}`);
  }

  if (parsedUrl.protocol === "file:") {
    throw new CommandError("Local plugin sources are not supported");
  }

  if (parsedUrl.protocol === "http:") {
    throw new CommandError(
      "Insecure http:// plugin sources are not allowed. Use https:// or ssh:// instead.",
    );
  }

  if (!["https:", "ssh:"].includes(parsedUrl.protocol)) {
    throw new CommandError(
      `Unsupported plugin source protocol: ${parsedUrl.protocol}`,
    );
  }

  return {
    kind: "git_url",
    original,
    ref,
    url: source,
  };
}
