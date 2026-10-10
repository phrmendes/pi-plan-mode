import {
    emptyModes,
    loadPlanFile,
    unique,
    type ParsedModes,
    type ParsedProfile,
    type PlanFile,
    type PlanModes,
    type PlanStage,
    type StageFields,
} from "./planFile.ts";
import { matchesGlob } from "./paths.ts";
import { STAGE_KEYS, type ActivePhase } from "./state.ts";

/** One profile in the resolved catalog. */
export interface LoadedProfile {
    /** Stable key: `work` for a global profile, `local:work` for a local one. */
    key: string;
    /** Display name: `work` or `work (local)`. */
    name: string;
    rank: "global" | "local";
    match: string[];
    deniedTools: string[];
    modes: PlanModes;
}

/** The merged configuration of the global and local files. */
export interface PlanConfig {
    profiles: LoadedProfile[];
    activeProfile?: string;
    globalDeniedTools: string[];
    localDeniedTools: string[];
    errors: string[];
}

interface ResolvedProfile {
    modes: ParsedModes;
    deniedTools: string[];
    match: string[];
}

/** Returns the configuration used before any file is read. */
export function emptyConfig(): PlanConfig {
    return {
        profiles: [fallbackProfile()],
        activeProfile: "default",
        globalDeniedTools: [],
        localDeniedTools: [],
        errors: [],
    };
}

/** Merges one stage over its base, keeping bans additive. */
function mergeStageFields(base: StageFields | undefined, override: StageFields): StageFields {
    const deniedTools = [...(base?.deniedTools ?? []), ...(override.deniedTools ?? [])];
    return {
        ...(base?.model ? { model: base.model } : {}),
        ...(base?.thinkingLevel ? { thinkingLevel: base.thinkingLevel } : {}),
        ...(override.model ? { model: override.model } : {}),
        ...(override.thinkingLevel ? { thinkingLevel: override.thinkingLevel } : {}),
        ...(deniedTools.length > 0 ? { deniedTools: unique(deniedTools) } : {}),
    };
}

/** Merges one stage map over its base. */
function mergeParsedModes(base: ParsedModes | undefined, override: ParsedModes): ParsedModes {
    const merged: ParsedModes = {};
    for (const stage of STAGE_KEYS) {
        const inherited = base?.[stage];
        const own = override[stage];
        if (inherited || own) merged[stage] = mergeStageFields(inherited, own ?? {});
    }
    return merged;
}

/** Returns whether a profile is registered under its local key. */
function profileId(name: string, isLocal: boolean): string {
    return `${isLocal ? "local:" : "global:"}${name}`;
}

/** Returns a profile's display name, marking local profiles. */
function displayName(name: string, isLocal: boolean): string {
    return isLocal ? `${name} (local)` : name;
}

/** Resolves a profile's extends chain into its final fields. */
function resolveProfileFields(
    name: string,
    isLocal: boolean,
    global: Record<string, ParsedProfile>,
    local: Record<string, ParsedProfile>,
    visiting: Set<string>,
    errors: string[],
): ResolvedProfile | undefined {
    const definition = isLocal ? local[name] : global[name];
    if (!definition) return undefined;
    const id = profileId(name, isLocal);
    if (visiting.has(id)) {
        errors.push(`profile "${displayName(name, isLocal)}" has a circular extends chain`);
        return undefined;
    }
    visiting.add(id);
    let base: ResolvedProfile | undefined;
    if (definition.extends) {
        const target = definition.extends;
        base =
            isLocal && target === name
                ? resolveProfileFields(name, false, global, local, visiting, errors)
                : (resolveProfileFields(target, true, global, local, visiting, errors) ??
                  resolveProfileFields(target, false, global, local, visiting, errors));
        if (!base) errors.push(`profile "${displayName(name, isLocal)}" extends unknown profile "${target}"`);
    } else if (isLocal) {
        base = resolveProfileFields(name, false, global, local, visiting, errors);
    }
    visiting.delete(id);
    return {
        modes: mergeParsedModes(base?.modes, definition.modes),
        deniedTools: unique([...(base?.deniedTools ?? []), ...definition.deniedTools]),
        match: definition.match.length > 0 ? definition.match : (base?.match ?? []),
    };
}

