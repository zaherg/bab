#!/usr/bin/env node

import { main as startServer } from "./bootstrap";
import { runAddCommand as executeAddCommand } from "./commands/add";
import { CommandError } from "./commands/errors";
import { runListCommand as executeListCommand } from "./commands/list";
import { runOnboardCommand as executeOnboardCommand } from "./commands/onboard";
import { runRemoveCommand as executeRemoveCommand } from "./commands/remove";
import { isBinaryInstall, runSelfUpdate } from "./commands/selfupdate";
import { loadConfig } from "./config";
import { validatePluginDirectory } from "./plugin-sdk/conformance";
import { VERSION } from "./version";

interface WritableLike {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

export interface CliDependencies {
  loadConfig: typeof loadConfig;
  runAddCommand: typeof executeAddCommand;
  runListCommand: typeof executeListCommand;
  runOnboardCommand: typeof executeOnboardCommand;
  runRemoveCommand: typeof executeRemoveCommand;
  startServer: typeof startServer;
  stdin: NodeJS.ReadStream;
  stdout: WritableLike;
  stderr: WritableLike;
  validatePluginDirectory: typeof validatePluginDirectory;
}

type CliCommandHandler = (
  args: string[],
  dependencies: CliDependencies,
) => Promise<number>;

class CliCommandError extends Error {
  readonly exitCode: number;
  readonly helpText?: string;

