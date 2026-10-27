// Set up for browser control (desktop/browser-host/install.ts): the extension
// copied out for Load unpacked, the wrapper the manifests point at, the
// manifests in each installed browser — Arc's twice — and a startup refresh
// that only touches an install this profile made.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  browserDirs,
  browserInstallPaths,
  extensionsPageUrl,
  installBrowserControl,
  installedHere,
  refreshBrowserControl,
  relaysHere,
  setupBrowsers,
  socketPathFor,
  windowsRegistry,
  wrapperBatch,
  wrapperScript
} from '../../src/desktop/browser-host/install';
import { FrameReader, appImageName, encodeFrame, launchableBrowser, launchableOnLinux, sandboxOf, windowsBrowserName } from '../../src/shared/browser-native';
import { parseRelayHello, relayKey, removeInSandbox } from '../../src/desktop/browser-host/relay';
import { appImageOf, browserOf } from '../../src/desktop/browser-host/native-host-main';
import { launchableAppImage } from '../../src/desktop/browser-host/appimage';
import { expectPosixMode } from './posix-mode';

let home: string;
let state: string;
let ext: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stem-home-'));
  state = mkdtempSync(join(tmpdir(), 'stem-state-'));
  ext = mkdtempSync(join(tmpdir(), 'stem-ext-'));
  writeFileSync(join(ext, 'manifest.json'), '{"manifest_version":3}');
  writeFileSync(join(ext, 'background.js'), '// v1');
});

afterEach(() => {
  for (const d of [home, state, ext]) rmSync(d, { recursive: true, force: true });
});

const support = (...p: string[]) => join(home, 'Library', 'Application Support', ...p);
const src = () => ({ extensionSource: ext, hostScript: '/App/dist/main/browser-native-host.js', nodeCommand: '/App/Stem' });

describe('installBrowserControl', () => {
  it('registers jbrow in its own folder', async () => {
    mkdirSync(support('jbrow'), { recursive: true });
    const paths = browserInstallPaths(state);
    expect((await installBrowserControl(src(), paths, home, 'darwin')).registered).toEqual(['jbrow']);
    expect(JSON.parse(readFileSync(support('jbrow', 'NativeMessagingHosts', 'com.stem.browser.json'), 'utf8')).path).toBe(
      paths.wrapperPath
    );
  });

  it('registers every installed browser, and Arc in Chrome’s folder too', async () => {
    mkdirSync(support('Arc', 'User Data'), { recursive: true });
    mkdirSync(support('BraveSoftware', 'Brave-Browser'), { recursive: true });
    expect(browserDirs(home, 'darwin').map((d) => d.name).sort()).toEqual(['Arc', 'Brave', 'Google Chrome']);

    const paths = browserInstallPaths(state);
    const res = await installBrowserControl(src(), paths, home, 'darwin');
    expect(res.registered.sort()).toEqual(['Arc', 'Brave', 'Google Chrome']);
    const manifest = JSON.parse(
      readFileSync(support('Google', 'Chrome', 'NativeMessagingHosts', 'com.stem.browser.json'), 'utf8')
    );
    expect(manifest).toMatchObject({ name: 'com.stem.browser', type: 'stdio', path: paths.wrapperPath });
    expect(manifest.allowed_origins).toEqual([expect.stringMatching(/^chrome-extension:\/\/[a-p]{32}\/$/)]);
    expect(existsSync(join(paths.extensionDir, 'background.js'))).toBe(true);
    expectPosixMode(paths.wrapperPath, 0o700);
    expectPosixMode(paths.configPath, 0o600);
    expect(installedHere(paths, home, 'darwin')).toBe(true);
  });

  it('copies the extension again only when its files changed', async () => {
    mkdirSync(support('Google', 'Chrome'), { recursive: true });
    const paths = browserInstallPaths(state);
    expect((await installBrowserControl(src(), paths, home, 'darwin')).extensionChanged).toBe(true);
    expect((await refreshBrowserControl(src(), paths, home, 'darwin'))?.extensionChanged).toBe(false);
    writeFileSync(join(ext, 'background.js'), '// v2');
    expect((await refreshBrowserControl(src(), paths, home, 'darwin'))?.extensionChanged).toBe(true);
    expect(readFileSync(join(paths.extensionDir, 'background.js'), 'utf8')).toBe('// v2');
  });

  it('never refreshes an install another profile owns', async () => {
    mkdirSync(support('Google', 'Chrome'), { recursive: true });
    const other = mkdtempSync(join(tmpdir(), 'stem-other-'));
    await installBrowserControl(src(), browserInstallPaths(other), home, 'darwin');
    const mine = browserInstallPaths(state);
    expect(installedHere(mine, home, 'darwin')).toBe(false);
    expect(await refreshBrowserControl(src(), mine, home, 'darwin')).toBeNull();
    expect(existsSync(mine.wrapperPath)).toBe(false);
    rmSync(other, { recursive: true, force: true });
  });
});