/** Returns the final stage of a parsed stage map. */
function finalStage(fields: StageFields | undefined): PlanStage {
    return {
        ...(fields?.model ? { model: fields.model } : {}),
        ...(fields?.thinkingLevel ? { thinkingLevel: fields.thinkingLevel } : {}),
    };
}

/** Returns the final modes of a parsed stage map. */
function finalModes(modes: ParsedModes): PlanModes {
    return {
        brainstorming: { ...finalStage(modes.brainstorming), deniedTools: modes.brainstorming?.deniedTools ?? [] },
        implementing: finalStage(modes.implementing),
        thinking: finalStage(modes.thinking),
    };
}

/** Returns one resolved profile catalog entry. */
function loadedProfile(
    key: string,
    name: string,
    rank: LoadedProfile["rank"],
    resolved: ResolvedProfile | undefined,
    definition: ParsedProfile,
): LoadedProfile {
    return {
        key,
        name,
        rank,
        match: resolved?.match ?? definition.match,
        deniedTools: resolved?.deniedTools ?? definition.deniedTools,
        modes: finalModes(resolved?.modes ?? definition.modes),
    };
}

/** Returns the profile used when the catalog is empty, which the merge prevents. */
function fallbackProfile(): LoadedProfile {
    return { key: "default", name: "default", rank: "global", match: [], deniedTools: [], modes: emptyModes() };
}

/** Merges the global and local files into the resolved catalog. */
export function mergePlanConfigs(global: PlanFile, local?: PlanFile): PlanConfig {
    const errors = [...global.errors, ...(local?.errors ?? [])];
    const localProfiles = local?.profiles ?? {};
    const profiles: LoadedProfile[] = [];
    for (const [name, definition] of Object.entries(global.profiles)) {
        const resolved = resolveProfileFields(name, false, global.profiles, localProfiles, new Set(), errors);
        profiles.push(loadedProfile(name, name, "global", resolved, definition));
    }
    if (!profiles.some((profile) => profile.key === "default")) profiles.push(fallbackProfile());
    for (const [name, definition] of Object.entries(localProfiles)) {
        const resolved = resolveProfileFields(name, true, global.profiles, localProfiles, new Set(), errors);
        profiles.push(loadedProfile(`local:${name}`, displayName(name, true), "local", resolved, definition));
    }
    return {
        profiles,
        activeProfile: local?.activeProfile ?? global.activeProfile,
        globalDeniedTools: global.deniedTools,
        localDeniedTools: local?.deniedTools ?? [],
        errors,
    };
}

/** Loads the global file and, when present, the local file into one configuration. */
export function loadPlanConfigs(globalPath: string, localPath?: string): PlanConfig {
    return mergePlanConfigs(loadPlanFile(globalPath), localPath ? loadPlanFile(localPath) : undefined);
}

/** Resolves a profile by key, local display name, or name, preferring a local profile. */
export function resolveProfile(config: PlanConfig, name: string | undefined): LoadedProfile | undefined {
    if (!name) return undefined;
    return (
        config.profiles.find((profile) => profile.key === `local:${name}`) ??
        config.profiles.find((profile) => profile.rank === "local" && profile.name === name) ??
        config.profiles.find((profile) => profile.key === name) ??
        config.profiles.find((profile) => profile.name === name)
    );
}

/** Selects the profile for a directory: the configured default, then a match, then `default`. */
export function selectProfile(config: PlanConfig, cwd: string): LoadedProfile {
    const configured = resolveProfile(config, config.activeProfile);
    if (configured) return configured;
    const matched =
        config.profiles.find(
            (profile) => profile.rank === "local" && profile.match.some((pattern) => matchesGlob(cwd, pattern)),
        ) ?? config.profiles.find((profile) => profile.match.some((pattern) => matchesGlob(cwd, pattern)));
    return matched ?? resolveProfile(config, "default") ?? fallbackProfile();
}

/** Returns the deny list of one phase: global, local, profile, and the brainstorming stage. */
export function effectiveDeniedTools(config: PlanConfig, profileKey: string, phase: ActivePhase): string[] {
    if (phase !== "brainstorming") return [];
    const profile = resolveProfile(config, profileKey);
    if (!profile) return unique([...config.globalDeniedTools, ...config.localDeniedTools]);
    return unique([
        ...config.globalDeniedTools,
        ...config.localDeniedTools,
        ...profile.deniedTools,
        ...profile.modes.brainstorming.deniedTools,
    ]);
}
