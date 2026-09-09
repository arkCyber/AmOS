//! Assistant always-on voice: a **resident microphone → daemon ASR** streaming
//! link for the System UI.
//!
//! On a device the mic is a [`amos_audio::AudioCapture`] (AAudio seam); this
//! module owns the one long-lived bidi `Chat` stream to the `amos-ai` daemon,
//! down-samples the capture to the 16 kHz wire spec, encodes it as little-endian
//! f32 PCM and pushes `Payload::Audio` frames. The daemon's recognizer turns a
//! complete utterance into an assistant reply, which streams back here and is
//! relayed to the caller (the WebView, or a headless test) as events.
//!
//! The core ([`VoiceLink`], [`VoiceLink::open`]) is Tauri-free so the streaming
//! path is exercisable headlessly against a real daemon (see
//! `tests/assistant_voice_e2e.rs`). The Tauri commands at the bottom wrap it in
//! a managed [`VoiceSession`] and fan events out to the WebView.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use amos_proto::ai_agent::client_message::Payload;
use amos_proto::ai_agent::{AgentChunk, ClientMessage};

use crate::ai_bridge::{with_client_id, AiBridge};

/// Tauri event name for every assistant-voice status/reply frame.
pub const VOICE_EVENT: &str = "assistant-voice-event";

/// One event the voice link relays to its consumer (WebView or a headless test).
#[derive(Clone, Debug, PartialEq)]
pub enum VoiceEvent {
    /// The stream is open and ready to accept mic frames.
    Listening { session: String },
    /// A token of the assistant's streaming reply.
    Token { session: String, token: String },
    /// A full assistant reply finished (utterance recognized → answered).
    TurnDone { session: String, text: String },
    /// The daemon closed the stream / recognition stopped.
    Stopped { session: String },
    /// A stream error.
    Error { session: String, message: String },
}

/// Serializable mirror of [`VoiceEvent`] so the WebView can receive it as a
/// single `assistant-voice-event` payload.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VoiceEventPayload {
    Listening { session: String },
    Token { session: String, token: String },
    TurnDone { session: String, text: String },
    Stopped { session: String },
    Error { session: String, message: String },
}

fn to_payload(e: &VoiceEvent) -> VoiceEventPayload {
    match e {
        VoiceEvent::Listening { session } => VoiceEventPayload::Listening {
            session: session.clone(),
        },
        VoiceEvent::Token { session, token } => VoiceEventPayload::Token {
            session: session.clone(),
            token: token.clone(),
        },
        VoiceEvent::TurnDone { session, text } => VoiceEventPayload::TurnDone {
            session: session.clone(),
            text: text.clone(),
        },
        VoiceEvent::Stopped { session } => VoiceEventPayload::Stopped {
            session: session.clone(),
        },
        VoiceEvent::Error { session, message } => VoiceEventPayload::Error {
            session: session.clone(),
            message: message.clone(),
        },
    }
}

/// Reduce one daemon `AgentChunk` into the [`VoiceEvent`]s to relay, accumulating
/// partial tokens into `full`. A `done` chunk finalizes the current turn (`full` is
/// taken and reset); an `error` chunk is relayed but does **not** finalize.
///
/// Kept pure (no I/O) so the reader-loop contract is unit-testable headlessly.
fn on_chunk(chunk: &AgentChunk, session: &str, full: &mut String) -> Vec<VoiceEvent> {
    let mut out = Vec::new();
    if !chunk.error.is_empty() {
        out.push(VoiceEvent::Error {
            session: session.to_string(),
            message: chunk.error.clone(),
        });
    }
    if !chunk.token.is_empty() {
        full.push_str(&chunk.token);
        out.push(VoiceEvent::Token {
            session: session.to_string(),
            token: chunk.token.clone(),
        });
    }
    if chunk.done {
        out.push(VoiceEvent::TurnDone {
            session: session.to_string(),
            text: std::mem::take(full),
        });
    }
    out
}

/// The outbound half of an assistant-voice `Chat` stream. Kept so the caller can
/// keep pushing mic frames after the stream is open, and can cancel it.
pub struct VoiceLink {
    tx: mpsc::Sender<ClientMessage>,
}

impl VoiceLink {
    /// Open a bidi `Chat` stream to the daemon and spawn the reader that relays
    /// [`VoiceEvent`]s to `emit`. Unlike the text `chat_agent`, **no prompt is
    /// pushed**: the daemon only reacts once its recognizer completes an
    /// utterance from the `Payload::Audio` frames this link sends.
    pub async fn open<F>(
        bridge: &AiBridge,
        session: String,
        mut emit: F,
    ) -> Result<VoiceLink, String>
    where
        F: FnMut(VoiceEvent) + Send + 'static,
    {
        let (tx, rx) = mpsc::channel(64);
        let request = ReceiverStream::new(rx);

        let mut client = bridge.connect().await?;
        let mut stream = client
            .chat(with_client_id(request))
            .await
            .map_err(|e| e.to_string())?
            .into_inner();

        let session_for_loop = session.clone();
        // The stream stays open across turns, so one mic listener can answer many
        // utterances without reconnecting.
        tokio::spawn(async move {
            emit(VoiceEvent::Listening {
                session: session_for_loop.clone(),
            });
            let mut full = String::new();
            loop {
                match stream.message().await {
                    Ok(Some(chunk)) => {
                        for evt in on_chunk(&chunk, &session_for_loop, &mut full) {
                            emit(evt);
                        }
                    }
                    // Stream ended (client Cancel or daemon teardown).
                    _ => {
                        emit(VoiceEvent::Stopped {
                            session: session_for_loop,
                        });
                        break;
                    }
                }
            }
        });

        Ok(VoiceLink { tx })
    }

