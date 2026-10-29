// Tool folders in the Files place: virtualenvs, node_modules, caches.
//
// Files is the user's own shelf, and nothing ever clears it. That held up while
// the only things on it were what people dropped there — and stopped holding the
// day an assistant copied a whole working folder in "to keep it": one Python
// virtualenv was 28,885 files and 5.8 GB, every one of them walked, stat'ed and
// fed into the per-turn name list, where the 100 names the assistant got to see
// were site-packages and not the user's documents.
//
// These folders are never something a person reads. So the listing names them
// once, by kind, and does not descend; the per-turn context says the same; and a
// run_command that makes one inside Files is told so in its result
// (findNewBulky), which is where the assistant can still move it back to scratch.

import { lstat, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** Folder names that are always tooling, whatever is inside. Dotted ones (.venv, .git) are already hidden. */
const BULKY_NAMES: Record<string, string> = {
  node_modules: 'Node packages',
  bower_components: 'Node packages',
  __pycache__: 'Python cache',
  'site-packages': 'Python packages',
  'dist-packages': 'Python packages'
};

/** A file whose presence makes the folder holding it a Python environment, whatever it is called. */
const VENV_MARKERS = ['pyvenv.cfg', 'conda-meta'];

/** By name alone — cheap, so a walk can stop before reading the folder at all. */
export function bulkyKindByName(name: string): string | null {
  return BULKY_NAMES[name] ?? null;
}

/** By what the folder holds, given the names a walk already read. */
export function bulkyKindByEntries(names: readonly string[]): string | null {
  return names.some((n) => VENV_MARKERS.includes(n)) ? 'Python environment' : null;
}

/** How deep the after-command check looks; tool folders made by hand land near the top. */
const SCAN_DEPTH = 4;
/** Folders the check will visit before giving up — it runs after every command, so it must stay cheap. */
const SCAN_BUDGET = 2_000;

/**
 * Tool folders under `root` that were made or filled at or after `sinceMs`
 * (by mtime: installing into a folder rewrites its entries). Rel paths with
 * `/` separators, outermost only. Never follows a symlink, never throws.
 */
export async function findNewBulky(root: string, sinceMs: number): Promise<{ rel: string; kind: string }[]> {
  const found: { rel: string; kind: string }[] = [];
  let budget = SCAN_BUDGET;

  async function walk(dir: string, depth: number): Promise<void> {
    if (budget-- <= 0) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // quiet: a best-effort hint after a command already finished; a folder
      // that will not read just goes unchecked.
      return;
    }
    if (dir !== root) {
      const kind = bulkyKindByEntries(entries.map((e) => e.name));
      if (kind) {
        // quiet: gone between the readdir and now — nothing left to report.
        const info = await lstat(dir).catch(() => null);
        if (info && info.mtimeMs >= sinceMs) found.push({ rel: relative(root, dir).split(sep).join('/'), kind });
        return;
      }
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const abs = join(dir, e.name);
      const kind = bulkyKindByName(e.name);
      if (kind) {
        // quiet: as above — a folder that vanished mid-walk is not news.
        const info = await lstat(abs).catch(() => null);
        if (info && info.mtimeMs >= sinceMs) found.push({ rel: relative(root, abs).split(sep).join('/'), kind });
        continue;
      }
      if (depth < SCAN_DEPTH) await walk(abs, depth + 1);
    }
  }

  await walk(root, 0);
  return found;
}
