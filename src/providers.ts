/**
 * Every storage provider beyond projects, worktrees and simulators, in the
 * order they are shown. Commands, stats and the doctor all read this list.
 */
import { cachesProvider } from "./caches";
import { dockerProvider } from "./docker";
import { toolsProvider } from "./tools";
import { xcodeProvider } from "./xcode";
import type { StorageProvider } from "./storage";

export const PROVIDERS: StorageProvider[] = [cachesProvider, xcodeProvider, dockerProvider, toolsProvider];

/** `purrge <command>` → provider. A few natural aliases. */
export const PROVIDER_COMMANDS = new Map<string, StorageProvider>([
  ["caches", cachesProvider],
  ["cache", cachesProvider],
  ["xcode", xcodeProvider],
  ["deriveddata", xcodeProvider],
  ["docker", dockerProvider],
  ["tools", toolsProvider],
  ["versions", toolsProvider],
]);
