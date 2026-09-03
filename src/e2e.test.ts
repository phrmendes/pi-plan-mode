import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createAgentSession,
    DefaultResourceLoader,
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

    // Use a scratch agent dir, not getAgentDir(), so the test only loads the local extension under
    // test and never a real globally-installed copy of this same package.
    const resourceLoader = new DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir: mkdtempSync(join(tmpdir(), "pi-plan-mode-e2e-")),
        extensionFactories: [
            (pi) =>
                planMode(pi, {
                    nushell: { shellPath: process.env.PI_NUSHELL_PATH ?? "/run/current-system/sw/bin/nu" },
                }),
            fauxProviderExtension,
        ],
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

test("brainstorming: the real nushell tool executes a direct Nushell pipeline", async () => {
    const sessionManager = SessionManager.inMemory();
    const { session, faux } = await createFakeModelSession(sessionManager);

    faux.setResponses([
        fauxAssistantMessage([fauxToolCall("nushell", { command: "echo hello | str uppercase" })], {
            stopReason: "toolUse",
        }),
        fauxAssistantMessage("Pipeline verified.", { stopReason: "stop" }),
    ]);

    await session.prompt("Run a safe Nushell pipeline.");

    assert.match(JSON.stringify(sessionManager.getEntries()), /HELLO/);
    session.dispose();
});

test("brainstorming: the real nushell tool rejects a write before execution", async () => {
    const sessionManager = SessionManager.inMemory();
    const { session, faux } = await createFakeModelSession(sessionManager);

    faux.setResponses([
        fauxAssistantMessage([fauxToolCall("nushell", { command: "print forbidden | save output.txt" })], {
            stopReason: "toolUse",
        }),
        fauxAssistantMessage("The command was blocked.", { stopReason: "stop" }),
    ]);

    await session.prompt("Try a forbidden planning command.");

    assert.match(JSON.stringify(sessionManager.getEntries()), /not a read-only command/i);
    session.dispose();
});

test("implementing: the real nushell tool runs without the planning policy", async () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendCustomEntry("plan-mode", {
        phase: "implementing",
        proposal: PROPOSAL,
        savedTools: FULL_TOOLS,
    });
    const { session, faux } = await createFakeModelSession(sessionManager);

    faux.setResponses([
        fauxAssistantMessage([fauxToolCall("nushell", { command: "echo unrestricted" })], {
            stopReason: "toolUse",
        }),
        fauxAssistantMessage("Nushell is unrestricted during implementation.", { stopReason: "stop" }),
    ]);

    await session.prompt("Run an implementation shell command.");

    assert.match(JSON.stringify(sessionManager.getEntries()), /unrestricted/);
    session.dispose();
});

test("the real nushell tool runs in the project working directory", async () => {
    const sessionManager = SessionManager.inMemory();
    const { session, faux } = await createFakeModelSession(sessionManager);

    faux.setResponses([
        fauxAssistantMessage([fauxToolCall("nushell", { command: "pwd" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("Working directory verified.", { stopReason: "stop" }),
    ]);

    await session.prompt("Show the project directory.");

    assert.match(
        JSON.stringify(sessionManager.getEntries()),
        new RegExp(process.cwd().replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")),
    );
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

        // The reminder fires asynchronously after the first turn settles, so wait for its effect
        // (plan_complete reverting the phase) rather than for a specific count of framework events.
        const phaseRevertedToBrainstorming = new Promise<void>((resolve) => {
            if (lastPlanModeEntry(sessionManager)?.phase === "brainstorming") {
                resolve();
                return;
            }
            const unsubscribe = session.subscribe((event) => {
                if (event.type !== "entry_appended") return;
                if (lastPlanModeEntry(sessionManager)?.phase !== "brainstorming") return;
                unsubscribe();
                resolve();
            });
        });

        await session.prompt("Implement the approved proposal.");
        await phaseRevertedToBrainstorming;

        assert.ok(faux.state.callCount >= 2, "the reminder should have triggered a second model turn");
        assert.equal(lastPlanModeEntry(sessionManager)?.phase, "brainstorming");

        session.dispose();
    },
);
