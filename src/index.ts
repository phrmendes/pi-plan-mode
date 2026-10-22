import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
    effectiveDeniedTools,
    emptyConfig,
    loadPlanConfigs,
    resolveProfile,
    selectProfile,
    type LoadedProfile,
    type PlanConfig,
} from "./config.ts";
import { splitModelRef } from "./planFile.ts";
import { createDesktopNotifier } from "./notify.ts";
import { findLocalPlanConfig, planConfigPath } from "./paths.ts";
import { createPlanController, PLAN_ASK_SCHEMA } from "./plan.ts";
import { PLAN_TOOLS } from "./policy.ts";
import { createPromptLoader } from "./prompts.ts";
import { PLAN_PROPOSAL_SCHEMA, PROPOSAL_ENTRY } from "./proposal.ts";
import { normalizePlanModeData, PLAN_MODE_ENTRY, type PlanModeData } from "./state.ts";

/** Registers the agent-driven plan workflow. */
export default function planMode(pi: ExtensionAPI): void {
    const prompts = createPromptLoader(new URL("../prompts/", import.meta.url));
    let config: PlanConfig = emptyConfig();
    let activeProfileKey = "default";
    let cwd = "";
    let trusted = false;
    let sessionCtx: ExtensionContext | undefined;

    /** Returns the active profile, resolving the default when the key is gone. */
    const activeProfile = (): LoadedProfile => resolveProfile(config, activeProfileKey) ?? selectProfile(config, cwd);

    /** Activates a profile by key, or the configured default when it is absent or unknown. */
    const activate = (key: string | undefined): void => {
        activeProfileKey = (resolveProfile(config, key) ?? selectProfile(config, cwd)).key;
    };

    /** Reads the global file and the trusted local file, reporting every bad value. */
    const readConfig = (): PlanConfig => {
        const localPath = trusted ? findLocalPlanConfig(cwd) : undefined;
        const loaded = loadPlanConfigs(planConfigPath(), localPath);
        for (const error of loaded.errors) sessionCtx?.ui.notify(`Plan mode: ${error}`, "warning");
        return loaded;
    };

    pi.registerEntryRenderer(PROPOSAL_ENTRY, (entry) => {
        const data = entry.data as { markdown?: unknown } | undefined;
        const markdown = typeof data?.markdown === "string" ? data.markdown : "";
        return new Markdown(markdown, 0, 0, getMarkdownTheme());
    });

    const sendDesktop = createDesktopNotifier();

    const controller = createPlanController({
        getModes: () => activeProfile().modes,
        getActiveProfile: () => ({ key: activeProfile().key, name: activeProfile().name }),
        listProfiles: () => config.profiles.map((profile) => ({ key: profile.key, name: profile.name })),
        setActiveProfile: (key) => {
            const found = resolveProfile(config, key);
            if (!found) return false;
            activeProfileKey = found.key;
            return true;
        },
        resetActiveProfile: () => {
            config = readConfig();
            const found = selectProfile(config, cwd);
            activeProfileKey = found.key;
            return { key: found.key, name: found.name };
        },
        getDeniedTools: (phase) => effectiveDeniedTools(config, activeProfileKey, phase),
        getActiveTools: () => pi.getActiveTools(),
        setActiveTools: (tools) => pi.setActiveTools(tools),
        getModel: (ctx) => (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
        setModel: async (ref, ctx) => {
            const parts = splitModelRef(ref);
            const model = parts ? ctx.modelRegistry.find(parts.provider, parts.id) : undefined;
            return model ? pi.setModel(model) : false;
        },
        getThinkingLevel: () => pi.getThinkingLevel(),
        setThinkingLevel: (level) => pi.setThinkingLevel(level),
        persist: (state) => pi.appendEntry(PLAN_MODE_ENTRY, state),
        displayProposal: (markdown) => pi.appendEntry(PROPOSAL_ENTRY, { markdown }),
        sendUserMessage: (message) => pi.sendUserMessage(message),
        loadPrompt: (phase) => prompts.load(phase),
        notifyDesktop: (message) => sendDesktop(message, cwd),
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
        sessionCtx = ctx;
        cwd = ctx.sessionManager.getCwd();
        trusted = ctx.isProjectTrusted();
        config = readConfig();
        const restored = readBranchState(ctx);
        activate(restored?.activeProfile);
        return controller.start(ctx, restored);
    });

    pi.on("session_tree", (_event, ctx) => {
        const restored = readBranchState(ctx);
        if (!restored) return undefined;
        activate(restored.activeProfile);
        return controller.resume(ctx, restored);
    });

    pi.on("model_select", (event, ctx) => {
        if (event.source === "restore" || controller.isApplying()) return;
        controller.captureOverride({ model: `${event.model.provider}/${event.model.id}` }, ctx);
    });

    pi.on("thinking_level_select", (event, ctx) => {
        if (controller.isApplying()) return;
        controller.captureOverride({ thinkingLevel: event.level }, ctx);
    });
}
