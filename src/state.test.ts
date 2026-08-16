import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePlanModeData, type PlanProposal } from "./state.ts";

const PROPOSAL: PlanProposal = {
    title: "Improve flow",
    summary: "Improve flow",
    problem: "The flow is hard to follow",
    goals: ["Clarify orchestration"],
    requirements: ["Use control tools"],
    files: [{ path: "src/index.ts", reason: "Change orchestration" }],
    steps: [{ title: "Refactor", description: "Use control tools" }],
    successCriteria: ["Orchestration reads clearly"],
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

test("removes proposals missing required PRD sections", () => {
    const { title, ...withoutTitle } = PROPOSAL;
    const data = normalizePlanModeData({ phase: "planning", proposal: withoutTitle, savedTools: ["read"] }, ["read"]);
    assert.equal(data.proposal, undefined);
});

test("keeps optional PRD sections when present and omits them otherwise", () => {
    const withOptional = normalizePlanModeData(
        {
            phase: "planning",
            proposal: { ...PROPOSAL, nonGoals: ["Rewrite unrelated modules"], risks: ["Scope creep"] },
            savedTools: ["read"],
        },
        ["read"],
    );
    assert.deepEqual(withOptional.proposal?.nonGoals, ["Rewrite unrelated modules"]);
    assert.deepEqual(withOptional.proposal?.risks, ["Scope creep"]);
    const withoutOptional = normalizePlanModeData({ phase: "planning", proposal: PROPOSAL, savedTools: ["read"] }, [
        "read",
    ]);
    assert.equal(withoutOptional.proposal?.nonGoals, undefined);
    assert.equal(withoutOptional.proposal?.risks, undefined);
});

test("migrates legacy steps into a structured proposal", () => {
    const data = normalizePlanModeData({ state: "planning", steps: [{ step: 8, text: "Legacy task" }] }, [
        "read",
        "bash",
    ]);
    assert.deepEqual(data.proposal, {
        title: "Restored legacy proposal",
        summary: "Restored legacy proposal",
        problem: "Restored from a legacy proposal without a recorded problem statement.",
        goals: ["Restore prior legacy work items"],
        requirements: ["Legacy task"],
        files: [],
        steps: [{ title: "Legacy task", description: "" }],
        successCriteria: ["All restored steps are completed"],
    });
});

test("normalizes workflow invariants", () => {
    assert.equal(normalizePlanModeData({ phase: "off", proposal: PROPOSAL }, ["read"]).proposal, undefined);
    assert.equal(normalizePlanModeData({ phase: "brainstorming", proposal: PROPOSAL }, ["read"]).proposal, undefined);
    assert.deepEqual(normalizePlanModeData({ phase: "implementing", proposal: PROPOSAL }, ["read"]).proposal, PROPOSAL);
    assert.equal(normalizePlanModeData({ phase: "implementing" }, ["read"]).phase, "planning");
});
