import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createPromptLoader } from "./prompts.ts";

/** Creates an empty prompt directory and returns its path and URL. */
function promptDir(): { path: string; url: URL } {
    const path = mkdtempSync(join(tmpdir(), "pi-plan-mode-prompts-"));
    return { path, url: pathToFileURL(`${path}/`) };
}

test("a changed prompt file applies only after the cache is cleared", () => {
    const dir = promptDir();
    writeFileSync(join(dir.path, "brainstorming.md"), "first");
    const prompts = createPromptLoader(dir.url);
    assert.equal(prompts.load("brainstorming"), "first");
    writeFileSync(join(dir.path, "brainstorming.md"), "second");
    assert.equal(prompts.load("brainstorming"), "first");
    prompts.clear();
    assert.equal(prompts.load("brainstorming"), "second");
});

test("a missing prompt file gives null", () => {
    assert.equal(createPromptLoader(promptDir().url).load("implementing"), null);
});

test("a prompt that cannot be read is reported, not treated as missing", () => {
    const dir = promptDir();
    mkdirSync(join(dir.path, "brainstorming.md"));
    assert.throws(() => createPromptLoader(dir.url).load("brainstorming"), /EISDIR/);
});

test("the package ships a prompt for every phase", () => {
    const prompts = createPromptLoader(new URL("../prompts/", import.meta.url));
    for (const phase of ["brainstorming", "implementing"] as const) {
        assert.ok(prompts.load(phase)?.trim(), phase);
    }
});
