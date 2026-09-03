import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { normalizePlanModeData, type PlanModeData, type PlanProposal, type PlanState } from "./state.ts";

export const CONTROL_TOOLS = new Set(["nushell", "plan_propose", "plan_complete", "plan_ask"]);
const BRAINSTORMING_TOOLS = new Set(["read"]);
const NON_PLAN_SHELL_TOOLS = new Set(["bash"]);
const ASK_OTHER_OPTION = "Other (type your own)";

export const PLAN_ASK_SCHEMA = Type.Object({
    questions: Type.Array(
        Type.Object({
            question: Type.String({ minLength: 1 }),
            options: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        }),
        { minItems: 1 },
    ),
});

interface PhaseConfig {
    controls: string[];
    commands: Array<{ value: string; label: string }>;
}

const PHASES: Record<PlanState, PhaseConfig> = {
    off: { controls: [], commands: [] },
    brainstorming: {
        controls: ["plan_propose", "plan_ask"],
        commands: [
            { value: "review", label: "review — review the stored proposal" },
            { value: "disable", label: "disable — exit plan mode" },
        ],
    },
    implementing: {
        controls: ["plan_complete"],
        commands: [{ value: "disable", label: "disable — exit plan mode" }],
    },
};

const STATE_NOTIFY: Record<Exclude<PlanState, "off">, string> = {
    brainstorming: "plan: brainstorming — read-only, exploring",
    implementing: "plan: implementing — approved tools enabled",
};

export interface PlanToolResult {
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
}

export interface PlanControllerDeps {
    getActiveTools(): string[];
    setActiveTools(tools: string[]): void;
    persist(data: PlanModeData): void;
    sendUserMessage(message: string): void;
    appendDisplay(type: string, data: unknown): void;
    loadPrompt(phase: PlanState): string | null;
}

export interface PlanController {
    readonly phase: PlanState;
    baseTools(): string[];
    isRestricted(): boolean;
    toolsFor(phase: Exclude<PlanState, "off">): string[];
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
    const content = JSON.stringify(proposal);
    if (/\b(?:tbd|todo|etc\.?|as needed|unknown)\b/i.test(content)) {
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
            return [
                ...new Set([
                    ...data.savedTools.filter((tool) => BRAINSTORMING_TOOLS.has(tool)),
                    "nushell",
                    ...PHASES[phase].controls,
                ]),
            ];
        }
        return [
            ...new Set([
                ...data.savedTools.filter((tool) => !NON_PLAN_SHELL_TOOLS.has(tool)),
                "nushell",
                ...PHASES[phase].controls,
            ]),
        ];
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
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Proposal stored. Approval requires a UI session.\n\n${markdown}`,
                    },
                ],
                details: {},
            };
        }
        deps.appendDisplay("plan-proposal", { markdown });
        const choice = await ctx.ui.select("Review the proposal above", [
            "Approve and implement",
            "Request revision",
            "Keep for later",
        ]);
        if (choice === "Approve and implement") {
            transition(ctx, "implementing");
            return {
                content: [{ type: "text" as const, text: "Proposal approved. Begin implementation." }],
                details: {},
            };
        }
        if (choice === "Request revision") {
            data.proposal = undefined;
            data.waitingForUserFeedback = true;
            setPlanStatus(ctx);
            persistState();
            return {
                content: [
                    {
                        type: "text" as const,
                        text: "Proposal rejected. Plan mode is waiting for your feedback. Describe the required changes before the agent asks questions or submits another proposal.",
                    },
                ],
                details: {},
            };
        }
        return {
            content: [{ type: "text" as const, text: "Proposal stored for later review." }],
            details: {},
        };
    }

    const controller: PlanController = {
        get phase() {
            return data.phase;
        },
        baseTools,
        isRestricted: () => data.phase === "brainstorming",
        toolsFor,
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
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "Clarifying questions require a UI session; none is available.",
                        },
                    ],
                    details: {},
                };
            }
            const answers: Array<{ question: string; answer: string }> = [];
            for (const item of questions.questions) answers.push(await askQuestion(ctx, item.question, item.options));
            const text = answers.map((entry) => `Q: ${entry.question}\nA: ${entry.answer}`).join("\n\n");
            return { content: [{ type: "text" as const, text }], details: {} };
        },
        async complete(ctx) {
            requirePhase("implementing");
            if (hasToolsInFlight()) {
                throw new Error("plan_complete must run after all implementation tools finish.");
            }
            data.proposal = undefined;
            transition(ctx, "brainstorming");
            return {
                content: [{ type: "text" as const, text: "Implementation complete. Brainstorming restored." }],
                details: {},
            };
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
            if (data.phase !== "off") deps.setActiveTools(data.savedTools);
        },
    };

    return controller;
}
