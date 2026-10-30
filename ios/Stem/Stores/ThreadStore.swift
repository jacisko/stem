import Foundation
import Observation
import UIKit

/// One open chat: its transcript, live turn state, and the actions the
/// composer can take on it. Port of src/shared/chatState.ts.
@MainActor @Observable
final class ThreadStore {
    private(set) var threadId: String?
    /// The chat list's row wins: it follows renames and the title written
    /// after the first reply, which history loaded earlier doesn't see.
    var title: String {
        if let id = threadId, let row = session.chats.chats.first(where: { $0.threadId == id }),
           row.subject?.isEmpty == false || !row.title.isEmpty {
            return row.displayTitle
        }
        return loadedTitle
    }
    private var loadedTitle = ""
    private(set) var messages: [ChatMessage] = []
    private(set) var running = false
    /// "Thinking", or the running tool.
    private(set) var activityLabel: String?
    private(set) var activities: [ActivityItem] = []
    private(set) var activeTurnId: String?
    private(set) var loading = false
    private(set) var isPrivate = false
    /// The open chat's own format ("mdx" or "md"), stored with it on the server.
    /// A draft has none yet: it starts in the composer's default.
    private(set) var format: String?
    /// Where a draft is filed once its first send makes it a chat.
    let folderId: String?
    var error: String?

    let session: Session
    @ObservationIgnored private var sub: UUID?
    /// The turn this phone just started, before startTurn answered with a thread.
    @ObservationIgnored private var pendingTurnId: String?
    /// A send whose answer the connection lost. The server may well have run it
    /// (switching apps mid-send cuts the request, not the turn), so sending the
    /// same message again reuses its turn id and the server answers with the
    /// turn it already started instead of a duplicate chat.
    @ObservationIgnored private var unanswered: (text: String, files: Int, turnId: String)?
    /// Voice chat (`ask`): callers waiting on a turn's final reply, and the
    /// recent ends of turns this store saw, for a turn that settled first.
    @ObservationIgnored private var replyWaiters: [String: CheckedContinuation<String, Error>] = [:]
    @ObservationIgnored private var settledReplies: [String: Result<String, Error>] = [:]
    /// What the last successful `send` started, and the reply when the backend answered it itself.
    @ObservationIgnored private var lastStart: (turnId: String, handledReply: String?)?

    init(session: Session, threadId: String?, folderId: String? = nil) {
        self.session = session
        self.threadId = threadId
        self.folderId = folderId
        if let id = threadId, let row = session.chats.chats.first(where: { $0.threadId == id }) {
            isPrivate = row.private == true
            format = row.format ?? "mdx"
        }
    }

    private var client: StemClient { session.client }

    /// Switch the open chat between MDX and plain Markdown. Its next turn runs on
    /// a server worker of the other kind; messages already written stay as they are.
    func setFormat(_ next: String) async {
        guard let id = threadId else { return }
        let previous = format
        format = next
        do { try await client.run("chats:setFormat", [.string(id), .string(next)]) }
        catch {
            format = previous
            self.error = error.localizedDescription
        }
    }

    /// Running here or anywhere: another device's turn also blocks sending.
    var busy: Bool {
        running || pendingTurnId != nil || (threadId.map { session.connection.liveTurns[$0] != nil } ?? false)
    }

    func open() {
        guard sub == nil else { return }
        sub = session.connection.subscribe { [weak self] e in self?.on(e) }
        if let id = threadId {
            Task {
                loading = messages.isEmpty
                await load(channel: "chats:open")
                loading = false
                await session.chats.setRead([id], true)
            }
        }
    }

    func close() {
        if let sub { session.connection.unsubscribe(sub) }
        sub = nil
    }

    // MARK: Loading

    func reload() async { await load(channel: "chats:history") }

