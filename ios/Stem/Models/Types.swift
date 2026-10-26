import Foundation

// Wire shapes from src/shared/types.ts. Only the fields the phone reads are
// declared; Codable skips the rest.

// MARK: Chats

struct ChatListResult: Codable {
    var chats: [ChatSummary]
    /// Absent only from a server older than folders.
    var folders: [ChatFolder]?
    var inbox: InboxState
}

/// A user-made chat folder; `parentId` nil = top level.
struct ChatFolder: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var parentId: String?
    /// Sort order among siblings.
    var order: Double
}

struct ChatSummary: Codable, Identifiable, Hashable {
    var threadId: String
    var title: String
    var subject: String?
    var preview: String?
    var folderId: String?
    var `private`: Bool?
    /// "md" when the chat runs as plain Markdown; nil means MDX.
    var format: String?
    var createdAt: Double
    /// Unix seconds (ms for rows created this session, see `Inbox.toMs`).
    var updatedAt: Double
    var id: String { threadId }
    var displayTitle: String {
        let s = subject?.isEmpty == false ? subject! : title
        return s.isEmpty ? "New chat" : s
    }
}

struct InboxEntry: Codable, Hashable {
    var readAt: Double?
    var forcedUnread: Bool?
    var archivedAt: Double?
    var snoozedAt: Double?
    var snoozedUntil: Double?
}

struct InboxState: Codable, Hashable {
    var baseline: Double = 0
    var entries: [String: InboxEntry] = [:]
}

struct ChatHistory: Decodable {
    var threadId: String
    var title: String
    var messages: [ChatMessage]
}

struct MessageAttachment: Codable, Hashable {
    var kind: String
    var name: String?
    var mime: String?
    var dataUrl: String?
    var imageId: String?
}

struct GeneratedImageRef: Codable, Hashable {
    var id: String
    var threadId: String
    var mime: String
    var width: Double?
    var height: Double?
    var prompt: String?
}

struct SourceRef: Codable, Hashable {
    var url: String
    var title: String?
}

struct ActivityItem: Codable, Hashable, Identifiable {
    var id: String
    var kind: String
    var type: String
    var name: String?
    var detail: String?
    var status: String
    var image: GeneratedImageRef?
}

struct MessageMeta: Codable, Hashable {
    var model: String?
    var effort: String?
}

struct ChatMessage: Codable, Hashable, Identifiable {
    var id: String
    var role: String
    var content: String
    var attachments: [MessageAttachment]?
    var turnAttachments: [TurnAttachment]?
    var meta: MessageMeta?
    var turnId: String?
    var runtimeTurnId: String?
    var activity: [ActivityItem]?
    var sources: [SourceRef]?
    var images: [GeneratedImageRef]?
    var createdAt: String?
    var sendFailed: Bool?

    // Client-only.
    /// Where this bubble's text starts inside the turn's accumulated reply,
    /// for applying offset deltas.
    var streamOffset: Int?
    /// Loaded from saved history: deltas for it are ignored until the item completes.
    var hydrated: Bool?
    /// Sent from this phone and not yet seen in history.
    var optimistic: Bool?

    enum CodingKeys: String, CodingKey {
        case id, role, content, attachments, turnAttachments, meta, turnId, runtimeTurnId, activity,
             sources, images, createdAt, sendFailed
    }
}

// MARK: Turns

struct TurnAttachment: Codable, Hashable {
    var name: String
    var path: String?
    var dataBase64: String?
    var mime: String?
}

struct StartTurnInput: Encodable {
    var input: String
    var threadId: String?
    var turnId: String?
    var model: String?
    var effort: String?
    var serviceTier: String?
    var format: String?
    var `private`: Bool?
    var attachments: [TurnAttachment]?
    var personaId: String?
}

struct StartTurnResult: Decodable {
    var threadId: String?
    var turnId: String?
    var handled: Bool?
    var canceled: Bool?
    var assistantMessage: String?
}

struct LiveTurnInfo: Decodable {
    var threadId: String
    var turnId: String?
}

struct MemoryNoteResult: Decodable {
    var saved: Bool
    var reason: String?
}

struct SkillLearnResult: Decodable {
    var ok: Bool
    var message: String
}

// MARK: Models + settings

