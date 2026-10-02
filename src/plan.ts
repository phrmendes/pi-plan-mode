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
    getAllowedTools(): string[];
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
    resume(ctx: ExtensionContext, data: PlanModeData): void;
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
const DISCOVERY_TOOLS = ["read", "grep", "ls", "find"];
const PLACEHOLDER_VALUE = /^(?:tbd|todo|n\/a|na|none|unknown|as needed|etc\.?)$/i;
const ASK_OTHER_OPTION = "Other (type your own)";
const REVIEW_ACCEPT = "Accept and implement";
const REVIEW_REJECT = "Reject";
const REVIEW_DEFER = "Ask for review";

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
    implementing: "plan: implementing — accepted tools enabled",
};

/** Returns whether the configured allowlist names a tool, matching exact names and `*` suffixes. */
function matchesAllowedTool(toolName: string, entries: string[]): boolean {
    return entries.some((entry) => {
        if (!entry.endsWith("*")) return toolName === entry;
        const prefix = entry.slice(0, -1);
        return prefix.length > 0 && toolName.startsWith(prefix);
    });
}

/** Builds a successful tool result with one text block. */
function textResult(text: string): PlanToolResult {
    return { content: [{ type: "text", text }], details: {} };
}

/** Rejects placeholder text that cannot support an informed decision. */
export function requireCompleteProposal(proposal: PlanProposal): void {
    if (proposal.description.trim().length < 3) {
        throw new Error("The proposal description is empty or overly short.");
    }
    if (proposal.changes.some((item) => item.path.trim().length < 2 || item.change.trim().length < 3)) {
        throw new Error("Every change must include a meaningful path and description.");
    }
    const tests = proposal.tests ?? [];
    if (tests.some((item) => item.path.trim().length < 2 || item.test.trim().length < 3)) {
        throw new Error("Every test must include a meaningful path and behavior.");
    }
    const texts = [
        proposal.description,
        ...proposal.changes.flatMap((item) => [item.path, item.change, ...(item.example ? [item.example] : [])]),
        ...tests.flatMap((item) => [item.path, item.test, ...(item.example ? [item.example] : [])]),
    ];
    if (texts.some((value) => PLACEHOLDER_VALUE.test(value.trim()))) {
        throw new Error("The proposal contains placeholder content. Resolve it before proposing.");
    }
}

/** Renders one change or test entry as a titled block with an optional example. */
function formatEntry(path: string, body: string, example?: string): string {
    const renderedExample = example ? `\n\nExample:\n\n\`\`\`\n${example}\n\`\`\`` : "";
    return `### \`${path}\`\n${body}${renderedExample}`;
}

/** Formats the proposal for review and implementation. */
export function formatProposal(proposal: PlanProposal): string {
    const changes = proposal.changes.map((item) => formatEntry(item.path, item.change, item.example)).join("\n\n");
    const tests = proposal.tests?.length
        ? `\n\n## Tests\n\n${proposal.tests.map((item) => formatEntry(item.path, item.test, item.example)).join("\n\n")}`
        : "";
    return `## Description\n${proposal.description}\n\n## Changes\n\n${changes}${tests}`;
}

