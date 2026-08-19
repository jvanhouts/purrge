import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_PURGE_STALE_WEEKS_AMOUNT = 8;
export const DEFAULT_CARGO_SWEEP_STALE_DAYS_AMOUNT = 14;

export type Config = {
  PURGE_STALE_WEEKS_AMOUNT: number;
  CARGO_SWEEP_STALE_DAYS_AMOUNT: number;
};

/** Load purrge.config.json from the directory the command is run in. */
export async function loadConfig(cwd = process.cwd()): Promise<Config> {
  const config: Config = {
    PURGE_STALE_WEEKS_AMOUNT: DEFAULT_PURGE_STALE_WEEKS_AMOUNT,
    CARGO_SWEEP_STALE_DAYS_AMOUNT: DEFAULT_CARGO_SWEEP_STALE_DAYS_AMOUNT,
  };

  try {
    const file = JSON.parse(await readFile(join(cwd, "purrge.config.json"), "utf8"));
    for (const key of Object.keys(config) as (keyof Config)[]) {
      if (typeof file?.[key] === "number" && Number.isFinite(file[key]) && file[key] >= 0) {
        config[key] = file[key];
      }
    }
  } catch {
    // A config file is optional. Environment variables still apply below.
  }

  for (const key of Object.keys(config) as (keyof Config)[]) {
    const value = process.env[key];
    if (value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0) {
      config[key] = Number(value);
    }
  }
  return config;
}
