import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { memoryType, parseTranscript, projectName, renderTranscript, slug, transcriptTitle } from './convert';

// One pass of the Claude Code export: read what Claude keeps on this machine,
// write the readable copy the "Claude Code" folder mirrors.
//
//   memory/<type>/<project>/<name>.md     Claude Code's memory files, as they are
//   sessions/<project>/<date>-<title>-<id>.md   one per session (more when long)
//   cowork/<date>-<title>-<id>.md         the Claude app's agent-mode sessions
//
// The copy is an ARCHIVE, not a mirror. Claude Code deletes sessions older
// than its cleanup period (30 days unless changed), and a session that leaves
// ~/.claude keeps its copy here — that is most of the point of keeping one.
// The one thing that removes a copy is learning the session was Stem's own:
// a coding persona's run is already in Stem as the chat that asked for it.
//
// Incremental by (mtime, size) per source, recorded in a state file beside
// the copy (never inside it — everything inside is uploaded). A converted file
// is rewritten only when its text changed, so a session Claude is appending
// to re-uploads only when something new was said.

export interface ClaudeExportPaths {
  /** ~/.claude/projects */
  projectsDir: string;
  /** The Claude app's local-agent-mode-sessions, or null where there is none. */
  coworkDir: string | null;
  /** The copy the folder mirrors. */
  outDir: string;
  /** The incremental state, outside outDir. */
  statePath: string;
  /** Home directory, for readable project names. */
  home: string;
}

export interface ClaudeExportResult {
  /** Sources (re)converted this pass. */
  converted: number;
  /** Copies removed because the session turned out to be Stem's own. */
  excluded: number;
  /** Sources known in total, including archived ones no longer on disk. */
  sources: number;
}

interface SourceState {
  mtimeMs: number;
  size: number;
  /** Paths under outDir this source produced, '/'-separated. */
  outputs: string[];
  /** The session id, for sessions (exclusion matches on it). */
  sessionId?: string;
  excluded?: boolean;
}

interface ExportState {
  version: 1;
  sources: Record<string, SourceState>;
}

/** A session file larger than this is read anyway; this only bounds a single line. */
const MAX_LINE_CHARS = 8 * 1024 * 1024;

async function loadState(path: string): Promise<ExportState> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<ExportState>;
    if (raw && raw.version === 1 && raw.sources && typeof raw.sources === 'object') return raw as ExportState;
  } catch {
    // quiet: no state yet (first pass) or a corrupt one — every source converts
    // again, and identical output is not rewritten, so nothing re-uploads.
  }
  return { version: 1, sources: {} };
}

async function saveState(path: string, state: ExportState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
  await rename(tmp, path);
}

async function readLines(path: string): Promise<string[]> {
  const lines: string[] = [];
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    // A record this long is a tool result carrying a whole file; nothing kept
    // from a transcript lives in one, so it is dropped rather than parsed.
    if (line.length <= MAX_LINE_CHARS) lines.push(line);
  }
  return lines;
}

async function listDir(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    // quiet: an absent source (no Cowork on this machine, Claude Code never
    // run) is simply nothing to export.
    return [];
  }
}

interface Source {
  abs: string;
  kind: 'session' | 'memory' | 'cowork';
  project?: string;
  sessionId?: string;
  /** Cowork: the session's metadata file, which holds its title. */
  metaPath?: string;
}

async function findSources(p: ClaudeExportPaths): Promise<Source[]> {
  const out: Source[] = [];
  for (const proj of await listDir(p.projectsDir)) {
    if (!proj.isDirectory() || proj.name.startsWith('.')) continue;
    const dir = join(p.projectsDir, proj.name);
    const project = projectName(proj.name, p.home);
    for (const e of await listDir(dir)) {
      // Top-level files only: subagents/ and tool-results/ are Claude talking
      // to itself and dumps of tool output, not the person's conversations.
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        out.push({ abs: join(dir, e.name), kind: 'session', project, sessionId: basename(e.name, '.jsonl') });
      }
    }
    for (const e of await listDir(join(dir, 'memory'))) {
      // MEMORY.md is the index of pointers to the other files, nothing of its own.
      if (e.isFile() && e.name.endsWith('.md') && e.name !== 'MEMORY.md') {
        out.push({ abs: join(dir, 'memory', e.name), kind: 'memory', project });
      }
    }
  }
  if (p.coworkDir) {
    // <account>/<workspace>/local_<id>/audit.jsonl, with local_<id>.json beside the directory.
    for (const account of await listDir(p.coworkDir)) {
      if (!account.isDirectory()) continue;
      for (const space of await listDir(join(p.coworkDir, account.name))) {
        if (!space.isDirectory()) continue;
        const spaceDir = join(p.coworkDir, account.name, space.name);
        for (const s of await listDir(spaceDir)) {
          if (!s.isDirectory() || !s.name.startsWith('local_')) continue;
          out.push({
            abs: join(spaceDir, s.name, 'audit.jsonl'),
            kind: 'cowork',
            sessionId: s.name.slice('local_'.length),
            metaPath: join(spaceDir, `${s.name}.json`)
          });
        }
      }
    }
  }
  return out;
}

