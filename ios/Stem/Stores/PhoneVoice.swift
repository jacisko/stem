import AVFAudio
import Foundation
import Observation
import WebRTC
import os

private let log = Logger(subsystem: "sk.awantech.stem", category: "voice")

/// Voice chat on the phone: a WebRTC call to OpenAI's realtime voice model,
/// which answers small talk itself and hands every real request to `ask` — an
/// ordinary message in the open chat. Same server step as the desktop
/// (`voice:connect` answers the offer; server/voice/realtime.ts). WebRTC's
/// voice-processing audio unit cancels the echo, so the user can talk over it.
@MainActor @Observable
final class PhoneVoice {
    enum Phase: Equatable { case idle, connecting, live }

    /// How often a live call re-checks that the plan still has room.
    static let checkInterval: Duration = .seconds(120)

    private(set) var phase: Phase = .idle
    private(set) var activity: VoiceActivity = .listening
    /// Why the last call ended or failed; cleared by the next start.
    private(set) var error: String?

    @ObservationIgnored private var call: Call?

    var active: Bool { phase != .idle }

    func toggle(client: StemClient, ask: @escaping (String) async throws -> String) {
        if active { stop() } else { start(client: client, ask: ask) }
    }

    func start(client: StemClient, ask: @escaping (String) async throws -> String) {
        guard call == nil else { return }
        error = nil
        phase = .connecting
        let call = Call(owner: self)
        self.call = call
        Task {
            do {
                guard await AVAudioApplication.requestRecordPermission() else {
                    throw StemError(message: "Stem may not use the microphone. Allow it in Settings → Stem.")
                }
                try await call.connect(client: client, ask: ask)
            } catch {
                log.error("voice: call failed: \(error.localizedDescription, privacy: .public)")
                if self.call === call { end(error.localizedDescription) }
            }
        }
    }

    func stop() { end(nil) }

    fileprivate func end(_ reason: String?) {
        call?.close()
        call = nil
        phase = .idle
        activity = .listening
        error = reason
    }

    fileprivate func opened(_ c: Call) { if call === c { phase = .live } }
    fileprivate func set(_ a: VoiceActivity, from c: Call) { if call === c { activity = a } }
    fileprivate func problem(_ message: String, from c: Call) { if call === c { error = message } }
    fileprivate func dropped(_ c: Call) { if call === c { end("The voice connection dropped.") } }
    fileprivate func refused(_ reason: String, from c: Call) { if call === c { end(reason) } }

    /// One call's WebRTC objects. Delegate callbacks arrive on WebRTC's own
    /// threads and hop to the main actor.
    @MainActor
    fileprivate final class Call: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate {
        private static let factory: RTCPeerConnectionFactory = {
            // Voice chat plays on the speaker (WebRTC's default is the earpiece)
            // and takes a Bluetooth headset's microphone.
            let audio = RTCAudioSessionConfiguration.webRTC()
            audio.category = AVAudioSession.Category.playAndRecord.rawValue
            audio.mode = AVAudioSession.Mode.voiceChat.rawValue
            audio.categoryOptions = [.defaultToSpeaker, .allowBluetoothHFP]
            RTCAudioSessionConfiguration.setWebRTC(audio)
            #if targetEnvironment(simulator)
            // The Simulator's voice-processing audio unit times out starting
            // and aborts the app (AURemoteIO::Initialize), so a call there runs
            // without audio: enough to check everything but the sound.
            RTCAudioSession.sharedInstance().useManualAudio = true
            RTCAudioSession.sharedInstance().isAudioEnabled = false
            #endif
            RTCInitializeSSL()
            return RTCPeerConnectionFactory()
        }()

        private weak var owner: PhoneVoice?
        private var pc: RTCPeerConnection?
        private var channel: RTCDataChannel?
        private var events: VoiceEvents?
        private var checker: Task<Void, Never>?

        init(owner: PhoneVoice) { self.owner = owner }

        func connect(client: StemClient, ask: @escaping (String) async throws -> String) async throws {
            let config = RTCConfiguration()
            config.sdpSemantics = .unifiedPlan
            let none = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
            guard let pc = Self.factory.peerConnection(with: config, constraints: none, delegate: self) else {
                throw StemError(message: "Couldn't start a voice connection.")
            }
            self.pc = pc
            let mic = Self.factory.audioTrack(with: Self.factory.audioSource(with: none), trackId: "mic")
            pc.add(mic, streamIds: ["stem"])
            guard let channel = pc.dataChannel(forLabel: "oai-events", configuration: RTCDataChannelConfiguration()) else {
                throw StemError(message: "Couldn't start a voice connection.")
            }
            channel.delegate = self
            self.channel = channel
            events = VoiceEvents(
                send: { [weak self] event in self?.send(event) },
                ask: ask,
                onActivity: { [weak self] a in if let self { self.owner?.set(a, from: self) } },
                onProblem: { [weak self] m in if let self { self.owner?.problem(m, from: self) } })

            log.info("voice: creating offer")
            let offer = try await pc.offer(for: none)
            try await pc.setLocalDescription(offer)
            struct Answer: Decodable { let sdp: String }
            log.info("voice: offer ready, connecting")
            let answer = try await client.call("voice:connect", [.string(offer.sdp)], as: Answer.self)
            log.info("voice: answer received (\(answer.sdp.count) chars)")
            guard self.pc != nil else { return }
            try await pc.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: answer.sdp))
            log.info("voice: answer applied")

