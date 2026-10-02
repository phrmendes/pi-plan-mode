import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePlanModeData, type PlanProposal } from "./state.ts";

const PROPOSAL: PlanProposal = {
    title: "Improve flow",
    problem: "The current proposal flow is hard to follow.",
    outcome: "Agents submit one complete engineering proposal.",
    approach: "Combine proposal submission and approval into one control tool.",
    changes: [{ path: "src/index.ts", change: "Simplify proposal orchestration and remove duplicate steps" }],
    acceptanceCriteria: ["One proposal call opens approval"],
};

test("normalizes current persisted state", () => {
    assert.deepEqual(
        normalizePlanModeData({ phase: "implementing", proposal: PROPOSAL, savedTools: ["read", "bash", "edit"] }, [
            "read",
        ]),
        {
            phase: "implementing",
            proposal: PROPOSAL,
            savedTools: ["read", "bash", "edit"],
        },
    );
});

test("removes malformed structured proposals", () => {
    const data = normalizePlanModeData(
        {
            phase: "brainstorming",
            proposal: { summary: "", files: [{ path: 1 }], steps: [] },
            savedTools: ["read"],
        },
        ["read"],
    );
    assert.equal(data.proposal, undefined);
});

test("removes proposals missing required brief PRD sections", () => {
    const { approach: _approach, ...withoutApproach } = PROPOSAL;
    const data = normalizePlanModeData({ phase: "brainstorming", proposal: withoutApproach, savedTools: ["read"] }, [
        "read",
    ]);
    assert.equal(data.proposal, undefined);
});

test("normalizes workflow invariants", () => {
    assert.equal(normalizePlanModeData({ phase: "off", proposal: PROPOSAL }, ["read"]).proposal, undefined);
    assert.deepEqual(
        normalizePlanModeData({ phase: "brainstorming", proposal: PROPOSAL }, ["read"]).proposal,
        PROPOSAL,
    );
    assert.deepEqual(normalizePlanModeData({ phase: "implementing", proposal: PROPOSAL }, ["read"]).proposal, PROPOSAL);
    assert.equal(normalizePlanModeData({ phase: "implementing" }, ["read"]).phase, "brainstorming");
    assert.equal(normalizePlanModeData({ phase: "planning", proposal: PROPOSAL }, ["read"]).phase, "off");
});

test("deduplicates and filters saved tools", () => {
    const data = normalizePlanModeData({ phase: "off", savedTools: ["read", "read", "", 42, "edit"] }, ["fallback"]);
    assert.deepEqual(data.savedTools, ["read", "edit"]);
});

test("falls back to active tools when saved tools are absent", () => {
    const data = normalizePlanModeData({ phase: "off" }, ["read", "edit", "read"]);
    assert.deepEqual(data.savedTools, ["read", "edit"]);
});

test("keeps revision feedback only in brainstorming", () => {
    const brainstorming = normalizePlanModeData({ phase: "brainstorming", waitingForUserFeedback: true }, ["read"]);
    assert.equal(brainstorming.waitingForUserFeedback, true);
    const implementing = normalizePlanModeData(
        { phase: "implementing", proposal: PROPOSAL, waitingForUserFeedback: true },
        ["read"],
    );
    assert.equal(implementing.waitingForUserFeedback, undefined);
    assert.equal(
        normalizePlanModeData({ phase: "off", waitingForUserFeedback: true }, ["read"]).waitingForUserFeedback,
        undefined,
    );
});
