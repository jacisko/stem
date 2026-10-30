// Which windows belong to a Chromium browser the Stem extension runs in, on
// each platform. A window's `bundleId` is a different kind of id per platform
// (window-peek.ts): the bundle id on the Mac, the exe name without ".exe",
// lowercased, on Windows, and the desktop-file id or WM_CLASS on Linux. Kept in
// step with the browsers Set up registers (desktop/browser-host/install.ts).

const BROWSER_IDS = new Set(
  [
    // macOS bundle ids
    'com.google.Chrome',
    'company.thebrowser.Browser',
    'company.thebrowser.dia',
    'com.brave.Browser',
    'org.chromium.Chromium',
    'com.microsoft.edgemac',
    'com.google.chrome.for.testing',
    'com.vivaldi.Vivaldi',
    'com.operasoftware.Opera',
    'net.imput.helium',
    'sk.awantech.jbrow',
    // Windows exe names
    'chrome',
    'msedge',
    'brave',
    'arc',
    'vivaldi',
    'opera',
    'thorium',
    // Linux desktop ids, WM_CLASS and Flatpak ids
    'google-chrome',
    'google-chrome-stable',
    'google-chrome-beta',
    'google-chrome-unstable',
    'chromium',
    'chromium-browser',
    'brave-browser',
    'microsoft-edge',
    'microsoft-edge-stable',
    'microsoft-edge-beta',
    'microsoft-edge-dev',
    'vivaldi-stable',
    'helium',
    'com.google.Chrome',
    'com.microsoft.Edge',
    'com.brave.Browser',
    'org.chromium.Chromium'
  ].map((id) => id.toLowerCase())
);

/** An app name, when the window came without an id. */
const BROWSER_NAME = /^(google chrome|chromium|arc|dia|brave( browser)?|microsoft edge|vivaldi|opera|helium|thorium|jbrow)\b/i;

/** Whether a window of this app is a browser the `browser` tool can drive. */
export function isBrowserApp(app: string, bundleId: string | null): boolean {
  return bundleId ? BROWSER_IDS.has(bundleId.toLowerCase()) : BROWSER_NAME.test(app.trim());
}
