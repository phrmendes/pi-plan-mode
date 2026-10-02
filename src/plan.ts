import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { normalizePlanModeData, type PlanModeData, type PlanProposal, type PlanState } from "./state.ts";

interface PhaseConfig {
    controls: string[];
    commands: Array<{ value: string; label: string }>;
}

interface PlanToolResult {
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
}

interface PlanControllerDeps {
    getActiveTools(): string[];
    setActiveTools(tools: string[]): void;
    persist(data: PlanModeData): void;
    sendUserMessage(message: string): void;
    appendDisplay(type: string, data: unknown): void;
    loadPrompt(phase: PlanState): string | null;
}

interface PlanController {
    baseTools(): string[];
    blockReason(toolName: string): string | undefined;
    start(ctx: ExtensionContext, data?: PlanModeData): void;
    propose(proposal: PlanProposal, ctx: ExtensionContext): Promise<PlanToolResult>;
    ask(
        questions: { questions: Array<{ question: string; options: string[] }> },
        ctx: ExtensionContext,
    ): Promise<PlanToolResult>;
    complete(ctx: ExtensionContext): Promise<PlanToolResult>;
    command(args: string | undefined, ctx: ExtensionContext): Promise<void>;
    completions(prefix: string): Array<{ value: string; label: string }> | null;
    handleInput(source: string | undefined, ctx: ExtensionContext): void;
    beforeAgentStart(systemPrompt: string, ctx: ExtensionContext): { systemPrompt: string } | undefined;
    onToolExecutionStart(toolCallId: string, toolName: string): void;
    onToolExecutionEnd(toolCallId: string): void;
    onAgentSettled(): void;
    onShutdown(): void;
}

export const PLAN_TOOLS = {
    propose: "plan_propose",
    complete: "plan_complete",
    ask: "plan_ask",
} as const;

const CONTROL_TOOLS = new Set<string>(Object.values(PLAN_TOOLS));
const BRAINSTORMING_TOOLS = ["read", "grep", "ls", "find"];
const BRAINSTORMING_MCP_PREFIX = "mcp__agent_browser__";
const PLACEHOLDER_VALUE = /^(?:tbd|todo|n\/a|na|none|unknown|as needed|etc\.?)$/i;
const ASK_OTHER_OPTION = "Other (type your own)";
const REVIEW_APPROVE = "Approve and implement";
const REVIEW_REVISE = "Request revision";
const REVIEW_DEFER = "Keep for later";

export const PLAN_ASK_SCHEMA = Type.Object({
    questions: Type.Array(
        Type.Object({
            question: Type.String({ minLength: 1 }),
            options: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        }),
        { minItems: 1 },
    ),
});

const PHASES: Record<PlanState, PhaseConfig> = {
    off: { controls: [], commands: [] },
    brainstorming: {
        controls: [PLAN_TOOLS.propose, PLAN_TOOLS.ask],
        commands: [
            { value: "review", label: "review — review the stored proposal" },
            { value: "disable", label: "disable — exit plan mode" },
        ],
    },
    implementing: {
        controls: [PLAN_TOOLS.complete],
        commands: [{ value: "disable", label: "disable — exit plan mode" }],
    },
};

const STATE_NOTIFY: Record<Exclude<PlanState, "off">, string> = {
    brainstorming: "plan: brainstorming — restricted tools",
    implementing: "plan: implementing — approved tools enabled",
};

/** Returns whether a tool stays active during brainstorming. */
function isBrainstormingTool(tool: string): boolean {
    return BRAINSTORMING_TOOLS.includes(tool) || tool.startsWith(BRAINSTORMING_MCP_PREFIX);
}

/** Returns a reason to block a tool call during brainstorming, or undefined to allow it. */
function brainstormingBlockReason(toolName: string): string | undefined {
    if (CONTROL_TOOLS.has(toolName) || isBrainstormingTool(toolName)) return undefined;
    return `Plan mode: the "${toolName}" tool is not available during brainstorming.`;
}

