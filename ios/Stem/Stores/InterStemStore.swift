import Foundation
import Observation

/// Mail with other people (inter-Stem): this Stem's addresses and contacts,
/// and the actions only those conversations have — release held mail, ask a
/// persona for a draft, send again, compose to an address. Nil status on a
/// server without inter-Stem mail.
@MainActor @Observable
final class InterStemStore {
    private(set) var status: InterStemStatus?
    var error: String?

    private let client: StemClient
    init(client: StemClient) { self.client = client }

    func attach(_ c: Connection) {
        _ = c.subscribe { [weak self] e in
            guard let self else { return }
            switch e {
            case .snapshot, .resync: Task { await self.reload() }
            case .push(let channel, _): if channel == "interstem:changed" { Task { await self.reload() } }
            }
        }
    }

    func reload() async {
        status = try? await client.call("interstem:status", as: InterStemStatus.self)
    }

    var verifiedAddresses: [String] { (status?.addresses ?? []).filter { $0.state == "verified" }.map(\.address) }
    var canWriteOut: Bool { !verifiedAddresses.isEmpty }

    func contact(_ address: String) -> InterStemContact? { status?.contacts.first { $0.address == address } }

    /// "Name <address>" when the user named them, else the address.
    func label(_ address: String) -> String {
        if let name = contact(address)?.name, !name.isEmpty { return name }
        return address
    }

    func isRequest(_ c: MailConversation) -> Bool {
        guard let a = c.external?.address else { return false }
        return contact(a)?.state == "request"
    }

    // MARK: Actions (each answers with the fresh status, or throws its message)

    func contactOp(_ op: String, _ address: String) async {
        await act { self.status = try await self.client.call("interstem:contact", [.string(op), .string(address)], as: InterStemStatus.self) }
    }

    func setName(_ address: String, _ name: String) async {
        await act {
            self.status = try await self.client.call("interstem:setContact", [.string(address), .object(["name": .string(name)])],
                                                     as: InterStemStatus.self)
        }
    }

    func setAutoDraft(_ address: String, _ on: Bool) async {
        await act {
            self.status = try await self.client.call("interstem:setContact", [.string(address), .object(["autoDraft": .bool(on)])],
                                                     as: InterStemStatus.self)
        }
    }

    func lookup(_ address: String) async throws -> InterStemReach {
        try await client.call("interstem:lookup", [.string(address)], as: InterStemReach.self)
    }

    func invite(_ address: String) async {
        await act { try await self.client.run("interstem:invite", [.string(address)]) }
    }

    func release(_ conversationId: String, _ itemId: String) async {
        await act { try await self.client.run("mail:release", [.string(conversationId), .string(itemId)]) }
    }

    /// `release`: the agents read the held mail first — one tap reads and drafts.
    func draft(_ conversationId: String, persona: String, instructions: String, release: Bool) async throws {
        try await client.run("mail:draftExternal", [.string(conversationId), .string(persona), .string(instructions), .bool(release)])
    }

    func resend(_ conversationId: String, _ itemId: String) async {
        await act { try await self.client.run("mail:resendExternal", [.string(conversationId), .string(itemId)]) }
    }

    func compose(to: String, from: String?, subject: String, body: String, attachments: [TurnAttachment] = []) async throws {
        var input: [String: JSONValue] = ["to": .string(to), "subject": .string(subject), "body": .string(body)]
        if let from { input["self"] = .string(from) }
        if !attachments.isEmpty { input["attachments"] = .from(attachments) }
        try await client.run("mail:composeExternal", [.object(input)])
    }

    private func act(_ f: @escaping () async throws -> Void) async {
        do {
            try await f()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
