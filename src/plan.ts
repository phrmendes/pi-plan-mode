import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { PlanModes } from "./config.ts";
import { formatProposal, requireCompleteProposal, type PlanProposal } from "./proposal.ts";
import { normalizePlanModeData, type ActivePhase, type PlanModeData, type PlanState } from "./state.ts";

export const PLAN_TOOLS = {
    propose: "plan_propose",
    complete: "plan_complete",
    ask: "plan_ask",
} as const;

export const PLAN_ASK_SCHEMA = Type.Object({
    questions: Type.Array(
        Type.Object({
            question: Type.String({ minLength: 1 }),
            options: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        }),
        { minItems: 1 },
    ),
});

export type PlanAskInput = Static<typeof PLAN_ASK_SCHEMA>;

export interface PlanToolResult {
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
}

export interface CommandCompletion {
    value: string;
    label: string;
}

export interface PlanControllerDeps {
    getModes(): PlanModes;
    getActiveTools(): string[];
    setActiveTools(tools: string[]): void;
    /** Returns the session model as `provider/id`, if any. */
    getModel(ctx: ExtensionContext): string | undefined;
    /** Sets the session model from `provider/id`; resolves false when the model cannot be used. */
    setModel(ref: string, ctx: ExtensionContext): Promise<boolean>;
    persist(state: PlanModeData): void;
    /** Shows a formatted proposal in the session for review. */
    displayProposal(markdown: string): void;
    sendUserMessage(message: string): void;
    loadPrompt(phase: ActivePhase): string | null;
}

export interface PlanController {
    baseTools(): string[];
    blockReason(toolName: string): string | undefined;
    start(ctx: ExtensionContext, restored?: PlanModeData): Promise<void>;
    resume(ctx: ExtensionContext, restored: PlanModeData): Promise<void>;
    propose(proposal: PlanProposal, ctx: ExtensionContext): Promise<PlanToolResult>;
    ask(input: PlanAskInput, ctx: ExtensionContext): Promise<PlanToolResult>;
    complete(ctx: ExtensionContext): Promise<PlanToolResult>;
    command(args: string | undefined, ctx: ExtensionContext): Promise<void>;
    completions(prefix: string): CommandCompletion[] | null;
    handleInput(source: string | undefined, ctx: ExtensionContext): void;
    beforeAgentStart(systemPrompt: string, ctx: ExtensionContext): { systemPrompt: string } | undefined;
    onToolExecutionStart(toolCallId: string, toolName: string): void;
    onToolExecutionEnd(toolCallId: string): void;
    onAgentSettled(): void;
    onShutdown(): void;
}

/** The runtime of one controller: the persisted plan state plus bookkeeping that is not persisted. */
interface Session {
    readonly deps: PlanControllerDeps;
    state: PlanModeData;
    planAddedTools: Set<string>;
    hasNudgedToComplete: boolean;
    readonly runningTools: Set<string>;
    readonly promptFailures: Set<ActivePhase>;
}

/** A /plan subcommand: the phases it works in, what it needs, and what it does. */
interface PlanCommand {
    label: string;
    phases: readonly ActivePhase[];
    needsProposal?: boolean;
    needsIdleTools?: boolean;
    run(s: Session, ctx: ExtensionContext): Promise<unknown>;
}

type NoticeType = Parameters<ExtensionContext["ui"]["notify"]>[1];

const CONTROL_TOOLS = new Set<string>(Object.values(PLAN_TOOLS));
const DISCOVERY_TOOLS = ["read", "grep", "ls", "find"];
const DEFAULT_DENIED_TOOLS = ["bash", "powershell", "edit", "write"];
const PHASE_CONTROLS: Record<ActivePhase, string[]> = {
    brainstorming: [PLAN_TOOLS.propose, PLAN_TOOLS.ask],
    implementing: [PLAN_TOOLS.complete],
};
const PHASE_NOTICES: Record<PlanState, string> = {
    off: "off.",
    brainstorming: "brainstorming; shell, editing, and denied tools are off.",
    implementing: "implementing; every tool is on.",
};
const ASK_OTHER_OPTION = "Other (type your own)";
const REVIEW_ACCEPT = "Accept and implement";
const REVIEW_REJECT = "Reject";

/** Returns whether a tool list names a tool, matching exact names and `*` suffixes. */
function matchesTool(toolName: string, entries: readonly string[]): boolean {
    return entries.some((entry) =>
        entry.endsWith("*") ? toolName.startsWith(entry.slice(0, -1)) : toolName === entry,
    );
}

