import { describe, expect, it } from 'vitest';
import { isBrowserApp } from '../../src/shared/browser-apps';
import { catalogEntryFor } from '../../src/shared/mcp-app-catalog';
import { MCP_APP_CATALOG } from '../../src/shared/mcp-app-catalog-data';
import { mcpServersForApp, windowMcpSuggestion } from '../../src/server/pi/app-match';
import { cleanWindowContext, formatWindowBlock } from '../../src/server/pi/window-context';
import { sameBrowser, sameTitle } from '../../src/desktop/browser-host';

// "Ask about this window": offering the app's official MCP server, and browser
// control over a browser window, on every platform.

describe('browsers on every platform', () => {
  it('knows a browser by its Mac bundle id, Windows exe or Linux id', () => {
    expect(isBrowserApp('Arc', 'company.thebrowser.Browser')).toBe(true);
    expect(isBrowserApp('jbrow', 'sk.awantech.jbrow')).toBe(true);
    expect(isBrowserApp('Google Chrome', 'chrome')).toBe(true);
    expect(isBrowserApp('Microsoft Edge', 'msedge')).toBe(true);
    expect(isBrowserApp('Google Chrome', 'google-chrome')).toBe(true);
    expect(isBrowserApp('Brave', 'com.brave.Browser')).toBe(true);
  });

  it('goes by the name only when the window came without an id', () => {
    expect(isBrowserApp('Google Chrome', null)).toBe(true);
    expect(isBrowserApp('Slack', 'slack')).toBe(false);
    expect(isBrowserApp('Arcade Pro', null)).toBe(false);
  });

  it('sends a Windows or Linux browser window to the browser tool', () => {
    for (const bundleId of ['chrome', 'google-chrome']) {
      const w = { windowId: 3, app: 'Google Chrome', bundleId, title: 'Inbox', text: null };
      expect(formatWindowBlock(w, [], { device: null }, { device: null })).toContain('with the browser tool');
    }
  });

  it('tells which host browser a window is, by the name both give it', () => {
    expect(sameBrowser('Google Chrome', 'Google Chrome')).toBe(true);
    expect(sameBrowser('Brave Browser', 'Brave')).toBe(true);
    expect(sameBrowser('Microsoft Edge', 'Edge')).toBe(true);
    expect(sameBrowser('Arc', 'Google Chrome')).toBe(false);
  });

  it('matches a tab to its window by title, whichever the browser shortened', () => {
    expect(sameTitle('Bratislava - Wikipedia', 'Bratislava')).toBe(true);
    expect(sameTitle('Inbox', 'Inbox - Google Chrome')).toBe(true);
    expect(sameTitle('Bratislava - Wikipedia', 'Košice - Wikipedia')).toBe(false);
    expect(sameTitle('', 'Bratislava')).toBe(false);
  });
});

describe('the browser window block', () => {
  const tab = { windowId: 9, app: 'Arc', bundleId: 'company.thebrowser.Browser', title: 'Issues', text: null };

  it('says the extension is not connected there, and what would fix it, instead of the browser tool', () => {
    const block = formatWindowBlock({ ...tab, browserReady: false }, [], { device: null }, { device: null });
    expect(block).not.toContain('browser tool');
    expect(block).toContain('the Stem extension is not connected in Arc');
    expect(block).toContain('Settings → Features → Browser control');
    expect(block).toContain('select_window window_id 9');
  });

  it('tells the model browser control is off, so it can point the user at it', () => {
    const block = formatWindowBlock(tab, [], undefined, undefined, { browserOff: 'off' });
    expect(block).toContain('browser control is off for this chat');
    expect(block).toContain('turning on browser control');
  });

  it('says nothing about browser control for an app that is not a browser', () => {
    const slack = { windowId: 2, app: 'Slack', bundleId: 'com.tinyspeck.slackmacgap', title: '', text: null };
    expect(formatWindowBlock(slack, [], undefined, undefined, { browserOff: 'off' })).not.toContain('browser control');
  });

  it('mentions the official server the user has not connected, and how to connect it', () => {
    const block = formatWindowBlock(tab, [], undefined, { device: null }, { offer: { name: 'Linear', kind: 'connect' } });
    expect(block).toContain('Linear publishes an official MCP server, which the user has not connected');
    expect(block).toContain('the Connect button beside the window chip');
  });

  it('points at the tab by its address when it has one', () => {
    const block = formatWindowBlock({ ...tab, url: 'https://linear.app/acme', browserReady: true }, [], undefined, { device: null });
    expect(block).toContain('url="https://linear.app/acme"');
    expect(block).toContain('whose address matches the url attribute');
  });

  it('keeps only a web address and a real readiness flag from a client', () => {
    const base = { app: 'Arc', bundleId: null, title: '', windowId: 1 };
    expect(cleanWindowContext({ ...base, url: 'javascript:alert(1)' })?.url).toBeUndefined();
    expect(cleanWindowContext({ ...base, url: 'https://app.slack.com/client' })?.url).toBe('https://app.slack.com/client');
    expect(cleanWindowContext({ ...base, browserReady: 'yes' })?.browserReady).toBeUndefined();
    expect(cleanWindowContext({ ...base, browserReady: false })?.browserReady).toBe(false);
  });
});

