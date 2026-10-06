import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { emptyModes, loadPlanConfig, planConfigPath, splitModelRef, type PlanModes } from "./config.ts";
import { createPlanController, PLAN_ASK_SCHEMA, PLAN_TOOLS } from "./plan.ts";
import { createPromptLoader } from "./prompts.ts";
import { PLAN_PROPOSAL_SCHEMA, PROPOSAL_ENTRY } from "./proposal.ts";
import { normalizePlanModeData, PLAN_MODE_ENTRY, type PlanModeData } from "./state.ts";

/** Registers the agent-driven plan workflow. */
export default function planMode(pi: ExtensionAPI): void {
    const prompts = createPromptLoader(new URL("../prompts/", import.meta.url));
    let modes: PlanModes = emptyModes();

    pi.registerEntryRenderer(PROPOSAL_ENTRY, (entry) => {
        const data = entry.data as { markdown?: unknown } | undefined;
        const markdown = typeof data?.markdown === "string" ? data.markdown : "";
        return new Markdown(markdown, 0, 0, getMarkdownTheme());
    });

    const controller = createPlanController({
        getModes: () => modes,
        getActiveTools: () => pi.getActiveTools(),
        setActiveTools: (tools) => pi.setActiveTools(tools),
        getModel: (ctx) => (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
        setModel: async (ref, ctx) => {
            const parts = splitModelRef(ref);
            const model = parts ? ctx.modelRegistry.find(parts.provider, parts.id) : undefined;
            return model ? pi.setModel(model) : false;
        },
        persist: (state) => pi.appendEntry(PLAN_MODE_ENTRY, state),
        displayProposal: (markdown) => pi.appendEntry(PROPOSAL_ENTRY, { markdown }),
        sendUserMessage: (message) => pi.sendUserMessage(message),
        loadPrompt: (phase) => prompts.load(phase),
    });

    pi.registerTool({
        name: PLAN_TOOLS.propose,
        exposure: "model-only",
        label: "Propose Plan",
        description: "Submit one complete proposal for user review and acceptance",
        parameters: PLAN_PROPOSAL_SCHEMA,
        async execute(_id, params, _signal, _update, ctx) {
            return controller.propose(params, ctx);
        },
    });

    pi.registerTool({
        name: PLAN_TOOLS.complete,
        exposure: "model-only",
        label: "Complete Plan",
        description: "Complete the accepted proposal after implementation and checks",
        parameters: Type.Object({}),
        async execute(_id, _params, _signal, _update, ctx) {
            return controller.complete(ctx);
        },
    });

    pi.registerTool({
        name: PLAN_TOOLS.ask,
        exposure: "model-only",
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

    /** Reads the plan state saved on the active branch, if any. */
    function readBranchState(ctx: ExtensionContext): PlanModeData | undefined {
        const entry = ctx.sessionManager
            .getBranch()
            .findLast((candidate) => candidate.type === "custom" && candidate.customType === PLAN_MODE_ENTRY);
        return entry?.type === "custom" ? normalizePlanModeData(entry.data, controller.baseTools()) : undefined;
    }

    pi.on("session_start", (_event, ctx) => {
        prompts.clear();
        const config = loadPlanConfig(planConfigPath());
        modes = config.modes;
        for (const error of config.errors) ctx.ui.notify(`Plan mode: ${error}`, "warning");
        return controller.start(ctx, readBranchState(ctx));
    });

    pi.on("session_tree", (_event, ctx) => {
        const restored = readBranchState(ctx);
        return restored ? controller.resume(ctx, restored) : undefined;
    });
}