/** Returns whether brainstorming denies a tool; the plan control tools are never denied. */
function isDenied(toolName: string, deniedTools: readonly string[]): boolean {
    return !CONTROL_TOOLS.has(toolName) && matchesTool(toolName, [...DEFAULT_DENIED_TOOLS, ...deniedTools]);
}

/** Returns the tools a phase activates from the saved tools. */
function toolsFor(phase: ActivePhase, savedTools: readonly string[], deniedTools: readonly string[]): string[] {
    if (phase === "implementing") return [...new Set([...savedTools, ...PHASE_CONTROLS.implementing])];
    const allowed = [...DISCOVERY_TOOLS, ...savedTools].filter((tool) => !isDenied(tool, deniedTools));
    return [...new Set([...allowed, ...PHASE_CONTROLS.brainstorming])];
}

/** Returns whether two tool lists contain the same names. */
function sameTools(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((tool) => right.includes(tool));
}

/** Builds a successful tool result with one text block. */
function textResult(text: string): PlanToolResult {
    return { content: [{ type: "text", text }], details: {} };
}

/** Shows a message that starts with "Plan mode:", so the user knows its source. */
function notify(ctx: ExtensionContext, message: string, type?: NoticeType): void {
    ctx.ui.notify(`Plan mode: ${message}`, type);
}

/** Returns the deny list that the configuration adds to the defaults. */
function configuredDeniedTools(s: Session): string[] {
    return s.deps.getModes().brainstorming.deniedTools;
}

/** Persists a snapshot of the plan state. */
function persistState(s: Session): void {
    s.deps.persist(structuredClone(s.state));
}

/** Updates the plan status indicator. */
function setPlanStatus(s: Session, ctx: ExtensionContext): void {
    if (s.state.phase === "off") {
        ctx.ui.setStatus("plan", undefined);
        return;
    }
    const label = s.state.waitingForUserFeedback
        ? "waiting for feedback"
        : s.state.thinking
          ? "thinking"
          : s.state.phase;
    ctx.ui.setStatus("plan", `plan: ${label}`);
}

/** Returns the active tools without the plan control tools. */
function baseTools(s: Session): string[] {
    return s.deps.getActiveTools().filter((tool) => !CONTROL_TOOLS.has(tool));
}

/** Activates a phase's tools and records which of them plan mode added. */
function applyTools(s: Session, phase: ActivePhase): void {
    const tools = toolsFor(phase, s.state.savedTools, configuredDeniedTools(s));
    s.planAddedTools = new Set(tools.filter((tool) => !s.state.savedTools.includes(tool)));
    s.deps.setActiveTools(tools);
}

/** Returns the saved tools plus tools that entered the session after plan mode started. */
function restoreTools(s: Session): string[] {
    const late = baseTools(s).filter((tool) => !s.planAddedTools.has(tool));
    return [...new Set([...s.state.savedTools, ...late])];
}

/** Adopts tools that connected after plan mode started and re-applies the phase's tool set. */
function syncTools(s: Session, phase: ActivePhase): void {
    const late = baseTools(s).filter((tool) => !s.state.savedTools.includes(tool) && !s.planAddedTools.has(tool));
    if (late.length > 0) {
        s.state.savedTools = [...s.state.savedTools, ...late];
        persistState(s);
    }
    const expected = toolsFor(phase, s.state.savedTools, configuredDeniedTools(s));
    if (!sameTools(expected, s.deps.getActiveTools())) applyTools(s, phase);
}

/** Removes plan control tools that registration activated while plan mode is off. */
function dropStrayControlTools(s: Session): void {
    if (s.deps.getActiveTools().some((tool) => CONTROL_TOOLS.has(tool))) s.deps.setActiveTools(baseTools(s));
}

/** Returns whether implementation tools are still running. */
function hasToolsInFlight(s: Session): boolean {
    return s.runningTools.size > 0;
}

/** Sets a model, warning instead of failing when the model cannot be used. */
async function switchModel(s: Session, ctx: ExtensionContext, ref: string): Promise<boolean> {
    let reason: string | undefined;
    try {
        if (!(await s.deps.setModel(ref, ctx))) reason = "it is unknown or has no credentials";
    } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
    }
    if (reason) notify(ctx, `cannot switch to the model "${ref}" (${reason}); keeping the current model.`, "warning");
    return reason === undefined;
}

/** Returns the configured model of a phase; brainstorming uses the thinking model while thinking is on. */
function configuredModel(s: Session, phase: ActivePhase): string | undefined {
    const modes = s.deps.getModes();
    return phase === "brainstorming" && s.state.thinking ? modes.thinking.model : modes[phase].model;
}

