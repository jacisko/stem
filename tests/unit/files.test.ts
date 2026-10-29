// Files-place suite — ported from scripts/files-verify.mjs. Exercises the REAL
// files store + inject against the throwaway STEM_FILES_DIR from setup-unit.ts:
// listing/grouping by subfolder, add (collisions + subdirs), the context builder,
// the traversal guard, and remove.
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as store from '../../src/server/files/store';
import * as inject from '../../src/server/files/inject';

const root = process.env.STEM_FILES_DIR!;
const stage = join(root, '..', 'stage');
const srcA = join(stage, 'a.txt');
const srcCake = join(stage, 'cake.pdf');

beforeAll(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  mkdirSync(stage, { recursive: true });
  writeFileSync(srcA, 'hello');
  writeFileSync(srcCake, 'PASSPHRASE-7731 chocolate');
});

describe('Files place', () => {
  it('starts empty with no context', async () => {
    const listing = await store.listFiles();
    expect(listing.files.length).toBe(0);
    expect(listing.dirs.length).toBe(0);
    expect(await inject.buildFilesContext()).toBeNull();
  });

  it('adds a file at the root', async () => {
    const listing = await store.addFiles([srcA]);
    expect(listing.files.some((f) => f.rel === 'a.txt' && f.dir === '')).toBe(true);
  });

  it('adds into a subfolder created on demand', async () => {
    const listing = await store.addFiles([srcCake], 'Recipes');
    expect(listing.files.some((f) => f.rel === 'Recipes/cake.pdf' && f.dir === 'Recipes')).toBe(true);
    expect(listing.dirs).toContain('Recipes');
  });

  it('renames colliding files to numbered siblings', async () => {
    const listing = await store.addFiles([srcA]);
    expect(listing.files.some((f) => f.rel === 'a-1.txt')).toBe(true);
  });

  it('does not overwrite files added concurrently with the same basename', async () => {
    const sources = Array.from({ length: 20 }, (_, i) => {
      const dir = join(stage, `concurrent-${i}`);
      mkdirSync(dir, { recursive: true });
      const source = join(dir, 'same.txt');
      writeFileSync(source, `source-${i}`);
      return source;
    });

    await Promise.all(sources.map((source) => store.addFiles([source])));
    const matches = (await store.listFiles()).files.filter((file) => /^same(?:-\d+)?\.txt$/.test(file.rel));
    expect(matches).toHaveLength(sources.length);
  });

  it('builds a context that lists names (with files/ prefix) but never contents', async () => {
    const ctx = await inject.buildFilesContext();
    expect(ctx).toBeTruthy();
    expect(ctx!).toContain('files/Recipes/cake.pdf');
    expect(ctx!).not.toContain('PASSPHRASE-7731');
  });

  it('treats an escaping (path-traversal) remove as a no-op', async () => {
    const before = (await store.listFiles()).files.length;
    await store.removeFile('../stage/a.txt');
    expect((await store.listFiles()).files.length).toBe(before);
  });

  it('removes a real file', async () => {
    const listing = await store.removeFile('Recipes/cake.pdf');
    expect(listing.files.some((f) => f.rel === 'Recipes/cake.pdf')).toBe(false);
  });
});

describe('Files subfolders', () => {
  it('creates an empty subfolder that still shows up in the listing', async () => {
    // The Files tab renders sections from `dirs`, so a folder the user just made
    // has to survive a listing round-trip before anything is dropped into it.
    const listing = await store.createSubdir('Invoices');
    expect(listing.dirs).toContain('Invoices');
    expect(listing.files.some((f) => f.dir === 'Invoices')).toBe(false);
  });

  it('trims the name and is idempotent for one that already exists', async () => {
    const listing = await store.createSubdir('  Invoices  ');
    expect(listing.dirs.filter((d) => d === 'Invoices')).toHaveLength(1);
  });

  it('rejects traversal, nesting, and hidden names', async () => {
    for (const bad of ['..', '.', '', '   ', 'a/b', '../escape', '.hidden']) {
      await expect(store.createSubdir(bad)).rejects.toThrow(/Unsafe files subfolder/);
    }
    for (const bad of ['../stage', '', '.', '..']) {
      await expect(store.removeSubdir(bad)).rejects.toThrow(/Unsafe files subfolder/);
    }
    // The guard must not have deleted anything on its way to throwing.
    expect((await store.listFiles()).dirs).toContain('Invoices');
  });

  it('removes a subfolder along with the files inside it', async () => {
    await store.addFiles([srcA], 'Invoices');
    expect((await store.listFiles()).files.some((f) => f.dir === 'Invoices')).toBe(true);

    const listing = await store.removeSubdir('Invoices');
    expect(listing.dirs).not.toContain('Invoices');
    expect(listing.files.some((f) => f.dir === 'Invoices')).toBe(false);
  });
});

describe('Files tool folders', () => {
  // A virtualenv an assistant copied in was 28,885 files: every one walked each
  // turn, and the 100 names the assistant saw were site-packages.
  beforeAll(() => {
    const venv = join(root, 'qwen-test');
    mkdirSync(join(venv, 'lib', 'python3.12', 'site-packages', 'torch'), { recursive: true });
    writeFileSync(join(venv, 'pyvenv.cfg'), 'home = /usr/bin');
    writeFileSync(join(venv, 'lib', 'python3.12', 'site-packages', 'torch', 'x.py'), '');
    const proj = join(root, 'proj');
    mkdirSync(join(proj, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(proj, 'node_modules', 'left-pad', 'index.js'), '');
    writeFileSync(join(proj, 'README.md'), 'hi');
    const big = join(root, 'big');
    mkdirSync(big, { recursive: true });
    for (let i = 0; i < 120; i++) writeFileSync(join(big, `f${String(i).padStart(3, '0')}.txt`), '');
  });

  it('names tool folders once and does not walk into them', async () => {
    const listing = await store.listFiles();
    expect(listing.skipped).toEqual([
      { rel: 'proj/node_modules', dir: 'proj', kind: 'Node packages' },
      { rel: 'qwen-test', dir: 'qwen-test', kind: 'Python environment' }
    ]);
    expect(listing.files.some((f) => f.rel.includes('site-packages') || f.rel.includes('node_modules'))).toBe(false);
    expect(listing.files.some((f) => f.rel === 'proj/README.md')).toBe(true);
    expect(listing.dirs).toContain('qwen-test');
  });

  it('summarizes a big subfolder in the context instead of spending every slot on it', async () => {
    const ctx = (await inject.buildFilesContext())!;
    expect(ctx).toContain('- files/big/ — 120 files, e.g. f000.txt, f001.txt, f002.txt');
    expect(ctx).not.toContain('files/big/f050.txt');
    expect(ctx).toContain('files/proj/README.md');
    expect(ctx).toContain('- files/qwen-test/ — Python environment (tooling, contents not listed)');
  });

  it('deletes a nested tool folder through removeFile', async () => {
    const listing = await store.removeFile('proj/node_modules');
    expect(listing.skipped?.some((s) => s.rel === 'proj/node_modules')).toBe(false);
    expect(listing.files.some((f) => f.rel === 'proj/README.md')).toBe(true);
  });

  it('reports only tool folders made since a moment', async () => {
    const { findNewBulky } = await import('../../src/server/files/bulky');
    expect(await findNewBulky(root, Date.now() + 60_000)).toEqual([]);
    const all = await findNewBulky(root, 0);
    expect(all.map((f) => f.rel)).toEqual(['qwen-test']);
  });
});
