import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedInspectionCommand } from "./policy.ts";

const allowed = ["git status", "git blame src/index.ts", "find . -name '*.ts'", "rg TODO src", "pnpm outdated"];
const blocked = [
    "rm -rf /",
    "find . -delete",
    "find . -exec cat {} \\;",
    "fd -x rm",
    "rg --pre=rm pattern",
    "git config key value",
    "git diff --output=result",
    "curl -X POST https://example.com",
    "echo $(whoami)",
    "cat file > copy",
];

test("allows configured inspection commands", () => {
    for (const command of allowed) assert.equal(isAllowedInspectionCommand(command), true, command);
});

test("blocks mutating and unsupported shell commands", () => {
    for (const command of blocked) assert.equal(isAllowedInspectionCommand(command), false, command);
});
