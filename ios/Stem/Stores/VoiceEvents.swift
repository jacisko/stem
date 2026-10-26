import Foundation

/// What a voice call is doing now, for the button.
enum VoiceActivity: Equatable {
    case listening, hearing, working, speaking
}

/// The realtime voice model's side of a voice call, without the WebRTC: what
/// to do with each event on the `oai-events` data channel. Port of
/// src/renderer/chat/voiceEvents.ts — keep the two in step.
@MainActor
final class VoiceEvents {
    static let askStemTool = "ask_stem"
    /// What the voice model is handed back at most; the rest is for reading in the chat.
    static let maxSpokenReply = 6000

    private let send: ([String: Any]) -> Void
    private let ask: (String) async throws -> String
    private let onActivity: (VoiceActivity) -> Void
    private let onProblem: (String) -> Void

    private var responseActive = false
    /// A response.create held back until the model's current response ends.
    private var responseWanted = false
    private var speaking = false
    private var hearing = false
    private var working = 0
    /// Stem runs one turn at a time per chat, so requests queue in order.
    private var queue: Task<Void, Never>?
    private var closed = false

    init(send: @escaping ([String: Any]) -> Void,
         ask: @escaping (String) async throws -> String,
         onActivity: @escaping (VoiceActivity) -> Void,
         onProblem: @escaping (String) -> Void) {
        self.send = send
        self.ask = ask
        self.onActivity = onActivity
        self.onProblem = onProblem
    }

    func close() { closed = true }

    func handle(_ data: Data) {
        guard let event = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = event["type"] as? String else { return }
        switch type {
        case "input_audio_buffer.speech_started": hearing = true
        case "input_audio_buffer.speech_stopped": hearing = false
        case "output_audio_buffer.started": speaking = true
        case "output_audio_buffer.stopped", "output_audio_buffer.cleared": speaking = false
        case "response.created": responseActive = true
        case "response.done":
            responseActive = false
            if responseWanted { requestResponse() }
        case "response.function_call_arguments.done":
            if event["name"] as? String == Self.askStemTool, let callId = event["call_id"] as? String {
                runAsk(callId: callId, arguments: event["arguments"] as? String ?? "")
            }
        case "error":
            let error = event["error"] as? [String: Any]
            // A response.create racing the model's own response is expected and retried at response.done.
            if error?["code"] as? String != "conversation_already_has_active_response" {
                onProblem(error?["message"] as? String ?? "The voice model reported an error.")
            }
        default: return
        }
        report()
    }

    private func report() {
        onActivity(hearing ? .hearing : speaking ? .speaking : working > 0 ? .working : .listening)
    }

    private func requestResponse() {
        if responseActive {
            responseWanted = true
            return
        }
        responseWanted = false
        responseActive = true
        send(["type": "response.create"])
    }

    private func runAsk(callId: String, arguments: String) {
        let parsed = (try? JSONSerialization.jsonObject(with: Data(arguments.utf8))) as? [String: Any]
        let request = (parsed?["request"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        working += 1
        report()
        let previous = queue
        queue = Task { [weak self] in
            await previous?.value
            guard let self else { return }
            var output: [String: String]
            if request.isEmpty {
                output = ["error": "The request was empty."]
            } else {
                do {
                    let reply = try await self.ask(request)
                    output = ["reply": reply.count > Self.maxSpokenReply
                        ? String(reply.prefix(Self.maxSpokenReply)) + "… (the full reply is in the chat)"
                        : reply]
                } catch {
                    let message = error.localizedDescription
                    self.onProblem(message)
                    output = ["error": message]
                }
            }
            self.working -= 1
            if self.closed { return }
            let json = (try? JSONSerialization.data(withJSONObject: output)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
            self.send(["type": "conversation.item.create",
                       "item": ["type": "function_call_output", "call_id": callId, "output": json]])
            self.requestResponse()
            self.report()
        }
    }
}
