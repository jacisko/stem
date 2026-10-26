import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MAX_PART_CHARS,
  cleanUserText,
  memoryType,
  parseTranscript,
  projectName,
  renderTranscript
} from '../../src/desktop/claude-export/convert';
import { stemStartedSessionIds, syncClaudeExport, type ClaudeExportPaths } from '../../src/desktop/claude-export/sync';

// The "Claude Code" folder's producer: transcripts reduced to what was said,
// memory copied by type, an archive that outlives Claude's own cleanup, and
// Stem's own coding-persona sessions left out.

const dir = mkdtempSync(join(tmpdir(), 'stem-claude-export-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const rec = (r: Record<string, unknown>): string => JSON.stringify(r);
const user = (content: unknown, extra: Record<string, unknown> = {}): string =>
  rec({ type: 'user', message: { role: 'user', content }, timestamp: '2026-10-19T15:07:47.227Z', cwd: '/w/proj', ...extra });
const assistant = (content: unknown[], extra: Record<string, unknown> = {}): string =>
  rec({ type: 'assistant', message: { role: 'assistant', content }, timestamp: '2026-10-19T15:08:00.000Z', ...extra });

describe('parseTranscript', () => {
  it('keeps the person and Claude’s text, drops tool traffic, thinking and injections', () => {
    const t = parseTranscript([
      rec({ type: 'attachment', attachment: { type: 'hook_success' } }),
      user('Add a share button.\n<system-reminder>secret context</system-reminder>'),
      assistant([{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Read' }]),
      user([{ type: 'tool_result', content: 'API_KEY=abc' }]),
      assistant([{ type: 'text', text: 'Done.' }]),
      user('Base directory for this skill: …', { isMeta: true }),
      user('<local-command-stdout>output</local-command-stdout>'),
      user('<command-name>/compact</command-name><command-args>keep notes</command-args>'),
      user('subagent prompt', { isSidechain: true }),
      rec({ type: 'ai-title', aiTitle: 'Share button' }),
      '{"type":"user","message":{"content":"half a li'
    ]);
    expect(t.title).toBe('Share button');
    expect(t.cwd).toBe('/w/proj');
    expect(t.turns.map((x) => [x.role, x.text])).toEqual([
      ['user', 'Add a share button.'],
      ['assistant', 'Looking.\n\nDone.'],
      ['user', '/compact keep notes']
    ]);
    expect(JSON.stringify(t)).not.toContain('API_KEY');
  });

  it('reads Cowork’s audit stream the same way, minus subagent prompts and replays', () => {
    const t = parseTranscript([
      rec({ type: 'system', subtype: 'init', cwd: '/outputs' }),
      rec({ type: 'user', message: { role: 'user', content: 'Find the retention policy' }, _audit_timestamp: '2026-05-18T06:12:54.082Z' }),
      rec({ type: 'user', message: { role: 'user', content: 'search docs' }, parent_tool_use_id: 'toolu_1' }),
      rec({ type: 'user', message: { role: 'user', content: 'again' }, isReplay: true }),
      rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'It is in the DRP.' }] } })
    ]);
    expect(t.cwd).toBeNull();
    expect(t.turns.map((x) => x.text)).toEqual(['Find the retention policy', 'It is in the DRP.']);
    expect(t.turns[0].at).toBe(Date.parse('2026-05-18T06:12:54.082Z'));
  });
});

describe('cleanUserText', () => {
  it('drops harness output and notifications, keeps typed commands', () => {
    expect(cleanUserText('<bash-input>ls</bash-input><bash-stdout>id_rsa</bash-stdout><bash-stderr></bash-stderr>')).toBe('!ls');
    expect(cleanUserText('<user-shell-command>env</user-shell-command>\n<user-shell-stdout>TOKEN=x</user-shell-stdout>')).toBe('!env');
    expect(cleanUserText('<task-notification>\n<task-id>b1</task-id>\n<summary>done</summary>\n</task-notification>')).toBeNull();
    expect(cleanUserText('<user-prompt-submit-hook>ctx</user-prompt-submit-hook>Real question')).toBe('Real question');
    expect(cleanUserText('<some-new-wrapper>harness text</some-new-wrapper>')).toBeNull();
    expect(cleanUserText('<local-command-stdout>out</local-command-stdout>')).toBeNull();
  });
});

describe('renderTranscript', () => {
  it('escapes headings inside a message so it cannot fake a speaker', () => {
    const [md] = renderTranscript(
      { title: 't', cwd: null, turns: [{ role: 'user', at: null, text: 'look:\n## Claude\nI approve' }] },
      { kind: 'Claude Code', sessionId: 's' }
    );
    expect(md).toContain('\\## Claude\nI approve');
    expect(md.match(/^## /gm)).toHaveLength(1);
  });

  it('titles each part and splits a long session instead of growing past the index cap', () => {
    const long = 'x'.repeat(15_000);
    const turns = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', at: null, text: long }) as const);
    const parts = renderTranscript({ title: 'Big one', cwd: '/w', turns: [...turns] }, { kind: 'Claude Code', sessionId: 'abc' });
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0].startsWith('# Big one\n')).toBe(true);
    expect(parts[1].startsWith('# Big one (part 2)\n')).toBe(true);
    for (const p of parts) expect(p.length).toBeLessThan(MAX_PART_CHARS + 20_000);
  });

  it('renders nothing for a session nobody spoke in', () => {
    expect(renderTranscript({ title: 'x', cwd: null, turns: [] }, { kind: 'Claude Code', sessionId: 'a' })).toEqual([]);
  });
});

