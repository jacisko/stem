// Claude Code transcripts → readable Markdown, for the "Claude Code" folder.
//
// A session file (~/.claude/projects/<project>/<id>.jsonl) is one JSON record
// per line, and most of it is not conversation: tool calls and their results
// (whole files, command output, pasted secrets), thinking, hook runs, cost
// bookkeeping, the skill and reminder text the harness injects as "user"
// turns. Indexing that raw would bury what the person and Claude actually
// said, so only the said parts survive here: the person's own messages and
// Claude's text replies. Cowork's audit.jsonl (the Claude app's agent mode)
// is the SDK stream of the same messages, so the same reader takes both.
//
// Pure: no disk, no clock. sync.ts decides what to read and where it lands.

export interface TranscriptTurn {
  role: 'user' | 'assistant';
  /** Epoch ms of the record, when it carries one. */
  at: number | null;
  text: string;
}

export interface Transcript {
  /** Claude's own title for the session (ai-title / custom title / summary), if any. */
  title: string | null;
  /** The directory the session ran in, from its records. */
  cwd: string | null;
  turns: TranscriptTurn[];
}

/** One message past this is cut — a pasted log is not worth a megabyte of index. */
export const MAX_TURN_CHARS = 20_000;

/**
 * A part past this starts a new file. The index skips text documents over
 * 2 MB, and a long-running session easily converts past that, so a session
 * becomes part 1, part 2, … rather than vanishing from search.
 */
export const MAX_PART_CHARS = 400_000;

type Block = { type?: unknown; text?: unknown };

function recordTime(r: Record<string, unknown>): number | null {
  const raw = r.timestamp ?? r._audit_timestamp;
  if (typeof raw !== 'string') return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

/**
 * The person's words in a user record, or null when the record is not one
 * they typed: harness injections (isMeta: skill bodies, subagent hand-backs,
 * "another session sent a message"), compaction summaries, replays, tool
 * results, and the bookkeeping local slash commands leave behind.
 */
function userText(r: Record<string, unknown>): string | null {
  if (r.isMeta || r.isSidechain || r.isCompactSummary || r.isSynthetic || r.isReplay) return null;
  if (r.parent_tool_use_id) return null; // Cowork: a subagent's prompt, written by Claude
  const content = (r.message as { content?: unknown } | undefined)?.content;
  let text: string;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content as Block[]) {
      if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      else if (b?.type === 'image') parts.push('[image]');
    }
    // Tool results only — the harness's half of a tool call, not the person.
    if (parts.length === 0) return null;
    text = parts.join('\n\n');
  } else return null;
  return cleanUserText(text);
}

/** Harness wrappers whose body is never the person's words: output, notifications, injected context. */
const HARNESS_BLOCKS =
  /<(system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr|user-shell-stdout|user-shell-stderr|user-shell-exit|task-notification|user-prompt-submit-hook|command-message)>[\s\S]*?<\/\1>/g;

export function cleanUserText(raw: string): string | null {
  if (/^\s*\[Request interrupted/.test(raw)) return null;
  let text = raw.replace(HARNESS_BLOCKS, '');
  // A slash command reads as what was typed: "/compact keep the API notes".
  const command = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (command) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim() ?? '';
    text = `${command[1].trim()}${args ? ` ${args}` : ''}`;
  }
  // A shell command typed with "!" keeps the command, never its output (dropped above).
  text = text.replace(/<(bash-input|user-shell-command)>([\s\S]*?)<\/\1>/g, (_m, _t, cmd: string) => `!${cmd.trim()}`);
  text = text.trim();
  // Whatever is still nothing but a wrapper is some other harness message this
  // list does not know yet. Dropping it is the safe side: the person's own
  // words are never one tag around the whole message.
  if (/^<([a-z][a-z0-9-]*)>[\s\S]*<\/\1>$/.test(text)) return null;
  return text ? text : null;
}

/**
 * A heading inside a message is escaped, so text that quotes "## You" or
 * "## Claude" cannot pass for a speaker line in the rendered transcript.
 */