async function coworkTitle(metaPath: string | undefined): Promise<string | null> {
  if (!metaPath) return null;
  try {
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { title?: unknown };
    return typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : null;
  } catch {
    // quiet: no metadata file — the opening request names the session instead.
    return null;
  }
}

function datePrefix(ms: number | null): string {
  return ms == null ? 'undated' : new Date(ms).toISOString().slice(0, 10);
}

/** What one source converts to: '/'-separated rel → file text. */
async function convert(src: Source): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  if (src.kind === 'memory') {
    const text = await readFile(src.abs, 'utf8');
    const type = memoryType(text) ?? 'other';
    files.set(`memory/${slug(type, 30)}/${src.project}/${basename(src.abs)}`, text);
    return files;
  }
  const t = parseTranscript(await readLines(src.abs));
  if (src.kind === 'cowork') t.title = (await coworkTitle(src.metaPath)) ?? t.title;
  const parts = renderTranscript(t, { kind: src.kind === 'cowork' ? 'Cowork' : 'Claude Code', sessionId: src.sessionId! });
  if (!parts.length) return files;
  const start = t.turns.find((x) => x.at != null)?.at ?? null;
  const stem = `${datePrefix(start)}-${slug(transcriptTitle(t), 50)}-${src.sessionId!.slice(0, 8)}`;
  const dir = src.kind === 'cowork' ? 'cowork' : `sessions/${src.project}`;
  parts.forEach((text, i) => files.set(`${dir}/${stem}${i ? `-part${i + 1}` : ''}.md`, text));
  return files;
}

/** Written beside the state file and renamed in: a temp file inside the copy would be uploaded. */
async function writeIfChanged(abs: string, text: string, tmpDir: string): Promise<void> {
  const current = await readFile(abs, 'utf8').catch(() => null);
  if (current === text) return;
  await mkdir(dirname(abs), { recursive: true });
  const tmp = join(tmpDir, `claude-export-${process.pid}.tmp`);
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, abs);
}

async function removeOutputs(outDir: string, rels: string[]): Promise<void> {
  for (const rel of rels) await rm(join(outDir, ...rel.split('/')), { force: true });
}

/**
 * One export pass. `excluded` holds the session ids Stem itself started on
 * this machine; their copies are removed and they are never converted.
 */
export async function syncClaudeExport(p: ClaudeExportPaths, excluded: ReadonlySet<string>): Promise<ClaudeExportResult> {
  const state = await loadState(p.statePath);
  await mkdir(p.outDir, { recursive: true });
  await mkdir(dirname(p.statePath), { recursive: true });
  let converted = 0;
  let excludedNow = 0;

  for (const src of await findSources(p)) {
    const prior = state.sources[src.abs];
    if (src.sessionId && src.kind === 'session' && excluded.has(src.sessionId)) {
      if (prior?.outputs.length) {
        await removeOutputs(p.outDir, prior.outputs);
        excludedNow++;
      }
      state.sources[src.abs] = { mtimeMs: 0, size: 0, outputs: [], sessionId: src.sessionId, excluded: true };
      continue;
    }
    const info = await stat(src.abs).catch(() => null);
    if (!info?.isFile()) continue; // a Cowork directory without its audit log yet
    const mtimeMs = Math.round(info.mtimeMs);
    if (prior && !prior.excluded && prior.mtimeMs === mtimeMs && prior.size === info.size) continue;
    let files: Map<string, string>;
    try {
      files = await convert(src);
    } catch {
      // quiet: unreadable right now (permissions, mid-rename). The state is
      // left as it was, so the next pass tries this source again.
      continue;
    }
    for (const [rel, text] of files) await writeIfChanged(join(p.outDir, ...rel.split('/')), text, dirname(p.statePath));
    // A title change renames the copy, and a shorter session drops a part:
    // whatever this source wrote before and did not write now goes.
    const stale = (prior?.outputs ?? []).filter((rel) => !files.has(rel));
    await removeOutputs(p.outDir, stale);
    state.sources[src.abs] = {
      mtimeMs,
      size: info.size,
      outputs: [...files.keys()],
      ...(src.sessionId ? { sessionId: src.sessionId } : {})
    };
    converted++;
  }

  // An archived session (its source gone from ~/.claude) found to be Stem's own.
  for (const s of Object.values(state.sources)) {
    if (!s.excluded && s.sessionId && excluded.has(s.sessionId) && s.outputs.length) {
      await removeOutputs(p.outDir, s.outputs);
      s.outputs = [];
      s.excluded = true;
      excludedNow++;
    }
  }

  await saveState(p.statePath, state);
  return { converted, excluded: excludedNow, sources: Object.keys(state.sources).length };
}

/**
 * The Claude Code session ids Stem's own coding personas started on this
 * machine: every acpx session record under the given harness state dirs
 * carries the agent's session id, which is the session file's name.
 */
export async function stemStartedSessionIds(harnessDirs: string[]): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const dir of new Set(harnessDirs)) {
    for (const e of await listDir(join(dir, 'sessions'))) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(await readFile(join(dir, 'sessions', e.name), 'utf8')) as { acp_session_id?: unknown };
        if (typeof rec.acp_session_id === 'string' && rec.acp_session_id) ids.add(rec.acp_session_id);
      } catch {
        // quiet: acpx's half-written temp files and foreign JSON are not records.
      }
    }
  }
  return ids;
}
