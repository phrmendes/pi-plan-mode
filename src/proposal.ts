import type { PlanProposal } from "./state.ts";

/** Renders a bullet list, or omits the section entirely when the list is empty. */
export function bulletSection(heading: string, items?: string[]): string {
    if (!items || items.length === 0) return "";
    return `\n\n## ${heading}\n${items.map((item) => `- ${item}`).join("\n")}`;
}

/** Rejects placeholder text that cannot support an informed approval. */
export function requireCompleteProposal(proposal: PlanProposal): void {
    const fields = [proposal.title, proposal.problem, proposal.outcome, proposal.approach];
    if (fields.some((value) => value.trim().length < 3)) {
        throw new Error("The proposal contains empty or overly short required text.");
    }
    if (proposal.changes.some((item) => item.path.trim().length < 2 || item.change.trim().length < 3)) {
        throw new Error("Every change must include a meaningful path and description.");
    }
    if (proposal.changes.some((item) => item.path.startsWith("/") || item.path.includes(".."))) {
        throw new Error("Change paths must be relative and must not traverse parent directories.");
    }
    const criteria = proposal.acceptanceCriteria.map((item) => item.trim().toLowerCase());
    if (criteria.some((item) => item.length < 3) || new Set(criteria).size !== criteria.length) {
        throw new Error("Acceptance criteria must be meaningful and unique.");
    }
    const content = JSON.stringify(proposal);
    if (/\b(?:tbd|todo|etc\.?|as needed|unknown)\b/i.test(content)) {
        throw new Error("The proposal contains placeholder content. Resolve it before proposing.");
    }
}

/** Formats the canonical engineering proposal for review and implementation. */
export function formatProposal(proposal: PlanProposal): string {
    const changes = proposal.changes.map((item) => `- \`${item.path}\` — ${item.change}`).join("\n");
    return (
        `# ${proposal.title}` +
        `\n\n## Problem\n${proposal.problem}` +
        `\n\n## Outcome\n${proposal.outcome}` +
        `\n\n## Approach\n${proposal.approach}` +
        `\n\n## Changes\n${changes}` +
        bulletSection("Acceptance Criteria", proposal.acceptanceCriteria)
    );
}