/** Creates the plan workflow controller. */
export function createPlanController(deps: PlanControllerDeps): PlanController {
    let data: PlanModeData = normalizePlanModeData(undefined, []);
    const promptFailures = new Set<PlanState>();
    const activeImplementationTools = new Set<string>();
    let planAdded = new Set<string>();
    let hasNudgedForProposal = false;

    /** Persists the current plan state. */
    function persistState(): void {
        deps.persist(structuredClone(data));
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

    /** Returns the tools plan mode activates for a phase. */
    function toolsFor(phase: Exclude<PlanState, "off">): string[] {
        if (phase === "brainstorming") {
            const allowed = data.savedTools.filter((tool) => matchesAllowedTool(tool, deps.getAllowedTools()));
            return [...new Set([...DISCOVERY_TOOLS, ...allowed, ...PHASES[phase].controls])];
        }
        return [...new Set([...data.savedTools, ...PHASES[phase].controls])];
    }

    /** Activates a phase's tools and records which of them plan mode added. */
    function applyTools(phase: Exclude<PlanState, "off">): void {
        const tools = toolsFor(phase);
        planAdded = new Set(tools.filter((tool) => !data.savedTools.includes(tool)));
        deps.setActiveTools(tools);
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
            applyTools(next);
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

    /** Returns saved tools plus tools that entered the session after plan mode started. */
    function restoreTools(): string[] {
        const late = baseTools().filter((tool) => !planAdded.has(tool));
        return [...new Set([...data.savedTools, ...late])];
    }

    /** Returns a reason to block a tool call during brainstorming, or undefined to allow it. */
    function brainstormingBlockReason(toolName: string): string | undefined {
        if (
            CONTROL_TOOLS.has(toolName) ||
            DISCOVERY_TOOLS.includes(toolName) ||
            matchesAllowedTool(toolName, deps.getAllowedTools())
        ) {
            return undefined;
        }
        return `Plan mode: the "${toolName}" tool is not available during brainstorming.`;
    }

    /** Returns whether two tool lists contain the same names. */
    function sameTools(left: string[], right: string[]): boolean {
        return left.length === right.length && left.every((tool) => right.includes(tool));
    }

    /** Adopts tools that connected after plan mode started and re-applies the phase's tool set. */
    function syncTools(phase: Exclude<PlanState, "off">): void {
        const late = baseTools().filter((tool) => !data.savedTools.includes(tool) && !planAdded.has(tool));
        if (late.length > 0) {
            data.savedTools = [...data.savedTools, ...late];
            persistState();
        }
        if (!sameTools(toolsFor(phase), deps.getActiveTools())) applyTools(phase);
    }

    /** Removes plan control tools that registration activated while plan mode is off. */
    function dropStrayControlTools(): void {
        if (deps.getActiveTools().some((tool) => CONTROL_TOOLS.has(tool))) deps.setActiveTools(baseTools());
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
            return textResult(`Proposal stored. Acceptance requires a UI session.\n\n${markdown}`);
        }
        deps.appendDisplay("plan-proposal", { markdown });
        const choice = await ctx.ui.select("Review the proposal above", [REVIEW_ACCEPT, REVIEW_REJECT, REVIEW_DEFER]);
        if (choice === REVIEW_ACCEPT) {
            transition(ctx, "implementing");
            return textResult("Proposal accepted. Begin implementation.");
        }
        if (choice === REVIEW_REJECT) {
            data.proposal = undefined;
            data.waitingForUserFeedback = true;
            setPlanStatus(ctx);
            persistState();
            return textResult(
                "Proposal rejected. Plan mode is waiting for your feedback. Describe the required changes before the agent asks questions or submits another proposal.",
            );
        }
        return textResult("Proposal kept for review. Run /plan review to open it again.");
    }

    const controller: PlanController = {
        baseTools,
        blockReason: (toolName) => (data.phase === "brainstorming" ? brainstormingBlockReason(toolName) : undefined),
        start(ctx, initial) {
            promptFailures.clear();
            activeImplementationTools.clear();
            planAdded = new Set();
            hasNudgedForProposal = false;
            if (!initial) {
                data = normalizePlanModeData(undefined, baseTools());
                data.savedTools = baseTools();
                transition(ctx, "brainstorming");
                return;
            }
            data = initial;
            if (data.phase === "off") dropStrayControlTools();
            else applyTools(data.phase);
            setPlanStatus(ctx);
        },
        resume(ctx, next) {
            const previous = data.phase;
            const sessionTools = previous === "off" ? baseTools() : restoreTools();
            activeImplementationTools.clear();
            hasNudgedForProposal = false;
            data = { ...next, savedTools: sessionTools };
            if (data.phase === "off") {
                planAdded = new Set();
                if (previous !== "off") deps.setActiveTools(sessionTools);
            } else {
                applyTools(data.phase);
            }
            setPlanStatus(ctx);
        },
        async propose(proposal, ctx) {
            requirePhase("brainstorming");
            if (data.waitingForUserFeedback) {
                throw new Error("Wait for the user to provide feedback first.");
            }
            requireCompleteProposal(proposal);
            data.proposal = proposal;
            persistState();
            return reviewProposal(ctx);
        },
        async ask(questions, ctx) {
            requirePhase("brainstorming");
            if (data.waitingForUserFeedback) {
                throw new Error("Wait for the user to provide feedback first.");
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
            if (data.phase === "off") {
                dropStrayControlTools();
                return undefined;
            }
            syncTools(data.phase);
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
                "If every change in the proposal is done and verified, call plan_complete now. If not, continue implementing.",
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
