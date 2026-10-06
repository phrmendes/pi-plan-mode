import { normalizeProposal, trimmedText, type PlanProposal } from "./proposal.ts";

/** Session entry type that persists the plan state. */
export const PLAN_MODE_ENTRY = "plan-mode";

const PLAN_STATES = ["off", "brainstorming", "implementing"] as const;

export type PlanState = (typeof PLAN_STATES)[number];

/** A phase in which plan mode manages tools and models. */
export type ActivePhase = Exclude<PlanState, "off">;

export interface PlanModeData {
    phase: PlanState;
    proposal?: PlanProposal;
    savedTools: string[];
    savedModel?: string;
    waitingForUserFeedback?: boolean;
    /** Whether `/plan thk` switched brainstorming to the thinking model. */
    thinking?: boolean;
}

/** Returns whether a persisted value names a plan state. */
function isPlanState(value: unknown): value is PlanState {
    return PLAN_STATES.some((state) => state === value);
}

/** Normalizes the persisted tool list. */
function normalizeTools(value: unknown, fallback: string[]): string[] {
    if (!Array.isArray(value)) return [...new Set(fallback)];
    return [...new Set(value.filter((tool): tool is string => typeof tool === "string" && tool.length > 0))];
}

/** Normalizes current persisted plan state and enforces its invariants. */
export function normalizePlanModeData(value: unknown, activeTools: string[]): PlanModeData {
    const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    let phase: PlanState = isPlanState(raw.phase) ? raw.phase : "off";
    const proposal = phase === "off" ? undefined : normalizeProposal(raw.proposal);
    if (phase === "implementing" && !proposal) phase = "brainstorming";
    const savedModel = phase === "off" ? undefined : trimmedText(raw.savedModel);
    return {
        phase,
        ...(proposal ? { proposal } : {}),
        savedTools: normalizeTools(raw.savedTools, activeTools),
        ...(savedModel ? { savedModel } : {}),
        ...(phase === "brainstorming" && raw.waitingForUserFeedback === true ? { waitingForUserFeedback: true } : {}),
        ...(phase === "brainstorming" && raw.thinking === true ? { thinking: true } : {}),
    };
}
