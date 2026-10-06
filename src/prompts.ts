import { readFileSync } from "node:fs";
import type { ActivePhase } from "./state.ts";

/**
 * Creates a loader that reads `<phase>.md` from a directory URL and caches each prompt until `clear`.
 * A missing file gives null; any other read error is thrown.
 */
export function createPromptLoader(dir: URL) {
    const cache = new Map<ActivePhase, string>();
    return {
        load(phase: ActivePhase): string | null {
            const cached = cache.get(phase);
            if (cached !== undefined) return cached;
            try {
                const content = readFileSync(new URL(`${phase}.md`, dir), "utf8");
                cache.set(phase, content);
                return content;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
                throw error;
            }
        },
        clear(): void {
            cache.clear();
        },
    };
}
