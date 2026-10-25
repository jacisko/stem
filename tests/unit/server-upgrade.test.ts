import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetHostForTests, setHost } from '../../src/server/host';
import { createServerUpgrader, type ServerUpgrader } from '../../src/server/upgrade';
import type { ServerUpgradeStatus } from '../../src/shared/types';

let root: string;
let dir: string;
let clock: number;
let idle: boolean;
let emitted: ServerUpgradeStatus[];
let upgrader: ServerUpgrader | null;

function updater(state: string, version = '', detail = '', heartbeatMs = clock): void {
  writeFileSync(
    join(dir, 'status.json'),
    JSON.stringify({ state, version, detail, heartbeat: Math.floor(heartbeatMs / 1000) })
  );
}

function make(opts: { releaseImage?: boolean; dir?: string } = {}): ServerUpgrader {
  upgrader = createServerUpgrader({
    emit: (s) => emitted.push(s),
    dir: opts.dir ?? dir,
    now: () => clock,
    isIdle: () => idle,
    releaseImage: opts.releaseImage ?? true
  });
  return upgrader;
}

const requestedVersion = () =>
  existsSync(join(dir, 'request.json'))
    ? (JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8')) as { version: string }).version
    : null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stem-upgrade-'));
  dir = join(root, 'updater');
  mkdirSync(dir);
  clock = 1_800_000_000_000;
  idle = true;
  emitted = [];
  upgrader = null;
  setHost({ stateRoot: () => join(root, 'state'), appVersion: () => '0.7.1' });
});

afterEach(() => {
  upgrader?.stop();
  resetHostForTests();
  rmSync(root, { recursive: true, force: true });
});

describe('server upgrader', () => {
  it('announces its version to the updater on start', () => {
    make();
    expect(JSON.parse(readFileSync(join(dir, 'server.json'), 'utf8'))).toMatchObject({ version: '0.7.1', release: true });
  });

  it('is absent without an updater heartbeat, and with a stale one', () => {
    const u = make();
    expect(u.status().updater).toBe('absent');
    updater('idle', '', '', clock - 5 * 60_000);
    expect(u.status().updater).toBe('absent');
    expect(() => u.start()).toThrow(/no updater/);
  });

  it('stays out of the way of an image built from source', () => {
    updater('idle');
    const u = make({ releaseImage: false });
    u.noteClientVersion('0.7.5');
    u.tick();
    u.tick();
    expect(u.status().updater).toBe('source');
    expect(requestedVersion()).toBeNull();
  });

  it('upgrades to the newest client version after two idle checks', () => {
    updater('idle');
    const u = make();
    u.noteClientVersion('0.7.3');
    u.noteClientVersion('0.7.5');
    u.noteClientVersion('0.7.4');
    u.tick();
    expect(requestedVersion()).toBeNull();
    u.tick();
    expect(requestedVersion()).toBe('0.7.5');
    expect(u.status()).toMatchObject({ updater: 'working', target: '0.7.5' });
  });

  it('waits while a turn is running', () => {
    updater('idle');
    const u = make();
    u.noteClientVersion('0.7.5');
    idle = false;
    u.tick();
    u.tick();
    u.tick();
    expect(requestedVersion()).toBeNull();
  });

  it('never goes down, and ignores dev versions', () => {
    updater('idle');
    const u = make();
    u.noteClientVersion('0.7.0');
    u.noteClientVersion('0.8.0-dev');
    u.tick();
    u.tick();
    expect(requestedVersion()).toBeNull();
    expect(() => u.start()).toThrow(/No client is newer/);
  });

  it('does not retry a failed version on its own, but does a newer one', () => {
    updater('failed', '0.7.5', 'pull failed');
    const u = make();
    u.noteClientVersion('0.7.5');
    u.tick();
    u.tick();
    expect(requestedVersion()).toBeNull();
    expect(u.status()).toMatchObject({ updater: 'failed', target: '0.7.5', detail: 'pull failed' });
    u.noteClientVersion('0.7.6');
    u.tick();
    u.tick();
    expect(requestedVersion()).toBe('0.7.6');
  });

  it('forgets a failure the server has since moved past', () => {
    updater('failed', '0.7.0', 'old');
    expect(make().status().updater).toBe('ready');
  });

  it('respects the auto switch, and still upgrades on request', () => {
    updater('idle');
    const u = make();
    u.setAuto(false);
    u.noteClientVersion('0.7.5');
    u.tick();
    u.tick();
    expect(requestedVersion()).toBeNull();
    expect(u.start()).toMatchObject({ updater: 'working', target: '0.7.5', auto: false });
    expect(requestedVersion()).toBe('0.7.5');
  });
});
