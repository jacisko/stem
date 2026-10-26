import { watch, type FSWatcher } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { join } from 'node:path';
import { log } from '../../server/log';
import { host } from '../../server/host';
import { harnessSessionsDir } from '../../server/workspace/paths';
import { stemStartedSessionIds, syncClaudeExport, type ClaudeExportPaths } from './sync';

// The "Claude Code" folder's producer on THIS machine: keeps a readable copy
// of Claude Code's memory and sessions (see sync.ts) in Stem's own state dir,
// and that copy is what gets connected — mirrored to a remote server like any
// folder picked here, or connected directly when the server runs here. The
// raw ~/.claude never leaves the machine; only the converted text does.
//
// It runs only while that copy is connected (`isConnected`), so disconnecting
// the folder in the Folders tab is also how it stops. Freshness: a watch on
// the sources with a long debounce (Claude appends to a live session on every
// step, and converting it every two seconds buys nothing), plus a periodic
// pass as the backstop, like the mirror host's.

const DEBOUNCE_MS = 30_000;
const PASS_INTERVAL_MS = 15 * 60_000;

export interface ClaudeExportHost {
  /** Where the copy lives: the folder path to connect. */
  readonly outDir: string;
  /** The folder's default name: "Claude Code", with this machine's name against a remote server. */
  label(remote: boolean): string;
  /**
   * The connect flow: fill the copy now, so the folder is not empty the moment
   * it is connected, and start keeping it fresh. Should the connect then fail,
   * the next periodic check finds the copy unconnected and stops.
   */
  prepare(): Promise<void>;
  /** Start watching if the copy is connected; called at launch and after a connect. */
  refresh(): Promise<void>;
  close(): void;
}

export interface ClaudeExportDeps {
  /** Whether the copy is a connected folder right now. */
  isConnected(outDir: string): Promise<boolean>;
}

export function claudeExportPaths(): ClaudeExportPaths {
  const home = homedir();
  const root = host().stateRoot();
  // Cowork (the Claude app's agent mode) keeps its sessions in the app's data
  // dir, which is Application Support on macOS and %APPDATA% on Windows.
  const appData =
    process.platform === 'darwin'
      ? join(home, 'Library', 'Application Support')
      : process.platform === 'win32'
        ? (process.env.APPDATA ?? join(home, 'AppData', 'Roaming'))
        : null;
  return {
    projectsDir: join(process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'projects'),
    // STEM_CLAUDE_COWORK_DIR keeps e2e runs off this machine's real Claude app data.
    coworkDir: process.env.STEM_CLAUDE_COWORK_DIR ?? (appData ? join(appData, 'Claude', 'local-agent-mode-sessions') : null),
    outDir: join(root, 'claude-code'),
    statePath: join(root, 'claude-code-export.json'),
    home
  };
}

export function createClaudeExportHost(deps: ClaudeExportDeps, paths = claudeExportPaths()): ClaudeExportHost {
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | null = null;
  let interval: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let closed = false;

  async function pass(): Promise<void> {
    // Both places a harness keeps acpx records here: the desktop's own
    // harness host, and the server's when the server runs on this machine.
    const excluded = await stemStartedSessionIds([join(host().stateRoot(), 'harness-sessions'), harnessSessionsDir()]);
    const res = await syncClaudeExport(paths, excluded);
    if (res.converted || res.excluded) log('claude-export', 'updated the Claude Code copy', { ...res });
  }

  function syncNow(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = pass()
      .catch((e) => log('claude-export', 'a pass failed', { error: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        running = null;
        if (again && !closed) {
          again = false;
          schedule(DEBOUNCE_MS);
        }
      });
    return running;
  }

  function schedule(delayMs: number): void {
    // A pass already due stays put: a session streaming steadily must not
    // push its own conversion back forever.
    if (timer || closed) return;
    timer = setTimeout(() => {
      timer = null;
      void syncNow();
    }, delayMs);
    timer.unref?.();
  }

  function stop(): void {
    for (const w of watchers.splice(0)) w.close();
    if (timer) clearTimeout(timer);
    if (interval) clearInterval(interval);
    timer = null;
    interval = null;
  }

  function start(): void {
    if (interval) return;
    for (const dir of [paths.projectsDir, paths.coworkDir]) {
      if (!dir) continue;
      try {
        const w = watch(dir, { recursive: true }, () => schedule(DEBOUNCE_MS));
        w.on('error', () => w.close()); // quiet: the periodic pass keeps it fresh
        watchers.push(w);
      } catch {
        // quiet: absent source or no recursive watch here; the periodic pass covers it.
      }
    }
    interval = setInterval(() => {
      void deps.isConnected(paths.outDir).then((on) => (on ? syncNow() : stop()));
    }, PASS_INTERVAL_MS);
    interval.unref?.();
    schedule(1_000);
  }

  return {
    outDir: paths.outDir,
    label(remote) {
      const machine = hostname().replace(/\.(local|lan|home)$/i, '');
      return remote && machine ? `Claude Code (${machine})` : 'Claude Code';
    },
    async prepare() {
      await syncNow();
      if (!closed) start();
    },
    async refresh() {
      if (closed) return;
      if (await deps.isConnected(paths.outDir).catch(() => false)) start();
      else stop();
    },
    close() {
      closed = true;
      stop();
    }
  };
}
