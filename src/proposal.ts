import { Type, type Static } from "typebox";

/** Session entry type that displays a proposal for review. */
export const PROPOSAL_ENTRY = "plan-proposal";

export type PlanProposal = Static<typeof PLAN_PROPOSAL_SCHEMA>;

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

const PLACEHOLDER_VALUE = /^(?:tbd|todo|n\/a|na|none|unknown|as needed|etc\.?)$/i;

/** Creates a required text schema with a field description. */
function meaningful(description: string) {
    return Type.String({ minLength: 1, description });
}

/** Returns trimmed text when the value is text that is not blank. */
export function trimmedText(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Normalizes every item in an object array, or returns undefined when one item is invalid. */
function objectArray<T>(value: unknown, normalize: (item: Record<string, unknown>) => T | undefined): T[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const items = value.map((item) =>
        typeof item === "object" && item !== null ? normalize(item as Record<string, unknown>) : undefined,
    );
    return items.some((item) => item === undefined) ? undefined : (items as T[]);
}

/** Normalizes a persisted proposal; an invalid proposal becomes undefined, invalid tests are dropped. */
export function normalizeProposal(value: unknown): PlanProposal | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const raw = value as Record<string, unknown>;
    const description = trimmedText(raw.description);
    const changes = objectArray(raw.changes, (item) => {
        const path = trimmedText(item.path);
        const change = trimmedText(item.change);
        const example = trimmedText(item.example);
        return path && change ? { path, change, ...(example ? { example } : {}) } : undefined;
    });
    const tests = objectArray(raw.tests, (item) => {
        const path = trimmedText(item.path);
        const test = trimmedText(item.test);
        const example = trimmedText(item.example);
        return path && test ? { path, test, ...(example ? { example } : {}) } : undefined;
    });
    if (!description || !changes?.length) return undefined;
    return { description, changes, ...(tests?.length ? { tests } : {}) };
}

/** Returns whether a path or its text is too short to support an informed decision. */
function isVague(path: string, body: string): boolean {
    return path.trim().length < 2 || body.trim().length < 3;
}

/** Rejects a proposal that is too vague or that holds placeholder text. */
export function requireCompleteProposal(proposal: PlanProposal): void {
    const tests = proposal.tests ?? [];
    if (proposal.description.trim().length < 3) {
        throw new Error("The proposal description is empty or overly short.");
    }
    if (proposal.changes.some((item) => isVague(item.path, item.change))) {
        throw new Error("Every change must include a meaningful path and description.");
    }
    if (tests.some((item) => isVague(item.path, item.test))) {
        throw new Error("Every test must include a meaningful path and behavior.");
    }
    const texts = [
        proposal.description,
        ...proposal.changes.flatMap((item) => [item.path, item.change, item.example ?? ""]),
        ...tests.flatMap((item) => [item.path, item.test, item.example ?? ""]),
    ];
    if (texts.some((value) => PLACEHOLDER_VALUE.test(value.trim()))) {
        throw new Error("The proposal contains placeholder content. Resolve it before proposing.");
    }
}

/** Renders one change or test entry as a titled block with an optional example. */
function formatEntry(path: string, body: string, example?: string): string {
    const renderedExample = example ? `\n\nExample:\n\n\`\`\`\n${example}\n\`\`\`` : "";
    return `### \`${path}\`\n${body}${renderedExample}`;
}

/** Formats the proposal for review and implementation. */
export function formatProposal(proposal: PlanProposal): string {
    const changes = proposal.changes.map((item) => formatEntry(item.path, item.change, item.example)).join("\n\n");
    const tests = proposal.tests?.length
        ? `\n\n## Tests\n\n${proposal.tests.map((item) => formatEntry(item.path, item.test, item.example)).join("\n\n")}`
        : "";
    return `## Description\n${proposal.description}\n\n## Changes\n\n${changes}${tests}`;
}