describe('the official-server catalog', () => {
  it('finds an app by its id on each platform, by name, and a web app by its site', () => {
    expect(catalogEntryFor('Slack', 'com.tinyspeck.slackmacgap')?.id).toBe('slack');
    expect(catalogEntryFor('Slack', 'slack')?.id).toBe('slack');
    expect(catalogEntryFor('Slack', 'com.slack.Slack')?.id).toBe('slack');
    expect(catalogEntryFor('Slack', null)?.id).toBe('slack');
    expect(catalogEntryFor('Arc', 'company.thebrowser.Browser', 'https://linear.app/acme/issue/A-1')?.id).toBe('linear');
  });

  it('matches a site with its subdomains, and nothing for an unknown one', () => {
    expect(catalogEntryFor('Arc', null, 'https://acme.atlassian.net/browse/X-1')).not.toBeNull();
    expect(catalogEntryFor('Arc', null, 'https://example.com/')).toBeNull();
    expect(catalogEntryFor('Arc', null, 'not a url')).toBeNull();
  });

  it('never offers a browser itself', () => {
    expect(catalogEntryFor('Google Chrome', 'com.google.Chrome')).toBeNull();
    expect(catalogEntryFor('Google Chrome', 'chrome')).toBeNull();
  });

  it('holds well-formed entries with unique ids', () => {
    const ids = MCP_APP_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of MCP_APP_CATALOG) {
      expect(e.id).toMatch(/^[a-z0-9-]+$/);
      expect(e.source).toMatch(/^https:\/\//);
      if ('url' in e.server) expect(e.server.url).toMatch(/^https?:\/\//);
      else expect(e.server.command).toBeTruthy();
      expect((e.ids?.length ?? 0) + (e.web?.length ?? 0) + (e.names?.length ?? 0)).toBeGreaterThan(0);
    }
  });
});

describe('what the window chip offers', () => {
  it('offers to connect the official server when nothing covers the app', () => {
    const s = windowMcpSuggestion({}, 'Slack', 'com.tinyspeck.slackmacgap');
    expect(s).toMatchObject({ kind: 'connect', entry: { id: 'slack' } });
  });

  it('offers nothing when a server covers it — by name, by apps, or by being the same server', () => {
    expect(windowMcpSuggestion({ slack: { url: 'https://x.test' } }, 'Slack', 'slack')).toBeNull();
    expect(windowMcpSuggestion({ chat: { url: 'https://x.test', apps: ['Slack'] } }, 'Slack', 'slack')).toBeNull();
    expect(windowMcpSuggestion({ work: { url: 'https://mcp.slack.com/mcp' } }, 'Slack', 'slack')).toBeNull();
  });

  it('offers to turn on a covering server that is off', () => {
    expect(windowMcpSuggestion({ slack: { url: 'https://mcp.slack.com/mcp', disabled: true } }, 'Slack', 'slack')).toMatchObject({
      kind: 'enable',
      server: 'slack'
    });
  });

  it('offers nothing when a persona hides the server there is', () => {
    expect(windowMcpSuggestion({ slack: { url: 'https://x.test' } }, 'Slack', 'slack', null, ['other'])).toBeNull();
  });

  it('offers nothing for an app with no official server', () => {
    expect(windowMcpSuggestion({}, 'TextEdit', 'com.apple.TextEdit')).toBeNull();
  });

  it('uses a site’s server in a browser window', () => {
    const servers = { linear: { url: 'https://mcp.linear.app/mcp' } };
    expect(mcpServersForApp(servers, 'Arc', 'company.thebrowser.Browser', null, 'https://linear.app/acme')).toEqual(['linear']);
    expect(mcpServersForApp(servers, 'Arc', 'company.thebrowser.Browser', null, 'https://example.com/')).toEqual([]);
    expect(windowMcpSuggestion({}, 'Arc', 'company.thebrowser.Browser', 'https://linear.app/acme')).toMatchObject({ kind: 'connect' });
  });
});