            // Past the plan's limit OpenAI bills credits; hang up instead.
            checker = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: PhoneVoice.checkInterval)
                    guard !Task.isCancelled, let self else { return }
                    struct Allowance: Decodable { let ok: Bool; let reason: String? }
                    if let a = try? await client.call("voice:check", as: Allowance.self), !a.ok {
                        self.owner?.refused(a.reason ?? "Voice chat is no longer allowed.", from: self)
                    }
                }
            }
        }

        func close() {
            checker?.cancel()
            events?.close()
            channel?.close()
            pc?.close()
            channel = nil
            pc = nil
        }

        private func send(_ event: [String: Any]) {
            guard let channel, channel.readyState == .open,
                  let data = try? JSONSerialization.data(withJSONObject: event) else { return }
            channel.sendData(RTCDataBuffer(data: data, isBinary: false))
        }

        // MARK: RTCDataChannelDelegate

        nonisolated func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
            let open = dataChannel.readyState == .open
            log.info("voice: data channel state \(dataChannel.readyState.rawValue)")
            Task { @MainActor in
                guard open else { return }
                self.owner?.opened(self)
                #if DEBUG
                // `-voiceProbe "<request>"` types a request into the call, for
                // testing in the Simulator, which has no usable microphone.
                if let probe = UserDefaults.standard.string(forKey: "voiceProbe") {
                    self.send(["type": "conversation.item.create",
                               "item": ["type": "message", "role": "user", "content": [["type": "input_text", "text": probe]]]])
                    self.send(["type": "response.create"])
                }
                #endif
            }
        }

        nonisolated func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
            let data = buffer.data
            #if DEBUG
            if let e = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let type = e["type"] as? String,
               ["response.output_audio_transcript.done", "response.output_text.done", "response.function_call_arguments.done", "error"].contains(type) {
                let detail = (e["transcript"] ?? e["text"] ?? e["arguments"] ?? e["error"]).map { "\($0)" } ?? ""
                log.info("voice: \(type, privacy: .public) \(detail, privacy: .public)")
            }
            #endif
            Task { @MainActor in self.events?.handle(data) }
        }

        // MARK: RTCPeerConnectionDelegate

        nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
            log.info("voice: connection state \(newState.rawValue)")
            guard newState == .failed || newState == .disconnected else { return }
            Task { @MainActor in self.owner?.dropped(self) }
        }

        nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
        nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
        nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
        nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
        nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
        nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
        nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
        nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
        nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
    }
}
