using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// stem-computer.exe — the Windows half of Stem's computer control, the twin of
// native/mac/stem-computer. A child of the Stem desktop app that speaks one
// JSON object per line on stdin/stdout, with the same commands and replies as
// the Mac helper (see its main.swift), so src/desktop/computer-host drives
// either one. Windows asks for no permissions: capture, input and UI
// Automation are open to any app in the user's session.
//
// Coordinates on the wire are pixels of the LAST SCREENSHOT this helper made
// (downscaled so the long side is at most 1568); the helper keeps the scale
// and maps them to screen pixels itself. The process is per-monitor DPI aware,
// so every Windows API here speaks physical pixels.
//
// Two modes. SCREEN (the default): the frame is the primary display, input is
// real (SendInput), and the person's first touch of their own mouse or
// keyboard ends the run. WINDOW (after select-window): the frame is one window
// wherever it sits in the stack (PrintWindow), clicks go through UI Automation
// or as messages posted to that window, so it never comes forward — the run
// ends from the banner's Stop instead.
//
// Built with the C# compiler every Windows has (.NET Framework 4.8's csc.exe,
// C# 5) by scripts/build-windows-helper.mjs; no SDK needed.
namespace StemComputer
{
    static class Program
    {
        static readonly object outLock = new object();
        static readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 64 };
        static Stream stdout;
        static readonly bool tracing = Environment.GetEnvironmentVariable("STEM_COMPUTER_TRACE") != null;

        static Capture capture;
        static Input input;
        static Watch watch;
        static Uia uia;
        static WindowInfo selected;
        static bool wantShot = true;
        /// The selected app's windows as last seen, to tell when an action opened another.
        static uint knownPid;
        static HashSet<long> knownWindows;

        public static void Emit(Dictionary<string, object> obj)
        {
            byte[] line = Encoding.UTF8.GetBytes(json.Serialize(obj) + "\n");
            lock (outLock)
            {
                stdout.Write(line, 0, line.Length);
                stdout.Flush();
            }
        }

        static void Trace(string message)
        {
            if (tracing) Console.Error.WriteLine("[stem-computer] " + message);
        }

