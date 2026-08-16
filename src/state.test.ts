import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePlanModeData, type PlanProposal } from "./state.ts";

const PROPOSAL: PlanProposal = {
    summary: "Improve flow",
    files: [{ path: "src/index.ts", reason: "Change orchestration" }],
    steps: [{ title: "Refactor", description: "Use control tools" }],
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

test("migrates legacy steps into a structured proposal", () => {
    const data = normalizePlanModeData({ state: "planning", steps: [{ step: 8, text: "Legacy task" }] }, [
        "read",
        "bash",
    ]);
    assert.deepEqual(data.proposal, {
        summary: "Restored legacy proposal",
        files: [],
        steps: [{ title: "Legacy task", description: "" }],
    });
});

test("normalizes workflow invariants", () => {
    assert.equal(normalizePlanModeData({ phase: "off", proposal: PROPOSAL }, ["read"]).proposal, undefined);
    assert.equal(normalizePlanModeData({ phase: "brainstorming", proposal: PROPOSAL }, ["read"]).proposal, undefined);
    assert.deepEqual(normalizePlanModeData({ phase: "implementing", proposal: PROPOSAL }, ["read"]).proposal, PROPOSAL);
    assert.equal(normalizePlanModeData({ phase: "implementing" }, ["read"]).phase, "planning");
});
