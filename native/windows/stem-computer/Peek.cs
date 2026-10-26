using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace StemComputer
{
    /// "Ask about this window": which window the person is in, one picture of
    /// it, its readable text, and where it is now (the panel docks beside it).
    /// The Windows twin of WindowPeek.swift. Bounds are physical pixels; the
    /// desktop app converts them to its own units.
    static class Peek
    {
        static Dictionary<string, object> Rect(RECT r)
        {
            return new Dictionary<string, object> { { "x", r.Left }, { "y", r.Top }, { "width", r.Width }, { "height", r.Height } };
        }

        /// The foreground window, or the next one down when Stem itself is in front.
        static WindowInfo Front()
        {
            var listed = Windows.List().Where(w => !w.Minimized && !w.OtherDesktop).ToList();
            var fg = Native.GetForegroundWindow();
            var hit = listed.FirstOrDefault(w => w.Hwnd == fg);
            return hit ?? listed.FirstOrDefault();
        }

        /// `windowId` re-captures a window asked about before (the panel's New).
        public static void FrontWindow(object id, long? windowId)
        {
            var access = new Dictionary<string, object> { { "screen", true }, { "accessibility", true }, { "inputMonitoring", true } };
            var w = windowId.HasValue
                ? Windows.List().FirstOrDefault(x => x.Id == windowId.Value && !x.Minimized)
                : Front();
            if (w == null)
            {
                Program.Emit(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "window", null }, { "access", access } });
                return;
            }
            var reply = new Dictionary<string, object> {
                { "id", id }, { "ok", true }, { "access", access },
                { "window", new Dictionary<string, object> {
                    { "windowId", w.Id }, { "app", w.App },
                    // What MCP app matching keys on, like a Mac bundle id: the program's file name.
                    { "bundleId", string.IsNullOrEmpty(w.Exe) ? null : Path.GetFileNameWithoutExtension(w.Exe).ToLowerInvariant() },
                    { "title", w.Title }, { "bounds", Rect(w.Bounds) } } }
            };
            try
            {
                var capture = new Capture();
                capture.Target = new Target { Hwnd = w.Hwnd, Pid = w.Pid, App = w.App, Title = w.Title, Bounds = w.Bounds };
                reply["screenshot"] = capture.Screenshot();
            }
            catch (Exception e)
            {
                reply["text"] = e.Message;
            }
            Program.Emit(reply);
        }

        public static string Text(long windowId, int maxChars)
        {
            var w = Windows.List().FirstOrDefault(x => x.Id == windowId);
            if (w == null) return null;
            try
            {
                return new Uia(w.Hwnd, w.Pid).ReadableText(w.Bounds, maxChars);
            }
            catch (Exception)
            {
                return null;
            }
        }

        public static object Bounds(long windowId)
        {
            var hwnd = new IntPtr(windowId);
            if (!Native.IsWindow(hwnd) || Native.IsIconic(hwnd)) return null;
            return Rect(Native.Frame(hwnd));
        }
    }
}
