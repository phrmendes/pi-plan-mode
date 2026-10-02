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
    description: meaningful("One short paragraph describing what should change and why"),
    changes: Type.Array(
        Type.Object({
            path: meaningful("A concrete file path or narrowly defined area"),
            change: meaningful("The specific change to make"),
            example: Type.Optional(meaningful("A small concrete example of the change")),
        }),
        { minItems: 1 },
    ),
    tests: Type.Optional(
        Type.Array(
            Type.Object({
                path: meaningful("The test file or area"),
                test: meaningful("The behavior the test covers"),
                example: Type.Optional(meaningful("A small concrete example of the test")),
            }),
            { minItems: 1 },
        ),
    ),
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

/** Normalizes every item in an object array. */
function objectArray<T>(value: unknown, normalize: (item: Record<string, unknown>) => T | undefined): T[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const items = value.map((item) =>
        typeof item === "object" && item !== null ? normalize(item as Record<string, unknown>) : undefined,
    );
    return items.some((item) => item === undefined) ? undefined : (items as T[]);
}

/** Normalizes the optional test list, dropping entries that are not meaningful. */
function normalizeTests(value: unknown): PlanProposal["tests"] {
    if (value === undefined) return undefined;
    const tests = objectArray(value, (item) => {
        const path = text(item.path);
        const test = text(item.test);
        const example = text(item.example);
        return path && test ? { path, test, ...(example ? { example } : {}) } : undefined;
    });
    return tests?.length ? tests : undefined;
}

/** Normalizes a persisted proposal. */
function normalizeProposal(value: unknown): PlanProposal | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const raw = value as Record<string, unknown>;
    const description = text(raw.description);
    const changes = objectArray(raw.changes, (item) => {
        const path = text(item.path);
        const change = text(item.change);
        const example = text(item.example);
        return path && change ? { path, change, ...(example ? { example } : {}) } : undefined;
    });
    const tests = normalizeTests(raw.tests);
    if (!description || !changes?.length) return undefined;
    return { description, changes, ...(tests ? { tests } : {}) };
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
