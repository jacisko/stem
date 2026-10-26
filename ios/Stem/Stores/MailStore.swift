import Foundation
import Observation

@MainActor @Observable
final class MailStore {
    private(set) var mail = MailListResult(conversations: [], items: [], inbox: InboxState())
    private(set) var sections: [MailFolder: [MailConversation]] = [:]
    private(set) var loaded = false
    var error: String?
    /// Whole mails of the conversations on screen. The list itself carries only
    /// what its rows show (mail:summary); a conversation's mail comes on open.
    private(set) var threads: [String: [MailItem]] = [:]

    private let client: StemClient
    /// Conversations on screen, with how many views show each.
    @ObservationIgnored private var openCounts: [String: Int] = [:]
    /// False on a server older than mail:summary: the whole list it sends holds every mail already.
    @ObservationIgnored private var slim = true

    init(client: StemClient) { self.client = client }

    func attach(_ c: Connection) {
        _ = c.subscribe { [weak self] e in
            guard let self else { return }
            switch e {
            case .snapshot, .resync: Task { await self.reload() }
            case .push(let channel, _): if channel == "mail:changed" { Task { await self.reload() } }
            }
        }
    }

    func reload() async {
        do {
            apply(try await fetchList())
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
        await withTaskGroup(of: Void.self) { group in
            for id in openCounts.keys { group.addTask { await self.fetchThread(id) } }
        }
    }

    private func fetchList() async throws -> MailListResult {
        if slim {
            do { return try await client.call("mail:summary", as: MailListResult.self) }
            catch let e as StemError where e.message.contains("no handler registered") { slim = false }
        }
        return try await client.call("mail:list", as: MailListResult.self)
    }

    private struct OpenResult: Decodable { var items: [MailItem] }

    private func fetchThread(_ id: String) async {
        guard slim else { return }
        do {
            threads[id] = try await client.call("mail:open", [.string(id)], as: OpenResult.self).items
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// A conversation came on screen: fetch its mail, and keep it fresh while it stays.
    func open(_ id: String) async {
        openCounts[id, default: 0] += 1
        await fetchThread(id)
    }

    func close(_ id: String) {
        let n = (openCounts[id] ?? 1) - 1
        openCounts[id] = n > 0 ? n : nil
        if n <= 0 { threads[id] = nil }
    }

    private func apply(_ r: MailListResult) {
        mail = r
        sections = MailSections.build(r)
    }

    var unreadCount: Int {
        (sections[.inbox] ?? []).filter { MailSections.isUnread($0, mail) }.count
    }

    func conversation(_ id: String) -> MailConversation? { mail.conversations.first { $0.id == id } }

    /// A conversation's mails, oldest first. Empty for the moment between opening
    /// it and its mail arriving: the list's copies are cut-down previews.
    func items(_ id: String) -> [MailItem] {
        let all = slim ? threads[id] ?? [] : mail.items.filter { $0.conversationId == id }
        return all.sorted { $0.at < $1.at }
    }

    // Mutators: the server answers each with the whole mail list; the phone
    // asks it to leave that out and re-reads the slim one instead.

    /// Starts a conversation; answers with the list it now appears in.
    func compose(_ input: MailComposeInput) async throws -> MailListResult {
        try await client.run("mail:compose", [.from(input)])
        await reload()
        return mail
    }

    func reply(_ id: String, body: String, attachments: [TurnAttachment]) async throws {
        var args: [JSONValue] = [.string(id), .string(body)]
        if !attachments.isEmpty { args.append(.from(attachments)) }
        try await client.run("mail:reply", args)
        await reload()
    }

    func addParticipant(_ id: String, persona: String) async {
        await mutate("mail:addParticipant", [.string(id), .string(persona)])
    }

    func setRead(_ ids: [String], _ read: Bool) async { await mutate("mail:setRead", [.init(ids), .bool(read)]) }
    func setArchived(_ ids: [String], _ a: Bool) async { await mutate("mail:setArchived", [.init(ids), .bool(a)]) }
    func delete(_ id: String) async { await mutate("mail:delete", [.string(id)]) }

    /// Allow or deny a parked run's command; the answer resumes it on the server.
    /// For a send draft, `body` is the (possibly edited) text that goes out.
    func resolveApproval(_ itemId: String, allow: Bool, body: String? = nil) async {
        do {
            var args: [JSONValue] = [.string(itemId), .string(allow ? "allow" : "deny")]
            if let body { args.append(.string(body)) }
            let r = try await client.call("mail:resolveApproval", args, as: MailApprovalResult.self)
            if !r.ok { self.error = r.error ?? "That approval could not be answered." }
        } catch { self.error = error.localizedDescription }
        await reload()
    }

    func stop(_ id: String) async {
        do { try await client.run("mail:stop", [.string(id)]) } catch { self.error = error.localizedDescription }
        await reload()
    }

    private func mutate(_ channel: String, _ args: [JSONValue]) async {
        do { try await client.run(channel, args) }
        catch { self.error = error.localizedDescription }
        await reload()
    }
}
