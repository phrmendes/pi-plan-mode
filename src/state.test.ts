import { test } from "node:test";
import assert from "node:assert/strict";
import type { PlanProposal } from "./proposal.ts";
import { normalizePlanModeData } from "./state.ts";

const PROPOSAL: PlanProposal = {
    description: "Agents should submit one short proposal that the user can accept.",
    changes: [
        {
            path: "src/index.ts",
            change: "Simplify proposal orchestration and remove duplicate steps",
            example: '"deniedTools": ["mcp__browser__*"]',
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

test("drops an optional example that is not meaningful text", () => {
    const data = normalizePlanModeData(
        {
            phase: "brainstorming",
            proposal: { ...PROPOSAL, changes: [{ ...PROPOSAL.changes[0], example: "   " }] },
            savedTools: ["read"],
        },
        ["read"],
    );
    assert.deepEqual(data.proposal?.changes, [{ path: "src/index.ts", change: PROPOSAL.changes[0]?.change }]);
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

const SAVED_MODELS: Array<{ name: string; data: Record<string, unknown>; expected: string | undefined }> = [
    { name: "keeps it while plan mode is on", data: { phase: "brainstorming", savedModel: " a/b " }, expected: "a/b" },
    { name: "drops it while plan mode is off", data: { phase: "off", savedModel: "a/b" }, expected: undefined },
    { name: "drops a value that is not text", data: { phase: "brainstorming", savedModel: 42 }, expected: undefined },
];

for (const { name, data, expected } of SAVED_MODELS) {
    test(`saved model: ${name}`, () => {
        const normalized = normalizePlanModeData(data, ["read"]);
        assert.equal(normalized.savedModel, expected);
        assert.equal("savedModel" in normalized, expected !== undefined);
    });
}

const THINKING_FLAGS: Array<{ name: string; data: Record<string, unknown>; expected: boolean | undefined }> = [
    { name: "keeps it while brainstorming", data: { phase: "brainstorming", thinking: true }, expected: true },
    {
        name: "drops it while implementing",
        data: { phase: "implementing", proposal: PROPOSAL, thinking: true },
        expected: undefined,
    },
    { name: "drops a value that is not true", data: { phase: "brainstorming", thinking: "yes" }, expected: undefined },
];

for (const { name, data, expected } of THINKING_FLAGS) {
    test(`thinking flag: ${name}`, () => {
        const normalized = normalizePlanModeData(data, ["read"]);
        assert.equal(normalized.thinking, expected);
        assert.equal("thinking" in normalized, expected !== undefined);
    });
}

const OVERRIDES = {
    "local:work": {
        brainstorming: { model: "a/b", thinkingLevel: "max" },
        implementing: { model: "a/c" },
        thinking: {},
    },
};

test("overrides: keeps them with the profile and saved thinking level", () => {
    const data = normalizePlanModeData(
        { phase: "brainstorming", savedThinkingLevel: "high", activeProfile: "local:work", overrides: OVERRIDES },
        ["read"],
    );
    assert.equal(data.savedThinkingLevel, "high");
    assert.equal(data.activeProfile, "local:work");
    assert.deepEqual(data.overrides, {
        "local:work": {
            brainstorming: { model: "a/b", thinkingLevel: "max" },
            implementing: { model: "a/c" },
        },
    });
});

test("overrides: drops them while plan mode is off", () => {
    const data = normalizePlanModeData(
        { phase: "off", savedThinkingLevel: "high", activeProfile: "local:work", overrides: OVERRIDES },
        ["read"],
    );
    assert.equal(data.savedThinkingLevel, undefined);
    assert.equal(data.activeProfile, undefined);
    assert.equal(data.overrides, undefined);
});

test("overrides: drops malformed entries", () => {
    const data = normalizePlanModeData(
        {
            phase: "brainstorming",
            overrides: {
                work: { brainstorming: { model: "   ", thinkingLevel: "loud" }, implementing: 7 },
                broken: "nope",
            },
        },
        ["read"],
    );
    assert.equal(data.overrides, undefined);
});
