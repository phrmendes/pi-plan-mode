import { spawn } from "node:child_process";
import { basename } from "node:path";

/** How long the branch lookup may take before it gives up and notifies without it. */
const BRANCH_TIMEOUT_MS = 2000;

/** Returns the argv for one desktop notification, or undefined when it is off or unsupported. */
export function notificationArgv(
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv,
    message: string,
    context?: string,
): string[] | undefined {
    if (platform !== "linux") return undefined;
    if ((env.PI_PLAN_NOTIFY ?? "").trim().toLowerCase() === "off") return undefined;
    return ["notify-send", "-a", "Pi plan mode", "--", message, ...(context ? [context] : [])];
}

/** Names the project that waits, as `<folder> on <branch>`, or just the folder without a branch. */
export function projectContext(cwd: string, branch?: string): string {
    const folder = basename(cwd) || cwd;
    return branch ? `${folder} on ${branch}` : folder;
}

/** Returns the current branch through git, or undefined outside a repository and on a detached head. */
export async function readBranch(cwd: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        const child = spawn("git", ["-C", cwd, "branch", "--show-current"], {
            stdio: ["ignore", "pipe", "ignore"],
            timeout: BRANCH_TIMEOUT_MS,
        });
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });
        child.on("error", () => resolve(undefined));
        child.on("close", (code) => resolve(code === 0 ? output.trim() || undefined : undefined));
    });
}

/** Returns a notifier that never blocks the session and never throws. */
export function createDesktopNotifier(
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    lookup: (cwd: string) => Promise<string | undefined> = readBranch,
): (message: string, cwd?: string) => void {
    return (message, cwd) => {
        if (!notificationArgv(platform, env, message)) return;
        const finish = (context?: string) => {
            const [command, ...args] = notificationArgv(platform, env, message, context) ?? [];
            if (!command) return;
            const child = spawn(command, args, { detached: true, stdio: "ignore" });
            child.on("error", () => {});
            child.unref();
        };
        if (!cwd) {
            finish();
            return;
        }
        lookup(cwd).then(
            (branch) => finish(projectContext(cwd, branch)),
            () => finish(projectContext(cwd)),
        );
    };
}
