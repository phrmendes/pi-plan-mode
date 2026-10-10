import type { PlanStage } from "./planFile.ts";
import type { ActivePhase, PlanState, StageKey, StageOverride } from "./state.ts";

export const PLAN_TOOLS = {
    propose: "plan_propose",
    complete: "plan_complete",
    ask: "plan_ask",
} as const;

/** The plan control tools, which are never denied and never treated as the user's tools. */
export const CONTROL_TOOLS = new Set<string>(Object.values(PLAN_TOOLS));

/** Tools plan mode adds during brainstorming so the agent can still inspect the project. */
const DISCOVERY_TOOLS = ["read", "grep", "ls", "find"];

/** Tools brainstorming always denies, in addition to the configured deny lists. */
const DEFAULT_DENIED_TOOLS = ["bash", "powershell", "edit", "write"];

/** The control tools each phase activates. */
const PHASE_CONTROLS: Record<ActivePhase, string[]> = {
    brainstorming: [PLAN_TOOLS.propose, PLAN_TOOLS.ask],
    implementing: [PLAN_TOOLS.complete],
};

/** Returns whether a tool list names a tool, matching exact names and `*` suffixes. */
function matchesTool(toolName: string, entries: readonly string[]): boolean {
    return entries.some((entry) =>
        entry.endsWith("*") ? toolName.startsWith(entry.slice(0, -1)) : toolName === entry,
    );
}

/** Returns whether brainstorming denies a tool; the plan control tools are never denied. */
export function isDenied(toolName: string, deniedTools: readonly string[]): boolean {
    return !CONTROL_TOOLS.has(toolName) && matchesTool(toolName, [...DEFAULT_DENIED_TOOLS, ...deniedTools]);
}

/** Returns the tools a phase activates from the saved tools. */
export function toolsFor(phase: ActivePhase, savedTools: readonly string[], deniedTools: readonly string[]): string[] {
    if (phase === "implementing") return [...new Set([...savedTools, ...PHASE_CONTROLS.implementing])];
    const allowed = [...DISCOVERY_TOOLS, ...savedTools].filter((tool) => !isDenied(tool, deniedTools));
    return [...new Set([...allowed, ...PHASE_CONTROLS.brainstorming])];
}

/** Returns whether two tool lists contain the same names. */
export function sameTools(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((tool) => right.includes(tool));
}

/** Returns the stage whose model and level plan mode applies. */
export function stageKey(phase: PlanState, thinking: boolean | undefined): StageKey {
    if (phase === "brainstorming" && thinking) return "thinking";
    return phase === "implementing" ? "implementing" : "brainstorming";
}

/** Merges a user's stage choice over the configured stage. */
export function mergeStage(configured: PlanStage, override: StageOverride | undefined): PlanStage {
    const model = override?.model ?? configured.model;
    const thinkingLevel = override?.thinkingLevel ?? configured.thinkingLevel;
    return { ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) };
}