/** Switches to a phase's model, or to the saved model when the phase has none; saves the model it replaces first. */
async function applyPhaseModel(s: Session, ctx: ExtensionContext, phase: ActivePhase): Promise<void> {
    const configured = configuredModel(s, phase);
    const previous = s.deps.getModel(ctx);
    const target = configured ?? s.state.savedModel;
    if (!target || target === previous) return;
    const switched = await switchModel(s, ctx, target);
    if (!switched || !configured || !previous || s.state.savedModel || s.state.phase === "off") return;
    s.state.savedModel = previous;
    persistState(s);
}

/** Restores the model plan mode replaced. */
async function restoreModel(s: Session, ctx: ExtensionContext, ref: string | undefined): Promise<void> {
    if (ref && ref !== s.deps.getModel(ctx)) await switchModel(s, ctx, ref);
}

/** Changes phase, applies its tools, and resolves once its model is applied. */
function transition(s: Session, ctx: ExtensionContext, next: PlanState): Promise<void> {
    const state = s.state;
    if (state.phase === next) return Promise.resolve();
    const savedModel = state.savedModel;
    if (state.phase === "off") state.savedTools = baseTools(s);
    if (next === "implementing") s.hasNudgedToComplete = false;
    if (next !== "brainstorming") {
        delete state.waitingForUserFeedback;
        delete state.thinking;
    }
    state.phase = next;
    if (next === "off") {
        delete state.proposal;
        delete state.savedModel;
        state.savedTools = restoreTools(s);
        s.deps.setActiveTools(state.savedTools);
    } else {
        applyTools(s, next);
    }
    setPlanStatus(s, ctx);
    notify(ctx, PHASE_NOTICES[next]);
    persistState(s);
    return next === "off" ? restoreModel(s, ctx, savedModel) : applyPhaseModel(s, ctx, next);
}

/** Throws when an operation is used in the wrong phase. */
function requirePhase(s: Session, expected: PlanState): void {
    if (s.state.phase !== expected) throw new Error(`This action is available only in ${expected} mode.`);
}

/** Throws unless the agent may ask or propose: in brainstorming, and not waiting for user feedback. */
function requireOpenBrainstorming(s: Session): void {
    requirePhase(s, "brainstorming");
    if (s.state.waitingForUserFeedback) throw new Error("Wait for the user to provide feedback first.");
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
    return { question, answer: custom?.trim() || "No answer provided" };
}

/** Displays the stored proposal and asks the user to accept it; any other answer rejects it. */
async function reviewProposal(s: Session, ctx: ExtensionContext): Promise<PlanToolResult> {
    if (!s.state.proposal) throw new Error("No stored proposal is available.");
    const markdown = formatProposal(s.state.proposal);
    if (!ctx.hasUI) return textResult(`Proposal stored. Acceptance requires a UI session.\n\n${markdown}`);
    s.deps.displayProposal(markdown);
    const choice = await ctx.ui.select("Review the proposal above", [REVIEW_ACCEPT, REVIEW_REJECT]);
    if (choice === REVIEW_ACCEPT) {
        await transition(s, ctx, "implementing");
        return textResult("Proposal accepted. Begin implementation.");
    }
    delete s.state.proposal;
    s.state.waitingForUserFeedback = true;
    setPlanStatus(s, ctx);
    persistState(s);
    return textResult(
        "Proposal rejected. Plan mode is waiting for your feedback. Describe the required changes before the agent asks questions or submits another proposal.",
    );
}

/** Toggles brainstorming between its own model and the thinking model. */
async function toggleThinking(s: Session, ctx: ExtensionContext): Promise<void> {
    if (!s.deps.getModes().thinking.model) {
        notify(ctx, 'set "modes.thinking.model" in plan.json to use /plan thk.', "warning");
        return;
    }
    if (s.state.thinking) delete s.state.thinking;
    else s.state.thinking = true;
    setPlanStatus(s, ctx);
    notify(ctx, s.state.thinking ? "thinking on." : "thinking off.");
    persistState(s);
    await applyPhaseModel(s, ctx, "brainstorming");
}

const COMMANDS: ReadonlyMap<string, PlanCommand> = new Map<string, PlanCommand>([
    [
        "impl",
        {
            label: "accept the stored proposal and start implementing",
            phases: ["brainstorming"],
            needsProposal: true,
            run: (s, ctx) => transition(s, ctx, "implementing"),
        },
    ],
    [
        "thk",
        {
            label: "toggle the thinking model",
            phases: ["brainstorming"],
            run: toggleThinking,
        },
    ],
    [
        "bst",
        {
            label: "stop implementing and return to brainstorming",
            phases: ["implementing"],
            needsIdleTools: true,
            run: (s, ctx) => {
                s.state.waitingForUserFeedback = true;
                return transition(s, ctx, "brainstorming");
            },
        },
    ],
    [
        "off",
        {
            label: "exit plan mode",
            phases: ["brainstorming", "implementing"],
            needsIdleTools: true,
            run: (s, ctx) => transition(s, ctx, "off"),
        },
    ],
]);