/** Builds a successful tool result with one text block. */
function textResult(text: string): PlanToolResult {
    return { content: [{ type: "text", text }], details: {} };
}

/** Renders a bullet list, or omits the section entirely when the list is empty. */
export function bulletSection(heading: string, items?: string[]): string {
    if (!items || items.length === 0) return "";
    return `\n\n## ${heading}\n${items.map((item) => `- ${item}`).join("\n")}`;
}

/** Rejects placeholder text that cannot support an informed approval. */
export function requireCompleteProposal(proposal: PlanProposal): void {
    const fields = [proposal.title, proposal.problem, proposal.outcome, proposal.approach];
    if (fields.some((value) => value.trim().length < 3)) {
        throw new Error("The proposal contains empty or overly short required text.");
    }
    if (proposal.changes.some((item) => item.path.trim().length < 2 || item.change.trim().length < 3)) {
        throw new Error("Every change must include a meaningful path and description.");
    }
    if (proposal.changes.some((item) => item.path.startsWith("/") || item.path.includes(".."))) {
        throw new Error("Change paths must be relative and must not traverse parent directories.");
    }
    const criteria = proposal.acceptanceCriteria.map((item) => item.trim().toLowerCase());
    if (criteria.some((item) => item.length < 3) || new Set(criteria).size !== criteria.length) {
        throw new Error("Acceptance criteria must be meaningful and unique.");
    }
    const texts = [
        ...fields,
        ...proposal.changes.map((item) => item.path),
        ...proposal.changes.map((item) => item.change),
        ...proposal.acceptanceCriteria,
    ];
    if (texts.some((value) => PLACEHOLDER_VALUE.test(value.trim()))) {
        throw new Error("The proposal contains placeholder content. Resolve it before proposing.");
    }
}

/** Formats the canonical engineering proposal for review and implementation. */
export function formatProposal(proposal: PlanProposal): string {
    const changes = proposal.changes.map((item) => `- \`${item.path}\` — ${item.change}`).join("\n");
    return (
        `# ${proposal.title}` +
        `\n\n## Problem\n${proposal.problem}` +
        `\n\n## Outcome\n${proposal.outcome}` +
        `\n\n## Approach\n${proposal.approach}` +
        `\n\n## Changes\n${changes}` +
        bulletSection("Acceptance Criteria", proposal.acceptanceCriteria)
    );
}