export function neutralizeHeadings(text: string): string {
  return text.replace(/^( {0,3})(#{1,6})(?=[ \t]|$)/gm, '$1\\$2');
}

function assistantText(r: Record<string, unknown>): string | null {
  if (r.isSidechain || r.parent_tool_use_id) return null;
  const content = (r.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return null;
  const parts = (content as Block[])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => (b.text as string).trim())
    .filter(Boolean);
  return parts.length ? parts.join('\n\n') : null;
}

function cap(text: string): string {
  return text.length > MAX_TURN_CHARS ? `${text.slice(0, MAX_TURN_CHARS)}\n\n[…cut]` : text;
}

/**
 * Read a transcript's lines. Unparseable lines are skipped (a session being
 * written right now can end mid-line). Claude's reply to one prompt arrives as
 * several records — text, tool call, more text — and is joined into one turn.
 */
export function parseTranscript(lines: Iterable<string>): Transcript {
  const turns: TranscriptTurn[] = [];
  let aiTitle: string | null = null;
  let customTitle: string | null = null;
  let summary: string | null = null;
  let cwd: string | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!r || typeof r !== 'object') continue;
    if (!cwd && typeof r.cwd === 'string' && r.type !== 'system') cwd = r.cwd;
    if (r.type === 'ai-title' && typeof r.aiTitle === 'string') aiTitle = r.aiTitle.trim() || aiTitle;
    else if (r.type === 'custom-title' && typeof r.customTitle === 'string') customTitle = r.customTitle.trim() || customTitle;
    else if (r.type === 'summary' && typeof r.summary === 'string') summary ??= r.summary.trim() || null;
    else if (r.type === 'user') {
      const text = userText(r);
      if (text) turns.push({ role: 'user', at: recordTime(r), text: cap(text) });
    } else if (r.type === 'assistant') {
      const text = assistantText(r);
      if (!text) continue;
      const last = turns[turns.length - 1];
      if (last?.role === 'assistant') last.text = cap(`${last.text}\n\n${text}`);
      else turns.push({ role: 'assistant', at: recordTime(r), text: cap(text) });
    }
  }
  return { title: customTitle ?? aiTitle ?? summary, cwd, turns };
}

function firstLine(text: string, max: number): string {
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The session's display title: Claude's own, else the opening request. */
export function transcriptTitle(t: Transcript): string {
  if (t.title) return t.title;
  const first = t.turns.find((x) => x.role === 'user');
  return first ? firstLine(first.text, 80) : 'Untitled session';
}

function stamp(ms: number | null): string {
  if (ms == null) return '';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * Render a transcript as Markdown parts (usually one). Each part opens with
 * the title as its first heading, which is what the index takes as the
 * document's title. Empty when nobody said anything — a session that only ran
 * hooks is not a conversation.
 */
export function renderTranscript(
  t: Transcript,
  meta: { kind: 'Claude Code' | 'Cowork'; sessionId: string }
): string[] {
  if (!t.turns.some((x) => x.role === 'user')) return [];
  const title = transcriptTitle(t);
  const start = t.turns.find((x) => x.at != null)?.at ?? null;
  const end = [...t.turns].reverse().find((x) => x.at != null)?.at ?? null;
  const span = start != null ? ` ${stamp(start)}${end != null && end !== start ? ` to ${stamp(end)}` : ''} UTC` : '';
  const where = t.cwd && meta.kind === 'Claude Code' ? ` in \`${t.cwd}\`` : '';
  const about = `${meta.kind} session${where},${span}. Session id ${meta.sessionId}. Only the messages are kept; tool calls and their output are left out.`;

  const parts: string[] = [];
  let body: string[] = [];
  let size = 0;
  const flush = (): void => {
    if (!body.length) return;
    const n = parts.length + 1;
    parts.push(`# ${title}${n > 1 ? ` (part ${n})` : ''}\n\n${about}\n\n${body.join('\n\n')}\n`);
    body = [];
    size = 0;
  };
  for (const turn of t.turns) {
    const who = turn.role === 'user' ? 'You' : 'Claude';
    const when = turn.at != null ? ` · ${stamp(turn.at)}` : '';
    const entry = `## ${who}${when}\n\n${neutralizeHeadings(turn.text)}`;
    if (size > 0 && size + entry.length > MAX_PART_CHARS) flush();
    body.push(entry);
    size += entry.length + 2;
  }
  flush();
  return parts;
}

/**
 * A memory file's type from its frontmatter (`type:` at the top level or
 * under `metadata:`), or null when it has none.
 */
export function memoryType(text: string): string | null {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (!fm) return null;
  const type = fm.match(/^\s*type:\s*["']?([A-Za-z][\w-]*)["']?\s*$/m)?.[1];
  return type ? type.toLowerCase() : null;
}

/** A file-name-safe slug: lowercase words joined by '-', at most `max` chars. */
export function slug(text: string, max = 60): string {
  const s = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'untitled';
}

/**
 * A readable name for a Claude Code project directory. Claude names it after
 * the session's cwd with every non-alphanumeric turned into '-', so the home
 * prefix ("-Users-join3r-") is the same noise on every one of them.
 */
export function projectName(dirName: string, home: string): string {
  const homeKey = home.replace(/[^A-Za-z0-9]/g, '-');
  let name = dirName;
  if (name === homeKey) return 'home';
  if (name.startsWith(`${homeKey}-`)) name = name.slice(homeKey.length + 1);
  name = name.replace(/^-+/, '');
  return (name || 'root').slice(0, 100);
}