    /// Push one wire audio frame (mono 16 kHz f32 little-endian bytes) into the
    /// daemon's recognizer. Errors when the stream has closed.
    pub async fn feed_bytes(&self, bytes: Vec<u8>) -> Result<(), String> {
        self.tx
            .send(ClientMessage {
                payload: Some(Payload::Audio(bytes)),
            })
            .await
            .map_err(|e| e.to_string())
    }

    /// **End the current utterance** (push-to-talk release): tell the daemon to
    /// force-finalize what was recognized so far into a prompt, instead of
    /// waiting for its own VAD/endpoint. Non-fatal; errors when the stream closed.
    pub async fn finish_turn(&self) -> Result<(), String> {
        self.tx
            .send(ClientMessage {
                payload: Some(Payload::AudioEnd(true)),
            })
            .await
            .map_err(|e| e.to_string())
    }

    /// Cancel the current/ongoing recognition and let the stream wind down.
    pub async fn stop(&self) {
        let _ = self
            .tx
            .send(ClientMessage {
                payload: Some(Payload::Cancel("voice stopped".to_string())),
            })
            .await;
    }
}

/// Tauri-managed state for the assistant voice listener: remembers the outbound
/// half of the current voice `Chat` stream so mic frames can keep flowing in.
pub struct VoiceSession {
    active: std::sync::Arc<std::sync::Mutex<Option<mpsc::Sender<ClientMessage>>>>,
}

impl Default for VoiceSession {
    fn default() -> Self {
        Self::new()
    }
}

impl VoiceSession {
    pub fn new() -> Self {
        Self {
            active: std::sync::Arc::new(std::sync::Mutex::new(None)),
        }
    }

    fn store(&self, tx: mpsc::Sender<ClientMessage>) {
        if let Ok(mut g) = self.active.lock() {
            *g = Some(tx);
        }
    }

    /// Take and drop the sender (stream teardown / cancel).
    fn take(&self) -> Option<mpsc::Sender<ClientMessage>> {
        self.active.lock().unwrap_or_else(|p| p.into_inner()).take()
    }

    /// Snapshot of the active outbound sender (None when nothing has been started).
    fn active_tx(&self) -> Result<mpsc::Sender<ClientMessage>, String> {
        let guard = self.active.lock().unwrap_or_else(|p| p.into_inner());
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| "no active voice session; start it first".to_string())
    }

    /// Push one wire audio frame (mono 16 kHz f32 LE) into the active stream.
    async fn feed(&self, frame: Vec<u8>) -> Result<(), String> {
        let tx = self.active_tx()?;
        tx.send(ClientMessage {
            payload: Some(Payload::Audio(frame)),
        })
        .await
        .map_err(|e| e.to_string())
    }

    /// End the current utterance (push-to-talk release).
    async fn end_utterance(&self) -> Result<(), String> {
        let tx = self.active_tx()?;
        tx.send(ClientMessage {
            payload: Some(Payload::AudioEnd(true)),
        })
        .await
        .map_err(|e| e.to_string())
    }

    /// Cancel the active stream (sends `Cancel`) and clear the session.
    async fn stop(&self) {
        if let Some(tx) = self.take() {
            let _ = tx
                .send(ClientMessage {
                    payload: Some(Payload::Cancel("voice stopped".to_string())),
                })
                .await;
        }
    }
}

/// Tauri command: begin resident listening — open the daemon `Chat` stream (no
/// prompt) and start relaying assistant replies as `assistant-voice-event`
/// frames. Mic PCM is pushed afterwards with `assistant_voice_feed`.
#[tauri::command]
pub async fn assistant_voice_start(
    app: AppHandle,
    state: State<'_, AiBridge>,
    voice: State<'_, VoiceSession>,
    session_id: Option<String>,
) -> Result<(), String> {
    let session = session_id.unwrap_or_else(|| "default".to_string());

    // Tear down any previous active voice session first: opening a new one must
    // not orphan the previous reader task or run two listeners that emit events
    // for the same UI (a double-start on a busy mic button). Best-effort: if
    // nothing is active this is a no-op.
    voice.stop().await;

    // Relay every voice event to the WebView as one typed `assistant-voice-event`.
    let app = app.clone();
    let emit = move |e: VoiceEvent| {
        let _ = app.emit(VOICE_EVENT, to_payload(&e));
    };

    let link = VoiceLink::open(&state, session, emit).await?;
    // Keep the outbound half so `assistant_voice_feed` / `_stop` can reach it.
    let tx = link.tx.clone();
    voice.store(tx);
    Ok(())
}

/// Tauri command: push one wire audio frame (mono 16 kHz f32 little-endian
/// bytes) into the resident voice stream. Feed continuously while listening.
#[tauri::command]
pub async fn assistant_voice_feed(
    voice: State<'_, VoiceSession>,
    frame: Vec<u8>,
) -> Result<(), String> {
    voice.feed(frame).await
}