describe('Linux', () => {
  const config = (...p: string[]) => join(home, '.config', ...p);

  it('registers the browsers under ~/.config', async () => {
    mkdirSync(config('google-chrome'), { recursive: true });
    mkdirSync(config('BraveSoftware', 'Brave-Browser'), { recursive: true });
    const paths = browserInstallPaths(state);
    const res = await installBrowserControl(src(), paths, home, 'linux');
    expect(res.registered.sort()).toEqual(['Brave', 'Google Chrome']);
    const manifest = JSON.parse(readFileSync(config('google-chrome', 'NativeMessagingHosts', 'com.stem.browser.json'), 'utf8'));
    expect(manifest).toMatchObject({ name: 'com.stem.browser', path: paths.wrapperPath });
    expect(existsSync(config('BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts', 'com.stem.browser.json'))).toBe(true);
    expect(installedHere(paths, home, 'linux')).toBe(true);
    // A Mac layout in the same home is not this platform's.
    expect(installedHere(paths, home, 'darwin')).toBe(false);
  });

  it('offers browsers with a command on PATH, the default first, by the command that exists', () => {
    mkdirSync(config('google-chrome'), { recursive: true });
    mkdirSync(config('chromium'), { recursive: true });
    mkdirSync(config('microsoft-edge'), { recursive: true });
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'google-chrome-stable'), '');
    writeFileSync(join(bin, 'chromium-browser'), '');
    // Edge was used but is gone.
    expect(setupBrowsers(home, 'linux', [bin], null)).toEqual([
      { name: 'Google Chrome', app: 'google-chrome-stable', extensionsUrl: 'chrome://extensions' },
      { name: 'Chromium', app: 'chromium-browser', extensionsUrl: 'chrome://extensions' }
    ]);
    expect(setupBrowsers(home, 'linux', [bin], 'chromium-browser.desktop').map((b) => b.name)).toEqual([
      'Chromium',
      'Google Chrome'
    ]);
    expect(extensionsPageUrl('/opt/microsoft/msedge/msedge')).toBe('edge://extensions');
    expect(extensionsPageUrl('microsoft-edge')).toBe('edge://extensions');
  });

  it('names the browser from its executable', () => {
    expect(browserOf('/opt/google/chrome/chrome')).toEqual({ appPath: '/opt/google/chrome/chrome', appName: 'Google Chrome' });
    expect(browserOf('/opt/brave.com/brave/brave').appName).toBe('Brave');
    expect(browserOf('/usr/lib/chromium/chromium').appName).toBe('Chromium');
    expect(browserOf('/opt/microsoft/msedge/msedge').appName).toBe('Microsoft Edge');
    expect(browserOf('/usr/bin/vivaldi-bin').appName).toBe('vivaldi-bin');
  });

  it('registers any other Chromium browser, but not Electron apps', async () => {
    for (const d of [['net.imput.helium'], ['thorium'], ['BraveSoftware', 'Brave-Browser-Beta']]) {
      mkdirSync(config(...d), { recursive: true });
      writeFileSync(config(...d, 'Local State'), '{}');
    }
    // Before its first profile, Helium has only these.
    mkdirSync(config('net.imput.helium', 'Crash Reports'));
    writeFileSync(config('net.imput.helium', 'Variations'), '');
    mkdirSync(config('thorium', 'Default'));
    mkdirSync(config('BraveSoftware', 'Brave-Browser-Beta', 'Default'));
    // Electron apps: the folder is the profile, Preferences and all; or one that died early.
    mkdirSync(config('Code', 'Default'), { recursive: true });
    writeFileSync(config('Code', 'Local State'), '{}');
    writeFileSync(config('Code', 'Preferences'), '{}');
    mkdirSync(config('oe', 'Crashpad'), { recursive: true });
    writeFileSync(config('oe', 'Local State'), '{}');
    const res = await installBrowserControl(src(), browserInstallPaths(state), home, 'linux');
    expect(res.registered.sort()).toEqual(['Brave Browser Beta', 'Helium', 'Thorium']);
    expect(existsSync(config('net.imput.helium', 'NativeMessagingHosts', 'com.stem.browser.json'))).toBe(true);
    expect(existsSync(config('Code', 'NativeMessagingHosts'))).toBe(false);
    // No command to run, so not among Set up's steps.
    expect(setupBrowsers(home, 'linux', [], null)).toEqual([]);
  });

  it('names an AppImage browser by its file, inside its own mount only', () => {
    expect(appImageName('/home/u/Applications/Helium-0.4.5.1-x86_64.AppImage')).toBe('Helium');
    expect(appImageName('/home/u/thorium-browser_130.0.6723.174_AVX2.AppImage')).toBe('Thorium Browser');
    expect(appImageName('/home/u/ungoogled-chromium_131.0-1.appimage')).toBe('Ungoogled Chromium');
    expect(browserOf('/home/u/Apps/Helium-0.4.5-x86_64.AppImage')).toEqual({
      appPath: '/home/u/Apps/Helium-0.4.5-x86_64.AppImage',
      appName: 'Helium'
    });
    const env = (vars: Record<string, string>) => vars;
    const image = '/home/u/Apps/Helium.AppImage';
    expect(appImageOf('/tmp/.mount_HeliumAb12/opt/helium/chrome', env({ APPIMAGE: image, APPDIR: '/tmp/.mount_HeliumAb12' }))).toBe(image);
    // Chrome started by Stem's own AppImage inherits Stem's variables.
    expect(appImageOf('/opt/google/chrome/chrome', env({ APPIMAGE: '/home/u/Stem.AppImage', APPDIR: '/tmp/.mount_Stem99' }))).toBeNull();
    expect(appImageOf('/tmp/.mount_Stem99x/chrome', env({ APPIMAGE: image, APPDIR: '/tmp/.mount_Stem99' }))).toBeNull();
    expect(appImageOf('/usr/bin/x', {})).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('starts an AppImage only when the file is one and only its owner can change it', () => {
    const elf = Buffer.alloc(64);
    elf.write('\x7fELF', 0, 'latin1');
    elf.write('AI\x02', 8, 'latin1');
    const good = join(realpathSync(home), 'Helium.AppImage');
    writeFileSync(good, elf);
    chmodSync(good, 0o755);
    expect(launchableAppImage(good)).toBe(true);
    chmodSync(good, 0o777);
    expect(launchableAppImage(good)).toBe(false);
    chmodSync(good, 0o644);
    expect(launchableAppImage(good)).toBe(false);
    const script = join(home, 'evil.AppImage');
    writeFileSync(script, '#!/bin/sh\necho hi\n');
    chmodSync(script, 0o755);
    expect(launchableAppImage(script)).toBe(false);
    expect(launchableAppImage(`${home}/x/../Helium.AppImage`)).toBe(false);
    // In a folder anyone may write to, someone else could swap it.
    chmodSync(good, 0o755);
    const open = join(home, 'open');
    mkdirSync(open);
    const there = join(open, 'Helium.AppImage');
    writeFileSync(there, elf);
    chmodSync(there, 0o755);
    expect(launchableAppImage(realpathSync(there))).toBe(true);
    chmodSync(open, 0o777);
    expect(launchableAppImage(realpathSync(there))).toBe(false);
    chmodSync(open, 0o755);
    // A link to it is not it.
    symlinkSync(there, join(home, 'link.AppImage'));
    expect(launchableAppImage(join(realpathSync(home), 'link.AppImage'))).toBe(false);
    expect(launchableAppImage('Helium.AppImage')).toBe(false);
  });

  it('starts only known browsers from system folders', () => {
    for (const ok of ['/opt/google/chrome/chrome', '/opt/brave.com/brave/brave', '/usr/lib64/chromium-browser/chromium-browser', 'google-chrome-stable', '/opt/vivaldi/vivaldi-bin', '/usr/lib/x86_64-linux-gnu/opera/opera', '/opt/chromium.org/thorium/thorium']) {
      expect(launchableOnLinux(ok)).toBe(true);
    }
    for (const bad of ['/home/u/bin/chrome', '/tmp/brave-evil.sh', '/opt/google/chrome/../../../tmp/x', '/usr/bin/vivaldi-bin', 'sh', '']) {
      expect(launchableOnLinux(bad)).toBe(false);
    }
  });
});

