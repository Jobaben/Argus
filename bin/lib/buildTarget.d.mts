/**
 * Type declarations for the launcher's build-target rules. The implementation
 * stays plain .mjs because the launcher loads it before anything is built.
 */
export const RELEASE_MANIFEST: "release.json";
export const POINTER_FILE: "current.json";

export class BuildTargetError extends Error {}

export function releasesRoot(env?: NodeJS.ProcessEnv, homedir?: string): string;
export function isReleaseId(id: unknown): id is string;
export function readPointer(root: string): { id: string } | null;
export function isRelease(dir: string): boolean;

export type BuildTarget =
  { kind: "dev"; root: string; warning: string } | { kind: "release"; root: string; id: string };

export function resolveBuildRoot(options: {
  checkout: string;
  dev?: boolean;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
}): BuildTarget;
