import XCTest
@testable import Stem

/// The phone's voice-call event handling; tests/unit/voice-events.test.ts
/// covers the desktop's copy.
@MainActor
final class VoiceEventsTests: XCTestCase {
    private var sent: [[String: Any]] = []
    private var activity: [VoiceActivity] = []
    private var problems: [String] = []

    private func make(_ ask: @escaping (String) async throws -> String) -> VoiceEvents {
        sent = []; activity = []; problems = []
        return VoiceEvents(send: { self.sent.append($0) }, ask: ask,
                           onActivity: { self.activity.append($0) }, onProblem: { self.problems.append($0) })
    }

    private func emit(_ e: VoiceEvents, _ event: [String: Any]) {
        e.handle(try! JSONSerialization.data(withJSONObject: event))
    }

    private func call(_ id: String, _ request: String) -> [String: Any] {
        ["type": "response.function_call_arguments.done", "name": "ask_stem", "call_id": id,
         "arguments": String(data: try! JSONSerialization.data(withJSONObject: ["request": request]), encoding: .utf8)!]
    }

    private func settle() async {
        for _ in 0..<20 { await Task.yield() }
    }

    func testAskStemRunsTheRequestAndHandsTheReplyBack() async {
        var asked: [String] = []
        let e = make { asked.append($0); return "Bratislava." }
        emit(e, call("c1", "Capital of Slovakia?"))
        XCTAssertEqual(activity.last, .working)
        await settle()
        XCTAssertEqual(asked, ["Capital of Slovakia?"])
        XCTAssertEqual(sent.compactMap { $0["type"] as? String }, ["conversation.item.create", "response.create"])
        let item = sent[0]["item"] as? [String: Any]
        XCTAssertEqual(item?["call_id"] as? String, "c1")
        XCTAssertEqual(item?["output"] as? String, #"{"reply":"Bratislava."}"#)
        XCTAssertEqual(activity.last, .listening)
    }

    func testResponseCreateWaitsForTheModelsCurrentResponse() async {
        let e = make { _ in "ok" }
        emit(e, ["type": "response.created"])
        emit(e, call("c1", "x"))
        await settle()
        XCTAssertEqual(sent.compactMap { $0["type"] as? String }, ["conversation.item.create"])
        emit(e, ["type": "response.done"])
        XCTAssertEqual(sent.compactMap { $0["type"] as? String }, ["conversation.item.create", "response.create"])
    }

    func testAFailedRequestBecomesAnErrorOutput() async {
        struct Busy: LocalizedError { var errorDescription: String? { "Stem is busy" } }
        let e = make { _ in throw Busy() }
        emit(e, call("c1", "x"))
        await settle()
        XCTAssertEqual((sent.first?["item"] as? [String: Any])?["output"] as? String, #"{"error":"Stem is busy"}"#)
        XCTAssertEqual(problems, ["Stem is busy"])
    }

    func testNothingIsSentAfterClose() async {
        let e = make { _ in "late" }
        emit(e, call("c1", "x"))
        e.close()
        await settle()
        XCTAssertTrue(sent.isEmpty)
    }

    func testTracksWhoIsTalking() {
        let e = make { _ in "" }
        emit(e, ["type": "input_audio_buffer.speech_started"])
        XCTAssertEqual(activity.last, .hearing)
        emit(e, ["type": "input_audio_buffer.speech_stopped"])
        emit(e, ["type": "output_audio_buffer.started"])
        XCTAssertEqual(activity.last, .speaking)
        emit(e, ["type": "output_audio_buffer.stopped"])
        XCTAssertEqual(activity.last, .listening)
    }
}