    private func load(channel: String) async {
        guard let id = threadId else { return }
        do {
            let h = try await client.call(channel, [.string(id)], as: ChatHistory.self)
            if !h.title.isEmpty { loadedTitle = h.title }
            merge(history: h.messages)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        // A turn the snapshot says isn't running can't be running here either.
        if running, pendingTurnId == nil, session.connection.status == .live, session.connection.liveTurns[id] == nil {
            settleLocally()
        }
    }

    /// Saved history wins, except for what it can't know yet: the message
    /// this phone just sent and the reply still streaming.
    private func merge(history: [ChatMessage]) {
        var out = history.map { m -> ChatMessage in var m = m; m.hydrated = m.role == "assistant"; return m }
        func match(_ m: ChatMessage) -> Int? {
            if let i = out.firstIndex(where: { $0.id == m.id }) { return i }
            if let rt = m.runtimeTurnId,
               let i = out.firstIndex(where: { $0.role == m.role && ($0.runtimeTurnId == rt || $0.turnId == rt) }) { return i }
            if m.optimistic == true {
                let text = m.content.trimmingCharacters(in: .whitespacesAndNewlines)
                return out.lastIndex { $0.role == "user" && $0.content.trimmingCharacters(in: .whitespacesAndNewlines) == text }
            }
            return nil
        }
        for m in messages {
            let live = m.role == "assistant" && m.hydrated != true && running && m.runtimeTurnId == activeTurnId
            guard m.optimistic == true || live || m.sendFailed == true else { continue }
            if let i = match(m) {
                if live, m.content.count >= out[i].content.count {
                    out[i] = m
                }
                continue
            }
            out.append(m)
        }
        messages = out
    }

    // MARK: Events

    private func on(_ e: StreamEvent) {
        switch e {
        case .snapshot(let live, _):
            if let id = threadId {
                if let t = live.first(where: { $0.threadId == id }) {
                    if let turn = t.turnId, !turn.isEmpty { activeTurnId = turn }
                    running = true
                } else if running, pendingTurnId == nil {
                    settleLocally()
                }
            }
            Task { await reload() }
        case .resync:
            Task { await reload() }
        case .push(let channel, let payload):
            guard channel == "backend:event", let method = payload["method"]?.stringValue else { return }
            apply(method: method, params: payload["params"] ?? .null)
        }
    }

    private func apply(method: String, params p: JSONValue) {
        let eventThread = p["threadId"]?.stringValue
        let eventTurn = p["turnId"]?.stringValue ?? p["turn"]?["id"]?.stringValue
        if method == "process/exit" {
            if case .object(let o) = p, o.keys.contains("threadId"), eventThread != threadId { return }
            if eventThread != nil, let turn = activeTurnId {
                endReply(turn, .failure(StemError(message: "Stem's worker stopped before it answered.")))
            }
            if running { settleLocally() }
            return
        }
        // A new chat learns its thread id from the first event of the turn it started.
        if threadId == nil, let pending = pendingTurnId, eventTurn == pending, let t = eventThread {
            threadId = t
        }
        guard let eventThread, eventThread == threadId else { return }

        switch method {
        case "item/agentMessage/delta":
            guard let turn = eventTurn, let delta = p["delta"]?.stringValue else { return }
            let offset = p["offset"].flatMap { v -> Int? in if case .number(let n) = v { return Int(n) }; return nil }
            let id = "assistant-\(turn)"
            if let i = messages.firstIndex(where: { $0.id == id }) {
                messages[i].content = Self.fold(messages[i], delta: delta, offset: offset)
            } else {
                messages.append(ChatMessage(id: id, role: "assistant", content: delta, turnId: turn, runtimeTurnId: turn, streamOffset: offset ?? 0))
            }
            stamp(turn)
            markRunning(turn)
            activityLabel = nil

        case "item/started":
            guard let turn = eventTurn, let item = p["item"], let type = item["type"]?.stringValue else { return }
            markRunning(turn)
            if type == "agentMessage" { return }
            if type == "reasoning" { activityLabel = "Thinking"; return }
            let itemId = item["id"]?.stringValue ?? UUID().uuidString
            if !activities.contains(where: { $0.id == itemId }) {
                activities.append(ActivityItem(
                    id: itemId,
                    kind: type == "webSearch" ? "webSearch" : type == "skill" ? "skill" : "tool",
                    type: type, name: item["name"]?.stringValue, detail: item["detail"]?.stringValue, status: "running"))
            }
            activityLabel = runningLabel()
            stamp(turn)

        case "item/completed":
            guard let turn = eventTurn, let item = p["item"], let type = item["type"]?.stringValue else { return }
            let id = "assistant-\(turn)"
            if type == "agentMessage" {
                let text = Self.agentText(item)
                if let i = messages.firstIndex(where: { $0.id == id }) {
                    let m = messages[i]
                    if m.hydrated == true, !text.isEmpty, m.content.hasPrefix(text) {
                        messages[i].hydrated = m.content != text
                    } else {
                        if !text.isEmpty { messages[i].content = text }
                        messages[i].hydrated = false
                    }
                    messages[i].streamOffset = 0
                } else {
                    messages.append(ChatMessage(id: id, role: "assistant", content: text, turnId: turn, runtimeTurnId: turn))
                }
                stamp(turn)
                return
            }
            let itemId = item["id"]?.stringValue
            let image = try? item["image"]?.decode(GeneratedImageRef.self)
            if let i = activities.firstIndex(where: { $0.id == itemId }) {
                activities[i].status = item["status"]?.stringValue ?? "ok"
                if let d = item["detail"]?.stringValue { activities[i].detail = d }
                if let image { activities[i].image = image }
                activityLabel = runningLabel() ?? activityLabel
            } else if type == "compaction", let itemId, let i = messages.firstIndex(where: { $0.id == id }),
                      !(messages[i].activity ?? []).contains(where: { $0.id == itemId }) {
                messages[i].activity = (messages[i].activity ?? []) + [ActivityItem(id: itemId, kind: "tool", type: "compaction", status: item["status"]?.stringValue ?? "ok")]
                return
            } else { return }
            if let image {
                if messages.firstIndex(where: { $0.id == id }) == nil {
                    messages.append(ChatMessage(id: id, role: "assistant", content: "", turnId: turn, runtimeTurnId: turn))
                }
                if let i = messages.firstIndex(where: { $0.id == id }), !(messages[i].images ?? []).contains(where: { $0.id == image.id }) {
                    messages[i].images = (messages[i].images ?? []) + [image]
                }
            }
            stamp(turn)

        case "harness/progress":
            guard let detail = p["detail"]?.stringValue else { return }
            let itemId = p["itemId"]?.stringValue
            if let i = activities.firstIndex(where: { itemId != nil ? $0.id == itemId : ($0.type == "codingAgent" && $0.status == "running") }) {
                activities[i].detail = detail
                activityLabel = runningLabel() ?? activityLabel
            }

        case "turn/sources":
            guard let turn = eventTurn, let sources = try? p["sources"]?.decode([SourceRef].self), !sources.isEmpty,
                  let i = messages.firstIndex(where: { $0.id == "assistant-\(turn)" }) else { return }
            messages[i].sources = sources

        case "turn/completed", "turn/failed", "turn/aborted":
            guard let turn = eventTurn else { return }
            stamp(turn)
            let reply = messages.last(where: { $0.id == "assistant-\(turn)" })?.content.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            endReply(turn, method == "turn/completed"
                ? (reply.isEmpty ? .failure(StemError(message: "Stem finished without a reply.")) : .success(reply))
                : .failure(StemError(message: method == "turn/aborted" ? "The reply was stopped." : (p["error"]?.stringValue ?? "Stem could not answer."))))
            if method != "turn/completed" {
                messages.removeAll { $0.id == "system-\(turn)" }
                let text = method == "turn/aborted"
                    ? "The reply was interrupted. You can edit and resend your message."
                    : (p["error"]?.stringValue.map { "Something went wrong: \($0)" } ?? "Something went wrong with this reply.")
                messages.append(ChatMessage(id: "system-\(turn)", role: "system", content: text, turnId: turn))
            }
            settleLocally()
            // The reply arrived on screen: it's read.
            if sub != nil { Task { await session.chats.setRead([eventThread], true) } }
            // Another device's turn: its user message never arrives as an event.
            let ours = messages.contains { $0.role == "user" && ($0.runtimeTurnId == turn || $0.turnId == turn) }
            if !ours || messages.contains(where: { $0.optimistic == true }) {
                Task { await reload() }
            }

        default: break
        }
    }

    private func markRunning(_ turn: String) {
        running = true
        activeTurnId = turn
    }

    private func settleLocally() {
        running = false
        activityLabel = nil
        activities = []
        activeTurnId = nil
        pendingTurnId = nil
    }

    /// Copies the live activity rows onto the turn's bubble.
    private func stamp(_ turn: String) {
        guard !activities.isEmpty, let i = messages.firstIndex(where: { $0.id == "assistant-\(turn)" }) else { return }
        messages[i].activity = activities
    }

    private func runningLabel() -> String? {
        guard let a = activities.last(where: { $0.status == "running" }) else { return nil }
        return ActivityText.label(a)
    }

    nonisolated static func agentText(_ item: JSONValue) -> String {
        if let t = item["text"]?.stringValue { return t }
        if case .array(let parts)? = item["content"] {
            return parts.compactMap { $0["text"]?.stringValue }.joined()
        }
        return ""
    }

    /// Applies a delta at its UTF-16 offset in the turn's accumulated reply,
    /// so a replayed delta never doubles text.
    nonisolated static func fold(_ m: ChatMessage, delta: String, offset: Int?) -> String {
        if m.hydrated == true { return m.content }
        let content = m.content as NSString
        guard let offset else { return m.content + delta }
        let o = offset - (m.streamOffset ?? 0)
        if o < 0 || o > content.length { return m.content + delta }
        let d = delta as NSString
        if o + d.length <= content.length, content.substring(with: NSRange(location: o, length: d.length)) == delta {
            return m.content
        }
        return content.substring(to: o) + delta
    }

    // MARK: Actions

    // MARK: Voice chat

    /// Ten minutes: a long tool turn, but not a call left waiting forever.
    static let replyTimeout: Duration = .seconds(600)

    /// A spoken request (PhoneVoice's `ask_stem`): send it as an ordinary
    /// message in this chat and settle with the reply the turn ends with.
    /// Requests queue, so this waits for the chat to finish its current reply.
    func ask(_ request: String, personaId: String?, private isPrivate: Bool) async throws -> String {
        for _ in 0..<900 where busy { try await Task.sleep(for: .milliseconds(200)) }
        if busy { throw StemError(message: "Stem is still answering something else in this chat. Ask again when it is done.") }
        lastStart = nil
        guard await send(text: request, previews: [], upload: { [] }, personaId: personaId, private: isPrivate),
              let start = lastStart else {
            throw StemError(message: error ?? "Stem could not start that request.")
        }
        if let reply = start.handledReply { return reply }
        if let ended = settledReplies.removeValue(forKey: start.turnId) { return try ended.get() }
        let turn = start.turnId
        Task { [weak self] in
            try? await Task.sleep(for: Self.replyTimeout)
            self?.endReply(turn, .failure(StemError(message: "Stem took too long to answer.")))
        }
        return try await withCheckedThrowingContinuation { replyWaiters[turn] = $0 }
    }

    private func endReply(_ turn: String, _ result: Result<String, Error>) {
        if let waiter = replyWaiters.removeValue(forKey: turn) {
            waiter.resume(with: result)
            return
        }
        // Kept briefly for an `ask` whose turn settled before startTurn answered.
        if settledReplies.count > 8 { settledReplies.removeAll() }
        settledReplies[turn] = result
    }

    /// Starts a turn. Returns false when the send failed and the draft should stay.
    /// The message shows before `upload` runs, so the bubble doesn't wait on the attachments.
    func send(text: String, previews: [MessageAttachment], upload: () async throws -> [TurnAttachment],
              personaId: String?, private isPrivate: Bool) async -> Bool {
        let turnId = unanswered.flatMap { $0.text == text && $0.files == previews.count ? $0.turnId : nil }
            ?? UUID().uuidString.lowercased()
        // Ask for time to finish if the user switches apps right after sending.
        let background = UIApplication.shared.beginBackgroundTask(withName: "startTurn")
        defer { if background != .invalid { UIApplication.shared.endBackgroundTask(background) } }
        let localId = "local-\(turnId)"
        messages.append(ChatMessage(id: localId, role: "user", content: text,
                                    attachments: previews.isEmpty ? nil : previews,
                                    turnId: turnId, runtimeTurnId: turnId, optimistic: true))
        pendingTurnId = turnId
        activeTurnId = turnId
        running = true
        activityLabel = previews.isEmpty ? "Sending" : "Uploading"
        let attachments: [TurnAttachment]
        do { attachments = try await upload() }
        catch {
            pendingTurnId = nil
            messages.removeAll { $0.id == localId }
            settleLocally()
            self.error = error.localizedDescription
            return false
        }
        if activityLabel == "Uploading" { activityLabel = "Sending" }
        let s = session.turnSettings()
        let input = StartTurnInput(
            input: text, threadId: threadId, turnId: turnId, model: s.model, effort: s.effort,
            // Format and privacy only count on the turn that creates the chat;
            // after that the server reads both back from the chat itself.
            serviceTier: s.serviceTier, format: threadId == nil ? s.format : nil,
            private: threadId == nil && isPrivate ? true : nil,
            attachments: attachments.isEmpty ? nil : attachments, personaId: personaId)
        do {
            let r = try await client.call("backend:startTurn", [.from(input)], as: StartTurnResult.self)
            unanswered = nil
            if threadId == nil, let t = r.threadId {
                threadId = t
                self.isPrivate = isPrivate
                format = s.format
                if let folderId { Task { await session.chats.moveChats([t], to: folderId) } }
            }
            pendingTurnId = nil
            if activityLabel == "Sending" { activityLabel = nil }
            lastStart = (r.turnId ?? turnId, r.turnId == nil && r.handled == true ? (r.assistantMessage ?? "Done.") : nil)
            if r.canceled == true {
                if let i = messages.firstIndex(where: { $0.id == localId }) { messages[i].sendFailed = true }
                settleLocally()
            } else if r.turnId == nil, r.handled == true {
                if let reply = r.assistantMessage, !reply.isEmpty {
                    messages.append(ChatMessage(id: "assistant-\(turnId)", role: "assistant", content: reply, turnId: turnId, runtimeTurnId: turnId))
                }
                settleLocally()
            } else if let real = r.turnId, real != turnId {
                activeTurnId = real
            }
            await reload()
            return true
        } catch {
            pendingTurnId = nil
            messages.removeAll { $0.id == localId }
            settleLocally()
            if (error as? StemError)?.unreachable == true {
                unanswered = (text, previews.count, turnId)
                self.error = "The connection dropped while sending, so it may have gone through. Send it again: it won't run twice."
            } else {
                self.error = error.localizedDescription
            }
            return false
        }
    }

    /// The turn Stop should interrupt: live events first, then the server's
    /// snapshot, then what this phone just sent.
    private var stoppableTurn: String? {
        if let t = activeTurnId { return t }
        if let id = threadId, let t = session.connection.liveTurns[id], !t.isEmpty { return t }
        if let t = pendingTurnId { return t }
        guard busy else { return nil }
        return messages.last { $0.role == "user" }.flatMap { $0.runtimeTurnId ?? $0.turnId }
    }

    func stop() async {
        guard let turn = stoppableTurn else { return }
        do { try await client.run("backend:interruptTurn", [.string(turn)]) }
        catch { self.error = error.localizedDescription }
    }

    /// Stop the turn and take the message back into the composer (the
    /// desktop's Escape). Returns the message to restore.
    func retract() async -> ChatMessage? {
        guard let turn = stoppableTurn,
              let userMsg = messages.last(where: { $0.role == "user" }) else { return nil }
        try? await client.run("backend:interruptTurn", [.string(turn)])
        guard let id = threadId else { return userMsg }
        let onlyTurn = messages.filter { $0.role == "user" }.count == 1
        do {
            if onlyTurn {
                await session.chats.delete(id)
                messages = []
                threadId = nil
            } else {
                try await client.run("chats:rollbackToTurn", [.string(id), .string(turn)])
                settleLocally()
                await reload()
            }
        } catch {
            self.error = error.localizedDescription
        }
        settleLocally()
        return userMsg
    }

    /// `/learn [focus]`: saves a skill from the last turn.
    func learn(focus: String?) async -> String {
        guard let id = threadId else { return "Send a message first — /learn saves a skill from the last turn." }
        do {
            let r = try await client.call("skills:learn", [.string(id), JSONValue(focus)], as: SkillLearnResult.self)
            return r.message
        } catch {
            return error.localizedDescription
        }
    }

    func image(_ ref: GeneratedImageRef) async -> Data? {
        await ImageCache.shared.generated(ref, client: client)
    }

    func remoteImage(_ url: String) async -> Data? {
        guard let id = threadId else { return nil }
        return await ImageCache.shared.remote(url, threadId: id, client: client)
    }
}

/// `/note`: a fact straight into memory, no turn.
enum NoteMode {
    static func flash(_ r: MemoryNoteResult) -> String {
        if r.saved { return "Saved to memory" }
        switch r.reason {
        case "empty": return "Nothing to save"
        case "disabled": return "Memory is off — turn it on in Settings"
        case "secret": return "That looks like a secret, so it wasn't saved"
        case "image": return "Couldn't save that picture"
        default: return "Not saved"
        }
    }
}

enum ActivityText {
    static func label(_ a: ActivityItem) -> String {
        switch a.type {
        case "webSearch": return a.detail.map { "Searching \($0)" } ?? "Searching the web"
        case "commandExecution": return a.detail.map { "Running \($0)" } ?? "Running a command"
        case "fileChange": return "Editing files"
        case "codingAgent": return a.detail ?? "Coding agent"
        case "compaction": return "Condensed the conversation"
        default:
            let name = (a.name ?? a.type).replacingOccurrences(of: "_", with: " ")
            if let d = a.detail, !d.isEmpty { return "\(name) · \(d)" }
            return name
        }
    }
}
