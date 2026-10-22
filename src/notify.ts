import { spawn } from "node:child_process";

/** Returns the argv for one desktop notification, or undefined when it is off or unsupported. */
export function notificationArgv(
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv,
    message: string,
): string[] | undefined {
    if (platform !== "linux") return undefined;
    if ((env.PI_PLAN_NOTIFY ?? "").trim().toLowerCase() === "off") return undefined;
    return ["notify-send", "-a", "Pi plan mode", message];
}

/** Returns a notifier that never blocks the session and never throws. */
export function createDesktopNotifier(
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
): (message: string) => void {
    return (message) => {
        const [command, ...args] = notificationArgv(platform, env, message) ?? [];
        if (!command) return;
        const child = spawn(command, args, { detached: true, stdio: "ignore" });
        child.on("error", () => {});
        child.unref();
    };
}
