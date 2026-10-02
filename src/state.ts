import { Type, type Static } from "typebox";

export type PlanState = (typeof PLAN_STATES)[number];

export interface PlanModeData {
    phase: PlanState;
    proposal?: PlanProposal;
    savedTools: string[];
    waitingForUserFeedback?: boolean;
}

export type PlanProposal = Static<typeof PLAN_PROPOSAL_SCHEMA>;

const PLAN_STATES = ["off", "brainstorming", "implementing"] as const;

export const PLAN_PROPOSAL_SCHEMA = Type.Object({
    title: meaningful("A concise title for the proposed change"),
    problem: meaningful("What needs to change and why"),
    outcome: meaningful("What should be true when the work is complete"),
    approach: meaningful("A brief explanation of how the problem will be solved"),
    changes: Type.Array(
        Type.Object({
            path: meaningful("A concrete file path or narrowly defined area"),
            change: meaningful("The specific change to make"),
        }),
        { minItems: 1 },
    ),
    acceptanceCriteria: Type.Array(meaningful("A specific condition that proves the work is complete"), {
        minItems: 1,
    }),
});

const PLAN_STATE_SET = new Set<string>(PLAN_STATES);

/** Creates a required text schema with a field description. */
function meaningful(description: string) {
    return Type.String({ minLength: 1, description });
}

/** Normalizes the persisted tool list. */
function normalizeTools(value: unknown, fallback: string[]): string[] {
    if (!Array.isArray(value)) return [...new Set(fallback)];
    return [...new Set(value.filter((tool): tool is string => typeof tool === "string" && tool.length > 0))];
}

/** Returns trimmed text when the value is meaningful. */
function text(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Normalizes an array of meaningful text values. */
function textArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const items = value.map((item) => text(item));
    return items.some((item) => item === undefined) ? undefined : (items as string[]);
}

/** Normalizes every item in an object array. */
function objectArray<T>(value: unknown, normalize: (item: Record<string, unknown>) => T | undefined): T[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const items = value.map((item) =>
        typeof item === "object" && item !== null ? normalize(item as Record<string, unknown>) : undefined,
    );
    return items.some((item) => item === undefined) ? undefined : (items as T[]);
}

/** Normalizes a persisted proposal. */
function normalizeProposal(value: unknown): PlanProposal | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const raw = value as Record<string, unknown>;
    const title = text(raw.title);
    const problem = text(raw.problem);
    const outcome = text(raw.outcome);
    const approach = text(raw.approach);
    const acceptanceCriteria = textArray(raw.acceptanceCriteria);
    const changes = objectArray(raw.changes, (item) => {
        const path = text(item.path);
        const change = text(item.change);
        return path && change ? { path, change } : undefined;
    });
    if (!title || !problem || !outcome || !approach || !changes?.length || !acceptanceCriteria?.length)
        return undefined;
    return { title, problem, outcome, approach, changes, acceptanceCriteria };
}

/** Normalizes current persisted plan state and enforces its invariants. */
export function normalizePlanModeData(value: unknown, activeTools: string[]): PlanModeData {
    const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    const persistedPhase = raw.phase;
    let phase: PlanState =
        typeof persistedPhase === "string" && PLAN_STATE_SET.has(persistedPhase)
            ? (persistedPhase as PlanState)
            : "off";
    let proposal = normalizeProposal(raw.proposal);
    if (phase === "off") proposal = undefined;
    if (phase === "implementing" && !proposal) phase = "brainstorming";
    return {
        phase,
        ...(proposal ? { proposal } : {}),
        savedTools: normalizeTools(raw.savedTools, activeTools),
        ...(phase === "brainstorming" && raw.waitingForUserFeedback === true ? { waitingForUserFeedback: true } : {}),
    };
}