/// Tauri command: end the current utterance (push-to-talk release) — tells the
/// daemon to force-finalize what was recognized so far into a prompt.
#[tauri::command]
pub async fn assistant_voice_end(voice: State<'_, VoiceSession>) -> Result<(), String> {
    voice.end_utterance().await
}

/// Tauri command: stop the resident voice listener (sends `Cancel`, then drops
/// the stream sender; the reader emits a final `stopped` event).
#[tauri::command]
pub async fn assistant_voice_stop(voice: State<'_, VoiceSession>) -> Result<(), String> {
    voice.stop().await;
    Ok(())
}

/// A running device-mic resident capture (the always-on listen worker).
struct ResidentMicRun {
    /// Backend label of the capture in use (`aaudio` / `tinyalsa` / `mock`).
    label: &'static str,
    handle: ResidentVoiceHandle,
}

/// Managed state for the always-on **device mic** resident capture: the platform
/// microphone (AAudio/TinyALSA on device, or an explicit mock for host/dev) fed
/// into the same resident worker as `VoiceLink::spawn_resident`.
pub struct DeviceMic {
    active: std::sync::Arc<std::sync::Mutex<Option<ResidentMicRun>>>,
}

impl Default for DeviceMic {
    fn default() -> Self {
        Self::new()
    }
}

impl DeviceMic {
    pub fn new() -> Self {
        Self {
            active: std::sync::Arc::new(std::sync::Mutex::new(None)),
        }
    }

    fn replace(&self, run: ResidentMicRun) {
        *self.active.lock().unwrap_or_else(|p| p.into_inner()) = Some(run);
    }

    /// Take + stop the running capture (join the worker thread). Returns whether
    /// one was running.
    fn stop(&self) -> bool {
        let taken = self.active.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(run) = taken {
            run.handle.stop();
            true
        } else {
            false
        }
    }

    /// The current status (no side effects).
    fn status(&self) -> DeviceMicStatus {
        let g = self.active.lock().unwrap_or_else(|p| p.into_inner());
        match g.as_ref() {
            Some(run) => DeviceMicStatus {
                running: true,
                backend: run.label.to_string(),
                submitted: run.handle.submitted(),
            },
            None => DeviceMicStatus {
                running: false,
                backend: "none".to_string(),
                submitted: 0,
            },
        }
    }
}

/// Serialisable status of the device-mic resident capture.
#[derive(Clone, Debug, serde::Serialize)]
pub struct DeviceMicStatus {
    pub running: bool,
    pub backend: String,
    pub submitted: usize,
}

/// Open the platform microphone for the always-on listen. On an Android build this
/// opens the real AAudio (or TinyALSA) capture via [`amos_audio::PlatformMic`]; on
/// a host with no native backend it fails honestly (no silent fake mic).
pub fn open_platform_mic() -> Result<amos_audio::PlatformMic, String> {
    amos_audio::PlatformMic::open_device().map_err(|e| {
        format!(
            "device mic unavailable: {e} (on-device needs an Android build with \
             amos-audio `aaudio`/`tinyalsa`; a host has no native mic — use a mock \
             capture for host/dev)"
        )
    })
}

/// Tauri command: start the **always-on device mic** — open the platform mic
/// (AAudio/TinyALSA on device), open a daemon `Chat` stream, and spawn the
/// resident capture worker that streams speech + auto-finalizes each utterance.
///
/// On a host this returns the honest "no native mic" error; the host path for
/// exercising the same worker is `VoiceLink::spawn_resident(mock, …)`.
#[tauri::command]
pub async fn device_mic_start(
    app: AppHandle,
    state: State<'_, AiBridge>,
    voice: State<'_, VoiceSession>,
    mic: State<'_, DeviceMic>,
    session_id: Option<String>,
) -> Result<String, String> {
    // One listener at a time. Tear down any prior session/capture *first* —
    // opening a second live mic while the old one still runs would double-open the
    // device. Cancel the daemon stream before joining so a resident worker blocked
    // on `feeder.blocking_send` is unblocked by the receiver drop.
    voice.stop().await;
    mic.stop();

    // Then open the real platform mic. If the host has none this fails honestly
    // (no silent fake mic) after we've already cleaned up, never mid-capture.
    let platform = open_platform_mic()?;
    let label = platform.backend_label();
    let native_rate = platform.native_rate();

    let session = session_id.unwrap_or_else(|| "device-mic".to_string());
    let app = app.clone();
    let emit = move |e: VoiceEvent| {
        let _ = app.emit(VOICE_EVENT, to_payload(&e));
    };
    let link = VoiceLink::open(&state, session, emit).await?;

    // Trailing-silence segmentation (end_silence_frames = 3 × ~10 ms); feed
    // silence too so a real VAD recognizer (sherpa) sees the true audio cadence.
    let handle = spawn_resident_capture::<amos_audio::PlatformMic>(
        link.feeder(),
        platform,
        native_rate,
        3,
        true,
    )
    .map_err(|e| format!("failed to spawn resident mic worker: {e}"))?;

    mic.replace(ResidentMicRun { label, handle });
    voice.store(link.feeder());
    Ok(label.to_string())
}

/// Tauri command: stop the always-on device mic. Cancel the daemon stream first so
/// a resident worker blocked on a `blocking_send` is unblocked, then join the
/// capture worker (frees the mic).
#[tauri::command]
pub async fn device_mic_stop(
    voice: State<'_, VoiceSession>,
    mic: State<'_, DeviceMic>,
) -> Result<(), String> {
    voice.stop().await;
    mic.stop();
    Ok(())
}

