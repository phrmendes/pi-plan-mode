import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePlanModeData, type PlanProposal } from "./state.ts";

const PROPOSAL: PlanProposal = {
    description: "Agents should submit one short proposal that the user can accept.",
    changes: [
        {
            path: "src/index.ts",
            change: "Simplify proposal orchestration and remove duplicate steps",
            example: 'planMode(pi, { allowedTools: ["mcp__browser__*"] })',
        },
    ],
};

test("keeps the optional tests in a proposal", () => {
    const proposal = {
        ...PROPOSAL,
        tests: [
            { path: "src/plan.test.ts", test: "Rejects a proposal without a description" },
            { path: "src/state.test.ts", test: "Keeps optional tests", example: "  " },
        ],
    };
    const data = normalizePlanModeData({ phase: "brainstorming", proposal, savedTools: ["read"] }, ["read"]);
    assert.deepEqual(data.proposal?.tests, [
        { path: "src/plan.test.ts", test: "Rejects a proposal without a description" },
        { path: "src/state.test.ts", test: "Keeps optional tests" },
    ]);
});

test("drops an empty or malformed tests field but keeps the proposal", () => {
    const empty = normalizePlanModeData(
        { phase: "brainstorming", proposal: { ...PROPOSAL, tests: [] }, savedTools: ["read"] },
        ["read"],
    );
    assert.equal(empty.proposal?.tests, undefined);
    const malformed = normalizePlanModeData(
        {
            phase: "brainstorming",
            proposal: { ...PROPOSAL, tests: [{ path: "src/plan.test.ts" }] },
            savedTools: ["read"],
        },
        ["read"],
    );
    assert.equal(malformed.proposal?.tests, undefined);
    assert.ok(malformed.proposal);
});

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

test("drops an optional example that is not meaningful text", () => {
    const data = normalizePlanModeData(
        {
            phase: "brainstorming",
            proposal: { ...PROPOSAL, changes: [{ ...PROPOSAL.changes[0], example: "   " }] },
            savedTools: ["read"],
        },
        ["read"],
    );
    assert.deepEqual(data.proposal?.changes, [{ path: "src/index.ts", change: PROPOSAL.changes[0].change }]);
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

test("removes proposals without a description or changes", () => {
    const { description: _description, ...withoutDescription } = PROPOSAL;
    assert.equal(
        normalizePlanModeData({ phase: "brainstorming", proposal: withoutDescription, savedTools: ["read"] }, ["read"])
            .proposal,
        undefined,
    );
    assert.equal(
        normalizePlanModeData(
            { phase: "brainstorming", proposal: { description: "Fine", changes: [] }, savedTools: ["read"] },
            ["read"],
        ).proposal,
        undefined,
    );
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

test("keeps rejection feedback only in brainstorming", () => {
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
