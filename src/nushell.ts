import {
    createBashToolDefinition,
    type BashOperations,
    type BashToolDetails,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export interface NushellToolOptions {
    cwd: string;
    shellPath?: string;
    operations?: BashOperations;
    isRestricted: () => boolean;
}

const NUSHELL_COMMANDS = new Set([
    "alias",
    "all",
    "any",
    "append",
    "cd",
    "columns",
    "compact",
    "describe",
    "diff",
    "echo",
    "eza",
    "first",
    "find",
    "flatten",
    "from",
    "get",
    "glob",
    "group-by",
    "help",
    "history",
    "inspect",
    "into",
    "items",
    "last",
    "length",
    "lines",
    "ls",
    "math",
    "merge",
    "metadata",
    "open",
    "path",
    "print",
    "ps",
    "pwd",
    "query",
    "range",
    "rename",
    "reverse",
    "select",
    "sort",
    "sort-by",
    "split",
    "str",
    "sys",
    "table",
    "transpose",
    "uniq",
    "values",
    "where",
    "which",
    "zip",
]);

const EXTERNAL_COMMANDS = new Set([
    "ast-grep",
    "diff",
    "file",
    "gcloud",
    "git",
    "id",
    "kubectl",
    "npm",
    "pnpm",
    "sha256sum",
    "stat",
    "uv",
]);

const BLOCKED_ARGUMENTS = new Set([
    "--exec",
    "--exec-batch",
    "--execdir",
    "--ext-diff",
    "--interactive",
    "--pre",
    "--rewrite",
    "-delete",
    "-exec",
    "-execdir",
    "-X",
    "-x",
]);

const BLOCKED_COMMANDS = new Set([
    "alias",
    "def",
    "def-env",
    "do",
    "each",
    "for",
    "-delete",
    "-exec",
    "-execdir",
    "--exec",
    "--exec-batch",
    "apply",
    "config",
    "cp",
    "create",
    "delete",
    "deploy",
    "destroy",
    "edit",
    "http",
    "install",
    "job",
    "mkdir",
    "mv",
    "patch",
    "plugin",
    "publish",
    "remove",
    "replace",
    "rm",
    "run-external",
    "source",
    "use",
    "overlay",
    "save",
    "scale",
    "set",
    "touch",
    "update",
]);

const SAFE_EXTERNAL_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
    "ast-grep": new Set(["run", "scan"]),
    gcloud: new Set(["compute", "describe", "info", "list", "projects", "services", "version"]),
    git: new Set([
        "blame",
        "cherry",
        "describe",
        "diff",
        "grep",
        "list",
        "log",
        "ls-files",
        "ls-tree",
        "merge-base",
        "remote",
        "reflog",
        "rev-list",
        "rev-parse",
        "show",
        "shortlog",
        "status",
    ]),
    kubectl: new Set(["api-resources", "cluster-info", "describe", "explain", "get", "version"]),
    npm: new Set(["list", "ls", "outdated", "run", "test", "view"]),
    pnpm: new Set(["list", "ls", "outdated", "run", "test"]),
    uv: new Set(["cache", "list", "pip", "python", "tool", "version"]),
};

const SAFE_RUN_SCRIPTS = new Set(["format:check", "lint", "test", "typecheck"]);

/** Splits direct source at top-level Nushell pipeline boundaries. */
function splitPipelines(command: string): string[] | undefined {
    const stages: string[] = [];
    let start = 0;
    let quote: "'" | '"' | undefined;
    for (let index = 0; index < command.length; index++) {
        const character = command[index];
        if (quote) {
            if (character === quote && command[index - 1] !== "\\") quote = undefined;
            continue;
        }
        if (character === "'" || character === '"') {
            quote = character;
            continue;
        }
        if ("([{".includes(character) || ")]}".includes(character)) return undefined;
        if (character === "|" || character === ";") {
            if (character === "|" && command[index + 1] === "|") return undefined;
            stages.push(command.slice(start, index).trim());
            start = index + 1;
        }
    }
    if (quote) return undefined;
    stages.push(command.slice(start).trim());
    return stages.every(Boolean) ? stages : undefined;
}