describe('Snap and Flatpak', () => {
  /** A Chromium user-data folder, as a browser leaves it. */
  const browserData = (...p: string[]) => {
    mkdirSync(join(home, ...p, 'Default'), { recursive: true });
    writeFileSync(join(home, ...p, 'Local State'), '{}');
    return join(home, ...p);
  };

  it('puts a relay and an extension copy in each sandboxed browser’s own folder', async () => {
    const snap = browserData('snap', 'chromium', 'common', 'chromium');
    const brave = browserData('snap', 'brave', 'current', '.config', 'BraveSoftware', 'Brave-Browser');
    const flatpak = browserData('.var', 'app', 'com.google.Chrome', 'config', 'google-chrome');
    // A sandboxed Electron app is no browser.
    browserData('.var', 'app', 'com.slack.Slack', 'config', 'Slack');
    writeFileSync(join(home, '.var', 'app', 'com.slack.Slack', 'config', 'Slack', 'Preferences'), '{}');
    const paths = browserInstallPaths(state);
    const res = await installBrowserControl(src(), paths, home, 'linux');
    expect(res.registered.sort()).toEqual(['Brave (Snap)', 'Chromium (Snap)', 'Google Chrome (Flatpak)']);

    const relay = join(home, 'snap', 'chromium', 'common', 'stem', 'stem-browser-host');
    const manifest = JSON.parse(readFileSync(join(snap, 'NativeMessagingHosts', 'com.stem.browser.json'), 'utf8'));
    expect(manifest).toMatchObject({ name: 'com.stem.browser', path: relay });
    expect(JSON.parse(readFileSync(join(brave, 'NativeMessagingHosts', 'com.stem.browser.json'), 'utf8')).path).toBe(
      join(home, 'snap', 'brave', 'common', 'stem', 'stem-browser-host')
    );
    const flatpakRelay = join(home, '.var', 'app', 'com.google.Chrome', 'data', 'stem', 'stem-browser-host');
    expect(JSON.parse(readFileSync(join(flatpak, 'NativeMessagingHosts', 'com.stem.browser.json'), 'utf8')).path).toBe(flatpakRelay);
    expect(existsSync(join(home, '.var', 'app', 'com.slack.Slack', 'config', 'Slack', 'NativeMessagingHosts'))).toBe(false);

    const config = JSON.parse(readFileSync(paths.configPath, 'utf8'));
    const script = readFileSync(relay, 'utf8');
    expect(script).toMatch(/^#!\/bin\/bash\n/);
    expect(script).toContain(`port=${config.relayPort}\n`);
    // Its own key, not the profile's token: a sandboxed browser can read it.
    expect(script).toContain(`token='${relayKey(config.relaySecret, 'snap:chromium')}'`);
    expect(script).not.toContain(config.token);
    expect(readFileSync(flatpakRelay, 'utf8')).toContain(`token='${relayKey(config.relaySecret, 'flatpak:com.google.Chrome')}'`);
    expect(script).toContain("app='snap:chromium'");
    expectPosixMode(relay, 0o700);
    expect(existsSync(join(home, 'snap', 'chromium', 'common', 'stem', 'extension', 'background.js'))).toBe(true);
    expect(installedHere(paths, home, 'linux')).toBe(true);
    expect(relaysHere(paths, home, 'linux').sort()).toEqual(['flatpak:com.google.Chrome', 'snap:brave', 'snap:chromium']);
  });

  it('refreshes relays only for the profile that wrote them, with the port the config has now', async () => {
    browserData('snap', 'chromium', 'common', 'chromium');
    const other = mkdtempSync(join(tmpdir(), 'stem-other-'));
    await installBrowserControl(src(), browserInstallPaths(other), home, 'linux');
    const mine = browserInstallPaths(state);
    expect(relaysHere(mine, home, 'linux')).toEqual([]);
    expect(await refreshBrowserControl(src(), mine, home, 'linux')).toBeNull();
    rmSync(other, { recursive: true, force: true });

    await installBrowserControl(src(), mine, home, 'linux');
    const config = JSON.parse(readFileSync(mine.configPath, 'utf8'));
    writeFileSync(mine.configPath, JSON.stringify({ ...config, relayPort: 23456 }));
    writeFileSync(join(ext, 'background.js'), '// v2');
    expect((await refreshBrowserControl(src(), mine, home, 'linux'))?.extensionChanged).toBe(true);
    const root = join(home, 'snap', 'chromium', 'common', 'stem');
    expect(readFileSync(join(root, 'stem-browser-host'), 'utf8')).toContain('port=23456\n');
    expect(readFileSync(join(root, 'extension', 'background.js'), 'utf8')).toBe('// v2');
  });

  it.skipIf(process.platform === 'win32')('never writes through a link the sandboxed browser planted in its folder', async () => {
    browserData('snap', 'chromium', 'common', 'chromium');
    const target = join(home, 'precious');
    mkdirSync(target);
    // The snap may write anywhere under common/: it points Stem's folder elsewhere.
    symlinkSync(target, join(home, 'snap', 'chromium', 'common', 'stem'));
    await expect(installBrowserControl(src(), browserInstallPaths(state), home, 'linux')).rejects.toThrow(/not a folder of this user/);
    expect(existsSync(join(target, 'stem-browser-host'))).toBe(false);
    rmSync(join(home, 'snap', 'chromium', 'common', 'stem'));

    // Or the relay file or the extension folder.
    const root = join(home, 'snap', 'chromium', 'common', 'stem');
    mkdirSync(root);
    const victim = join(home, 'victim.txt');
    writeFileSync(victim, 'KEEP');
    symlinkSync(victim, join(root, 'stem-browser-host'));
    symlinkSync(target, join(root, 'extension'));
    await installBrowserControl(src(), browserInstallPaths(state), home, 'linux');
    expect(readFileSync(victim, 'utf8')).toBe('KEEP');
    expect(readFileSync(join(root, 'stem-browser-host'), 'utf8')).toMatch(/^#!\/bin\/bash/);
    expect(existsSync(join(target, 'background.js'))).toBe(false);
    expect(existsSync(join(root, 'extension', 'background.js'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('deletes a tree in the browser’s folder without following the links in it', async () => {
    const outside = join(home, 'outside');
    mkdirSync(join(outside, 'keep'), { recursive: true });
    writeFileSync(join(outside, 'keep', 'file'), 'KEEP');
    const tree = join(home, 'tree');
    mkdirSync(join(tree, 'a', 'b'), { recursive: true });
    writeFileSync(join(tree, 'a', 'b', 'f'), 'x');
    symlinkSync(outside, join(tree, 'a', 'link'));
    symlinkSync(join(outside, 'keep', 'file'), join(tree, 'filelink'));
    await removeInSandbox(home, 'tree');
    expect(existsSync(tree)).toBe(false);
    expect(readFileSync(join(outside, 'keep', 'file'), 'utf8')).toBe('KEEP');
    // The thing to delete itself a link: only the link goes.
    symlinkSync(outside, join(home, 'tree'));
    await removeInSandbox(home, 'tree');
    expect(existsSync(join(outside, 'keep', 'file'))).toBe(true);
    await removeInSandbox(home, 'missing');
  });

  it('offers a sandboxed browser with its own extension folder only when Snap or Flatpak has its launcher', () => {
    browserData('snap', 'chromium', 'common', 'chromium');
    browserData('.var', 'app', 'org.chromium.Chromium', 'config', 'chromium');
    const snapBin = join(home, 'sys', 'snap', 'bin');
    const exports = join(home, 'sys', 'flatpak', 'exports', 'bin');
    const path = join(home, 'bin');
    for (const d of [snapBin, exports, path]) mkdirSync(d, { recursive: true });
    // A same-named command elsewhere on PATH is not the snap.
    writeFileSync(join(path, 'chromium'), '');
    expect(setupBrowsers(home, 'linux', [path, snapBin, exports], null)).toEqual([]);
    writeFileSync(join(snapBin, 'chromium'), '');
    writeFileSync(join(exports, 'org.chromium.Chromium'), '');
    expect(setupBrowsers(home, 'linux', [path, snapBin, exports], 'org.chromium.Chromium.desktop')).toEqual([
      {
        name: 'Chromium (Flatpak)',
        app: 'flatpak:org.chromium.Chromium',
        extensionsUrl: 'chrome://extensions',
        extensionPath: join(home, '.var', 'app', 'org.chromium.Chromium', 'data', 'stem', 'extension')
      },
      {
        name: 'Chromium (Snap)',
        app: 'snap:chromium',
        extensionsUrl: 'chrome://extensions',
        extensionPath: join(home, 'snap', 'chromium', 'common', 'stem', 'extension')
      }
    ]);
    expect(extensionsPageUrl('flatpak:com.microsoft.Edge')).toBe('edge://extensions');
  });

  it('starts only the Snap and Flatpak browsers it knows, and takes only well-formed relay hellos', () => {
    expect(launchableOnLinux('snap:chromium')).toBe(true);
    expect(launchableOnLinux('flatpak:com.google.Chrome')).toBe(true);
    for (const bad of ['snap:evil', 'flatpak:org.evil.App', 'snap:toString', 'flatpak:', 'snap:../x']) {
      expect(launchableOnLinux(bad)).toBe(false);
    }
    expect(sandboxOf('snap:chromium')).toEqual({ kind: 'snap', id: 'chromium' });
    expect(sandboxOf('flatpak:com.brave.Browser')).toEqual({ kind: 'flatpak', id: 'com.brave.Browser' });
    expect(sandboxOf('flatpak:Chrome')).toBeNull();
    expect(sandboxOf('/usr/bin/chromium')).toBeNull();
    const nonce = 'a'.repeat(32);
    expect(parseRelayHello(`STEM-RELAY 1 ${nonce} snap:chromium`)).toEqual({ nonce, app: 'snap:chromium' });
    expect(parseRelayHello(`STEM-RELAY 2 ${nonce} snap:chromium`)).toBeNull();
    expect(parseRelayHello(`STEM-RELAY 1 ${nonce} /usr/bin/chromium`)).toBeNull();
    expect(parseRelayHello(`STEM-RELAY 1 short snap:chromium`)).toBeNull();
  });
});

describe('Windows', () => {
  const local = (...p: string[]) => join(home, 'AppData', 'Local', ...p);
  let registry: Map<string, string>;

  beforeEach(() => {
    registry = new Map();
    vi.spyOn(windowsRegistry, 'read').mockImplementation((key, value) => registry.get(value ? `${key}|${value}` : key) ?? null);
    vi.spyOn(windowsRegistry, 'write').mockImplementation((key, data) => void registry.set(key, data));
  });
  afterEach(() => vi.restoreAllMocks());

  it('registers each browser in the registry, pointing at one manifest beside a batch-file wrapper', async () => {
    mkdirSync(local('Google', 'Chrome', 'User Data'), { recursive: true });
    mkdirSync(local('Microsoft', 'Edge', 'User Data'), { recursive: true });
    const paths = browserInstallPaths(state, 'win32');
    expect(paths.wrapperPath.endsWith('stem-browser-host.cmd')).toBe(true);
    const res = await installBrowserControl(src(), paths, home, 'win32');
    expect(res.registered.sort()).toEqual(['Google Chrome', 'Microsoft Edge']);
    expect(registry.get('HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.stem.browser')).toBe(paths.manifestPath);
    expect(registry.get('HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.stem.browser')).toBe(paths.manifestPath);
    expect(JSON.parse(readFileSync(paths.manifestPath, 'utf8'))).toMatchObject({ name: 'com.stem.browser', path: paths.wrapperPath });
    expect(readFileSync(paths.wrapperPath, 'utf8')).toContain('set ELECTRON_RUN_AS_NODE=1\r\n');
    expect(installedHere(paths, home, 'win32')).toBe(true);
    expect(installedHere(browserInstallPaths(mkdtempSync(join(tmpdir(), 'stem-other-')), 'win32'), home, 'win32')).toBe(false);
  });

  it('offers browsers whose executable exists, the default first', () => {
    mkdirSync(local('Google', 'Chrome', 'User Data'), { recursive: true });
    mkdirSync(local('Google', 'Chrome', 'Application'), { recursive: true });
    writeFileSync(local('Google', 'Chrome', 'Application', 'chrome.exe'), '');
    mkdirSync(local('Chromium', 'User Data'), { recursive: true });
    mkdirSync(local('Chromium', 'Application'), { recursive: true });
    writeFileSync(local('Chromium', 'Application', 'chrome.exe'), '');
    // Brave was used but is gone.
    mkdirSync(local('BraveSoftware', 'Brave-Browser', 'User Data'), { recursive: true });
    expect(setupBrowsers(home, 'win32', [''], 'ChromiumHTM').map((b) => [b.name, b.app])).toEqual([
      ['Chromium', local('Chromium', 'Application', 'chrome.exe')],
      ['Google Chrome', local('Google', 'Chrome', 'Application', 'chrome.exe')]
    ]);
  });

  it('listens on a named pipe nobody can guess', () => {
    const dir = 'C:\\Users\\a\\AppData\\Roaming\\Stem\\browser';
    expect(socketPathFor(dir, 'win32')).toMatch(/^\\\\\.\\pipe\\stem-browser-[0-9a-f]{32}$/);
    expect(socketPathFor(dir, 'win32')).not.toBe(socketPathFor(dir, 'win32'));
  });

  it('quotes the paths in the batch wrapper', () => {
    expect(wrapperBatch('C:\\Program Files\\Stem\\Stem.exe', 'C:\\x\\host.js', 'C:\\s\\config.json')).toContain(
      '"C:\\Program Files\\Stem\\Stem.exe" "C:\\x\\host.js" "C:\\s\\config.json" %*'
    );
  });

  it('names the browser from its executable', () => {
    expect(browserOf('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe').appName).toBe('Google Chrome');
    expect(browserOf('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe').appName).toBe('Microsoft Edge');
    expect(browserOf('C:\\Users\\me\\AppData\\Local\\Vivaldi\\Application\\vivaldi.exe').appName).toBe('vivaldi');
  });

  it('starts only known browsers from where their installers put them', () => {
    for (const ok of [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'c:\\program files (x86)\\microsoft\\edge\\application\\msedge.exe',
      'C:\\Users\\john.doe\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
    ]) {
      expect(windowsBrowserName(ok)).not.toBeNull();
      expect(launchableBrowser(ok, 'win32')).toBe(true);
    }
    for (const bad of [
      'C:\\Users\\me\\Downloads\\chrome.exe',
      'C:\\Users\\..\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Users\\me/../..\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe.bat',
      'chrome.exe',
      ''
    ]) {
      expect(launchableBrowser(bad, 'win32')).toBe(false);
    }
  });
});

describe('pieces', () => {
  it('quotes paths with spaces and quotes in the wrapper', () => {
    const script = wrapperScript('/Applications/Stem.app/Contents/MacOS/Stem', "/x/it's here.js", '/a b/config.json');
    expect(script).toContain(
      `ELECTRON_RUN_AS_NODE=1 exec '/Applications/Stem.app/Contents/MacOS/Stem' '/x/it'\\''s here.js' '/a b/config.json' "$@"`
    );
  });

  it('offers Set up’s steps only for browsers used here and still installed', () => {
    mkdirSync(support('Arc', 'User Data'), { recursive: true });
    mkdirSync(support('BraveSoftware', 'Brave-Browser'), { recursive: true });
    mkdirSync(support('Microsoft Edge'), { recursive: true });
    mkdirSync(support('jbrow'), { recursive: true });
    const apps = join(home, 'Apps');
    mkdirSync(join(apps, 'Arc.app'), { recursive: true });
    mkdirSync(join(apps, 'Brave Browser.app'), { recursive: true });
    mkdirSync(join(apps, 'jbrow.app'), { recursive: true });
    // Chrome's folder gets Arc's manifest but Chrome was never used; Edge was
    // used but is gone; jbrow loads the folder from its own menu.
    expect(setupBrowsers(home, 'darwin', [apps], null)).toEqual([
      { name: 'Arc', app: 'Arc', extensionsUrl: 'arc://extensions' },
      { name: 'Brave', app: 'Brave Browser', extensionsUrl: 'chrome://extensions' }
    ]);
    // The default browser leads; LaunchServices stores its id lowercased.
    expect(setupBrowsers(home, 'darwin', [apps], 'com.brave.browser').map((b) => b.name)).toEqual(['Brave', 'Arc']);
    expect(extensionsPageUrl('/Applications/Arc.app')).toBe('arc://extensions');
    expect(extensionsPageUrl('/Applications/Google Chrome.app')).toBe('chrome://extensions');
    expect(extensionsPageUrl('Microsoft Edge')).toBe('edge://extensions');
  });

  it.skipIf(process.platform === 'win32')('keeps socket paths under the unix limit', () => {
    expect(socketPathFor('/short')).toBe('/short/host.sock');
    const long = socketPathFor(`/${'x'.repeat(120)}`);
    expect(Buffer.byteLength(long)).toBeLessThan(104);
  });

  it('reads the browser app off the parent command', () => {
    expect(browserOf('/Applications/Arc.app/Contents/MacOS/Arc')).toEqual({ appPath: '/Applications/Arc.app', appName: 'Arc' });
    expect(browserOf('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')).toEqual({
      appPath: '/Applications/Google Chrome.app',
      appName: 'Google Chrome'
    });
  });

  it('frames survive arbitrary chunking and oversize frames are refused', () => {
    const bytes = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: 'two' })]);
    const reader = new FrameReader();
    const out: unknown[] = [];
    for (let i = 0; i < bytes.length; i += 3) {
      for (const body of reader.push(bytes.subarray(i, i + 3))) out.push(JSON.parse(body.toString('utf8')));
    }
    expect(out).toEqual([{ a: 1 }, { b: 'two' }]);
    const small = new FrameReader(4);
    expect(() => small.push(encodeFrame({ long: 'xxxxxxxx' }))).toThrow(/cap/);
  });
});
