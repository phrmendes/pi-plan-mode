import { test } from "node:test";
import assert from "node:assert/strict";
import { notificationArgv } from "./notify.ts";

const MESSAGE = "Proposal ready for review";

interface Case {
    name: string;
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    argv: string[] | undefined;
}

const CASES: Case[] = [
    {
        name: "linux sends the message through notify-send",
        platform: "linux",
        env: {},
        argv: ["notify-send", "-a", "Pi plan mode", MESSAGE],
    },
    { name: "off disables notifications", platform: "linux", env: { PI_PLAN_NOTIFY: "off" }, argv: undefined },
    {
        name: "OFF in capitals and spaces also disables them",
        platform: "linux",
        env: { PI_PLAN_NOTIFY: " OFF " },
        argv: undefined,
    },
    {
        name: "any other value keeps them on",
        platform: "linux",
        env: { PI_PLAN_NOTIFY: "on" },
        argv: ["notify-send", "-a", "Pi plan mode", MESSAGE],
    },
    { name: "macOS stays silent", platform: "darwin", env: {}, argv: undefined },
    { name: "windows stays silent", platform: "win32", env: {}, argv: undefined },
];

for (const item of CASES) {
    test(item.name, () => {
        assert.deepEqual(notificationArgv(item.platform, item.env, MESSAGE), item.argv);
    });
}
