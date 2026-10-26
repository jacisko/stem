// stem-computer for Linux: the GNOME Wayland half of Stem's computer control,
// the twin of native/mac/stem-computer and native/windows/stem-computer. A gjs
// child of the Stem desktop app that speaks one JSON object per line on
// stdin/stdout, with the same commands and replies as the other two, so
// src/desktop/computer-host drives any of them. Run as `gjs -m main.js`.
//
// Wayland lets no app look at other windows or move the pointer, so the
// screen, the window list and the virtual pointer and keyboard come from
// Stem's GNOME Shell extension (native/linux/gnome-extension, see shell.js);
// the controls inside a window come from AT-SPI (a11y.js), read here so a hung
// app never stalls the shell.
//
// Coordinates on the wire are pixels of the LAST SCREENSHOT this helper made
// (downscaled so the long side is at most 1568); the helper keeps the scale
// and maps them to stage coordinates itself.
//
// Two modes. SCREEN (the default): the frame is the primary monitor, input is
// the extension's virtual devices, and the person's first touch of their own
// mouse or keyboard ends the run. WINDOW (after select-window): the frame is
// one window wherever it sits in the stack, and clicks, typing and scrolling
// go through its accessibility tree, so it never comes forward — the run ends
// from the banner's Stop instead.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as shell from './shell.js';
import * as a11y from './a11y.js';
import { Capture } from './capture.js';
import { HelperError } from './errors.js';
import { Input, pause } from './input.js';
import { parseCombo } from './keys.js';

let GioUnix = null;
try {
  GioUnix = (await import('gi://GioUnix')).default;
} catch {
  // Older GLib: the Unix streams are still in Gio.
}

const tracing = GLib.getenv('STEM_COMPUTER_TRACE') !== null;
const parentPid = Number.parseInt(GLib.getenv('STEM_PARENT_PID') ?? '', 10);
const loop = new GLib.MainLoop(null, false);
const stdout = new (GioUnix?.OutputStream ?? Gio.UnixOutputStream)({ fd: 1, close_fd: false });
const stdin = new Gio.DataInputStream({ base_stream: new (GioUnix?.InputStream ?? Gio.UnixInputStream)({ fd: 0, close_fd: false }) });

const capture = new Capture();
const input = new Input(capture);
let tree = null;
let wantShot = true;
let knownPid = null;
let knownWindows = null;

function emit(obj) {
  stdout.write_all(new TextEncoder().encode(`${JSON.stringify(obj)}\n`), null);
  stdout.flush(null);
}

function trace(message) {
  if (tracing) printerr(`[stem-computer] ${message}`);
}

const ACCESS_ALL = { screen: true, accessibility: true, inputMonitoring: true };
const ACCESS_NONE = { screen: false, accessibility: false, inputMonitoring: false };

