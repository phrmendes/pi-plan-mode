import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { isAllowedInspectionCommand } from "./policy.ts";
import {
    normalizePlanModeData,
    PLAN_PROPOSAL_SCHEMA,
    type PlanModeData,
    type PlanProposal,
    type PlanState,
} from "./state.ts";

const CONTROL_TOOLS = new Set(["plan_propose", "plan_complete", "plan_ask"]);
const READ_ONLY_TOOLS = new Set(["read", "bash"]);
const ASK_OTHER_OPTION = "Other (type your own)";
const PLAN_ASK_SCHEMA = Type.Object({
    questions: Type.Array(
        Type.Object({
            question: Type.String({ minLength: 1 }),
            options: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        }),
        { minItems: 1 },
    ),
});
const PHASES: Record<
    PlanState,
    { readOnly: boolean; controls: string[]; commands: Array<{ value: string; label: string }> }
> = {
    off: { readOnly: false, controls: [], commands: [] },
    brainstorming: {
        readOnly: true,
        controls: ["plan_propose", "plan_ask"],
        commands: [
            { value: "review", label: "review — review the stored proposal" },
            { value: "disable", label: "disable — exit plan mode" },
        ],
    },
    implementing: {
        readOnly: false,
        controls: ["plan_complete"],
        commands: [{ value: "disable", label: "disable — exit plan mode" }],
    },
};
const STATE_NOTIFY: Record<Exclude<PlanState, "off">, string> = {
    brainstorming: "plan: brainstorming — read-only, exploring",
    implementing: "plan: implementing — approved tools enabled",
};
export interface PlanModeOptions {
    loadPrompt?: (phase: PlanState) => string | null;
}

