import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuickChatSettings, StartTurnInput } from '../../src/shared/types';

// "Ask about this window" gives every window its own panel: two windows asked
// about are two panels on screen, each running its own conversation.
const mock = vi.hoisted(() => {
  const window = () => {
    const win = {
      visible: false,
      focused: false,
      destroyed: false,
      closed: [] as (() => void)[],
      isDestroyed() { return this.destroyed; },
      isVisible() { return this.visible; },
      isFocused() { return this.focused; },
      showInactive() { this.visible = true; },
      hide() { this.visible = false; this.focused = false; },
      destroy() { this.destroyed = true; this.visible = false; for (const fn of this.closed) fn(); },
      getBounds: () => ({ x: 0, y: 0, width: 596, height: 108 }),
      on(event: string, fn: () => void) { if (event === 'closed') this.closed.push(fn); },
      webContents: { send: vi.fn() }
    };
    return win;
  };
  return {
    window,
    overlays: [] as ReturnType<typeof window>[],
    front: { windowId: 1, app: 'Slack' },
    handlers: new Map<string, (...args: unknown[]) => unknown>()
  };
});
vi.mock('../../src/desktop/quickchat/windows', () => ({
  createHudWindow: () => mock.window(),
  createOverlayWindow: () => {
    const win = mock.window();
    mock.overlays.push(win);
    return win;
  },
  placeHud: vi.fn(), placeOverlay: vi.fn(), placeOverlayBeside: vi.fn(), compactOverlay: vi.fn(),
  setOverlayWorkspaceVisibility: vi.fn()
}));
vi.mock('../../src/desktop/quickchat/window-peek', () => ({
  windowPeekSupported: true,
  warmWindowPeek: vi.fn(), stopWindowPeek: vi.fn(),
  windowBounds: async () => null,
  readWindowText: async () => 'text',
  peekFrontWindow: async () => ({
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    window: { ...mock.front, bundleId: null, title: 'w', imageBase64: null, missing: [] }
  })
}));
vi.mock('../../src/desktop/platform', () => ({
  isWaylandSession: () => false, playFinishChime: vi.fn(), quickChatSummonCommand: () => 'stem',
  presentOverlayWindow: (win: { visible: boolean; focused: boolean }) => {
    for (const other of mock.overlays) other.focused = false;
    win.visible = true;
    win.focused = true;
  }
}));
vi.mock('../../src/desktop/ipc-bridge', () => ({
  handleLocal: (name: string, fn: (...args: unknown[]) => unknown) => mock.handlers.set(name, fn),
  handleLocalFrom: (name: string, fn: (...args: unknown[]) => unknown) => mock.handlers.set(name, fn)
}));

import { createQuickChat } from '../../src/desktop/quickchat';

const settings: QuickChatSettings = {
  shortcut: null, windowShortcut: null, defaultModel: null, defaultEffort: 'medium', defaultServiceTier: null,
  showOnAllDisplays: true, newThreadTimeoutMs: 300000, followAcrossSpaces: true, finishSound: false
};

beforeEach(() => {
  mock.overlays.length = 0;
  mock.handlers.clear();
});

function fixture() {
  let threads = 0;
  const startTurn = vi.fn();
  const surface = createQuickChat({
    mainWindow: () => null,
    sendToMain: vi.fn(), revealMainWindow: vi.fn(), installNavigationGuards: vi.fn(), beginSummon: vi.fn(),
    invoke: async (channel, args) => {
      if (channel === 'backend:createThread') return `thread-${++threads}`;
      const input = args[0] as StartTurnInput;
      startTurn(input);
      return { threadId: input.threadId, turnId: input.turnId };
    }
  });
  surface.start(settings);
  surface.registerIpc();
  const ask = async (windowId: number) => {
    mock.front = { windowId, app: `App ${windowId}` };
    surface.askAboutWindow();
    await vi.waitFor(() => expect(mock.overlays.some((o) => o.visible && o.focused)).toBe(true));
    return mock.overlays.find((o) => o.focused)!;
  };
  const run = (panel: (typeof mock.overlays)[number], input: string) =>
    mock.handlers.get('quickchat:run')!(panel.webContents, { input, turnId: input, windowId: undefined });
  return { surface, ask, run, startTurn };
}

describe('Ask about this window panels', () => {
  it('opens a separate panel per window and keeps the first one on screen', async () => {
    const { ask } = fixture();
    const first = await ask(1);
    first.focused = false; // the user clicks into the next window
    const second = await ask(2);
    expect(second).not.toBe(first);
    expect(first.visible).toBe(true);
    expect(second.visible).toBe(true);
  });

  it('runs each panel in its own thread and routes each thread only to its panel', async () => {
    const { ask, run, surface, startTurn } = fixture();
    const first = await ask(1);
    first.focused = false;
    const second = await ask(2);
    await run(first, 'a');
    await run(second, 'b');
    const threads = startTurn.mock.calls.map(([input]) => (input as StartTurnInput).threadId);
    expect(new Set(threads).size).toBe(2);
    first.webContents.send.mockClear();
    second.webContents.send.mockClear();
    surface.routeBackendEvent({ method: 'item/agentMessage/delta', receivedAt: '', params: { threadId: threads[1], turnId: 'b' } });
    expect(second.webContents.send).toHaveBeenCalledWith('backend:event', expect.anything());
    expect(first.webContents.send).not.toHaveBeenCalled();
  });

  it('dismisses only the focused panel, and the same window brings its panel back', async () => {
    const { ask, surface } = fixture();
    const first = await ask(1);
    first.focused = false;
    const second = await ask(2);
    surface.askAboutWindow(); // pressed while typing in the second panel
    expect(second.visible).toBe(false);
    expect(first.visible).toBe(true);
    expect(await ask(2)).toBe(second);
  });
});