struct ModelServiceTier: Decodable, Hashable { var id: String; var name: String }

struct ModelSummary: Decodable, Hashable, Identifiable {
    var id: String
    var displayName: String
    var description: String
    var provider: String
    var providerName: String
    var supportedEfforts: [String]
    var defaultEffort: String
    var serviceTiers: [ModelServiceTier]
    var isDefault: Bool
    var contextWindow: Double?
    var input: [String]?
    var hasFast: Bool { serviceTiers.contains { $0.id == "priority" } }
}

/// The slice of server settings the phone reads.
struct ServerSettings: Decodable {
    struct WebSearch: Decodable { var main: Bool }
    struct Defaults: Decodable { var model: String? }
    struct Instructions: Decodable { var main: String; var quickChat: String }
    var webSearch: WebSearch
    var defaults: Defaults?
    var customInstructions: Instructions?
    struct ChatFeatures: Decodable {
        struct Allow: Decodable { var allow: Bool }
        var voice: Allow?
    }
    /// Absent on an older server, which has no voice chat.
    var chatFeatures: ChatFeatures?
}

// MARK: Personas

struct Persona: Decodable, Hashable, Identifiable {
    var id: String
    var name: String
    var clients: Bool?
    var builtin: Bool?
}

// MARK: Mail

struct MailListResult: Decodable {
    var conversations: [MailConversation]
    var items: [MailItem]
    var inbox: InboxState
}

struct MailConversation: Decodable, Hashable, Identifiable {
    var id: String
    var subject: String
    var participants: [String]
    var `private`: Bool?
    /// Inter-Stem: a conversation with another person (only presence matters here).
    var external: JSONValue?
    /// Owned by a server feature ("memory-check") instead of a persona.
    var owner: String?
    var status: String
    var updatedAt: Double
    var userUpdatedAt: Double
    var userSentAt: Double?
    /// The user's latest approval answer; absent from older servers.
    var userAnsweredAt: Double?
    var createdAt: Double

    /// Mail for the user landed after their last send or approval answer.
    var waitingOnUser: Bool { userUpdatedAt > max(userSentAt ?? 0, userAnsweredAt ?? 0) }
}

struct MailItem: Decodable, Hashable, Identifiable {
    var id: String
    var conversationId: String
    var from: String
    var to: [String]
    var body: String
    var at: Double
    var subject: String?
    var stale: Bool?
    /// Persona↔persona mail that reached a persona after it had answered: filed, no turn started.
    var filed: Bool?
    /// A progress question asked mid-work, answered on the spot instead of delivered.
    var statusQuery: Bool?
    /// The on-the-spot answer to a progress question, written from the thread and the live work log.
    var statusReply: Bool?
    var attachments: [MessageAttachment]?
    var images: [GeneratedImageRef]?
    var agentReplies: [String]?
    /// A parked run's Allow/Deny (the safety check would not run a command without the user).
    var approval: MailApproval?
}

struct MailApproval: Decodable, Hashable {
    var id: String
    var kind: String
    var command: String
    var cwd: String?
    var deviceLabel: String?
    var reason: String?
    /// pending | allowed | denied | superseded | cancelled
    var status: String
}

struct MailApprovalResult: Decodable {
    var ok: Bool
    var error: String?
}

struct MailComposeInput: Encodable {
    var to: [String]
    var subject: String?
    var body: String
    var attachments: [TurnAttachment]?
    var `private`: Bool?
}

// MARK: Approvals

struct ExecApprovalRequest: Decodable, Hashable {
    var id: String
    var threadId: String
    var command: String
    var cwd: String
    var prefixes: [String]
    var judgeVerdict: String?
    var judgeReason: String?
    var deviceLabel: String?
}

struct McpAdminProposal: Decodable, Hashable {
    var id: JSONValue
    var threadId: String
    var action: String
    var name: String?
    var input: JSONValue?
}

struct InstructionsProposal: Decodable, Hashable {
    var id: JSONValue
    var threadId: String
    var action: String
    var incomingText: String
    var suggestedSurface: String?
}

struct SkillProposal: Decodable, Hashable {
    var id: JSONValue
    var threadId: String
    var name: String
    var description: String
    var body: String
    var isPatch: Bool
}

struct ImageResult: Decodable { var dataUrl: String; var mime: String }