  constructor(
    message: string,
    options: { exitCode?: number; helpText?: string } = {},
  ) {
    super(message);
    this.name = "CliCommandError";
    this.exitCode = options.exitCode ?? 1;
    this.helpText = options.helpText;
  }
}

const defaultCliDependencies: CliDependencies = {
  loadConfig,
  runAddCommand: executeAddCommand,
  runListCommand: executeListCommand,
  runOnboardCommand: executeOnboardCommand,
  runRemoveCommand: executeRemoveCommand,
  startServer,
  stderr: process.stderr,
  stdin: process.stdin,
  stdout: process.stdout,
  validatePluginDirectory,
};

function writeLine(stream: WritableLike, message: string): void {
  stream.write(`${message}\n`);
}

function isHelpFlag(argument?: string): boolean {
  return argument === "--help" || argument === "-h" || argument === "help";
}

const CLI_TIPS = [
  "Run `bab onboard` to generate host-agent skills.",
  "Use `bab add <source>` to install plugin packs.",
  "Check updates without installing via `bab selfupdate --check`.",
  "Validate a plugin with `bab test-plugin <plugin-directory>`.",
  "Use `bab list` to inspect bundled and installed plugins.",
] as const;

const ANSI = {
  amber: "\u001B[38;5;179m",
  bold: "\u001B[1m",
  dim: "\u001B[38;5;145m",
  indigo: "\u001B[38;5;111m",
  reset: "\u001B[0m",
  white: "\u001B[97m",
} as const;

const CLI_BANNER_WIDTH = 72;

interface CliHelpTextOptions {
  color?: boolean;
  tipIndex?: number;
}

function colorize(text: string, enabled: boolean, ...codes: string[]): string {
  if (!enabled || codes.length === 0) {
    return text;
  }

  return `${codes.join("")}${text}${ANSI.reset}`;
}

function isInteractiveHelp(stream: WritableLike): boolean {
  return (
    stream.isTTY === true &&
    process.env.CI === undefined &&
    process.env.TERM !== "dumb"
  );
}

function shouldColorizeHelp(stream: WritableLike): boolean {
  return isInteractiveHelp(stream) && process.env.NO_COLOR === undefined;
}

function pickCliTipIndex(): number {
  return Math.floor(Math.random() * CLI_TIPS.length);
}

function renderBannerRow(
  left: string,
  right: string,
  color: boolean,
  rightTone: "title" | "subtitle" | "tip" | "plain",
): string {
  const separator = left.length > 0 && right.length > 0 ? "  " : "";
  const plainContent = `${left}${separator}${right}`;
  const padding = " ".repeat(
    Math.max(0, CLI_BANNER_WIDTH - plainContent.length),
  );

  let styledRight = right;

  if (rightTone === "title") {
    styledRight = colorize(right, color, ANSI.white, ANSI.bold);
  } else if (rightTone === "subtitle") {
    styledRight = colorize(right, color, ANSI.indigo);
  } else if (rightTone === "tip") {
    styledRight = colorize(right, color, ANSI.dim);
  }

  return [
    colorize("|", color, ANSI.amber),
    " ",
    colorize(left, color, ANSI.amber),
    separator,
    styledRight,
    padding,
    " ",
    colorize("|", color, ANSI.amber),
  ].join("");
}

function getCliBanner(tipIndex: number, color: boolean): string {
  const topBorder = colorize(
    `+${"-".repeat(CLI_BANNER_WIDTH + 2)}+`,
    color,
    ANSI.amber,
  );
  const tip = CLI_TIPS[tipIndex] ?? CLI_TIPS[0];
  const rows = [
    renderBannerRow("", `Bab CLI v${VERSION}`, color, "title"),
    renderBannerRow(
      "",
      "MCP server, plugins, and CLI tools.",
      color,
      "subtitle",
    ),
    renderBannerRow(
      "",
      "Add plugins, onboard agents, validate adapters.",
      color,
      "plain",
    ),
    renderBannerRow("", `Tip: ${tip}`, color, "tip"),
  ];

  return [topBorder, ...rows, topBorder].join("\n");
}

export function getCliHelpText(options: CliHelpTextOptions = {}): string {
  const tipIndex = options.tipIndex ?? 0;
  const color = options.color ?? false;

  return [
    getCliBanner(tipIndex, color),
    "",
    "Usage:",
    "  bab",
    "  bab --version",
    "  bab serve",
    "  bab add <source>",
    "  bab remove <plugin-id>",
    "  bab list",
    "  bab onboard",
    "  bab help",
    "  bab selfupdate [--check] [--force]",
    "  bab test-plugin <plugin-directory>",
    "",
    "Commands:",
    "  add                   Install plugin(s) from a git source",
    "  remove                Remove an installed plugin",
    "  list                  List bundled and installed plugins",
    "  onboard               Generate Agent Skills for detected host agents",
    "  selfupdate            Update bab to the latest release",
    "  help                  Show CLI usage information",
    "  serve                 Start the Bab MCP server over stdio",
    "  test-plugin <dir>     Validate a delegate plugin directory",
    "  --version             Print the Bab CLI version",
  ].join("\n");
}

export function getAddHelpText(): string {
  return [
    "Usage:",
    "  bab add <source> [--yes]",
    "",
    "Install plugin(s) from a git repository source.",
  ].join("\n");
}

export function getRemoveHelpText(): string {
  return [
    "Usage:",
    "  bab remove <plugin-id> [--yes]",
    "",
    "Remove an installed plugin by ID.",
  ].join("\n");
}

export function getListHelpText(): string {
  return [
    "Usage:",
    "  bab list",
    "",
    "List bundled and installed plugins.",
  ].join("\n");
}

export function getOnboardHelpText(): string {
  return [
    "Usage:",
    "  bab onboard [--agent <name>]",
    "",
    "Generate Agent Skills for detected host agents (Claude Code, Codex, etc.).",
    "",
    "Options:",
    "  --agent <name>  Target a specific agent (e.g. claude, codex)",
  ].join("\n");
}

export function getTestPluginHelpText(): string {
  return [
    "Usage:",
    "  bab test-plugin <plugin-directory>",
    "",
    "Validate a delegate plugin directory.",
  ].join("\n");
}

export function getSelfupdateHelpText(): string {
  return [
    "Usage:",
    "  bab selfupdate [--check] [--force]",
    "",
    "Update bab to the latest release (compiled binary only).",
    "",
    "Options:",
    "  --check   Check for updates without installing (exit 0=up to date, 80=update available)",
    "  --force   Re-download and install even if already up to date",
  ].join("\n");
}

async function runServeCommand(
  _args: string[],
  dependencies: CliDependencies,
): Promise<number> {
  await dependencies.startServer();
  return 0;
}

async function runHelpCommand(
  _args: string[],
  dependencies: CliDependencies,
): Promise<number> {
  writeLine(
    dependencies.stdout,
    getCliHelpText({
      color: shouldColorizeHelp(dependencies.stdout),
      tipIndex: isInteractiveHelp(dependencies.stdout) ? pickCliTipIndex() : 0,
    }),
  );
  return 0;
}

async function runVersionCommand(
  _args: string[],
  dependencies: CliDependencies,
): Promise<number> {
  writeLine(dependencies.stdout, VERSION);
  return 0;
}

async function runAddCommand(
  args: string[],
  dependencies: CliDependencies,
): Promise<number> {
  if (isHelpFlag(args[0])) {
    writeLine(dependencies.stdout, getAddHelpText());
    return 0;
  }

  if (!args[0]) {
    throw new CliCommandError("Plugin source is required", {
      helpText: getAddHelpText(),
    });
  }

  const config = await dependencies.loadConfig();

  return dependencies.runAddCommand(args, {
    config,
    isTty: dependencies.stdin.isTTY,
    stderr: dependencies.stderr,
    stdin: dependencies.stdin,
    stdout: dependencies.stdout,
  });
}

async function runRemoveCommand(
  args: string[],
  dependencies: CliDependencies,
): Promise<number> {
  if (isHelpFlag(args[0])) {
    writeLine(dependencies.stdout, getRemoveHelpText());
    return 0;
  }

  if (!args[0]) {
    throw new CliCommandError("Plugin ID is required", {
      helpText: getRemoveHelpText(),
    });
  }

  const config = await dependencies.loadConfig();

  return dependencies.runRemoveCommand(args, {
    config,
    isTty: dependencies.stdin.isTTY,
    stderr: dependencies.stderr,
    stdin: dependencies.stdin,
    stdout: dependencies.stdout,
  });
}

async function runListCommand(
  args: string[],
  dependencies: CliDependencies,
): Promise<number> {
  if (isHelpFlag(args[0])) {
    writeLine(dependencies.stdout, getListHelpText());
    return 0;
  }

  const config = await dependencies.loadConfig();

  return dependencies.runListCommand(args, {
    config,
    stdout: dependencies.stdout,
  });
}

async function runTestPluginCommand(
  args: string[],
  dependencies: CliDependencies,
): Promise<number> {
  if (isHelpFlag(args[0])) {
    writeLine(dependencies.stdout, getTestPluginHelpText());
    return 0;
  }

  const pluginDirectory = args[0];

  if (!pluginDirectory) {
    throw new CliCommandError("Plugin directory is required", {
      helpText: getTestPluginHelpText(),
    });
  }

  const result = await dependencies.validatePluginDirectory(pluginDirectory);
  writeLine(dependencies.stdout, JSON.stringify(result, null, 2));
  return result.valid ? 0 : 1;
}

async function runOnboardCommand(
  args: string[],
  dependencies: CliDependencies,
): Promise<number> {
  if (isHelpFlag(args[0])) {
    writeLine(dependencies.stdout, getOnboardHelpText());
    return 0;
  }

  const config = await dependencies.loadConfig();

  return dependencies.runOnboardCommand(args, {
    config,
    stderr: dependencies.stderr,
    stdout: dependencies.stdout,
  });
}

async function runSelfupdateCommand(
  args: string[],
  dependencies: CliDependencies,
): Promise<number> {
  if (isHelpFlag(args[0])) {
    writeLine(dependencies.stdout, getSelfupdateHelpText());
    return 0;
  }

  return runSelfUpdate(args, {
    arch: process.arch,
    execPath: process.execPath,
    fetch: globalThis.fetch,
    isBinaryInstall,
    platform: process.platform,
    stderr: dependencies.stderr,
  });
}

const commandHandlers: Record<string, CliCommandHandler> = {
  add: runAddCommand,
  list: runListCommand,
  onboard: runOnboardCommand,
  remove: runRemoveCommand,
  selfupdate: runSelfupdateCommand,
  serve: runServeCommand,
  "test-plugin": runTestPluginCommand,
};

export async function runCli(
  argv = process.argv.slice(2),
  dependencies: CliDependencies = defaultCliDependencies,
): Promise<number> {
  const [command, ...args] = argv;

  if (!command) {
    return runServeCommand(args, dependencies);
  }

  if (isHelpFlag(command)) {
    return runHelpCommand(args, dependencies);
  }

  if (command === "--version") {
    return runVersionCommand(args, dependencies);
  }

  const handler = commandHandlers[command];

  if (!handler) {
    writeLine(dependencies.stderr, `Unknown command: ${command}`);
    writeLine(
      dependencies.stderr,
      getCliHelpText({
        color: shouldColorizeHelp(dependencies.stderr),
        tipIndex: isInteractiveHelp(dependencies.stderr)
          ? pickCliTipIndex()
          : 0,
      }),
    );
    return 1;
  }

  try {
    return await handler(args, dependencies);
  } catch (error) {
    if (error instanceof CliCommandError || error instanceof CommandError) {
      writeLine(dependencies.stderr, error.message);

      if (error.helpText) {
        writeLine(dependencies.stderr, error.helpText);
      }

      return error.exitCode;
    }

    throw error;
  }
}

function isServeMode(argv: string[]): boolean {
  const command = argv[0];
  return !command || command === "serve";
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const serve = isServeMode(argv);

  runCli(argv)
    .then((exitCode) => {
      if (serve) {
        return;
      }
      process.exit(exitCode);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `Fatal: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    });
}
