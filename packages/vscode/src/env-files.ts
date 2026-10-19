import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The credential files from `aqa.envFile` that exist in the folder, in order.
 * The setting may list several, comma-separated, as `aqa run --env` takes
 * them ("first file to set a variable wins"). Checked one by one: the whole
 * list was once checked as a single file name, which never exists, so
 * `--env` was dropped and the run read `.env` alone (RC check, 19 Oct 2026).
 * The files are passed by name; the extension never opens them.
 */
export function presentEnvFiles(root: string, setting: string): string[] {
  return setting
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f.length > 0 && existsSync(join(root, f)));
}