// ---- the kill switch ----------------------------------------------------
// Starts disarmed, like the other helpers: looking never ends a run, and the
// first screen-mode input action arms it.
const watch = {
  started: false,
  armed: false,
  unsubscribe: null,
  async start() {
    this.started = true;
    this.unsubscribe ??= shell.onHumanInput((kind) => {
      if (!this.armed) return;
      this.armed = false;
      emit({ event: 'human-input', kind });
    });
  },
  async arm() {
    if (!this.started || this.armed) return;
    // Armed before the input goes out, so the extension is listening when it lands.
    await shell.call('watch', { on: true });
    this.armed = true;
  },
  async disarm() {
    this.armed = false;
    if (this.started) await shell.call('watch', { on: false }).catch(() => undefined);
  },
  async stop() {
    await this.disarm();
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
};

// ---- windows --------------------------------------------------------------

async function listWindows() {
  const r = await shell.call('windows');
  // Stem's own windows are never listed.
  return r.windows.filter((w) => w.pid !== parentPid && (w.minimized || (w.frame.width >= 50 && w.frame.height >= 50)));
}

function brief(w) {
  return `${w.id} ${w.title ? `"${w.title}"` : '(untitled)'} ${w.frame.width}x${w.frame.height}`;
}

function describe(windows) {
  if (windows.length === 0) return 'No windows are open.';
  const lines = ['Windows (id  app  "title"  where  size). select_window by window_id, or by app (+ title).'];
  const order = [...windows].sort((a, b) => (b.focused ? 1 : 0) - (a.focused ? 1 : 0) || (a.minimized || a.otherWorkspace ? 1 : 0) - (b.minimized || b.otherWorkspace ? 1 : 0));
  for (const w of order) {
    const place = w.minimized ? 'minimized' : w.otherWorkspace ? 'other workspace' : 'on screen (maybe covered)';
    const hint = w.minimized ? '  · minimized: cannot be pictured until restored' : '';
    lines.push(`${w.id}  ${w.app}  ${w.title ? `"${w.title}"` : '(untitled)'}  ${place}  ${w.frame.width}x${w.frame.height}${hint}${w.focused ? '  ← frontmost' : ''}`);
  }
  return lines.join('\n');
}

async function findWindow(windowId, app, title) {
  const all = await listWindows();
  if (windowId !== undefined && windowId !== null) {
    const hit = all.find((w) => w.id === windowId);
    if (!hit) throw new HelperError(`No window ${windowId} is open now. Run list_windows again.`);
    return hit;
  }
  if (!app) throw new HelperError('select_window needs window_id, or app (and optionally title).');
  const needle = app.toLowerCase();
  const names = (w) => [w.app, w.wmClass, w.appId?.replace(/\.desktop$/, '')].filter(Boolean).map((s) => s.toLowerCase());
  let cands = all.filter((w) => names(w).some((n) => n === needle || n.split('.').pop() === needle));
  if (cands.length === 0) cands = all.filter((w) => names(w).some((n) => n.includes(needle)));
  if (cands.length === 0) {
    const apps = [...new Set(all.map((w) => w.app))].sort();
    throw new HelperError(`No running app called "${app}" has a window. Apps with windows: ${apps.join(', ')}.`);
  }
  if (title) {
    const t = title.toLowerCase();
    cands = cands.filter((w) => w.title.toLowerCase().includes(t));
    if (cands.length === 0) throw new HelperError(`${app} has no window whose title contains "${title}". Run list_windows to see its windows.`);
  }
  return cands.sort((a, b) => (a.minimized ? 1 : 0) - (b.minimized ? 1 : 0) || (a.otherWorkspace ? 1 : 0) - (b.otherWorkspace ? 1 : 0) || b.frame.width * b.frame.height - a.frame.width * a.frame.height)[0];
}

const windowMode = () => capture.target !== null;
const targetField = () => (capture.target ? { app: capture.target.app, title: capture.target.title, windowId: capture.target.id } : null);

/** Refreshes the selected window's frame and title (it may have moved), for tree positions. */
async function refreshTarget() {
  if (!capture.target) return;
  const w = (await listWindows()).find((x) => x.id === capture.target.id);
  if (!w) return;
  capture.target.title = w.title;
  capture.target.frame = w.frame;
  tree?.update(w);
}

async function noteNewWindows() {
  const t = capture.target;
  if (!t) return null;
  const now = (await listWindows()).filter((w) => w.pid === t.pid);
  const before = knownWindows;
  const samePid = knownPid === t.pid;
  knownPid = t.pid;
  knownWindows = new Set(now.map((w) => w.id));
  if (!before || !samePid) return null;
  const fresh = now.filter((w) => !before.has(w.id) && w.id !== t.id);
  if (fresh.length === 0) return null;
  return `${t.app} opened a new window: ${fresh.map(brief).join('; ')}. It is a separate window, not in this one's picture: select_window window_id ${fresh[0].id} to work in it (staying in window mode), rather than switching to the whole screen.`;
}

async function answerWithScreenshot(id, settleMs = 300, text = null) {
  if (settleMs > 0) await pause(settleMs);
  const said = [text, windowMode() ? await noteNewWindows() : null].filter(Boolean).join('\n\n');
  if (!wantShot) {
    emit({ id, ok: true, text: said || 'Done.', target: targetField() });
    return;
  }
  const screenshot = await capture.screenshot();
  await refreshTarget();
  const reply = { id, ok: true, screenshot, cursor: await input.cursorInScreenshot(), target: targetField() };
  if (said) reply.text = said;
  emit(reply);
}

async function selectWindow(w) {
  knownWindows = null;
  if (w) {
    if (!tree || tree.win.id !== w.id) tree = new a11y.WindowTree(w);
    capture.target = { ...w };
    await watch.disarm();
  } else {
    capture.target = null;
    tree = null;
  }
}

const screenOnly = (what) => new HelperError(`${what} is a screen-mode action (it moves the real pointer). Clear the window first: select_window with no arguments.`);

// ---- status ------------------------------------------------------------

async function status() {
  const ext = await shell.extensionState();
  return { status: ext.state === 'ready' ? ACCESS_ALL : ACCESS_NONE, linux: ext };
}

// ---- Ask about this window ----------------------------------------------

async function peekWindow(id, windowId) {
  const ext = await shell.extensionState();
  if (ext.state !== 'ready') {
    emit({ id, ok: true, window: null, access: ACCESS_NONE, linux: ext });
    return;
  }
  const listed = (await listWindows()).filter((w) => !w.minimized && !w.otherWorkspace);
  // A windowId re-captures a window asked about before (the panel's New).
  const w = windowId !== undefined ? listed.find((x) => x.id === windowId) : (listed.find((x) => x.focused) ?? listed[0]);
  if (!w) {
    emit({ id, ok: true, window: null, access: ACCESS_ALL });
    return;
  }
  const reply = {
    id,
    ok: true,
    access: ACCESS_ALL,
    window: { windowId: w.id, app: w.app, bundleId: w.appId?.replace(/\.desktop$/, '') ?? w.wmClass ?? null, title: w.title, bounds: w.frame }
  };
  try {
    const own = new Capture();
    own.target = { ...w };
    reply.screenshot = await own.screenshot();
  } catch (e) {
    reply.text = e.message;
  }
  emit(reply);
}

// ---- commands ------------------------------------------------------------

async function handle(obj) {
  const id = obj.id ?? null;
  const cmd = obj.cmd ?? '';
  wantShot = obj.shot !== false;
  trace(`cmd ${cmd}`);
  switch (cmd) {
    case 'status':
    case 'request-access':
      emit({ id, ok: true, ...(await status()) });
      return;
    case 'screenshot':
      wantShot = true;
      await answerWithScreenshot(id, 0);
      return;
    case 'cursor':
      if (windowMode()) throw screenOnly('cursor_position');
      emit({ id, ok: true, cursor: await input.cursorInScreenshot(), target: targetField() });
      return;
    case 'move':
      if (windowMode()) throw screenOnly('mouse_move');
      await watch.arm();
      await input.move(obj.x, obj.y);
      await answerWithScreenshot(id);
      return;
    case 'click': {
      const button = obj.button ?? 'left';
      const count = obj.count ?? 1;
      if (windowMode()) {
        if (typeof obj.x !== 'number' || typeof obj.y !== 'number') throw new HelperError('In window mode a click needs a coordinate (there is no cursor to click at).');
        await refreshTarget();
        tree.click(capture.toPoint(obj.x, obj.y), button, count);
      } else {
        await watch.arm();
        await input.click(obj.x, obj.y, button, count);
      }
      await answerWithScreenshot(id);
      return;
    }
    case 'drag':
      if (windowMode()) throw screenOnly('left_click_drag');
      await watch.arm();
      await input.drag(obj.from, obj.to);
      await answerWithScreenshot(id);
      return;
    case 'scroll': {
      const dir = obj.dir ?? 'down';
      const amount = obj.amount ?? 3;
      if (windowMode()) {
        if (typeof obj.x !== 'number' || typeof obj.y !== 'number') throw new HelperError('In window mode scroll needs a coordinate over the area to scroll.');
        await refreshTarget();
        tree.scroll(capture.toPoint(obj.x, obj.y), dir, amount);
      } else {
        await watch.arm();
        await input.scroll(obj.x, obj.y, dir, amount);
      }
      await answerWithScreenshot(id);
      return;
    }
    case 'type':
      if (windowMode()) {
        tree.type(obj.text ?? '');
        await answerWithScreenshot(id);
      } else {
        await watch.arm();
        await answerWithScreenshot(id, 300, await input.type(obj.text ?? ''));
      }
      return;
    case 'key':
    case 'hold': {
      const combo = obj.combo ?? '';
      if (windowMode()) {
        const parsed = parseCombo(combo);
        const plainReturn = parsed.modifiers.length === 0 && (parsed.keysym === 0xff0d || parsed.keysym === 0xff8d);
        if (!(plainReturn && tree.activateFocused())) {
          throw new HelperError('On GNOME a background window takes no keys: Wayland routes the keyboard to the window in front only. Type text with `type`, act through snapshot and press, or clear the window and send the key in screen mode.');
        }
      } else {
        await watch.arm();
        if (cmd === 'key') await input.pressKey(combo);
        else await input.hold(combo, obj.ms ?? 0);
      }
      await answerWithScreenshot(id);
      return;
    }
    case 'wait':
      await answerWithScreenshot(id, obj.ms ?? 1000);
      return;
    case 'zoom':
      emit({ id, ok: true, screenshot: await capture.zoom(obj.x ?? 0, obj.y ?? 0, obj.w ?? 0, obj.h ?? 0), cursor: await input.cursorInScreenshot(), target: targetField() });
      return;
    case 'list-windows':
      emit({ id, ok: true, text: describe(await listWindows()), target: targetField() });
      return;
    case 'select-window': {
      const app = (obj.app ?? '').trim();
      const title = (obj.title ?? '').trim();
      if ((obj.windowId === undefined || obj.windowId === null) && !app) {
        await selectWindow(null);
        await answerWithScreenshot(id, 0);
        return;
      }
      const w = await findWindow(obj.windowId, app, title);
      await selectWindow(w);
      await noteNewWindows();
      let screenshot;
      try {
        screenshot = await capture.screenshot();
      } catch (e) {
        await selectWindow(null);
        throw e;
      }
      const reply = { id, ok: true, target: targetField() };
      if (wantShot) {
        reply.screenshot = screenshot;
        reply.cursor = await input.cursorInScreenshot().catch(() => ({ x: 0, y: 0 }));
      } else {
        reply.text = 'Done.';
      }
      emit(reply);
      return;
    }
    case 'snapshot': {
      if (!windowMode()) throw new HelperError('snapshot lists the controls of a selected window; select_window first (or take a screenshot of the screen).');
      const screenshot = await capture.screenshot();
      await refreshTarget();
      const depth = Math.max(1, Math.min(obj.depth ?? 12, 30));
      const text = tree.snapshot(depth, (p) => capture.toPixel(p), capture.unitsPerShotPixel);
      const reply = { id, ok: true, text, target: targetField() };
      if (wantShot) {
        reply.screenshot = screenshot;
        reply.cursor = await input.cursorInScreenshot();
      }
      emit(reply);
      return;
    }
    case 'press':
    case 'focus':
    case 'menu':
    case 'set-value': {
      if (!windowMode()) throw new HelperError(`${cmd.replace('-', '_')} acts on a snapshot id; select_window and snapshot first.`);
      const element = obj.element ?? -1;
      if (cmd === 'press') tree.press(element);
      else if (cmd === 'focus') tree.focus(element);
      else if (cmd === 'menu') tree.menu(element);
      else tree.setValue(element, obj.text ?? '');
      await answerWithScreenshot(id, cmd === 'focus' ? 100 : 300);
      return;
    }
    case 'peek-window':
      await peekWindow(id, obj.windowId);
      return;
    case 'peek-text': {
      const w = (await listWindows()).find((x) => x.id === obj.windowId);
      let text = null;
      if (w) {
        try {
          text = a11y.readableText(w, obj.maxChars ?? 20000);
        } catch {
          text = null;
        }
      }
      emit({ id, ok: true, text });
      return;
    }
    case 'window-bounds': {
      const w = (await listWindows()).find((x) => x.id === obj.windowId);
      emit({ id, ok: true, bounds: w && !w.minimized ? w.frame : null });
      return;
    }
    case 'place-window': {
      // Stem's own window (the run's banner) by title: Wayland gives Stem no
      // way to place it, the extension does. It may not be mapped yet.
      let w = null;
      for (let tries = 0; !w && tries < 20; tries++) {
        w = (await shell.call('windows')).windows.find((x) => x.pid === parentPid && x.title === obj.title) ?? null;
        if (!w) await pause(100);
      }
      if (!w) throw new HelperError(`No window "${obj.title}" of Stem's is open.`);
      await shell.call('place', { window: w.id, x: obj.x, y: obj.y });
      emit({ id, ok: true });
      return;
    }
    case 'reload-extension':
      emit({ id, ok: true, protocol: await shell.reload() });
      return;
    case 'watch':
      if (obj.on ?? true) await watch.start();
      else await watch.stop();
      emit({ id, ok: true });
      return;
    case 'stop':
      await watch.stop();
      a11y.restoreToolkits();
      emit({ id, ok: true });
      loop.quit();
      return;
    default:
      emit({ id, ok: false, error: `unknown command "${cmd}"` });
  }
}

// One command at a time, in order, like the other helpers.
let queue = Promise.resolve();

function readLine() {
  stdin.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, result) => {
    let line;
    try {
      [line] = stream.read_line_finish_utf8(result);
    } catch {
      line = null;
    }
    if (line === null) {
      // Stem went away: stop like a `stop` would.
      queue = queue.then(async () => {
        await watch.stop().catch(() => undefined);
        a11y.restoreToolkits();
        loop.quit();
      });
      return;
    }
    if (line.trim()) {
      let obj = null;
      try {
        obj = JSON.parse(line);
      } catch {
        obj = null;
      }
      if (!obj || typeof obj !== 'object') emit({ ok: false, error: 'unreadable command' });
      else
        queue = queue.then(() =>
          handle(obj).catch((e) => emit({ id: obj.id ?? null, ok: false, error: e instanceof HelperError ? e.message : `${e?.name ?? 'Error'}: ${e?.message ?? e}` }))
        );
    }
    readLine();
  });
}

readLine();
loop.runAsync ? await loop.runAsync() : loop.run();
