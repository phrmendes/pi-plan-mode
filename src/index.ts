import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

const CONTROL_TOOLS = new Set(["plan_propose", "plan_submit", "plan_approve", "plan_complete"]);
const READ_ONLY_TOOLS = new Set(["read", "bash"]);
const PHASES: Record<
    PlanState,
    { readOnly: boolean; controls: string[]; commands: Array<{ value: string; label: string }> }
> = {
    off: { readOnly: false, controls: [], commands: [] },
    brainstorming: {
        readOnly: true,
        controls: ["plan_propose"],
        commands: [
            { value: "create", label: "create — enter planning" },
            { value: "disable", label: "disable — exit plan mode" },
        ],
    },
    planning: {
        readOnly: true,
        controls: ["plan_submit"],
        commands: [
            { value: "bstorm", label: "bstorm — return to brainstorming" },
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
    planning: "plan: planning — read-only, drafting proposal",
    implementing: "plan: implementing — approved tools enabled",
};
export interface PlanModeOptions {
    loadPrompt?: (phase: PlanState) => string | null;
}

/** Registers the agent-driven plan workflow. */
export default function planMode(pi: ExtensionAPI, options: PlanModeOptions = {}): void {
    const baseTools = (): string[] => pi.getActiveTools().filter((tool) => !CONTROL_TOOLS.has(tool));
    let data: PlanModeData = normalizePlanModeData(undefined, baseTools());
    const promptCache = new Map<PlanState, string>();
    const promptFailures = new Set<PlanState>();
    const activeImplementationTools = new Set<string>();

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
        const controls = [...config.controls];
        if (phase === "planning" && data.proposal) controls.push("plan_approve");
        return [...new Set([...tools, ...controls])];
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

    /** Formats the approved proposal for the implementation contract. */
    function formatProposal(proposal: PlanProposal): string {
        const steps = proposal.steps
            .map((step, index) => `${index + 1}. ${step.title} — ${step.description}`)
            .join("\n");
        return `Approved work: ${proposal.summary}\n${steps}`;
    }

    /** Requests approval for the currently stored proposal. */
    async function approveProposal(ctx: ExtensionContext) {
        if (!data.proposal) throw new Error("No stored proposal is available.");
        if (!ctx.hasUI) {
            return {
                content: [{ type: "text" as const, text: "Proposal stored. Approval requires a UI session." }],
                details: {},
            };
        }
        const choice = await ctx.ui.select("Plan proposed — accept?", ["Implement now", "Back to brainstorming"]);
        if (choice === "Implement now") {
            transition(ctx, "implementing");
            return {
                content: [{ type: "text" as const, text: "Proposal approved. Begin implementation." }],
                details: {},
            };
        }
        if (choice === "Back to brainstorming") {
            data.proposal = undefined;
            transition(ctx, "brainstorming");
            return {
                content: [{ type: "text" as const, text: "Proposal rejected. Brainstorming restored." }],
                details: {},
            };
        }
        return {
            content: [{ type: "text" as const, text: "Proposal stored in planning without approval." }],
            details: {},
        };
    }

    pi.registerTool({
        name: "plan_propose",
        label: "Enter Planning",
        description: "Enter planning after the user requests a formal proposal",
        parameters: Type.Object({}),
        async execute(_id, _params, _signal, _update, ctx) {
            requirePhase("brainstorming");
            transition(ctx, "planning");
            return {
                content: [{ type: "text" as const, text: "Planning mode active. Submit with plan_submit." }],
                details: {},
            };
        },
    });

    pi.registerTool({
        name: "plan_submit",
        label: "Submit Plan",
        description: "Submit a structured proposal for user approval",
        parameters: PLAN_PROPOSAL_SCHEMA,
        async execute(_id, params, _signal, _update, ctx) {
            requirePhase("planning");
            data.proposal = params;
            persistState();
            pi.setActiveTools(toolsFor("planning"));
            return approveProposal(ctx);
        },
    });

    pi.registerTool({
        name: "plan_approve",
        label: "Approve Stored Plan",
        description: "Approve a proposal already stored in planning",
        parameters: Type.Object({}),
        async execute(_id, _params, _signal, _update, ctx) {
            requirePhase("planning");
            return approveProposal(ctx);
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

    const subcommands: Record<string, (ctx: ExtensionContext) => void> = {
        create(ctx) {
            if (data.phase !== "brainstorming") {
                ctx.ui.notify("/plan create is available only in brainstorming.", "warning");
                return;
            }
            transition(ctx, "planning");
            pi.sendUserMessage("Draft and submit the formal proposal.", { deliverAs: "followUp" });
        },
        bstorm(ctx) {
            if (data.phase !== "planning") {
                ctx.ui.notify("/plan bstorm is available only in planning.", "warning");
                return;
            }
            data.proposal = undefined;
            transition(ctx, "brainstorming");
        },
        disable(ctx) {
            if (data.phase === "off") {
                ctx.ui.notify("Plan mode is already disabled.", "warning");
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
            handler(ctx);
        },
    });

    pi.on("tool_call", (event) => {
        if ((data.phase !== "brainstorming" && data.phase !== "planning") || event.toolName !== "bash") return;
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
