import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { createPlanController, PLAN_ASK_SCHEMA, PLAN_TOOLS } from "./plan.ts";
import { normalizePlanModeData, PLAN_PROPOSAL_SCHEMA, type PlanState } from "./state.ts";

export interface PlanModeOptions {
    loadPrompt?: (phase: PlanState) => string | null;
}

/** Registers the agent-driven plan workflow. */
export default function planMode(pi: ExtensionAPI, options: PlanModeOptions = {}): void {
    const promptCache = new Map<PlanState, string>();

    pi.registerEntryRenderer("plan-proposal", (entry) => {
        const data = entry.data as { markdown?: unknown } | undefined;
        const markdown = typeof data?.markdown === "string" ? data.markdown : "";
        return new Markdown(markdown, 0, 0, getMarkdownTheme());
    });

    /** Reads one bundled prompt file, or returns null when it is missing. */
    function readPromptFile(name: string): string | null {
        try {
            return readFileSync(new URL(`../prompts/${name}`, import.meta.url), "utf8");
        } catch (error) {
            if ((error as { code?: string }).code === "ENOENT") return null;
            throw error;
        }
    }

    /** Loads and caches the prompt contract for a phase. */
    function loadPhasePrompt(phase: PlanState): string | null {
        const cached = promptCache.get(phase);
        if (cached) return cached;
        const content = (options.loadPrompt ?? ((value: PlanState) => readPromptFile(`${value}.md`)))(phase);
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

    pi.registerTool({
        name: PLAN_TOOLS.propose,
        label: "Propose Plan",
        description: "Submit one complete proposal for user review and approval",
        parameters: PLAN_PROPOSAL_SCHEMA,
        async execute(_id, params, _signal, _update, ctx) {
            return controller.propose(params, ctx);
        },
    });

    pi.registerTool({
        name: PLAN_TOOLS.complete,
        label: "Complete Plan",
        description: "Complete the approved proposal after implementation and checks",
        parameters: Type.Object({}),
        async execute(_id, _params, _signal, _update, ctx) {
            return controller.complete(ctx);
        },
    });

    pi.registerTool({
        name: PLAN_TOOLS.ask,
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
        controller.handleInput(event.source, ctx);
        return { action: "continue" as const };
    });

    pi.on("tool_call", (event) => {
        const reason = controller.blockReason(event.toolName);
        return reason ? { block: true, reason } : undefined;
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
        return controller.beforeAgentStart(event.systemPrompt, ctx);
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