/** Returns why a command cannot run now, or undefined when it can. */
function commandProblem(s: Session, name: string, command: PlanCommand): string | undefined {
    const phase = s.state.phase;
    if (phase === "off") return "off. Run /plan to start.";
    if (!command.phases.includes(phase)) return `/plan ${name} works only while ${command.phases.join(" or ")}.`;
    if (command.needsProposal && !s.state.proposal) return "no stored proposal.";
    if (command.needsIdleTools && hasToolsInFlight(s)) {
        return `wait for implementation tools to finish before /plan ${name}.`;
    }
    return undefined;
}

/** Runs `/plan` with no argument (enter plan mode) or with a subcommand. */
async function runCommand(s: Session, args: string | undefined, ctx: ExtensionContext): Promise<void> {
    const name = args?.trim() ?? "";
    if (!name) {
        if (s.state.phase === "off") await transition(s, ctx, "brainstorming");
        else notify(ctx, `already on (${s.state.phase}).`);
        return;
    }
    const command = COMMANDS.get(name);
    if (!command) {
        notify(ctx, `unknown subcommand "${name}".`, "warning");
        return;
    }
    const problem = commandProblem(s, name, command);
    if (problem) {
        notify(ctx, problem, "warning");
        return;
    }
    await command.run(s, ctx);
}

/** Returns the subcommands of the current phase that start with a prefix. */
function commandCompletions(s: Session, prefix: string): CommandCompletion[] | null {
    const phase = s.state.phase;
    if (phase === "off") return null;
    const matches = [...COMMANDS]
        .filter(([name, command]) => command.phases.includes(phase) && name.startsWith(prefix))
        .map(([name, command]) => ({ value: name, label: `${name} — ${command.label}` }));
    return matches.length > 0 ? matches : null;
}

/** Returns why brainstorming blocks a tool call, or undefined to allow it. */
function blockReason(s: Session, toolName: string): string | undefined {
    if (s.state.phase !== "brainstorming" || !isDenied(toolName, configuredDeniedTools(s))) return undefined;
    return `Plan mode: the "${toolName}" tool is not available during brainstorming.`;
}

/** Starts the session: a fresh session enters brainstorming, a restored one keeps its phase. */
function startSession(s: Session, ctx: ExtensionContext, restored: PlanModeData | undefined): Promise<void> {
    s.promptFailures.clear();
    s.runningTools.clear();
    s.planAddedTools = new Set();
    s.hasNudgedToComplete = false;
    if (!restored) {
        s.state = normalizePlanModeData(undefined, []);
        return transition(s, ctx, "brainstorming");
    }
    s.state = { ...restored };
    setPlanStatus(s, ctx);
    if (s.state.phase === "off") {
        dropStrayControlTools(s);
        return Promise.resolve();
    }
    applyTools(s, s.state.phase);
    return applyPhaseModel(s, ctx, s.state.phase);
}

/** Switches to the plan state of another session branch. */
function resumeBranch(s: Session, ctx: ExtensionContext, restored: PlanModeData): Promise<void> {
    const previous = s.state.phase;
    const savedModel = s.state.savedModel;
    const sessionTools = previous === "off" ? baseTools(s) : restoreTools(s);
    s.runningTools.clear();
    s.hasNudgedToComplete = false;
    s.state = { ...restored, savedTools: sessionTools };
    setPlanStatus(s, ctx);
    if (s.state.phase === "off") {
        delete s.state.savedModel;
        s.planAddedTools = new Set();
        if (previous === "off") return Promise.resolve();
        s.deps.setActiveTools(sessionTools);
        return restoreModel(s, ctx, savedModel);
    }
    if (!s.state.savedModel && savedModel) s.state.savedModel = savedModel;
    applyTools(s, s.state.phase);
    return applyPhaseModel(s, ctx, s.state.phase);
}

/** Stores a complete proposal and opens the review. */
async function proposePlan(s: Session, proposal: PlanProposal, ctx: ExtensionContext): Promise<PlanToolResult> {
    requireOpenBrainstorming(s);
    requireCompleteProposal(proposal);
    s.state.proposal = proposal;
    persistState(s);
    return reviewProposal(s, ctx);
}

