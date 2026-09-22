import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Directory of the calling module.
 * `import.meta.dirname` exists only on Node 20.11+; this server runs Node 18.
 */
export function moduleDir(metaUrl: string): string {
  return path.dirname(fileURLToPath(metaUrl));
}