/** Creates the plan workflow controller. */
export function createPlanController(deps: PlanControllerDeps): PlanController {
    let data: PlanModeData = normalizePlanModeData(undefined, []);
    const promptFailures = new Set<PlanState>();
    const activeImplementationTools = new Set<string>();
    let hasNudgedForProposal = false;

    /** Persists the current plan state. */
    function persistState(): void {
        deps.persist(data);
    }

    /** Updates the plan status indicator. */
    function setPlanStatus(ctx: ExtensionContext): void {
        if (data.phase === "off") {
            ctx.ui.setStatus("plan", undefined);
            return;
        }
        const state = data.waitingForUserFeedback ? "waiting for feedback" : data.phase;
        ctx.ui.setStatus("plan", `plan: ${state}`);
    }

    /** Returns the active tools for a plan phase. */
    function toolsFor(phase: Exclude<PlanState, "off">): string[] {
        if (phase === "brainstorming") {
            const mcpTools = data.savedTools.filter((tool) => tool.startsWith(BRAINSTORMING_MCP_PREFIX));
            return [...new Set([...BRAINSTORMING_TOOLS, ...mcpTools, ...PHASES[phase].controls])];
        }
        return [...new Set([...data.savedTools, ...PHASES[phase].controls])];
    }

    /** Changes phase and applies its tool permissions. */
    function transition(ctx: ExtensionContext, next: PlanState): void {
        if (data.phase === next) return;
        if (data.phase === "off" && next !== "off") data.savedTools = baseTools();
        if (next === "implementing") hasNudgedForProposal = false;
        data.phase = next;
        if (next !== "brainstorming") data.waitingForUserFeedback = undefined;
        if (next === "off") {
            data.proposal = undefined;
            data.savedTools = restoreTools();
            deps.setActiveTools(data.savedTools);
        } else {
            deps.setActiveTools(toolsFor(next));
        }
        setPlanStatus(ctx);
        ctx.ui.notify(next === "off" ? "Plan mode disabled." : STATE_NOTIFY[next]);
        persistState();
    }

    /** Throws when an operation is used in the wrong phase. */
    function requirePhase(expected: PlanState): void {
        if (data.phase !== expected) throw new Error(`This action is available only in ${expected} mode.`);
    }

    /** Returns whether implementation tools are still running. */
    function hasToolsInFlight(): boolean {
        return activeImplementationTools.size > 0;
    }

    /** Returns saved tools without plan-managed tools. */
    function baseTools(): string[] {
        return deps.getActiveTools().filter((tool) => !CONTROL_TOOLS.has(tool));
    }

    /** Returns the saved tools plus any tools that became active after plan mode started. */
    function restoreTools(): string[] {
        const late = baseTools().filter((tool) => !BRAINSTORMING_TOOLS.includes(tool));
        return [...new Set([...data.savedTools, ...late])];
    }

    /** Asks a choice question and supports a custom answer. */
    async function askQuestion(
        ctx: ExtensionContext,
        question: string,
        options: string[],
    ): Promise<{ question: string; answer: string }> {
        const choice = await ctx.ui.select(question, [...options, ASK_OTHER_OPTION]);
        if (choice !== undefined && choice !== ASK_OTHER_OPTION) return { question, answer: choice };
        const custom = await ctx.ui.input("Your answer:");
        return {
            question,
            answer: custom && custom.trim().length > 0 ? custom.trim() : "No answer provided",
        };
    }

    /** Displays a proposal and handles the review decision. */
    async function reviewProposal(ctx: ExtensionContext): Promise<PlanToolResult> {
        if (!data.proposal) throw new Error("No stored proposal is available.");
        const markdown = formatProposal(data.proposal);
        if (!ctx.hasUI) {
            return textResult(`Proposal stored. Approval requires a UI session.\n\n${markdown}`);
        }
        deps.appendDisplay("plan-proposal", { markdown });
        const choice = await ctx.ui.select("Review the proposal above", [REVIEW_APPROVE, REVIEW_REVISE, REVIEW_DEFER]);
        if (choice === REVIEW_APPROVE) {
            transition(ctx, "implementing");
            return textResult("Proposal approved. Begin implementation.");
        }
        if (choice === REVIEW_REVISE) {
            data.proposal = undefined;
            data.waitingForUserFeedback = true;
            setPlanStatus(ctx);
            persistState();
            return textResult(
                "Proposal rejected. Plan mode is waiting for your feedback. Describe the required changes before the agent asks questions or submits another proposal.",
            );
        }
        return textResult("Proposal stored for later review.");
    }

    const controller: PlanController = {
        baseTools,
        blockReason: (toolName) => (data.phase === "brainstorming" ? brainstormingBlockReason(toolName) : undefined),
        start(ctx, initial) {
            promptFailures.clear();
            activeImplementationTools.clear();
            hasNudgedForProposal = false;
            if (!initial) {
                data = normalizePlanModeData(undefined, baseTools());
                data.savedTools = baseTools();
                transition(ctx, "brainstorming");
                return;
            }
            data = initial;
            if (data.phase !== "off") deps.setActiveTools(toolsFor(data.phase));
            setPlanStatus(ctx);
        },
        async propose(proposal, ctx) {
            requirePhase("brainstorming");
            if (data.waitingForUserFeedback) {
                throw new Error("Wait for the user to provide revision feedback first.");
            }
            requireCompleteProposal(proposal);
            data.proposal = proposal;
            persistState();
            return reviewProposal(ctx);
        },
        async ask(questions, ctx) {
            requirePhase("brainstorming");
            if (data.waitingForUserFeedback) {
                throw new Error("Wait for the user to provide revision feedback first.");
            }
            if (!ctx.hasUI) {
                return textResult("Clarifying questions require a UI session; none is available.");
            }
            const answers: Array<{ question: string; answer: string }> = [];
            for (const item of questions.questions) answers.push(await askQuestion(ctx, item.question, item.options));
            const text = answers.map((entry) => `Q: ${entry.question}\nA: ${entry.answer}`).join("\n\n");
            return textResult(text);
        },
        async complete(ctx) {
            requirePhase("implementing");
            if (hasToolsInFlight()) {
                throw new Error("plan_complete must run after all implementation tools finish.");
            }
            transition(ctx, "off");
            return textResult("Implementation complete. Plan mode disabled.");
        },
        async command(args, ctx) {
            const command = args?.trim();
            if (!command) {
                if (data.phase === "off") transition(ctx, "brainstorming");
                else ctx.ui.notify(`Already in plan mode (${data.phase}).`);
                return;
            }
            if (command === "review") {
                if (data.phase !== "brainstorming" || !data.proposal) {
                    ctx.ui.notify("No stored proposal is available for review.", "warning");
                    return;
                }
                await reviewProposal(ctx);
                return;
            }
            if (command === "disable") {
                if (data.phase === "off") {
                    ctx.ui.notify("Plan mode is already disabled.", "warning");
                    return;
                }
                if (hasToolsInFlight()) {
                    ctx.ui.notify("Plan mode: wait for implementation tools to finish before disabling.", "warning");
                    return;
                }
                transition(ctx, "off");
                return;
            }
            ctx.ui.notify(`Unknown subcommand: ${args}`, "warning");
        },
        completions(prefix) {
            const matches = PHASES[data.phase].commands.filter((item) => item.value.startsWith(prefix));
            return matches.length > 0 ? matches : null;
        },
        handleInput(source, ctx) {
            if (data.waitingForUserFeedback && source !== "extension") {
                data.waitingForUserFeedback = undefined;
                setPlanStatus(ctx);
                persistState();
            }
        },
        beforeAgentStart(systemPrompt, ctx) {
            if (data.phase === "off") return undefined;
            const base = deps.loadPrompt(data.phase);
            if (!base) {
                if (!promptFailures.has(data.phase)) {
                    promptFailures.add(data.phase);
                    ctx.ui.notify(`Plan mode prompt is missing for phase: ${data.phase}`, "error");
                }
                return undefined;
            }
            const contract =
                data.phase === "implementing" && data.proposal ? `${base}\n\n${formatProposal(data.proposal)}` : base;
            return { systemPrompt: `${systemPrompt}\n\n${contract}` };
        },
        onToolExecutionStart(toolCallId, toolName) {
            if (data.phase === "implementing" && !CONTROL_TOOLS.has(toolName)) {
                activeImplementationTools.add(toolCallId);
            }
        },
        onToolExecutionEnd(toolCallId) {
            activeImplementationTools.delete(toolCallId);
        },
        onAgentSettled() {
            if (data.phase !== "implementing" || !data.proposal) return;
            if (hasToolsInFlight() || hasNudgedForProposal) return;
            hasNudgedForProposal = true;
            deps.sendUserMessage(
                "If every acceptance criterion is verified, call plan_complete now. If not, continue implementing.",
            );
        },
        onShutdown() {
            activeImplementationTools.clear();
            if (data.phase !== "off") {
                data.savedTools = restoreTools();
                deps.setActiveTools(data.savedTools);
            }
        },
    };

    return controller;
}