/** Asks the user the agent's questions and returns the answers. */
async function askQuestions(s: Session, input: PlanAskInput, ctx: ExtensionContext): Promise<PlanToolResult> {
    requireOpenBrainstorming(s);
    if (!ctx.hasUI) return textResult("Clarifying questions require a UI session; none is available.");
    const answers: Array<{ question: string; answer: string }> = [];
    for (const item of input.questions) answers.push(await askQuestion(ctx, item.question, item.options));
    return textResult(answers.map((entry) => `Q: ${entry.question}\nA: ${entry.answer}`).join("\n\n"));
}

/** Ends the implementation and returns to brainstorming. */
async function completePlan(s: Session, ctx: ExtensionContext): Promise<PlanToolResult> {
    requirePhase(s, "implementing");
    if (hasToolsInFlight(s)) throw new Error("plan_complete must run after all implementation tools finish.");
    delete s.state.proposal;
    await transition(s, ctx, "brainstorming");
    return textResult("Implementation complete. Plan mode remains enabled in brainstorming.");
}

/** Treats a user message as the feedback that plan mode waits for. */
function handleInput(s: Session, source: string | undefined, ctx: ExtensionContext): void {
    if (!s.state.waitingForUserFeedback || source === "extension") return;
    delete s.state.waitingForUserFeedback;
    setPlanStatus(s, ctx);
    persistState(s);
}

/** Syncs the tools and appends the phase prompt to the system prompt of the next turn. */
function beforeAgentStart(
    s: Session,
    systemPrompt: string,
    ctx: ExtensionContext,
): { systemPrompt: string } | undefined {
    const phase = s.state.phase;
    if (phase === "off") {
        dropStrayControlTools(s);
        return undefined;
    }
    syncTools(s, phase);
    const base = s.deps.loadPrompt(phase);
    if (!base) {
        if (!s.promptFailures.has(phase)) {
            s.promptFailures.add(phase);
            notify(ctx, `the ${phase} prompt is missing.`, "error");
        }
        return undefined;
    }
    const contract =
        phase === "implementing" && s.state.proposal ? `${base}\n\n${formatProposal(s.state.proposal)}` : base;
    return { systemPrompt: `${systemPrompt}\n\n${contract}` };
}

/** Tracks an implementation tool that starts running. */
function trackToolStart(s: Session, toolCallId: string, toolName: string): void {
    if (s.state.phase === "implementing" && !CONTROL_TOOLS.has(toolName)) s.runningTools.add(toolCallId);
}

/** Reminds the agent once to complete an implementation that looks finished. */
function nudgeToComplete(s: Session): void {
    if (s.state.phase !== "implementing" || !s.state.proposal) return;
    if (hasToolsInFlight(s) || s.hasNudgedToComplete) return;
    s.hasNudgedToComplete = true;
    s.deps.sendUserMessage(
        "If every change in the proposal is done and verified, call plan_complete now. If not, continue implementing.",
    );
}

/** Restores the user's tools when the session ends. */
function shutdown(s: Session): void {
    s.runningTools.clear();
    if (s.state.phase === "off") return;
    s.state.savedTools = restoreTools(s);
    s.deps.setActiveTools(s.state.savedTools);
}

/** Creates the plan workflow controller. */
export function createPlanController(deps: PlanControllerDeps): PlanController {
    const s: Session = {
        deps,
        state: normalizePlanModeData(undefined, []),
        planAddedTools: new Set(),
        hasNudgedToComplete: false,
        runningTools: new Set(),
        promptFailures: new Set(),
    };
    return {
        baseTools: () => baseTools(s),
        blockReason: (toolName) => blockReason(s, toolName),
        start: (ctx, restored) => startSession(s, ctx, restored),
        resume: (ctx, restored) => resumeBranch(s, ctx, restored),
        propose: (proposal, ctx) => proposePlan(s, proposal, ctx),
        ask: (input, ctx) => askQuestions(s, input, ctx),
        complete: (ctx) => completePlan(s, ctx),
        command: (args, ctx) => runCommand(s, args, ctx),
        completions: (prefix) => commandCompletions(s, prefix),
        handleInput: (source, ctx) => handleInput(s, source, ctx),
        beforeAgentStart: (systemPrompt, ctx) => beforeAgentStart(s, systemPrompt, ctx),
        onToolExecutionStart: (toolCallId, toolName) => trackToolStart(s, toolCallId, toolName),
        onToolExecutionEnd: (toolCallId) => void s.runningTools.delete(toolCallId),
        onAgentSettled: () => nudgeToComplete(s),
        onShutdown: () => shutdown(s),
    };
}
