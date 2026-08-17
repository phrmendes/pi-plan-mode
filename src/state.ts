import { Type, type Static } from "typebox";

export const PLAN_STATES = ["off", "brainstorming", "implementing"] as const;
export type PlanState = (typeof PLAN_STATES)[number];

const meaningful = (description: string) => Type.String({ minLength: 1, description });

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
export type PlanProposal = Static<typeof PLAN_PROPOSAL_SCHEMA>;

export interface PlanModeData {
    phase: PlanState;
    proposal?: PlanProposal;
    savedTools: string[];
}

const PLAN_STATE_SET = new Set<string>(PLAN_STATES);

function normalizeTools(value: unknown, fallback: string[]): string[] {
    if (!Array.isArray(value)) return [...new Set(fallback)];
    return [...new Set(value.filter((tool): tool is string => typeof tool === "string" && tool.length > 0))];
}

function text(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function textArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const items = value.map((item) => text(item));
    return items.some((item) => item === undefined) ? undefined : (items as string[]);
}

function objectArray<T>(value: unknown, normalize: (item: Record<string, unknown>) => T | undefined): T[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const items = value.map((item) =>
        typeof item === "object" && item !== null ? normalize(item as Record<string, unknown>) : undefined,
    );
    return items.some((item) => item === undefined) ? undefined : (items as T[]);
}

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

function normalizeDetailedProposal(value: unknown): PlanProposal | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const raw = value as Record<string, unknown>;
    const title = text(raw.title);
    const problem = text(raw.problem);
    const outcome = text(raw.outcome) ?? text(raw.summary);
    const approach = text(raw.approach) ?? textArray(raw.requirements)?.join("; ");
    const acceptanceCriteria = textArray(raw.acceptanceCriteria) ?? textArray(raw.successCriteria);
    const changes = objectArray(raw.changes ?? raw.files, (item) => {
        const path = text(item.path);
        const change = text(item.change) ?? text(item.reason);
        return path && change ? { path, change } : undefined;
    });
    if (!title || !problem || !outcome || !approach || !acceptanceCriteria?.length) return undefined;
    return {
        title,
        problem,
        outcome,
        approach,
        changes: changes?.length ? changes : [{ path: "Unknown", change: "Complete the restored work" }],
        acceptanceCriteria,
    };
}

function normalizeLegacySteps(value: unknown): PlanProposal | undefined {
    if (!Array.isArray(value)) return undefined;
    const actions = value
        .map((item) =>
            typeof item === "object" && item !== null ? text((item as Record<string, unknown>).text) : undefined,
        )
        .filter((item): item is string => item !== undefined);
    if (actions.length === 0) return undefined;
    return {
        title: "Restored legacy proposal",
        problem: "A legacy proposal was restored without a recorded problem statement.",
        outcome: "Complete the restored legacy work items.",
        approach: actions.join("; "),
        changes: [{ path: "Unknown", change: "Complete the restored legacy work" }],
        acceptanceCriteria: ["All restored work items are complete"],
    };
}

export function normalizePlanModeData(value: unknown, activeTools: string[]): PlanModeData {
    const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    const persistedPhase = typeof raw.phase === "string" ? raw.phase : raw.state;
    let phase: PlanState =
        persistedPhase === "planning"
            ? "brainstorming"
            : typeof persistedPhase === "string" && PLAN_STATE_SET.has(persistedPhase)
              ? (persistedPhase as PlanState)
              : raw.enabled
                ? "brainstorming"
                : "off";
    let proposal =
        normalizeProposal(raw.proposal) ?? normalizeDetailedProposal(raw.proposal) ?? normalizeLegacySteps(raw.steps);
    if (phase === "off") proposal = undefined;
    if (phase === "implementing" && !proposal) phase = "brainstorming";
    return { phase, proposal, savedTools: normalizeTools(raw.savedTools, activeTools) };
}
