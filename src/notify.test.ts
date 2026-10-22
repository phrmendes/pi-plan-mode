import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopNotifier, notificationArgv, projectContext, readBranch } from "./notify.ts";

const MESSAGE = "Proposal ready for review";
const BASE = ["notify-send", "-a", "Pi plan mode", "--", MESSAGE];

interface Case {
    name: string;
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    argv: string[] | undefined;
}

const CASES: Case[] = [
    { name: "linux sends the message through notify-send", platform: "linux", env: {}, argv: BASE },
    { name: "off disables notifications", platform: "linux", env: { PI_PLAN_NOTIFY: "off" }, argv: undefined },
    {
        name: "OFF in capitals and spaces also disables them",
        platform: "linux",
        env: { PI_PLAN_NOTIFY: " OFF " },
        argv: undefined,
    },
    { name: "any other value keeps them on", platform: "linux", env: { PI_PLAN_NOTIFY: "on" }, argv: BASE },
    { name: "macOS stays silent", platform: "darwin", env: {}, argv: undefined },
    { name: "windows stays silent", platform: "win32", env: {}, argv: undefined },
];

for (const item of CASES) {
    test(item.name, () => {
        assert.deepEqual(notificationArgv(item.platform, item.env, MESSAGE), item.argv);
    });
}

test("the project context goes after a separator, so it cannot act as an option", () => {
    const argv = notificationArgv("linux", {}, MESSAGE, "-rf on main");
    assert.deepEqual(argv, [...BASE, "-rf on main"]);
    assert.equal(argv?.indexOf("--"), 3);
});

test("projectContext joins the folder and the branch", () => {
    assert.equal(projectContext("/home/u/dotfiles", "main"), "dotfiles on main");
});

test("projectContext drops a missing branch", () => {
    assert.equal(projectContext("/home/u/dotfiles", undefined), "dotfiles");
});

test("projectContext tolerates a trailing slash and an empty branch", () => {
    assert.equal(projectContext("/home/u/dotfiles/", "main"), "dotfiles on main");
    assert.equal(projectContext("/home/u/dotfiles/", ""), "dotfiles");
});

function withRepo(branch: string, run: (dir: string) => Promise<void>): Promise<void> {
    return (async () => {
        const dir = mkdtempSync(join(tmpdir(), "pi-notify-branch-"));
        try {
            execFileSync("git", ["init", "-q", "-b", branch, dir]);
            execFileSync("git", [
                "-C",
                dir,
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "x",
            ]);
            await run(dir);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    })();
}

test("readBranch returns the branch of a repository", async () => {
    await withRepo("feature-x", async (dir) => {
        assert.equal(await readBranch(dir), "feature-x");
    });
});

test("readBranch returns nothing outside a repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-notify-plain-"));
    try {
        assert.equal(await readBranch(dir), undefined);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("readBranch returns nothing on a detached head", async () => {
    await withRepo("main", async (dir) => {
        execFileSync("git", ["-C", dir, "checkout", "-q", "--detach"]);
        assert.equal(await readBranch(dir), undefined);
    });
});

test("a disabled gate never looks up the branch", () => {
    const calls: string[] = [];
    const lookup = async (cwd: string) => {
        calls.push(cwd);
        return "main";
    };
    createDesktopNotifier("darwin", {}, lookup)("m", "/x");
    createDesktopNotifier("linux", { PI_PLAN_NOTIFY: "off" }, lookup)("m", "/x");
    assert.deepEqual(calls, []);
});

test("the notifier passes the project context to the command", async () => {
    // The spawn inherits process.env, so the stub must reach it through PATH.
    const stubDir = mkdtempSync(join(tmpdir(), "pi-notify-stub-"));
    const log = join(stubDir, "log");
    const originalPath = process.env.PATH;
    writeFileSync(join(stubDir, "notify-send"), `#!/bin/sh\nprintf "%s\\n" "$*" >> ${log}\n`);
    chmodSync(join(stubDir, "notify-send"), 0o755);
    process.env.PATH = `${stubDir}:${originalPath ?? ""}`;
    try {
        createDesktopNotifier("linux", {}, async () => "main")("Proposal ready for review", "/home/u/dotfiles");
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(readFileSync(log, "utf8").trim(), "-a Pi plan mode -- Proposal ready for review dotfiles on main");
    } finally {
        process.env.PATH = originalPath;
        rmSync(stubDir, { recursive: true, force: true });
    }
});