/** Extracts shell-like tokens from one pipeline stage. */
function words(stage: string): string[] {
    return stage.match(/(?:[^\s"']+|"(?:\\.|[^"\\])*"|'[^']*')+/g) ?? [];
}

/** Checks an external command and its read-only arguments. */
function isSafeExternal(command: string, tokens: string[]): boolean {
    if (tokens.slice(1).some((token) => BLOCKED_COMMANDS.has(token))) return false;
    if (
        command === "git" &&
        tokens.some((token) => token === "--exec-path" || token === "--ext-diff" || token.startsWith("--output"))
    )
        return false;
    if (command === "ast-grep" && tokens.some((token) => token === "--rewrite" || token.startsWith("--rewrite=")))
        return false;
    const subcommands = SAFE_EXTERNAL_SUBCOMMANDS[command];
    if (!subcommands) return EXTERNAL_COMMANDS.has(command);
    const subcommand = tokens.find((token) => !token.startsWith("-") && token !== command);
    if (!subcommand || !subcommands.has(subcommand)) return false;
    if ((command === "npm" || command === "pnpm") && subcommand === "run") {
        const script = tokens[tokens.indexOf(subcommand) + 1];
        return SAFE_RUN_SCRIPTS.has(script);
    }
    if (command === "uv" && subcommand === "pip") {
        return ["show", "list", "check", "freeze"].includes(tokens[tokens.indexOf(subcommand) + 1] ?? "");
    }
    return true;
}

/** Checks one Nushell pipeline stage. */
function isSafeStage(stage: string): boolean {
    if (/[\r\n`]|\$\(|(?:^|\s)o(?:\+e)?>>?(?:\s|$)/.test(stage)) return false;
    const tokens = words(stage);
    const first = tokens[0];
    const command = first?.startsWith("^") ? first.slice(1) : first;
    if (!command || BLOCKED_COMMANDS.has(command)) return false;
    if (
        tokens.some(
            (token) => BLOCKED_ARGUMENTS.has(token) || token.startsWith("--output") || token.startsWith("--rewrite="),
        )
    )
        return false;
    if (first?.startsWith("^") && !EXTERNAL_COMMANDS.has(command)) return false;
    if (NUSHELL_COMMANDS.has(command)) return true;
    return isSafeExternal(command, tokens);
}

/** Returns whether direct Nushell source is within the read-only planning subset. */
export function isAllowedPlanningCommand(command: string): boolean {
    return splitPipelines(command)?.every(isSafeStage) ?? false;
}

/** Creates a Nushell-named tool backed by Pi's shell executor. */
export function createNushellTool(
    options: NushellToolOptions,
): ToolDefinition<ReturnType<typeof createBashToolDefinition>["parameters"], BashToolDetails | undefined, unknown> {
    const backend = createBashToolDefinition(options.cwd, {
        shellPath: options.shellPath ?? "nu",
        operations: options.operations,
    });

    return {
        ...backend,
        name: "nushell",
        label: "Nushell",
        description:
            "Use Pi's shell backend to execute Nushell commands. Commands are read-only during planning and unrestricted during implementation.",
        renderCall(input, theme, context) {
            const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
            text.setText(theme.fg("toolTitle", theme.bold("Nushell ")) + theme.fg("muted", `$ ${input.command}`));
            return text;
        },
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            if (options.isRestricted() && !isAllowedPlanningCommand(params.command)) {
                throw new Error(`Plan mode: blocked — not a read-only command.\n${params.command}`);
            }
            return backend.execute(toolCallId, params, signal, onUpdate, ctx);
        },
    } as ToolDefinition<
        ReturnType<typeof createBashToolDefinition>["parameters"],
        BashToolDetails | undefined,
        unknown
    >;
}
