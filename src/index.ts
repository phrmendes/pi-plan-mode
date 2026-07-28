import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseShell } from "shell-quote";
import { marked } from "marked";

const WRITE_TOOLS = new Set(["edit", "write"]);

const SAFE_TOOLS = new Set([
    "agent-browser",
    "bat",
    "cat",
    "cd",
    "curl",
    "date",
    "df",
    "diff",
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
    "jira",
    "jq",
    "less",
    "ls",
    "more",
    "ps",
    "pwd",
    "readlink",
    "rg",
    "sort",
    "stat",
    "tail",
    "tree",
    "true",
    "type",
    "uname",
    "uniq",
    "wc",
    "which",
    "whoami",
    "xargs",
]);

const SAFE_SUBCOMMANDS: Record<string, string[]> = {
    git: ["status", "log", "diff", "show", "branch", "remote", "ls-files", "ls-tree"],
    kubectl: [
        "get",
        "describe",
        "logs",
        "top",
        "explain",
        "version",
        "cluster-info",
        "api-resources",
        "api-versions",
        "events",
        "auth",
        "config",
        "diff",
        "rollout",
    ],
    gh: [
        "issue",
        "pr",
        "repo",
        "run",
        "search",
        "status",
        "auth",
        "browse",
        "label",
        "milestone",
        "project",
        "release",
        "gist",
        "codespace",
        "workflow",
        "extension",
    ],
    gcloud: ["version", "info", "config", "list", "describe"],
    nix: ["eval", "search", "show-config", "path-info", "why-depends", "log", "flake", "repl"],
    systemctl: [
        "status",
        "list-units",
        "list-automounts",
        "list-paths",
        "list-sockets",
        "list-timers",
        "is-active",
        "is-failed",
        "show",
        "cat",
        "list-dependencies",
        "is-enabled",
        "is-system-running",
    ],
};

const PLAN_SUBCOMMANDS = [
    { value: "create", label: "create — ask the agent to draft the formal plan" },
    { value: "disable", label: "disable — exit plan mode" },
];

const CHAIN_OPS = new Set(["|", "||", "&&", ";"]);
const BLOCK_OPS = new Set(["&", "<&", "<(", ">", ">>"]);

const DIALOG_OPTIONS = ["Implement now", "Back to brainstorming"] as const;

interface PlanStep {
    step: number;
    text: string;
}

type PlanState = "off" | "brainstorming" | "planning" | "implementing";

const PLAN_STATES = new Set(["off", "brainstorming", "planning", "implementing"]);
const READ_ONLY_STATES: ReadonlySet<string> = new Set(["brainstorming", "planning"]);

const STATE_NOTIFY: Record<Exclude<PlanState, "off">, string> = {
    brainstorming: "plan: brainstorming — read-only, exploring",
    planning: "plan: planning — drafting PRD",
    implementing: "plan: implementing — write tools enabled",
};

/**
 * Plan mode extension for pi coding agent.
 *
 * States: off → brainstorming (read-only) → planning (read-only, drafting
 * PRD) → implementing (write tools) → auto-return to brainstorming.
 * Ctrl+Alt+P cycles; the agent asks before transitioning to planning.
 */