/// Tauri command: is the always-on device mic running, on which backend?
#[tauri::command]
pub fn device_mic_status(mic: State<'_, DeviceMic>) -> DeviceMicStatus {
    mic.status()
}

/// Energy gate used by the resident voice loop: is there audible content above
/// `threshold` anywhere in this mono f32 frame? Mirrors the frontend's
/// `hasSignal`. Used to tell "speech" from "silence" for utterance segmentation.
pub fn has_signal(samples: &[f32], threshold: f32) -> bool {
    let threshold = if threshold.is_finite() && threshold > 0.0 {
        threshold
    } else {
        0.0
    };
    samples.iter().any(|s| s.abs() > threshold)
}

impl VoiceLink {
    /// Clone the outbound sender so a resident capture thread (or another task)
    /// can keep pushing frames/end signals without owning the whole link.
    pub fn feeder(&self) -> mpsc::Sender<ClientMessage> {
        self.tx.clone()
    }

    /// Spawn a [`ResidentVoiceHandle`] on `mic` that streams into this link and
    /// auto-submits each utterance via `AudioEnd`. See
    /// [`spawn_resident_capture`] for the parameters.
    pub fn spawn_resident<C>(
        &self,
        mic: C,
        mic_rate: u32,
        end_silence_frames: usize,
        feed_silence: bool,
    ) -> Result<ResidentVoiceHandle, String>
    where
        C: amos_audio::AudioCapture + Send + 'static,
    {
        spawn_resident_capture(
            self.feeder(),
            mic,
            mic_rate,
            end_silence_frames,
            feed_silence,
        )
    }
}

/// A handle to a running **resident capture thread** (the "always-on mic"
/// worker that a device AAudio capture feeds). Reads a capture continuously,
/// down-samples to 16 kHz, pushes `Payload::Audio`, and submits each utterance
/// with `AudioEnd` once a trailing-silence gate is crossed.
pub struct ResidentVoiceHandle {
    stop: Arc<AtomicBool>,
    submitted: Arc<AtomicUsize>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl ResidentVoiceHandle {
    /// Non-blocking: ask the capture thread to stop after its current read. Safe
    /// to call from any thread; the worker observes the flag at its next loop.
    /// Prefer this over [`Self::stop`] when the mic's `read()` may block (e.g. a
    /// live AAudio capture) and you do not want this caller to wait on the join.
    pub fn request_stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }

    /// Ask the capture thread to stop and **join** it. For a live mic whose
    /// `read()` blocks until new audio arrives, the join waits for that read to
    /// return (which it will on the next frame). A synthetic/finite capture ends
    /// on its own. When you must not block the current thread indefinitely, call
    /// [`Self::request_stop`] instead and join later.
    pub fn stop(mut self) {
        self.request_stop();
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }

    /// Number of utterances this thread has submitted (`AudioEnd`) so far.
    pub fn submitted(&self) -> usize {
        self.submitted.load(Ordering::Relaxed)
    }
}

