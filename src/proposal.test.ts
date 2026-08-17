import test from "node:test";
import assert from "node:assert/strict";
import { bulletSection, formatProposal, requireCompleteProposal } from "./proposal.ts";
import type { PlanProposal } from "./state.ts";

const PROPOSAL: PlanProposal = {
    title: "Improve flow",
    problem: "The flow is hard to follow",
    outcome: "The proposal flow is clear",
    approach: "Use one proposal tool for submission and approval.",
    changes: [{ path: "src/index.ts", change: "Simplify orchestration and remove duplicate actions" }],
    acceptanceCriteria: ["One tool submits the proposal", "Transition tests pass"],
};

test("bulletSection omits the heading when there are no items", () => {
    assert.equal(bulletSection("Notes", []), "");
    assert.equal(bulletSection("Notes", undefined), "");
});

test("bulletSection renders one bullet per item under the heading", () => {
    assert.equal(bulletSection("Notes", ["a", "b"]), "\n\n## Notes\n- a\n- b");
});

test("formatProposal renders every section of the proposal", () => {
    const markdown = formatProposal(PROPOSAL);
    assert.match(markdown, /^# Improve flow/);
    assert.match(markdown, /## Problem\nThe flow is hard to follow/);
    assert.match(markdown, /## Changes\n- `src\/index\.ts` — Simplify orchestration/);
    assert.match(markdown, /## Acceptance Criteria\n- One tool submits the proposal/);
});

test("requireCompleteProposal accepts a fully specified proposal", () => {
    assert.doesNotThrow(() => requireCompleteProposal(PROPOSAL));
});

test("requireCompleteProposal rejects placeholder content", () => {
    assert.throws(() => requireCompleteProposal({ ...PROPOSAL, approach: "TBD" }), /placeholder/i);
});