        static void Fail(object id, string message)
        {
            Emit(new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", message } });
        }

        static double? Number(Dictionary<string, object> obj, string key)
        {
            object v;
            if (obj == null || !obj.TryGetValue(key, out v) || v == null) return null;
            if (v is int) return (int)v;
            if (v is long) return (long)v;
            if (v is decimal) return (double)(decimal)v;
            if (v is double) return (double)v;
            return null;
        }

        static string Str(Dictionary<string, object> obj, string key)
        {
            object v;
            return obj != null && obj.TryGetValue(key, out v) ? v as string : null;
        }

        static bool? Bool(Dictionary<string, object> obj, string key)
        {
            object v;
            if (obj != null && obj.TryGetValue(key, out v) && v is bool) return (bool)v;
            return null;
        }

        static Dictionary<string, object> Sub(Dictionary<string, object> obj, string key)
        {
            object v;
            return obj != null && obj.TryGetValue(key, out v) ? v as Dictionary<string, object> : null;
        }

        static bool WindowMode { get { return capture.Target != null; } }

        static object TargetField()
        {
            return capture.Target != null ? (object)capture.Target.Summary() : null;
        }

        static Dictionary<string, object> Access()
        {
            return new Dictionary<string, object> { { "screen", true }, { "accessibility", true }, { "inputMonitoring", true } };
        }

        static string NoteNewWindows()
        {
            var t = capture.Target;
            if (t == null) return null;
            var now = Windows.AppWindows(t.Pid);
            var before = knownWindows;
            bool samePid = knownPid == t.Pid;
            knownPid = t.Pid;
            knownWindows = new HashSet<long>(now.Select(w => w.Id));
            if (before == null || !samePid) return null;
            var fresh = now.Where(w => !before.Contains(w.Id) && w.Hwnd != t.Hwnd).ToList();
            if (fresh.Count == 0) return null;
            return t.App + " opened a new window: " + string.Join("; ", fresh.Select(Windows.Brief)) + ". It is a separate window, not in this one's picture: select_window window_id " + fresh[0].Id + " to work in it (staying in window mode), rather than switching to the whole screen.";
        }

        static void AnswerWithScreenshot(object id, int settleMs = 300, string text = null)
        {
            if (settleMs > 0) Thread.Sleep(settleMs);
            var said = string.Join("\n\n", new[] { text, WindowMode ? NoteNewWindows() : null }.Where(s => !string.IsNullOrEmpty(s)));
            if (!wantShot)
            {
                Emit(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "text", said.Length == 0 ? "Done." : said }, { "target", TargetField() } });
                return;
            }
            var shot = capture.Screenshot();
            var reply = new Dictionary<string, object> { { "id", id }, { "ok", true }, { "screenshot", shot }, { "cursor", input.CursorInScreenshot() }, { "target", TargetField() } };
            if (said.Length > 0) reply["text"] = said;
            Emit(reply);
        }

        static void SelectWindow(WindowInfo info)
        {
            selected = info;
            knownWindows = null;
            if (info != null)
            {
                if (uia == null || uia.Hwnd != info.Hwnd) uia = new Uia(info.Hwnd, info.Pid);
                capture.Target = new Target { Hwnd = info.Hwnd, Pid = info.Pid, App = info.App, Title = info.Title, Bounds = info.Bounds };
                input.KeyboardWindow = info.Hwnd;
                watch.Disarm();
            }
            else
            {
                capture.Target = null;
                input.KeyboardWindow = IntPtr.Zero;
                uia = null;
            }
        }

        static HelperError ScreenOnly(string what)
        {
            return new HelperError(what + " is a screen-mode action (it moves the real mouse). Clear the window first: select_window with no arguments.");
        }

        static void Handle(Dictionary<string, object> obj)
        {
            object id = obj.ContainsKey("id") ? obj["id"] : null;
            string cmd = Str(obj, "cmd") ?? "";
            wantShot = Bool(obj, "shot") ?? true;
            Trace("cmd " + cmd);
            try
            {
                switch (cmd)
                {
                    case "status":
                    case "request-access":
                        Emit(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "status", Access() } });
                        break;
                    case "screenshot":
                        wantShot = true;
                        AnswerWithScreenshot(id, 0);
                        break;
                    case "cursor":
                        if (WindowMode) throw ScreenOnly("cursor_position");
                        Emit(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "cursor", input.CursorInScreenshot() }, { "target", TargetField() } });
                        break;
                    case "move":
                        if (WindowMode) throw ScreenOnly("mouse_move");
                        watch.Arm();
                        input.Move(Number(obj, "x"), Number(obj, "y"));
                        AnswerWithScreenshot(id);
                        break;
                    case "click":
                        {
                            string button = Str(obj, "button") ?? "left";
                            int count = (int)(Number(obj, "count") ?? 1);
                            if (WindowMode)
                            {
                                var x = Number(obj, "x");
                                var y = Number(obj, "y");
                                if (!x.HasValue || !y.HasValue) throw new HelperError("In window mode a click needs a coordinate (there is no cursor to click at).");
                                uia.Click(capture.ToPoint(x.Value, y.Value), button, count);
                            }
                            else
                            {
                                watch.Arm();
                                input.Click(Number(obj, "x"), Number(obj, "y"), button, count);
                            }
                            AnswerWithScreenshot(id);
                            break;
                        }
                    case "drag":
                        {
                            if (WindowMode) throw ScreenOnly("left_click_drag");
                            watch.Arm();
                            var from = Sub(obj, "from");
                            var to = Sub(obj, "to");
                            input.Drag(Number(from, "x"), Number(from, "y"), Number(to, "x"), Number(to, "y"));
                            AnswerWithScreenshot(id);
                            break;
                        }
                    case "scroll":
                        {
                            string dir = Str(obj, "dir") ?? "down";
                            int amount = (int)(Number(obj, "amount") ?? 3);
                            if (WindowMode)
                            {
                                var x = Number(obj, "x");
                                var y = Number(obj, "y");
                                if (!x.HasValue || !y.HasValue) throw new HelperError("In window mode scroll needs a coordinate over the area to scroll.");
                                uia.Scroll(capture.ToPoint(x.Value, y.Value), dir, amount);
                            }
                            else
                            {
                                watch.Arm();
                                input.Scroll(Number(obj, "x"), Number(obj, "y"), dir, amount);
                            }
                            AnswerWithScreenshot(id);
                            break;
                        }
                    case "type":
                        if (WindowMode && !uia.HasFocusedControl())
                        {
                            throw new HelperError("Nothing in this window has keyboard focus. Click a field or `focus` its id first, then type.");
                        }
                        if (!WindowMode) watch.Arm();
                        input.Type(Str(obj, "text") ?? "");
                        AnswerWithScreenshot(id);
                        break;
                    case "key":
                        if (!WindowMode) watch.Arm();
                        input.PressKey(Str(obj, "combo") ?? "");
                        AnswerWithScreenshot(id);
                        break;
                    case "hold":
                        if (!WindowMode) watch.Arm();
                        input.Hold(Str(obj, "combo") ?? "", (int)(Number(obj, "ms") ?? 0));
                        AnswerWithScreenshot(id);
                        break;
                    case "wait":
                        AnswerWithScreenshot(id, (int)(Number(obj, "ms") ?? 1000));
                        break;
                    case "zoom":
                        {
                            var shot = capture.Zoom(Number(obj, "x") ?? 0, Number(obj, "y") ?? 0, Number(obj, "w") ?? 0, Number(obj, "h") ?? 0);
                            Emit(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "screenshot", shot }, { "cursor", input.CursorInScreenshot() }, { "target", TargetField() } });
                            break;
                        }
                    case "list-windows":
                        Emit(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "text", Windows.Describe(Windows.List()) }, { "target", TargetField() } });
                        break;
                    case "select-window":
                        {
                            var windowId = Number(obj, "windowId");
                            string app = (Str(obj, "app") ?? "").Trim();
                            string title = (Str(obj, "title") ?? "").Trim();
                            if (!windowId.HasValue && app.Length == 0)
                            {
                                SelectWindow(null);
                                AnswerWithScreenshot(id, 0);
                                break;
                            }
                            var info = Windows.Find(windowId.HasValue ? (long?)(long)windowId.Value : null, app, title);
                            SelectWindow(info);
                            NoteNewWindows();
                            Dictionary<string, object> shot;
                            try
                            {
                                shot = capture.Screenshot();
                            }
                            catch (Exception)
                            {
                                SelectWindow(null);
                                throw;
                            }
                            var reply = new Dictionary<string, object> { { "id", id }, { "ok", true }, { "target", TargetField() } };
                            if (wantShot)
                            {
                                reply["screenshot"] = shot;
                                reply["cursor"] = input.CursorInScreenshot();
                            }
                            else
                            {
                                reply["text"] = "Done.";
                            }
                            Emit(reply);
                            break;
                        }
                    case "snapshot":
                        {
                            if (!WindowMode) throw new HelperError("snapshot lists the controls of a selected window; select_window first (or take a screenshot of the screen).");
                            var shot = capture.Screenshot();
                            int depth = (int)(Number(obj, "depth") ?? 12);
                            string tree = uia.Snapshot(Math.Max(1, Math.Min(depth, 30)), capture.Target.Bounds, capture.Pixel, capture.PixelsPerShotPixel);
                            var reply = new Dictionary<string, object> { { "id", id }, { "ok", true }, { "text", tree }, { "target", TargetField() } };
                            if (wantShot)
                            {
                                reply["screenshot"] = shot;
                                reply["cursor"] = input.CursorInScreenshot();
                            }
                            Emit(reply);
                            break;
                        }
                    case "press":
                        if (!WindowMode) throw new HelperError("press acts on a snapshot id; select_window and snapshot first.");
                        uia.Press((int)(Number(obj, "element") ?? -1));
                        AnswerWithScreenshot(id);
                        break;
                    case "focus":
                        if (!WindowMode) throw new HelperError("focus acts on a snapshot id; select_window and snapshot first.");
                        uia.Focus((int)(Number(obj, "element") ?? -1));
                        AnswerWithScreenshot(id, 100);
                        break;
                    case "menu":
                        if (!WindowMode) throw new HelperError("menu acts on a snapshot id; select_window and snapshot first.");
                        uia.Menu((int)(Number(obj, "element") ?? -1));
                        AnswerWithScreenshot(id);
                        break;
                    case "set-value":
                        if (!WindowMode) throw new HelperError("set_value acts on a snapshot id; select_window and snapshot first.");
                        uia.SetValue((int)(Number(obj, "element") ?? -1), Str(obj, "text") ?? "");
                        AnswerWithScreenshot(id);
                        break;
                    case "peek-window":
                    {
                        var peekId = Number(obj, "windowId");
                        Peek.FrontWindow(id, peekId.HasValue ? (long?)(long)peekId.Value : null);
                        break;
                    }
                    case "peek-text":
                        Emit(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "text", Peek.Text((long)(Number(obj, "windowId") ?? 0), (int)(Number(obj, "maxChars") ?? 20000)) } });
                        break;
                    case "window-bounds":
                        Emit(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "bounds", Peek.Bounds((long)(Number(obj, "windowId") ?? 0)) } });
                        break;
                    case "watch":
                        if (Bool(obj, "on") ?? true)
                        {
                            watch.Start(kind => Emit(new Dictionary<string, object> { { "event", "human-input" }, { "kind", kind } }));
                        }
                        else
                        {
                            watch.Stop();
                        }
                        Emit(new Dictionary<string, object> { { "id", id }, { "ok", true } });
                        break;
                    case "stop":
                        watch.Stop();
                        Emit(new Dictionary<string, object> { { "id", id }, { "ok", true } });
                        Environment.Exit(0);
                        break;
                    default:
                        Fail(id, "unknown command \"" + cmd + "\"");
                        break;
                }
            }
            catch (HelperError e)
            {
                Fail(id, e.Message);
            }
            catch (Exception e)
            {
                Fail(id, e.GetType().Name + ": " + e.Message);
            }
        }

        [STAThread]
        static void Main()
        {
            // Physical pixels everywhere (PER_MONITOR_AWARE_V2 = -4), or at least system-aware.
            if (!Native.SetProcessDpiAwarenessContext((IntPtr)(-4))) Native.SetProcessDPIAware();
            uint parent;
            if (uint.TryParse(Environment.GetEnvironmentVariable("STEM_PARENT_PID") ?? "", out parent)) Windows.ParentPid = parent;
            stdout = Console.OpenStandardOutput();
            capture = new Capture();
            input = new Input(capture);
            watch = new Watch();
            var reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            string line;
            while ((line = reader.ReadLine()) != null)
            {
                if (line.Trim().Length == 0) continue;
                Dictionary<string, object> obj;
                try
                {
                    obj = json.DeserializeObject(line) as Dictionary<string, object>;
                }
                catch (Exception)
                {
                    obj = null;
                }
                if (obj == null)
                {
                    Emit(new Dictionary<string, object> { { "ok", false }, { "error", "unreadable command" } });
                    continue;
                }
                Handle(obj);
            }
            watch.Stop();
        }
    }
}