/// Spawn the resident capture thread on `mic`, streaming into the daemon via
/// `feeder` (a clone of a [`VoiceLink`]'s outbound sender). Audio is read at
/// `mic_rate`, down-sampled to 16 kHz, and segmented by the client energy gate:
/// after `end_silence_frames` of read silence (160-sample/10 ms frames) an
/// utterance is force-finalized with `AudioEnd`. When `feed_silence` is set the
/// silence frames are also transmitted (best with a real VAD recognizer such as
/// sherpa); leave it off to keep the deterministic mock recognizer from
/// auto-finalizing on transmitted silence.
pub fn spawn_resident_capture<C>(
    feeder: mpsc::Sender<ClientMessage>,
    mut mic: C,
    mic_rate: u32,
    end_silence_frames: usize,
    feed_silence: bool,
) -> Result<ResidentVoiceHandle, String>
where
    C: amos_audio::AudioCapture + Send + 'static,
{
    if mic_rate < 16_000 {
        // The resident path down-samples (never up-samples) to the 16 kHz ASR
        // target; a sub-16k source would silently no-op, so refuse it loudly.
        return Err(format!(
            "mic rate {mic_rate} is below the 16 kHz ASR target and up-sampling is unsupported"
        ));
    }
    if !amos_audio::AudioSpec::new(mic_rate, 1).is_valid() {
        return Err(format!("bad mic rate {mic_rate}"));
    }
    let endgap = end_silence_frames.max(1);

    let stop = Arc::new(AtomicBool::new(false));
    let submitted = Arc::new(AtomicUsize::new(0));
    let stop2 = Arc::clone(&stop);
    let submitted2 = Arc::clone(&submitted);

    let join = std::thread::Builder::new()
        .name("amos-resident-voice".to_string())
        .spawn(move || {
            let mut down = match amos_audio::resample::LinearDownsampler::new(mic_rate, 16_000) {
                Ok(d) => d,
                Err(_) => return,
            };
            let mic_chunk = ((mic_rate as usize) / 100).clamp(160, 3200); // ~10 ms
            let mut buf = vec![0.0f32; mic_chunk];
            let mut heard = false;
            let mut silent = 0usize;
            loop {
                if stop2.load(Ordering::Relaxed) {
                    break;
                }
                let n = match mic.read(&mut buf) {
                    Ok(n) => n,
                    Err(_) => break,
                };
                if n == 0 {
                    break;
                }
                let ds = match down.process(&buf[..n]) {
                    Ok(v) => v,
                    Err(_) => break,
                };
                for frame in ds.chunks(160) {
                    let speech = has_signal(frame, 0.01);
                    if (speech || feed_silence)
                        && feeder
                            .blocking_send(ClientMessage {
                                payload: Some(Payload::Audio(amos_audio::spec::encode_f32_le(
                                    frame,
                                ))),
                            })
                            .is_err()
                    {
                        return; // stream closed
                    }
                    if speech {
                        heard = true;
                        silent = 0;
                    } else if heard {
                        silent += 1;
                        if silent >= endgap {
                            let _ = feeder.blocking_send(ClientMessage {
                                payload: Some(Payload::AudioEnd(true)),
                            });
                            submitted2.fetch_add(1, Ordering::Relaxed);
                            heard = false;
                            silent = 0;
                        }
                    }
                }
            }
            if heard {
                let _ = feeder.blocking_send(ClientMessage {
                    payload: Some(Payload::AudioEnd(true)),
                });
                submitted2.fetch_add(1, Ordering::Relaxed);
            }
        })
        .map_err(|e| e.to_string())?;

    Ok(ResidentVoiceHandle {
        stop,
        submitted,
        join: Some(join),
    })
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn has_signal_detects_speech_but_not_silence() {
        assert!(has_signal(&[0.0, 0.2, 0.0], 0.01), "audible content");
        assert!(!has_signal(&[0.0, 0.0, 0.0], 0.01), "pure silence");
        // Below-threshold samples count as silence.
        assert!(!has_signal(&[0.001, 0.0], 0.01));
        // Non-finite / bad threshold degrade safely (never panics).
        assert!(!has_signal(&[f32::NAN], 0.01), "NaN is silence");
        assert!(has_signal(&[1.0], f32::NAN), "bad threshold treated as 0");
    }

    #[test]
    fn to_payload_preserves_event_kind_and_fields() {
        use VoiceEvent as E;
        use VoiceEventPayload as P;

        let l = E::Listening {
            session: "s".into(),
        };
        match to_payload(&l) {
            P::Listening { session } => assert_eq!(session, "s"),
            _ => panic!("expected Listening"),
        }
        let t = E::Token {
            session: "s".into(),
            token: "hi".into(),
        };
        match to_payload(&t) {
            P::Token { session, token } => {
                assert_eq!(session, "s");
                assert_eq!(token, "hi");
            }
            _ => panic!("expected Token"),
        }
        let d = E::TurnDone {
            session: "s".into(),
            text: "hello".into(),
        };
        match to_payload(&d) {
            P::TurnDone { session, text } => {
                assert_eq!(session, "s");
                assert_eq!(text, "hello");
            }
            _ => panic!("expected TurnDone"),
        }
        let st = E::Stopped {
            session: "s".into(),
        };
        match to_payload(&st) {
            P::Stopped { session } => assert_eq!(session, "s"),
            _ => panic!("expected Stopped"),
        }
        let er = E::Error {
            session: "s".into(),
            message: "boom".into(),
        };
        match to_payload(&er) {
            P::Error { session, message } => {
                assert_eq!(session, "s");
                assert_eq!(message, "boom");
            }
            _ => panic!("expected Error"),
        }
    }

    #[test]
    fn voice_session_store_then_take_is_single_shot() {
        let v = VoiceSession::new();
        assert!(v.take().is_none(), "nothing active before start");
        let (tx, _rx) = tokio::sync::mpsc::channel(4);
        v.store(tx);
        assert!(v.take().is_some(), "a started session is takeable");
        assert!(v.take().is_none(), "take clears the session");
    }

    fn chunk(token: &str, done: bool, error: &str) -> AgentChunk {
        AgentChunk {
            session_id: "s".to_string(),
            token: token.to_string(),
            done,
            error: error.to_string(),
            card: None,
        }
    }

    fn token_of(e: &VoiceEvent) -> Option<&str> {
        match e {
            VoiceEvent::Token { token, .. } => Some(token.as_str()),
            _ => None,
        }
    }
    fn done_text_of(e: &VoiceEvent) -> Option<&str> {
        match e {
            VoiceEvent::TurnDone { text, .. } => Some(text.as_str()),
            _ => None,
        }
    }
    fn error_of(e: &VoiceEvent) -> Option<&str> {
        match e {
            VoiceEvent::Error { message, .. } => Some(message.as_str()),
            _ => None,
        }
    }

    #[test]
    fn on_chunk_relays_token_and_accumulates() {
        let mut full = String::new();
        let evts = on_chunk(&chunk("你", false, ""), "s", &mut full);
        assert_eq!(token_of(&evts[0]), Some("你"));
        assert_eq!(full, "你");

        let evts = on_chunk(&chunk("好", false, ""), "s", &mut full);
        assert_eq!(token_of(&evts[0]), Some("好"));
        assert_eq!(full, "你好");
    }

    #[test]
    fn on_chunk_done_finalizes_and_resets_turn() {
        let mut full = String::new();
        on_chunk(&chunk("你好", false, ""), "s", &mut full);
        let evts = on_chunk(&chunk("", true, ""), "s", &mut full);
        assert_eq!(done_text_of(&evts[0]), Some("你好"));
        assert!(full.is_empty(), "done must reset the accumulation buffer");
    }

    #[test]
    fn on_chunk_error_is_relayed_but_does_not_finalize() {
        let mut full = String::new();
        on_chunk(&chunk("部分", false, ""), "s", &mut full);
        let evts = on_chunk(&chunk("", false, "boom"), "s", &mut full);
        assert_eq!(error_of(&evts[0]), Some("boom"));
        assert!(
            !evts.iter().any(|e| done_text_of(e).is_some()),
            "an error must not finalize the turn"
        );
        assert_eq!(full, "部分", "partial tokens survive an error");
    }

    #[test]
    fn on_chunk_empty_chunk_emits_nothing() {
        let mut full = String::new();
        let evts = on_chunk(&chunk("", false, ""), "s", &mut full);
        assert!(evts.is_empty());
    }

    #[tokio::test]
    async fn voice_session_feed_requires_active_then_sends_audio() {
        use amos_proto::ai_agent::client_message::Payload;
        let v = VoiceSession::new();
        assert!(v.feed(vec![1]).await.is_err(), "feed before start fails");
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        v.store(tx);
        v.feed(vec![9, 10]).await.unwrap();
        let msg = rx.recv().await.expect("a frame was sent");
        match msg.payload {
            Some(Payload::Audio(bytes)) => assert_eq!(bytes, vec![9, 10]),
            _ => panic!("expected an Audio payload"),
        }
    }

    #[tokio::test]
    async fn voice_session_end_sends_audio_end_and_stop_sends_cancel_then_clears() {
        use amos_proto::ai_agent::client_message::Payload;
        let v = VoiceSession::new();
        assert!(v.end_utterance().await.is_err(), "end before start fails");

        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        v.store(tx);
        v.end_utterance().await.unwrap();
        match rx.recv().await.expect("AudioEnd sent").payload {
            Some(Payload::AudioEnd(_)) => {}
            _ => panic!("expected AudioEnd payload"),
        }

        // A fresh session then stop: Cancel is sent and the session is cleared.
        let (tx2, mut rx2) = tokio::sync::mpsc::channel(8);
        v.store(tx2);
        v.stop().await;
        match rx2.recv().await.expect("Cancel sent").payload {
            Some(Payload::Cancel(_)) => {}
            _ => panic!("expected Cancel payload"),
        }
        assert!(
            v.feed(vec![1]).await.is_err(),
            "session is cleared after stop"
        );
    }

    #[tokio::test]
    async fn resident_capture_streams_speech_and_endpoints_on_trailing_silence() {
        use amos_audio::mock::FrameMic;
        use amos_proto::ai_agent::client_message::Payload;

        // ~10 ms of loud speech, then enough pure-silence frames to cross the gate.
        let mut frames = vec![0.5f32; 160];
        frames.extend(std::iter::repeat(0.0f32).take(160 * 6));

        let (feeder, mut rx) = tokio::sync::mpsc::channel(64);
        let handle = spawn_resident_capture::<FrameMic>(
            feeder.clone(),
            FrameMic::new(16_000, frames),
            16_000,
            3, // end after 3 silent 160-sample frames
            false,
        )
        .expect("valid capture spawns");

        // Consume until AudioEnd or the deadline. A single idle timeout is *not*
        // fatal: under CI/CPU load the capture worker can pause >25ms between
        // pushes, and breaking on the first gap made this test flaky.
        let mut saw_audio = false;
        let mut saw_end = false;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            match tokio::time::timeout(std::time::Duration::from_millis(50), rx.recv()).await {
                Ok(Some(msg)) => match msg.payload {
                    Some(Payload::Audio(_)) => saw_audio = true,
                    Some(Payload::AudioEnd(_)) => {
                        saw_end = true;
                        break;
                    }
                    _ => {}
                },
                Ok(None) => break, // worker finished without an explicit AudioEnd
                Err(_) => {}       // idle gap under load — keep waiting until the deadline
            }
        }
        assert!(
            saw_audio,
            "loud speech frames must stream as Audio payloads"
        );
        assert!(
            saw_end,
            "trailing silence past the gate must finalize with AudioEnd"
        );
        assert_eq!(handle.submitted(), 1, "exactly one utterance submitted");
        handle.stop(); // the finite FrameMic already ended; join is prompt
    }

    #[tokio::test]
    async fn resident_capture_submits_each_utterance_and_final_partial_on_end() {
        use amos_audio::mock::FrameMic;
        use amos_proto::ai_agent::client_message::Payload;

        // Two utterances back-to-back:
        //   speech A ─► 6 silence frames (crosses the end-gate → AudioEnd #1)
        //   speech B ─► stream EOF (mic ends) → the worker's trailing `if heard`
        //               must force-finalize the still-open second utterance (AudioEnd #2).
        // This locks the always-on listener's real-world shape: a user speaks, pauses
        // (utterance submitted), speaks again, and the stream ends mid-sentence — the
        // partial second turn must NOT be dropped.
        let mut frames: Vec<f32> = Vec::new();
        frames.extend(std::iter::repeat(0.5f32).take(160)); // speech A (10 ms @16 kHz)
        frames.extend(std::iter::repeat(0.0f32).take(160 * 6)); // trailing silence A
        frames.extend(std::iter::repeat(0.5f32).take(160 * 2)); // speech B
                                                                // No trailing silence: the mic (FrameMic) ends right after speech B.

        let (feeder, mut rx) = tokio::sync::mpsc::channel(64);
        let handle = spawn_resident_capture::<FrameMic>(
            feeder.clone(),
            FrameMic::new(16_000, frames),
            16_000,
            3, // end after 3 silent 160-sample frames
            false,
        )
        .expect("valid capture spawns");

        // Read until the worker closes the channel (finite FrameMic → feeder drop),
        // tolerating idle gaps under load the way the single-utterance test does.
        let mut ends = 0usize;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            match tokio::time::timeout(std::time::Duration::from_millis(50), rx.recv()).await {
                Ok(Some(msg)) => {
                    if matches!(msg.payload, Some(Payload::AudioEnd(_))) {
                        ends += 1;
                    }
                }
                Ok(None) => break, // worker ended and closed the stream
                Err(_) => {}       // idle gap under load — keep waiting until the deadline
            }
        }

        assert_eq!(handle.submitted(), 2, "two utterances must be submitted");
        assert_eq!(
            ends, 2,
            "each submitted utterance must reach the daemon as AudioEnd"
        );
        handle.stop();
    }

    #[tokio::test]
    async fn platform_mic_facade_drives_the_resident_worker() {
        use amos_audio::PlatformMic;
        use amos_proto::ai_agent::client_message::Payload;

        // ~10 ms of loud speech then enough trailing silence to cross the gate —
        // served through the Send platform-mic facade, exactly how a device AAudio /
        // TinyALSA capture will feed the resident worker on Android.
        let mut frames = vec![0.5f32; 160];
        frames.extend(std::iter::repeat(0.0f32).take(160 * 6));
        let mic = PlatformMic::from_mock(amos_audio::mock::FrameMic::new(16_000, frames));
        assert!(
            !mic.is_native(),
            "host facade is a mock, never a claimed device"
        );

        let (feeder, mut rx) = tokio::sync::mpsc::channel(64);
        let handle = spawn_resident_capture::<PlatformMic>(feeder.clone(), mic, 16_000, 3, false)
            .expect("facade capture spawns (Send + AudioCapture)");

        // Same deadline-tolerant consume as the FrameMic test above (a single idle
        // timeout must not be treated as the end of the utterance).
        let mut saw_audio = false;
        let mut saw_end = false;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            match tokio::time::timeout(std::time::Duration::from_millis(50), rx.recv()).await {
                Ok(Some(msg)) => match msg.payload {
                    Some(Payload::Audio(_)) => saw_audio = true,
                    Some(Payload::AudioEnd(_)) => {
                        saw_end = true;
                        break;
                    }
                    _ => {}
                },
                Ok(None) => break,
                Err(_) => {}
            }
        }
        assert!(saw_audio, "facade mic must stream speech as Audio payloads");
        assert!(
            saw_end,
            "trailing silence past the gate must finalize with AudioEnd"
        );
        assert_eq!(handle.submitted(), 1, "exactly one utterance submitted");
        handle.stop();
    }

    #[test]
    fn spawn_resident_rejects_mic_rate_below_asr_target() {
        use amos_audio::mock::FrameMic;

        let (feeder, _rx) = tokio::sync::mpsc::channel(8);
        // 8 kHz would need up-sampling to reach 16 kHz, which the resident
        // down-sampler does not support — it must be refused loudly, not silently
        // spawn a worker that never streams.
        let mic = FrameMic::new(8_000, vec![0.0f32; 800]);
        let err = match spawn_resident_capture::<FrameMic>(feeder, mic, 8_000, 3, false) {
            Ok(_) => panic!("expected Err for a sub-16k mic"),
            Err(e) => e,
        };
        assert!(
            err.contains("up-sampling is unsupported"),
            "clear error expected, got: {err}"
        );
    }

    #[test]
    fn request_stop_is_nonblocking_and_stop_requests_then_joins() {
        use amos_audio::mock::FrameMic;

        // A long-enough, finite capture so the worker outlives the request.
        let (feeder, _rx) = tokio::sync::mpsc::channel(64);
        let mut frames = vec![0.0f32; 160 * 4];
        frames.extend(std::iter::repeat(0.0f32).take(160 * 200)); // silence (no submit)
        let handle = spawn_resident_capture::<FrameMic>(
            feeder,
            FrameMic::new(16_000, frames),
            16_000,
            50,
            false,
        )
        .expect("valid spawn");
        // request_stop() borrows; we can still read submitted() afterwards and
        // then consume stop() to join.
        handle.request_stop();
        let _ = handle.submitted();
        handle.stop();
    }

    #[test]
    fn device_mic_empty_status_and_stop_are_noops() {
        let mic = DeviceMic::new();
        let st = mic.status();
        assert!(!st.running);
        assert_eq!(st.backend, "none");
        assert_eq!(st.submitted, 0);
        assert!(!mic.stop(), "nothing running to stop");
    }

    #[test]
    fn device_mic_run_then_stop_updates_status() {
        use amos_audio::PlatformMic;

        // A finite speech+silence clip through the platform-mic facade drives the
        // resident worker, exactly as a device AAudio capture will.
        let mut frames = vec![0.5f32; 160];
        frames.extend(std::iter::repeat(0.0f32).take(160 * 6));
        let mic = PlatformMic::from_mock(amos_audio::mock::FrameMic::new(16_000, frames));
        let label = mic.backend_label();
        let rate = mic.native_rate();

        let (feeder, _rx) = tokio::sync::mpsc::channel(64);
        let handle =
            spawn_resident_capture::<PlatformMic>(feeder, mic, rate, 3, false).expect("spawn");
        let mic_state = DeviceMic::new();
        mic_state.replace(ResidentMicRun { label, handle });

        let st = mic_state.status();
        assert!(st.running);
        assert_eq!(st.backend, "mock");

        assert!(mic_state.stop(), "a running worker is stopped");
        assert!(!mic_state.status().running);
    }

    #[test]
    fn open_platform_mic_on_host_is_an_honest_error() {
        #[cfg(not(target_os = "android"))]
        {
            match open_platform_mic() {
                Ok(_) => panic!("a host must not report a device mic"),
                Err(err) => assert!(
                    err.contains("no native audio capture backend"),
                    "honest host error expected, got: {err}"
                ),
            }
        }
    }

    /// A pull `AudioCapture` backed by the same bounded [`SampleRing`] a device
    /// `AAudioCallbackCapture` uses, fed by an external *producer* thread that
    /// stands in for AAudio's real-time data callback. `read` drains the ring and
    /// only reports EOF once the producer has closed (`open == false`) *and* the
    /// ring is drained — a live, momentarily-silent capture must never look like
    /// the end of the stream. This is the exact contract the Android-only
    /// callback seam relies on, exercised here through a real consumer.
    #[derive(Clone)]
    struct RingCapture {
        ring: std::sync::Arc<amos_audio::ring::SampleRing>,
        spec: amos_audio::spec::AudioSpec,
        open: std::sync::Arc<AtomicBool>,
    }

    impl RingCapture {
        /// A 16 kHz mono capture over a ring. The short per-wait budget keeps a
        /// starved read prompt so the worker can re-check `open`; the ring
        /// capacity is far larger than any test utterance so it never overflows.
        fn at_asr() -> Self {
            Self {
                ring: std::sync::Arc::new(amos_audio::ring::SampleRing::with_read_timeout(
                    8192,
                    std::time::Duration::from_millis(20),
                )),
                spec: amos_audio::spec::AudioSpec::new(16_000, 1),
                open: std::sync::Arc::new(AtomicBool::new(true)),
            }
        }

        /// Handles for the external producer: push samples and, when finished,
        /// close the capture so `read` can report EOF.
        fn producer(
            &self,
        ) -> (
            std::sync::Arc<amos_audio::ring::SampleRing>,
            std::sync::Arc<AtomicBool>,
        ) {
            (self.ring.clone(), self.open.clone())
        }
    }

    impl amos_audio::AudioCapture for RingCapture {
        fn spec(&self) -> amos_audio::spec::AudioSpec {
            self.spec
        }

        fn read(&mut self, out: &mut [f32]) -> Result<usize, amos_audio::error::AudioError> {
            loop {
                let n = self.ring.read(out);
                if n > 0 {
                    return Ok(n);
                }
                // Empty for a whole wait slice. If the producer is still live it
                // can push at any moment, so keep waiting (never a false EOF); only
                // a closed + drained producer is the genuine end of the stream.
                if !self.open.load(Ordering::Relaxed) {
                    return Ok(0);
                }
            }
        }
    }

    #[tokio::test]
    async fn ring_backed_push_capture_drives_resident_worker_segmentation() {
        use amos_proto::ai_agent::client_message::Payload;

        // Emulate AAudio data callbacks: an external producer thread pushes ~10 ms
        // periods (speech, then enough trailing silence to cross the gate) into the
        // shared ring while the resident worker drains it — mirroring how a device
        // `AAudioCallbackCapture` feeds `assistant_voice`.
        let capture = RingCapture::at_asr();
        let (ring, open) = capture.producer();

        let producer = std::thread::spawn(move || {
            ring.push(&vec![0.5f32; 160]);
            for _ in 0..6 {
                ring.push(&[0.0f32; 160]);
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            open.store(false, Ordering::Relaxed); // producer done -> EOF for the worker
        });

        let (feeder, mut rx) = tokio::sync::mpsc::channel(64);
        let handle =
            spawn_resident_capture::<RingCapture>(feeder.clone(), capture, 16_000, 3, false)
                .expect("ring-backed push capture spawns (Send + AudioCapture)");

        let mut saw_audio = false;
        let mut saw_end = false;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            match tokio::time::timeout(std::time::Duration::from_millis(50), rx.recv()).await {
                Ok(Some(msg)) => match msg.payload {
                    Some(Payload::Audio(_)) => saw_audio = true,
                    Some(Payload::AudioEnd(_)) => {
                        saw_end = true;
                        break;
                    }
                    _ => {}
                },
                Ok(None) => break,
                Err(_) => {}
            }
        }
        producer.join().unwrap();
        assert!(saw_audio, "pushed speech must stream as Audio payloads");
        assert!(
            saw_end,
            "trailing silence past the gate must finalize with AudioEnd"
        );
        assert_eq!(handle.submitted(), 1, "exactly one utterance submitted");
        handle.stop(); // the producer already closed the capture; join is prompt
    }
}
