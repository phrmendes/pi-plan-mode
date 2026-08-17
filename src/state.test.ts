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
        { phase: "implementing", proposal: PROPOSAL, savedTools: ["read", "bash", "edit"] },
    );
});

test("removes malformed structured proposals", () => {
    const data = normalizePlanModeData(
        {
            phase: "planning",
            proposal: { summary: "", files: [{ path: 1 }], steps: [] },
            savedTools: ["read"],
        },
        ["read"],
    );
    assert.equal(data.proposal, undefined);
});

test("removes proposals missing required brief PRD sections", () => {
    const { approach, ...withoutApproach } = PROPOSAL;
    const data = normalizePlanModeData({ phase: "planning", proposal: withoutApproach, savedTools: ["read"] }, [
        "read",
    ]);
    assert.equal(data.proposal, undefined);
});

test("preserves a pending proposal in brainstorming", () => {
    const data = normalizePlanModeData({ phase: "brainstorming", proposal: PROPOSAL, savedTools: ["read"] }, ["read"]);
    assert.deepEqual(data.proposal, PROPOSAL);
});

test("migrates an old planning proposal without file entries", () => {
    const data = normalizePlanModeData(
        {
            phase: "planning",
            proposal: {
                title: "Legacy plan",
                summary: "Complete legacy work",
                problem: "The old workflow needs migration",
                goals: ["Preserve the plan"],
                requirements: ["Keep the approved scope"],
                files: [],
                steps: [{ title: "Migrate", description: "Run migration tests" }],
                successCriteria: ["The proposal is preserved"],
            },
        },
        ["read"],
    );
    assert.equal(data.phase, "brainstorming");
    assert.equal(data.proposal?.changes.length, 1);
});

test("migrates legacy steps into a structured proposal", () => {
    const data = normalizePlanModeData({ state: "planning", steps: [{ step: 8, text: "Legacy task" }] }, [
        "read",
        "bash",
    ]);
    assert.equal(data.proposal?.title, "Restored legacy proposal");
    assert.equal(data.proposal?.approach, "Legacy task");
});

test("normalizes workflow invariants", () => {
    assert.equal(normalizePlanModeData({ phase: "off", proposal: PROPOSAL }, ["read"]).proposal, undefined);
    assert.deepEqual(
        normalizePlanModeData({ phase: "brainstorming", proposal: PROPOSAL }, ["read"]).proposal,
        PROPOSAL,
    );
    assert.deepEqual(normalizePlanModeData({ phase: "implementing", proposal: PROPOSAL }, ["read"]).proposal, PROPOSAL);
    assert.equal(normalizePlanModeData({ phase: "implementing" }, ["read"]).phase, "brainstorming");
    assert.equal(normalizePlanModeData({ phase: "planning", proposal: PROPOSAL }, ["read"]).phase, "brainstorming");
});