/** Registers the agent-driven plan workflow. */
export default function planMode(pi: ExtensionAPI, options: PlanModeOptions = {}): void {
    const baseTools = (): string[] => pi.getActiveTools().filter((tool) => !CONTROL_TOOLS.has(tool));
    let data: PlanModeData = normalizePlanModeData(undefined, []);
    const promptCache = new Map<PlanState, string>();
    const promptFailures = new Set<PlanState>();
    const activeImplementationTools = new Set<string>();

    pi.registerEntryRenderer("plan-proposal", (entry) => {
        const proposal = entry.data as { markdown: string };
        return new Markdown(proposal.markdown, 0, 0, getMarkdownTheme());
    });

    /** Persists the durable workflow state. */
    function persistState(): void {
        pi.appendEntry("plan-mode", data);
    }

    /** Updates the plan status indicator. */
    function setPlanStatus(ctx: ExtensionContext): void {
        ctx.ui.setStatus("plan", data.phase === "off" ? undefined : `plan: ${data.phase}`);
    }

    /** Returns the tool set for an enabled phase. */
    function toolsFor(phase: Exclude<PlanState, "off">): string[] {
        const config = PHASES[phase];
        const tools = config.readOnly ? data.savedTools.filter((tool) => READ_ONLY_TOOLS.has(tool)) : data.savedTools;
        return [...new Set([...tools, ...config.controls])];
    }

    /** Enters a phase and applies its tool permissions. */
    function transition(ctx: ExtensionContext, next: PlanState): void {
        if (data.phase === next) return;
        if (data.phase === "off" && next !== "off") data.savedTools = baseTools();
        data.phase = next;
        if (next === "off") {
            data.proposal = undefined;
            pi.setActiveTools(data.savedTools);
        } else {
            pi.setActiveTools(toolsFor(next));
        }
        setPlanStatus(ctx);
        ctx.ui.notify(next === "off" ? "Plan mode disabled." : STATE_NOTIFY[next]);
        persistState();
    }

    /** Throws when a control tool is called outside its allowed phase. */
    function requirePhase(expected: PlanState): void {
        if (data.phase !== expected) throw new Error(`This action is available only in ${expected} mode.`);
    }

    /** Asks one clarifying question, falling back to free text for a custom answer. */
    async function askQuestion(
        ctx: ExtensionContext,
        question: string,
        options: string[],
    ): Promise<{ question: string; answer: string }> {
        const choice = await ctx.ui.select(question, [...options, ASK_OTHER_OPTION]);
        if (choice !== undefined && choice !== ASK_OTHER_OPTION) return { question, answer: choice };
        const custom = await ctx.ui.input("Your answer:");
        return { question, answer: custom && custom.trim().length > 0 ? custom.trim() : "No answer provided" };
    }

    /** Reads one bundled phase prompt. */
    function readBundledPrompt(phase: PlanState): string | null {
        try {
            return readFileSync(new URL(`../prompts/${phase}.md`, import.meta.url), "utf8");
        } catch {
            return null;
        }
    }

    /** Loads the compact prompt contract for a phase. */
    function loadPhasePrompt(phase: PlanState): string | null {
        const cached = promptCache.get(phase);
        if (cached) return cached;
        const content = (options.loadPrompt ?? readBundledPrompt)(phase);
        if (content) promptCache.set(phase, content);
        return content;
    }

    /** Renders a bullet list, or omits the section entirely when the list is empty. */
    function bulletSection(heading: string, items?: string[]): string {
        if (!items || items.length === 0) return "";
        return `\n\n## ${heading}\n${items.map((item) => `- ${item}`).join("\n")}`;
    }

    /** Rejects placeholder text that cannot support an informed approval. */
    function requireCompleteProposal(proposal: PlanProposal): void {
        const content = JSON.stringify(proposal);
        if (/\b(?:tbd|todo|etc\.?|as needed|unknown)\b/i.test(content)) {
            throw new Error("The proposal contains placeholder content. Resolve it before proposing.");
        }
    }

    /** Formats the canonical engineering proposal for review and implementation. */
    function formatProposal(proposal: PlanProposal): string {
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

    /** Shows the stored proposal and requests a user decision. */
    async function reviewProposal(ctx: ExtensionContext) {
        if (!data.proposal) throw new Error("No stored proposal is available.");
        const markdown = formatProposal(data.proposal);
        if (!ctx.hasUI) {
            return {
                content: [
                    { type: "text" as const, text: `Proposal stored. Approval requires a UI session.\n\n${markdown}` },
                ],
                details: {},
            };
        }
        pi.appendEntry("plan-proposal", { markdown });
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
            persistState();
            return {
                content: [{ type: "text" as const, text: "Proposal needs revision. Brainstorming continues." }],
                details: {},
            };
        }
        return { content: [{ type: "text" as const, text: "Proposal stored for later review." }], details: {} };
    }

    pi.registerTool({
        name: "plan_propose",
        label: "Propose Plan",
        description: "Submit one complete engineering proposal for user review and approval",
        parameters: PLAN_PROPOSAL_SCHEMA,
        async execute(_id, params, _signal, _update, ctx) {
            requirePhase("brainstorming");
            requireCompleteProposal(params);
            data.proposal = params;
            persistState();
            return reviewProposal(ctx);
        },
    });

    pi.registerTool({
        name: "plan_complete",
        label: "Complete Plan",
        description: "Complete the approved proposal after implementation and verification",
        parameters: Type.Object({}),
        async execute(_id, _params, _signal, _update, ctx) {
            requirePhase("implementing");
            if (activeImplementationTools.size > 0) {
                throw new Error("plan_complete must run after all implementation tools finish.");
            }
            data.proposal = undefined;
            transition(ctx, "brainstorming");
            return {
                content: [{ type: "text" as const, text: "Implementation complete. Brainstorming restored." }],
                details: {},
            };
        },
    });

    pi.registerTool({
        name: "plan_ask",
        label: "Ask Clarifying Questions",
        description:
            "Ask the user one or more multiple-choice clarifying questions before proposing or submitting work",
        parameters: PLAN_ASK_SCHEMA,
        async execute(_id, params, _signal, _update, ctx) {
            requirePhase("brainstorming");
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
            for (const item of params.questions) answers.push(await askQuestion(ctx, item.question, item.options));
            const text = answers.map((entry) => `Q: ${entry.question}\nA: ${entry.answer}`).join("\n\n");
            return { content: [{ type: "text" as const, text }], details: {} };
        },
    });

    const subcommands: Record<string, (ctx: ExtensionContext) => void | Promise<void>> = {
        async review(ctx) {
            if (data.phase !== "brainstorming" || !data.proposal) {
                ctx.ui.notify("No stored proposal is available for review.", "warning");
                return;
            }
            await reviewProposal(ctx);
        },
        disable(ctx) {
            if (data.phase === "off") {
                ctx.ui.notify("Plan mode is already disabled.", "warning");
                return;
            }
            if (activeImplementationTools.size > 0) {
                ctx.ui.notify("Plan mode: wait for implementation tools to finish before disabling.", "warning");
                return;
            }
            transition(ctx, "off");
        },
    };

    pi.registerCommand("plan", {
        description: "Enter plan mode or use a phase-specific fallback",
        getArgumentCompletions: (prefix: string) => {
            const matches = PHASES[data.phase].commands.filter((item) => item.value.startsWith(prefix));
            return matches.length > 0 ? matches : null;
        },
        handler: async (args, ctx) => {
            const command = args?.trim();
            if (!command) {
                if (data.phase === "off") transition(ctx, "brainstorming");
                else ctx.ui.notify(`Already in plan mode (${data.phase}).`);
                return;
            }
            const handler = subcommands[command];
            if (!handler) {
                ctx.ui.notify(`Unknown subcommand: ${args}`, "warning");
                return;
            }
            await handler(ctx);
        },
    });

    pi.on("tool_call", (event) => {
        if (data.phase !== "brainstorming" || event.toolName !== "bash") return;
        const command = event.input.command;
        if (typeof command !== "string" || !isAllowedInspectionCommand(command)) {
            return { block: true, reason: `Plan mode: blocked — not a read-only command.\n${command}` };
        }
    });

    pi.on("tool_execution_start", (event) => {
        if (data.phase === "implementing" && !CONTROL_TOOLS.has(event.toolName)) {
            activeImplementationTools.add(event.toolCallId);
        }
    });

    pi.on("tool_execution_end", (event) => {
        activeImplementationTools.delete(event.toolCallId);
    });

    pi.on("before_agent_start", (event, ctx) => {
        if (data.phase === "off") return;
        const base = loadPhasePrompt(data.phase);
        if (!base) {
            if (!promptFailures.has(data.phase)) {
                promptFailures.add(data.phase);
                ctx.ui.notify(`Plan mode prompt is missing for phase: ${data.phase}`, "error");
            }
            return;
        }
        const contract =
            data.phase === "implementing" && data.proposal ? `${base}\n\n${formatProposal(data.proposal)}` : base;
        return { systemPrompt: `${event.systemPrompt}\n\n${contract}` };
    });

    pi.on("session_shutdown", () => {
        activeImplementationTools.clear();
        if (data.phase !== "off") pi.setActiveTools(data.savedTools);
    });

    pi.on("session_start", (_event, ctx) => {
        promptCache.clear();
        promptFailures.clear();
        activeImplementationTools.clear();
        const entry = ctx.sessionManager
            .getBranch()
            .filter((candidate) => candidate.type === "custom" && candidate.customType === "plan-mode")
            .pop() as { data?: unknown } | undefined;
        if (!entry) {
            data = normalizePlanModeData(undefined, baseTools());
            data.savedTools = baseTools();
            transition(ctx, "brainstorming");
            return;
        }
        data = normalizePlanModeData(entry.data, baseTools());
        if (data.phase !== "off") pi.setActiveTools(toolsFor(data.phase));
        setPlanStatus(ctx);
    });
}