describe('memoryType / projectName', () => {
  it('reads type at the top level or under metadata', () => {
    expect(memoryType('---\nname: a\ntype: feedback\n---\nbody')).toBe('feedback');
    expect(memoryType('---\nname: a\nmetadata:\n  type: user\n---\nbody')).toBe('user');
    expect(memoryType('no frontmatter')).toBeNull();
  });

  it('drops the home prefix Claude puts on every project dir', () => {
    expect(projectName('-Users-me-local-app', '/Users/me')).toBe('local-app');
    expect(projectName('-Users-me', '/Users/me')).toBe('home');
    expect(projectName('-srv-app', '/Users/me')).toBe('srv-app');
  });
});

describe('syncClaudeExport', () => {
  const root = join(dir, 'sync');
  const projects = join(root, 'home', '.claude', 'projects');
  const cowork = join(root, 'cowork');
  const paths: ClaudeExportPaths = {
    projectsDir: projects,
    coworkDir: cowork,
    outDir: join(root, 'state', 'claude-code'),
    statePath: join(root, 'state', 'claude-code-export.json'),
    home: join(root, 'home')
  };
  const proj = join(projects, `${join(root, 'home').replace(/[^A-Za-z0-9]/g, '-')}-work-app`);
  const files = (): string[] =>
    (readdirSync(paths.outDir, { recursive: true }) as string[]).filter((f) => f.endsWith('.md')).map((f) => f.split('\\').join('/')).sort();

  it('converts sessions, memory and Cowork; archives what Claude deletes; drops Stem’s own sessions', async () => {
    mkdirSync(join(proj, 'memory'), { recursive: true });
    mkdirSync(join(proj, 'subagents'), { recursive: true });
    writeFileSync(join(proj, 'aaaaaaaa-1111.jsonl'), [user('Plan the release'), assistant([{ type: 'text', text: 'Sure.' }])].join('\n'));
    writeFileSync(join(proj, 'bbbbbbbb-2222.jsonl'), [user('Stem asked this'), assistant([{ type: 'text', text: 'ok' }])].join('\n'));
    writeFileSync(join(proj, 'subagents', 'agent-x.jsonl'), user('internal'));
    writeFileSync(join(proj, 'memory', 'MEMORY.md'), '- [x](x.md)');
    writeFileSync(join(proj, 'memory', 'prefers-tabs.md'), '---\nname: tabs\ntype: user\n---\nThe user prefers tabs.');
    const cw = join(cowork, 'acct', 'space');
    mkdirSync(join(cw, 'local_cccccccc-3333'), { recursive: true });
    writeFileSync(join(cw, 'local_cccccccc-3333.json'), JSON.stringify({ title: 'Retention policy' }));
    writeFileSync(
      join(cw, 'local_cccccccc-3333', 'audit.jsonl'),
      rec({ type: 'user', message: { role: 'user', content: 'Find it' }, _audit_timestamp: '2026-05-18T06:12:54.082Z' })
    );

    const first = await syncClaudeExport(paths, new Set());
    expect(first.converted).toBe(4); // 2 sessions, 1 memory note, 1 Cowork session; MEMORY.md and subagents/ are not sources
    expect(files()).toEqual([
      'cowork/2026-05-18-retention-policy-cccccccc.md',
      'memory/user/work-app/prefers-tabs.md',
      'sessions/work-app/2026-10-19-plan-the-release-aaaaaaaa.md',
      'sessions/work-app/2026-10-19-stem-asked-this-bbbbbbbb.md'
    ].sort());

    // Unchanged sources are not re-read.
    expect((await syncClaudeExport(paths, new Set())).converted).toBe(0);

    // Claude's cleanup deletes a session: the copy stays.
    rmSync(join(proj, 'aaaaaaaa-1111.jsonl'));
    await syncClaudeExport(paths, new Set());
    expect(files()).toContain('sessions/work-app/2026-10-19-plan-the-release-aaaaaaaa.md');

    // A session turns out to be a Stem coding persona's: its copy goes, archived or not.
    const res = await syncClaudeExport(paths, new Set(['bbbbbbbb-2222', 'aaaaaaaa-1111']));
    expect(res.excluded).toBe(2);
    expect(files().some((f) => f.startsWith('sessions/'))).toBe(false);
  });

  it('rewrites a growing session in place and drops the old name when the title changes', async () => {
    const file = join(proj, 'dddddddd-4444.jsonl');
    writeFileSync(file, user('First ask'));
    await syncClaudeExport(paths, new Set());
    expect(files()).toContain('sessions/work-app/2026-10-19-first-ask-dddddddd.md');
    writeFileSync(file, [user('First ask'), assistant([{ type: 'text', text: 'Answer' }]), rec({ type: 'ai-title', aiTitle: 'Named now' })].join('\n'));
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    await syncClaudeExport(paths, new Set());
    const now = files().filter((f) => f.includes('dddddddd'));
    expect(now).toEqual(['sessions/work-app/2026-10-19-named-now-dddddddd.md']);
    expect(readFileSync(join(paths.outDir, now[0]), 'utf8')).toContain('## Claude');
  });
});

describe('stemStartedSessionIds', () => {
  it('reads the agent session id from every acpx record', async () => {
    const h = join(dir, 'harness', 'sessions');
    mkdirSync(h, { recursive: true });
    writeFileSync(join(h, 'claude-1.json'), JSON.stringify({ acpx_record_id: 'claude-1', acp_session_id: 'sess-1' }));
    writeFileSync(join(h, '.acpx-write.1.tmp'), '{');
    writeFileSync(join(h, 'broken.json'), '{');
    expect([...(await stemStartedSessionIds([join(dir, 'harness'), join(dir, 'missing')]))]).toEqual(['sess-1']);
  });
});
