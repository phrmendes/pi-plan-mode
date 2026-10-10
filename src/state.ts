import { normalizeProposal, trimmedText, type PlanProposal } from "./proposal.ts";

/** Session entry type that persists the plan state. */
export const PLAN_MODE_ENTRY = "plan-mode";

/** Thinking levels pi accepts, in increasing order of effort. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Returns whether a persisted value names a pi thinking level. */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
    return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

const PLAN_STATES = ["off", "brainstorming", "implementing"] as const;

export type PlanState = (typeof PLAN_STATES)[number];

/** A phase in which plan mode manages tools and models. */
export type ActivePhase = Exclude<PlanState, "off">;

/** The stages a profile configures, in display order. */
export const STAGE_KEYS = ["brainstorming", "thinking", "implementing"] as const;

/** The stage whose model and level plan mode applies: brainstorming also has a thinking stage. */
export type StageKey = ActivePhase | "thinking";

/** A user's model and level choice for one stage, recorded while plan mode is on. */
export interface StageOverride {
    model?: string;
    thinkingLevel?: ThinkingLevel;
}

/** Runtime overrides keyed by profile key, then by stage. */
export type PlanOverrides = Record<string, Partial<Record<StageKey, StageOverride>>>;

export interface PlanModeData {
    phase: PlanState;
    proposal?: PlanProposal;
    savedTools: string[];
    savedModel?: string;
    savedThinkingLevel?: ThinkingLevel;
    activeProfile?: string;
    overrides?: PlanOverrides;
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

/** Normalizes one override stage, keeping only meaningful fields. */
function normalizeStageOverride(value: unknown): StageOverride | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const stage = value as Record<string, unknown>;
    const model = trimmedText(stage.model);
    const thinkingLevel = isThinkingLevel(stage.thinkingLevel) ? stage.thinkingLevel : undefined;
    if (!model && !thinkingLevel) return undefined;
    return { ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) };
}

/** Normalizes the persisted override map, dropping malformed profile and stage entries. */
function normalizeOverrides(value: unknown): PlanOverrides | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const overrides: PlanOverrides = {};
    for (const [profile, stages] of Object.entries(value)) {
        if (typeof stages !== "object" || stages === null || Array.isArray(stages)) continue;
        const parsed: Partial<Record<StageKey, StageOverride>> = {};
        for (const stage of STAGE_KEYS) {
            const override = normalizeStageOverride((stages as Record<string, unknown>)[stage]);
            if (override) parsed[stage] = override;
        }
        if (Object.keys(parsed).length > 0) overrides[profile] = parsed;
    }
    return Object.keys(overrides).length > 0 ? overrides : undefined;
}

/** Normalizes current persisted plan state and enforces its invariants. */
export function normalizePlanModeData(value: unknown, activeTools: string[]): PlanModeData {
    const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    let phase: PlanState = isPlanState(raw.phase) ? raw.phase : "off";
    const proposal = phase === "off" ? undefined : normalizeProposal(raw.proposal);
    if (phase === "implementing" && !proposal) phase = "brainstorming";
    const savedModel = phase === "off" ? undefined : trimmedText(raw.savedModel);
    const savedThinkingLevel =
        phase === "off" || !isThinkingLevel(raw.savedThinkingLevel) ? undefined : raw.savedThinkingLevel;
    const activeProfile = phase === "off" ? undefined : trimmedText(raw.activeProfile);
    const overrides = phase === "off" ? undefined : normalizeOverrides(raw.overrides);
    return {
        phase,
        ...(proposal ? { proposal } : {}),
        savedTools: normalizeTools(raw.savedTools, activeTools),
        ...(savedModel ? { savedModel } : {}),
        ...(savedThinkingLevel ? { savedThinkingLevel } : {}),
        ...(activeProfile ? { activeProfile } : {}),
        ...(overrides ? { overrides } : {}),
        ...(phase === "brainstorming" && raw.waitingForUserFeedback === true ? { waitingForUserFeedback: true } : {}),
        ...(phase === "brainstorming" && raw.thinking === true ? { thinking: true } : {}),
    };
}