export default function planMode(pi: ExtensionAPI): void {
    let state: PlanState = "off";
    let creating = false;
    let steps: PlanStep[] = [];
    let savedTools: string[] | undefined;
    let skillContent: string | null = null;

    const isReadOnly = (): boolean => READ_ONLY_STATES.has(state);

    /** Writes current plan-mode state to the session entry. */
    function persistState(): void {
        pi.appendEntry("plan-mode", { state, creating, steps });
    }

    function setPlanStatus(ctx: ExtensionContext): void {
        ctx.ui.setStatus("plan", state === "off" ? undefined : `plan: ${state}`);
    }

    /**
     * Central state transition. Snapshots and filters tools when crossing
     * into a read-only state, restores them when leaving it. Steps are kept
     * across the implementing → brainstorming auto-return so work can resume;
     * they are only cleared on off.
     */
    function transition(ctx: ExtensionContext, next: PlanState, message?: string): void {
        if (state === next) return;
        const willReadOnly = READ_ONLY_STATES.has(next);
        if (isReadOnly() !== willReadOnly) {
            if (willReadOnly) {
                savedTools = pi.getActiveTools();
                pi.setActiveTools(savedTools.filter((t) => !WRITE_TOOLS.has(t)));
            } else {
                pi.setActiveTools(savedTools ?? pi.getActiveTools());
                savedTools = undefined;
            }
        }
        state = next;
        if (next === "off") {
            steps = [];
            creating = false;
        }
        setPlanStatus(ctx);
        ctx.ui.notify(message ?? (next === "off" ? "Plan mode disabled." : STATE_NOTIFY[next]));
        persistState();
    }

    /** Accepts the proposed plan and tells the agent to implement it. */
    function accept(ctx: ExtensionContext): void {
        transition(ctx, "implementing");
        pi.sendUserMessage("The plan is accepted. Begin implementation now.", { deliverAs: "followUp" });
    }

    /**
     * Returns true if the first word is a known safe tool or a known
     * subcommand of a restricted tool (e.g. `git status`).
     */
    function isCommandSafe(words: string[]): boolean {
        const [cmd, sub] = words;
        if (!cmd) return false;
        if (SAFE_TOOLS.has(cmd)) return true;
        const allowed = SAFE_SUBCOMMANDS[cmd];
        return allowed != null && sub != null && allowed.includes(sub);
    }

    /**
     * Returns true if every segment of a shell command is safe.
     * Blocks backticks and {@link BLOCK_OPS}. Splits on {@link CHAIN_OPS}
     * and checks each segment independently.
     */
    function isSafe(command: string): boolean {
        if (command.includes("`")) return false;
        const tokens = parseShell(command);
        const segments: string[][] = [[]];
        for (let i = 0; i < tokens.length; i++) {
            const tok = tokens[i];
            if (typeof tok === "string") {
                segments[segments.length - 1].push(tok);
            } else if ("op" in tok) {
                if (tok.op === ">&" && i + 1 < tokens.length) {
                    const next = tokens[i + 1];
                    if (typeof next === "string" && /^\d+$/.test(next)) continue;
                    return false;
                }
                if (BLOCK_OPS.has(tok.op)) return false;
                if (CHAIN_OPS.has(tok.op)) segments.push([]);
            }
        }
        return segments.every(isCommandSafe);
    }

    /**
     * Extracts the title from a markdown list item.
     * Handles `**Title** — description`, falls back to text before ` —`.
     */
    function extractBoldTitle(text: string): string | null {
        if (text.startsWith("**")) {
            const close = text.indexOf("**", 2);
            if (close > 2) return text.slice(2, close).trim();
        }
        const fallback = text.split(" —")[0].trim();
        return fallback.length > 0 ? fallback : null;
    }

    /**
     * Parses a markdown message for an ordered list under a `## Steps` heading.
     * Returns an array of {@link PlanStep} with incrementing step numbers.
     */
    function extractPlanSteps(message: string): PlanStep[] {
        const tokens = marked.lexer(message);
        const items: PlanStep[] = [];
        let inSteps = false;

        for (const tok of tokens) {
            if (tok.type === "heading" && tok.depth <= 3 && tok.text.trim().toLowerCase() === "steps") {
                inSteps = true;
                continue;
            }
            if (inSteps && tok.type === "heading") break;
            if (!inSteps || tok.type !== "list" || !tok.ordered) continue;

            for (const item of tok.items) {
                const title = extractBoldTitle(item.text);
                if (title && title.length > 3) items.push({ step: items.length + 1, text: title });
            }
            break;
        }
        return items;
    }

    /**
     * Loads the plan mode SKILL.md: preferring the copy bundled with this
     * package, falling back to a user copy in the agent home.
     * Returns null if neither exists or cannot be read.
     */
    function loadSkillContent(): string | null {
        const candidates: (URL | string)[] = [new URL("../skills/plan/SKILL.md", import.meta.url)];
        if (process.env.HOME) {
            candidates.push(join(process.env.HOME, ".pi", "agent", "skills", "plan", "SKILL.md"));
        }
        for (const candidate of candidates) {
            try {
                return readFileSync(candidate, "utf8");
            } catch {
                /* try the next candidate */
            }
        }
        return null;
    }

    const subcommandHandlers: Record<string, (ctx: ExtensionContext) => void> = {
        create(ctx) {
            if (state === "off") {
                ctx.ui.notify("Not in plan mode.", "warning");
                return;
            }
            if (!isReadOnly()) {
                ctx.ui.notify("Finish implementing or cycle back to brainstorming first.", "warning");
                return;
            }
            creating = true;
            transition(ctx, "planning");
            pi.sendUserMessage("Produce the formal PRD now.", { deliverAs: "followUp" });
            persistState();
        },
        disable: (ctx) => {
            if (state === "off") {
                ctx.ui.notify("Not in plan mode.", "warning");
                return;
            }
            transition(ctx, "off");
        },
    };

    pi.registerCommand("plan", {
        description: "Plan mode: enter brainstorming, or run a subcommand (create / disable)",
        getArgumentCompletions: (prefix: string) => {
            const matches = PLAN_SUBCOMMANDS.filter((s) => s.value.startsWith(prefix));
            return matches.length > 0 ? matches : null;
        },
        handler: async (args, ctx) => {
            if (!args?.trim()) {
                if (state === "off") transition(ctx, "brainstorming");
                else ctx.ui.notify(`Already in plan mode (${state}).`);
                return;
            }
            const handler = subcommandHandlers[args.trim()];
            if (!handler) {
                ctx.ui.notify(`Unknown subcommand: ${args}`, "warning");
                return;
            }
            handler(ctx);
        },
    });

    pi.registerShortcut(Key.ctrlAlt("p"), {
        description: "Cycle plan mode",
        handler: (ctx) => {
            switch (state) {
                case "off":
                    transition(ctx, "brainstorming");
                    break;
                case "brainstorming":
                    if (steps.length === 0) {
                        ctx.ui.notify("No plan proposed yet — run /plan create.", "warning");
                        return;
                    }
                    transition(ctx, "planning");
                    break;
                case "planning":
                    accept(ctx);
                    break;
                case "implementing":
                    transition(ctx, "brainstorming");
                    break;
            }
        },
    });

    pi.on("tool_call", (event) => {
        if (!isReadOnly() || event.toolName !== "bash") return;
        const command = event.input.command;
        if (typeof command !== "string" || !isSafe(command)) {
            return {
                block: true,
                reason: `Plan mode: blocked — not a read-only command.\n${command}`,
            };
        }
    });

    pi.on("before_agent_start", () => {
        if (!isReadOnly()) return;
        const content = skillContent ?? loadSkillContent();
        if (!content) return;
        skillContent = content;
        return { message: { customType: "plan-context", content, display: false } };
    });

    /** Extracts the concatenated text from the last assistant message. */
    function lastAssistantText(
        messages: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>,
    ): string {
        const last = messages.findLast((m) => m.role === "assistant" && Array.isArray(m.content));
        if (!last?.content) return "";
        return last.content
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("\n");
    }

    pi.on("agent_end", async (event, ctx) => {
        if (state === "off" || !ctx.hasUI) return;

        if (!creating) {
            if (state === "brainstorming") {
                const text = lastAssistantText(
                    event.messages as Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>,
                );
                if (text.includes("[PLAN_READY]")) {
                    const answer = await ctx.ui.select("Move to planning?", ["Yes", "Not yet"]);
                    if (answer === "Yes") {
                        creating = true;
                        transition(ctx, "planning");
                        pi.sendUserMessage("Produce the formal PRD now.", { deliverAs: "followUp" });
                        persistState();
                    }
                }
            }
            if (state === "implementing")
                transition(ctx, "brainstorming", "Back to brainstorming — Ctrl+Alt+P ×2 resumes implementing.");
            return;
        }

        creating = false;
        const text = lastAssistantText(
            event.messages as Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>,
        );
        if (!text) {
            persistState();
            return;
        }
        const extracted = extractPlanSteps(text);
        if (extracted.length === 0) {
            ctx.ui.notify("No plan steps found — try /plan create again.", "warning");
            persistState();
            return;
        }

        steps = extracted;
        persistState();
        transition(ctx, "planning");
        const choice = await ctx.ui.select("Plan proposed — accept?", [...DIALOG_OPTIONS]);
        if (choice === "Implement now") accept(ctx);
        else if (choice === "Back to brainstorming") transition(ctx, "brainstorming");
        else ctx.ui.notify("Still in planning — Ctrl+Alt+P to accept, /plan disable to exit.");
    });

    pi.on("session_start", (_event, ctx) => {
        const entries = ctx.sessionManager.getEntries() as Array<{ type: string; customType?: string; data?: unknown }>;
        const planEntry = entries.filter((e) => e.type === "custom" && e.customType === "plan-mode").pop() as
            { data?: { state?: PlanState; enabled?: boolean; creating?: boolean; steps?: PlanStep[] } } | undefined;

        if (!planEntry?.data) {
            transition(ctx, "brainstorming");
            return;
        }

        const data = planEntry.data;
        state =
            data.state && PLAN_STATES.has(data.state)
                ? data.state
                : data.enabled
                  ? data.steps?.length
                      ? "planning"
                      : "brainstorming"
                  : "off";
        creating = data.creating ?? false;
        steps = data.steps ?? [];

        if (isReadOnly()) {
            savedTools = pi.getActiveTools();
            pi.setActiveTools(savedTools.filter((t) => !WRITE_TOOLS.has(t)));
        }
        setPlanStatus(ctx);
    });
}
