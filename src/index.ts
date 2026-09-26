import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { createNushellTool, type NushellToolOptions } from "./nushell.ts";
import { createPlanController, PLAN_ASK_SCHEMA } from "./plan.ts";
import { normalizePlanModeData, PLAN_PROPOSAL_SCHEMA, type PlanState } from "./state.ts";

export interface PlanModeOptions {
    loadPrompt?: (phase: PlanState) => string | null;
    nushell?: Omit<NushellToolOptions, "isRestricted" | "cwd">;
}

/** Registers the agent-driven plan workflow. */
export default function planMode(pi: ExtensionAPI, options: PlanModeOptions = {}): void {
    const promptCache = new Map<PlanState, string>();

    pi.registerEntryRenderer("plan-proposal", (entry) => {
        const proposal = entry.data as { markdown: string };
        return new Markdown(proposal.markdown, 0, 0, getMarkdownTheme());
    });

    /** Reads one bundled phase prompt from disk. */
    function readBundledPrompt(phase: PlanState): string | null {
        try {
            return readFileSync(new URL(`../prompts/${phase}.md`, import.meta.url), "utf8");
        } catch {
            return null;
        }
    }

    /** Reads the bundled instructions that apply to every agent turn. */
    function readAgentInstructions(): string | null {
        try {
            return readFileSync(new URL("../prompts/instructions.md", import.meta.url), "utf8");
        } catch {
            return null;
        }
    }

    const agentInstructions = readAgentInstructions();

    /** Loads and caches the prompt contract for a phase. */
    function loadPhasePrompt(phase: PlanState): string | null {
        const cached = promptCache.get(phase);
        if (cached) return cached;
        const content = (options.loadPrompt ?? readBundledPrompt)(phase);
        if (content) promptCache.set(phase, content);
        return content;
    }

    const controller = createPlanController({
        getActiveTools: () => pi.getActiveTools(),
        setActiveTools: (tools) => pi.setActiveTools(tools),
        persist: (data) => pi.appendEntry("plan-mode", data),
        sendUserMessage: (message) => pi.sendUserMessage(message),
        appendDisplay: (type, data) => pi.appendEntry(type, data),
        loadPrompt: loadPhasePrompt,
    });

    pi.registerTool(
        createNushellTool({
            cwd: process.cwd(),
            shellPath: options.nushell?.shellPath ?? process.env.PI_NUSHELL_PATH ?? "nu",
            operations: options.nushell?.operations,
            isRestricted: () => controller.isRestricted(),
        }),
    );

    pi.registerTool({
        name: "plan_propose",
        label: "Propose Plan",
        description: "Submit one complete proposal for user review and approval",
        parameters: PLAN_PROPOSAL_SCHEMA,
        async execute(_id, params, _signal, _update, ctx) {
            return controller.propose(params, ctx);
        },
    });

    pi.registerTool({
        name: "plan_complete",
        label: "Complete Plan",
        description: "Complete the approved proposal after implementation and checks",
        parameters: Type.Object({}),
        async execute(_id, _params, _signal, _update, ctx) {
            return controller.complete(ctx);
        },
    });

    pi.registerTool({
        name: "plan_ask",
        label: "Ask Clarifying Questions",
        description: "Ask the user one or more choice questions before you submit a proposal",
        parameters: PLAN_ASK_SCHEMA,
        async execute(_id, params, _signal, _update, ctx) {
            return controller.ask(params, ctx);
        },
    });

    pi.registerCommand("plan", {
        description: "Enter plan mode or run a phase command",
        getArgumentCompletions: (prefix: string) => controller.completions(prefix),
        handler: async (args, ctx) => {
            await controller.command(args, ctx);
        },
    });

    pi.on("input", (event, ctx) => {
        const source = (event as { source?: string }).source;
        controller.handleInput(source, ctx as ExtensionContext);
        return { action: "continue" as const };
    });

    pi.on("tool_execution_start", (event) => {
        controller.onToolExecutionStart(event.toolCallId, event.toolName);
    });

    pi.on("tool_execution_end", (event) => {
        controller.onToolExecutionEnd(event.toolCallId);
    });

    pi.on("agent_settled", () => {
        controller.onAgentSettled();
    });

    pi.on("before_agent_start", (event, ctx) => {
        const planPrompt = controller.beforeAgentStart(event.systemPrompt, ctx);
        const systemPrompt = planPrompt?.systemPrompt ?? event.systemPrompt;
        if (!agentInstructions) return planPrompt;
        return { systemPrompt: `${systemPrompt}\n\n${agentInstructions}` };
    });

    pi.on("session_shutdown", () => {
        controller.onShutdown();
    });

    pi.on("session_start", (_event, ctx) => {
        promptCache.clear();
        const entry = ctx.sessionManager
            .getBranch()
            .filter((candidate) => candidate.type === "custom" && candidate.customType === "plan-mode")
            .pop() as { data?: unknown } | undefined;
        const data = entry ? normalizePlanModeData(entry.data, controller.baseTools()) : undefined;
        controller.start(ctx, data);
    });
}
