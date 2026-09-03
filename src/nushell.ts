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

const BLOCKED_TOKENS = new Set([
    "--exec",
    "--exec-batch",
    "--execdir",
    "--ext-diff",
    "--interactive",
    "--output",
    "--output=result",
    "--pre",
    "--rewrite",
    "--rewrite=",
    "-delete",
    "-exec",
    "-execdir",
    "-X",
    "-x",
    "apply",
    "config",
    "cp",
    "create",
    "delete",
    "deploy",
    "destroy",
    "edit",
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
    "save",
    "scale",
    "set",
    "source",
    "touch",
    "update",
    "use",
    "overlay",
    "bash",
    "node",
    "perl",
    "python",
    "python3",
    "ruby",
]);

/** Extracts quoted and unquoted tokens without interpreting Nushell syntax. */
function words(command: string): string[] {
    return command.match(/(?:[^\s"']+|"(?:\\.|[^"\\])*"|'[^']*')+/g) ?? [];
}

/** Returns whether direct Nushell source contains a blocked planning token. */
export function isAllowedPlanningCommand(command: string): boolean {
    return !words(command).some(
        (token) => BLOCKED_TOKENS.has(token) || token.startsWith("--output=") || token.startsWith("--rewrite="),
    );
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
