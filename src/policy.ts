import { parse as parseShell } from "shell-quote";

const CHAIN_OPERATORS = new Set(["|", "||", "&&", ";"]);
const FIND_WRITE_FLAGS = new Set([
    "-delete",
    "-exec",
    "-execdir",
    "-fls",
    "-fprint",
    "-fprint0",
    "-fprintf",
    "-ok",
    "-okdir",
]);
const FD_EXEC_FLAGS = new Set(["-x", "--exec", "-X", "--exec-batch"]);
const SAFE_COMMANDS = new Set([
    "basename",
    "cat",
    "cd",
    "column",
    "cut",
    "df",
    "diff",
    "dirname",
    "du",
    "echo",
    "eza",
    "false",
    "fd",
    "file",
    "find",
    "grep",
    "head",
    "id",
    "jq",
    "ls",
    "printenv",
    "ps",
    "pwd",
    "readlink",
    "realpath",
    "rg",
    "sha256sum",
    "stat",
    "tail",
    "tr",
    "tree",
    "true",
    "type",
    "uname",
    "uniq",
    "wc",
    "which",
    "whoami",
]);
const SAFE_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
    git: new Set([
        "status",
        "log",
        "diff",
        "show",
        "ls-files",
        "ls-tree",
        "rev-parse",
        "rev-list",
        "describe",
        "blame",
        "remote",
        "reflog",
        "grep",
        "shortlog",
        "merge-base",
        "cherry",
    ]),
    npm: new Set(["ls", "list", "view", "outdated", "test", "run"]),
    pnpm: new Set(["list", "ls", "outdated", "test", "run"]),
};
const SAFE_RUN_SCRIPTS = new Set(["test", "typecheck", "format:check", "lint"]);

type ArgumentPolicy = (words: string[]) => boolean;

const argumentPolicies: Record<string, ArgumentPolicy> = {
    find: (words) => words.every((word) => !FIND_WRITE_FLAGS.has(word)),
    fd: (words) =>
        words.every(
            (word) => !FD_EXEC_FLAGS.has(word) && !word.startsWith("--exec=") && !word.startsWith("--exec-batch="),
        ),
    rg: (words) => words.every((word) => word !== "--pre" && !word.startsWith("--pre=")),
    git: (words) => words.every((word) => word !== "--ext-diff" && !word.startsWith("--output")),
    npm: (words) => words[1] !== "run" || (words.length === 3 && SAFE_RUN_SCRIPTS.has(words[2])),
    pnpm: (words) => words[1] !== "run" || (words.length === 3 && SAFE_RUN_SCRIPTS.has(words[2])),
};

/** Returns whether one command segment matches the inspection allowlist. */
function isAllowedSegment(words: string[]): boolean {
    const [command, subcommand] = words;
    if (!command) return false;
    if (SAFE_COMMANDS.has(command)) return argumentPolicies[command]?.(words) ?? true;
    if (!subcommand || !SAFE_SUBCOMMANDS[command]?.has(subcommand)) return false;
    return argumentPolicies[command]?.(words) ?? true;
}

/** Returns whether all shell segments match the fail-closed inspection allowlist. */
export function isAllowedInspectionCommand(command: string): boolean {
    if (command.includes("`") || command.includes("$(")) return false;
    try {
        const segments: string[][] = [[]];
        for (const token of parseShell(command)) {
            if (typeof token === "string") {
                segments.at(-1)!.push(token);
                continue;
            }
            if ("op" in token && token.op === "glob") {
                segments.at(-1)!.push(token.pattern);
                continue;
            }
            if (!("op" in token) || !CHAIN_OPERATORS.has(token.op)) return false;
            segments.push([]);
        }
        return segments.every(isAllowedSegment);
    } catch {
        return false;
    }
}
