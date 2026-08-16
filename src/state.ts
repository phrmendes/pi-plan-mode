import { Type, type Static } from "typebox";

export const PLAN_STATES = ["off", "brainstorming", "planning", "implementing"] as const;
export type PlanState = (typeof PLAN_STATES)[number];

export const PLAN_PROPOSAL_SCHEMA = Type.Object({
    title: Type.String({ minLength: 1 }),
    summary: Type.String({ minLength: 1 }),
    problem: Type.String({ minLength: 1 }),
    goals: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    nonGoals: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    requirements: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    files: Type.Array(
        Type.Object({
            path: Type.String({ minLength: 1 }),
            reason: Type.String({ minLength: 1 }),
        }),
    ),
    steps: Type.Array(
        Type.Object({
            title: Type.String({ minLength: 1 }),
            description: Type.String({ minLength: 1 }),
        }),
        { minItems: 1 },
    ),
    risks: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    successCriteria: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
});
export type PlanProposal = Static<typeof PLAN_PROPOSAL_SCHEMA>;

export interface PlanModeData {
    phase: PlanState;
    proposal?: PlanProposal;
    savedTools: string[];
}

const PLAN_STATE_SET = new Set<string>(PLAN_STATES);

/** Returns a unique list of valid tool names. */
function normalizeTools(value: unknown, fallback: string[]): string[] {
    if (!Array.isArray(value)) return [...new Set(fallback)];
    return [...new Set(value.filter((tool): tool is string => typeof tool === "string" && tool.length > 0))];
}

/** Returns a trimmed non-empty string. */
function text(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Returns a non-empty array of trimmed strings, or undefined when any item is invalid. */
function textArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const items = value.map((item) => text(item));
    return items.some((item) => item === undefined) ? undefined : (items as string[]);
}

/** Returns a possibly empty array of trimmed strings for an optional field. */
function optionalTextArray(value: unknown): string[] | undefined {
    if (value === undefined) return undefined;
    return textArray(value);
}

/** Normalizes a current structured proposal. */
function normalizeProposal(value: unknown): PlanProposal | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const raw = value as Record<string, unknown>;
    const title = text(raw.title);
    const summary = text(raw.summary);
    const problem = text(raw.problem);
    const goals = textArray(raw.goals);
    const requirements = textArray(raw.requirements);
    const successCriteria = textArray(raw.successCriteria);
    if (
        !title ||
        !summary ||
        !problem ||
        !goals ||
        goals.length === 0 ||
        !requirements ||
        requirements.length === 0 ||
        !successCriteria ||
        successCriteria.length === 0 ||
        !Array.isArray(raw.files) ||
        !Array.isArray(raw.steps) ||
        raw.steps.length === 0
    )
        return undefined;
    const nonGoals = optionalTextArray(raw.nonGoals);
    const risks = optionalTextArray(raw.risks);
    const files = raw.files.map((item) => {
        if (typeof item !== "object" || item === null) return undefined;
        const path = text((item as Record<string, unknown>).path);
        const reason = text((item as Record<string, unknown>).reason);
        return path && reason ? { path, reason } : undefined;
    });
    const steps = raw.steps.map((item) => {
        if (typeof item !== "object" || item === null) return undefined;
        const title = text((item as Record<string, unknown>).title);
        const description = text((item as Record<string, unknown>).description);
        return title && description ? { title, description } : undefined;
    });
    if (files.some((item) => !item) || steps.some((item) => !item)) return undefined;
    return {
        title,
        summary,
        problem,
        goals,
        ...(nonGoals ? { nonGoals } : {}),
        requirements,
        files: files as PlanProposal["files"],
        steps: steps as PlanProposal["steps"],
        ...(risks ? { risks } : {}),
        successCriteria,
    };
}

/** Converts valid legacy steps into a structured proposal. */
function normalizeLegacyProposal(value: unknown): PlanProposal | undefined {
    if (!Array.isArray(value)) return undefined;
    const steps = value
        .map((item) =>
            typeof item === "object" && item !== null ? text((item as Record<string, unknown>).text) : undefined,
        )
        .filter((title): title is string => title !== undefined)
        .map((title) => ({ title, description: "" }));
    return steps.length > 0
        ? {
              title: "Restored legacy proposal",
              summary: "Restored legacy proposal",
              problem: "Restored from a legacy proposal without a recorded problem statement.",
              goals: ["Restore prior legacy work items"],
              requirements: steps.map((step) => step.title),
              files: [],
              steps,
              successCriteria: ["All restored steps are completed"],
          }
        : undefined;
}

/** Normalizes current and legacy custom-entry data. */
export function normalizePlanModeData(value: unknown, activeTools: string[]): PlanModeData {
    const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    const currentPhase = typeof raw.phase === "string" && PLAN_STATE_SET.has(raw.phase) ? raw.phase : undefined;
    const legacyPhase = typeof raw.state === "string" && PLAN_STATE_SET.has(raw.state) ? raw.state : undefined;
    let phase = (currentPhase ?? legacyPhase ?? (raw.enabled ? "brainstorming" : "off")) as PlanState;
    let proposal = normalizeProposal(raw.proposal) ?? normalizeLegacyProposal(raw.steps);
    if (phase === "off" || phase === "brainstorming") proposal = undefined;
    if (phase === "implementing" && !proposal) phase = "planning";

    return {
        phase,
        proposal,
        savedTools: normalizeTools(raw.savedTools, activeTools),
    };
}
