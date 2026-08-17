import { test } from "node:test";
import assert from "node:assert/strict";
import {
    createAgentSession,
    DefaultResourceLoader,
    getAgentDir,
    SessionManager,
    type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import planMode from "./index.ts";
import type { PlanProposal } from "./state.ts";

const FULL_TOOLS = ["read", "bash", "edit", "write"];
const PROPOSAL: PlanProposal = {
    title: "Improve flow",
    problem: "The flow is hard to follow",
    outcome: "The proposal flow is clear",
    approach: "Use one proposal tool for submission and approval.",
    changes: [{ path: "src/index.ts", change: "Simplify orchestration and remove duplicate actions" }],
    acceptanceCriteria: ["One tool submits the proposal", "Transition tests pass"],
};

/** Builds a real pi agent session wired to a scripted (network-free) fake model. */
async function createFakeModelSession(sessionManager: SessionManager) {
    const faux = fauxProvider();
    const fauxProviderExtension = (pi: ExtensionAPI): void => {
        pi.registerProvider(faux.provider);
    };

    const resourceLoader = new DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir: getAgentDir(),
        extensionFactories: [planMode, fauxProviderExtension],
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
        resourceLoader,
        sessionManager,
        model: faux.getModel(),
    });
    // Bare createAgentSession() does not fire session_start; that only happens once extensions
    // are bound to a running mode (normally done by pi's interactive/print/RPC runners).
    await session.bindExtensions({ mode: "print" });

    return { session, faux };
}

function lastPlanModeEntry(sessionManager: SessionManager): { phase?: string } | undefined {
    const entries = sessionManager
        .getEntries()
        .filter((entry): entry is Extract<typeof entry, { type: "custom" }> => entry.type === "custom")
        .filter((entry) => entry.customType === "plan-mode");
    return entries.at(-1)?.data as { phase?: string } | undefined;
}

test("brainstorming: a real agent turn calling plan_propose surfaces the formatted PRD", async () => {
    const sessionManager = SessionManager.inMemory();
    const { session, faux } = await createFakeModelSession(sessionManager);

    faux.setResponses([
        fauxAssistantMessage([fauxToolCall("plan_propose", PROPOSAL)], { stopReason: "toolUse" }),
        fauxAssistantMessage("Proposal submitted for review.", { stopReason: "stop" }),
    ]);

    await session.prompt("Refactor the plan-mode workflow.");

    const transcript = JSON.stringify(sessionManager.getEntries());
    assert.match(transcript, /# Improve flow/);
    assert.match(transcript, /Transition tests pass/);

    session.dispose();
});

test(
    "implementing: the agent_settled reminder brings a silently-idle agent back to call plan_complete",
    { timeout: 5000 },
    async () => {
        const sessionManager = SessionManager.inMemory();
        sessionManager.appendCustomEntry("plan-mode", {
            phase: "implementing",
            proposal: PROPOSAL,
            savedTools: FULL_TOOLS,
        });
        const { session, faux } = await createFakeModelSession(sessionManager);

        // First turn: the model finishes without calling plan_complete (the bug we are guarding against).
        // Second turn: triggered automatically by the extension's agent_settled reminder.
        faux.setResponses([
            fauxAssistantMessage("The change is done and verified.", { stopReason: "stop" }),
            fauxAssistantMessage([fauxToolCall("plan_complete", {})], { stopReason: "toolUse" }),
            fauxAssistantMessage("Acknowledged.", { stopReason: "stop" }),
        ]);

        let settledCount = 0;
        const waitForSettled = (count: number) =>
            new Promise<void>((resolve) => {
                const unsubscribe = session.subscribe((event) => {
                    if (event.type !== "agent_settled") return;
                    settledCount++;
                    if (settledCount >= count) {
                        unsubscribe();
                        resolve();
                    }
                });
            });

        const settled = waitForSettled(2);
        await session.prompt("Implement the approved proposal.");
        await settled;

        assert.equal(faux.state.callCount, 3, "the reminder should have triggered a second model turn");
        assert.equal(lastPlanModeEntry(sessionManager)?.phase, "brainstorming");

        session.dispose();
    },
);
