# Browser control through a Chromium extension

Status: built on the 0.6.0 branch (October 2026). User-facing page:
[user/browser-control.md](user/browser-control.md).

Stem drives the user's own, signed-in browser through the Stem extension, replacing
the earlier setup of launching Arc with `--remote-debugging-port` and pointing a
DevTools MCP server at it, which needed a special launch and left an unauthenticated
CDP port open to every local process.

## Decisions (2026-10-05)

These replace the stricter plan of 7 September 2026, which had per-tab grants, origin
gates, approval before submits, and an automatic pause when the user touched a tab.
The user chose the computer-control posture instead.

| Area | Decision |
| --- | --- |
| Reach | Any ordinary tab, signed-in ones included. No tab grants, no origin gates, no approval before a submit. Incognito is excluded. |
| Who | Its own persona pin, `Persona.browser {device}`, separate from the computer pin. Chats with no persona follow `chatFeatures.browser` (Settings → Features → Browser control → Allow in chats), either a fixed Mac or the model's pick. It applies to chats, mail and scheduled runs, as for computer control. |
| Consent | A client-local switch on the Mac, off by default and never sent over the wire. |
| Where | Pages Stem opens are background tabs in the user's last-focused window (in Arc, the current Space). Stem never switches the view, and the tabs stay open after the run. The model may also act in any existing tab, but closes only tabs it opened. |
| Debugging bar | `chrome.debugger` is attached on the first touch of a tab and detached at the end of the run, or after 3 idle minutes, so the bar shows only during runs. Cancelling the bar counts as Stop. |
| Marker | A border and a "Stem is working · Stop" pill inside the tab, drawn in a CDP isolated world and hidden while a screenshot is taken. There is no automatic pause, and no floating screen pill. |
| Actions | `tabs`, `open`, `navigate`, `snapshot` (an accessibility outline with refs), `screenshot`, `click`, `hover`, `type`, `fill`, `press`, `scroll`, `wait`, `dialog`, `evaluate`, `console`, `network`, `upload`, `downloads`, `close`. |
| Uploads | Only files Stem holds: Files, scratch, connected folders, `img_` ids, and the conversation's attachments, which a browser turn keeps as files. Never an arbitrary path on the Mac. |
| Downloads | Copied into the conversation's scratch `downloads/` on the server. |
| Several browsers | One per computer, chosen in that computer's Settings. The chosen browser is started when a run needs it and it is closed: `open -g -a` on a Mac; on Linux its executable is run unless a process already runs it, and it may come to the front. |
| Several profiles (2026-10-13) | Every profile with the extension connects on its own and stays connected. Settings names them and picks the default; the model names another with `profile`, and that profile sticks to the thread until the run ends. `tabs` with no profile lists every open profile's tabs. See below. |
| Concurrency | Several runs at once, each keeping track of its own tabs, with one action queue per tab. A run is warned when another run used the same tab recently. |
| Platform | macOS: Arc, Chrome, Dia, Brave, plus Chromium, Edge and Chrome for Testing when they are installed. Linux: Chrome, Brave, Chromium, Edge, plus every other Chromium user-data folder under `$XDG_CONFIG_HOME` (one or two levels down, `Local State` + `Default/`, which leaves Electron apps out) — Helium, Thorium, Vivaldi, Opera, beta channels. The browser is named by `/proc/<ppid>/exe`; for an AppImage (exe inside the parent's `APPDIR`) by its `APPIMAGE` file instead, since the mount changes every launch. Stem starts known system binaries, and AppImages that are a regular executable file with the AppImage magic, owned by the user or root and writable by no one else; a tarball browser in the home folder connects but is never started. Snap and Flatpak browsers (Chromium-family user-data folders under `~/snap/<name>/{common,current/.config}` and `~/.var/app/<id>/config`) get a bash relay in their own folder (`~/snap/<name>/common/stem`, `~/.var/app/<id>/data/stem`) instead of the Node host, since the sandbox runs nothing outside it: it reaches Stem on a loopback TCP port (kept in the config, up only while a relay is set up for this profile) with the HMAC handshake in text lines under its own key (an HMAC of its id under a secret only the desktop keeps, so a compromised sandboxed browser can neither pose as another nor learn the profile token), then pipes frames unparsed (`desktop/browser-host/relay.ts`). Each gets its own extension copy and upload folder there, the desktop spools its downloads itself, only plain files inside the XDG Downloads folder (opened O_NOFOLLOW, checked via /proc/self/fd); work in the browser's folder goes through a folder held open (each part opened O_NOFOLLOW through its parent, then `/proc/self/fd/<n>/…` paths, openat by another name), files created O_EXCL and renamed in, the extension staged in Stem's own folder; download opens are O_NONBLOCK so a planted FIFO cannot hang them, and it is named `snap:<name>` / `flatpak:<id>` ("Chromium (Snap)"); Stem starts only the ones in `SANDBOXED_BROWSERS`, via `/snap/bin/<name>` or `flatpak run`. Verified with Flatpak Chromium 156 (2026-10-25); Snap untested on a real install. Windows: no. |
| Install | An unpacked extension: Set up copies it into the profile's state folder and writes native-messaging manifests. The extension id is fixed by the manifest `key`. A Web Store listing comes later. |
| Local server | Works when the server runs on the same Mac. Computer control was opened up to that case at the same time. |

## How a call travels

```
pi `browser` tool ──ctx.ui.input(stem-browser-bridge)──▶ PiRuntime.handleMacToolBridge
  └▶ startup/browser.ts (files) ──▶ browser-device/router.ts ──SSE 'browser-request'──▶ Mac
       └▶ desktop/browser-host ──unix socket (0600, token)──▶ native host (Stem binary as Node)
            └▶ native messaging ──▶ extension service worker ──chrome.debugger/tabs/downloads──▶ tab
  ◀── answers return the same way; the Mac replies with RPC `browserHost:result`
```

- The wire messages and framing are defined in `src/shared/browser-native.ts`. Both
  legs use Chrome's 4-byte length framing, so the native host relays frames without
  re-serialising them.
- File bytes never travel in SSE frames or native messages (Chrome caps host→extension
  messages at 1 MB). For an upload, the server checks each file and copies it through
  the verified handle into a private outbox (`files/outbox.ts`, `files/browser-sources.ts`).
  The Mac fetches it once through `GET /files/stem-outbox:<id>`, the extension attaches
  it with `DOM.setFileInputFiles`, and the local copy is removed when the run ends.
- Downloads: the native host copies a finished download out of `~/Downloads` into the
  spool. It runs as the browser's child, so macOS attributes that read to the browser.
  The desktop then streams the copy up with `POST /upload`, and the server files it into
  scratch.
- The native host keeps retrying the socket while Stem is down. The open native port
  keeps the extension's service worker alive, so it sees Stem come back.

## Profiles

Each browser profile runs its own copy of the extension, and so its own native host.
Until 0.7.0 the desktop keyed connections by the app bundle the host was launched from,
so Arc's work and personal profiles replaced each other's connection every few seconds.
Now the extension keeps a random id in `chrome.storage.local` (one per profile) and sends
it in its `hello`, along with the three sites most open there. The desktop keys
connections by `<app path>#<profile id>`, and a connection counts only once that hello
has arrived (the native host replays it on every socket connection).

- Names: the user's label from Settings, otherwise "Arc 2" by connect order when an app
  has several profiles, otherwise the app's name. The desktop sends each extension its
  name (`{type: 'profile'}`) for the toolbar popup, which is how the user tells the
  profiles apart. The sites hint is shown only in that Mac's Settings and never goes to
  the server.
- Routing: `DeviceBrowserRequest.profile` is the name the model passed. The desktop
  resolves it (a profile's name, or an app with one profile), and it then sticks to the
  thread until the `end` frame. With no name, the thread's last profile is used, or the
  default.
- `tabs` without a profile on a Mac with several asks every connected profile, plus the
  thread's own one (started if needed), and answers with one section per profile. Arc's
  sidebar completion is added once.
- Entries remembered before profiles (the bare app path) are taken over by the first
  profile of that app to connect, keeping their name and their place as the default.
- An extension older than 0.7.0 sends no id and is keyed by the app path, as before.
- Starting a closed profile: Stem can only start the app (`open -g -a`). Chrome then
  opens its last-used profile. When the wanted profile does not connect, the error tells
  the model to ask the user to open a window of it.
- A persona pin to a single profile is not built. The model picks the profile from the
  task.

## Arc's unloaded tabs

Arc gives extensions only the tabs it has loaded since it started. A sidebar tab
nobody has clicked since then is not a Chromium tab at all, so `chrome.tabs` misses it
(found 2026-10-06: 2 of 101 tabs listed). For Arc, the desktop completes the `tabs`
answer from Arc's AppleScript dictionary (`browser-host/arc-tabs.ts`, about 0.2 s): the
extension reports the URLs it saw, and the rest are listed by Space without ids. To work
in one, the model opens its URL in a new background tab. Stem never selects a sidebar
tab, because that would switch the user's view. The first read asks for macOS Automation
permission (Stem → Arc).

## Security notes

- The token in `<state>/browser/config.json` (0600) proves only that the native host was
  installed by this Stem profile. It does not protect against malware running as the
  same user, which could read the same file.
- `allowed_origins` limits which extension the browser lets start the host.
- Page content is untrusted. The tool description and the persona brief tell the model
  never to follow instructions found on a page. That is the main defence against a
  hostile page steering a run into the user's other signed-in tabs, and it is a
  prompt, not a boundary. The user accepted that trade for the no-approvals posture.

## Feasibility probe

`experiments/browser-control/` holds the September probe, which passed 14/14 checks in
Chrome and Chrome for Testing. Arc stayed unverified because Arc ignores
`--user-data-dir`, so an isolated second instance never started. Arc is reported to read
native-messaging manifests from Chrome's folder, so Set up writes to both Arc's folder
and Chrome's. One probe finding still holds: `Input.insertText` through extension CDP
produces `isTrusted: true` events, which is part of why automatic pause on takeover was
dropped.
