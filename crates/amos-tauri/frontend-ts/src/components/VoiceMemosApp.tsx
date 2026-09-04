/* Voice Memos (语音备忘录) — iOS-style recorder, persisted through the shared
 * amos.* store (metadata + audio as a data URL), mic gated by the OS permission
 * ledger. Demo clips (generated WAV) make the list playable without a mic.
 */
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { readStoreValue, writeStoreValue } from "../lib/amosStore";
import { defaultMediaStore } from "../lib/mediaStore";
import { useCapability } from "./CapabilityGate";
import { GROUP, ROW, SUB } from "./ui";
import {
  VMEMOS_KEY,
  makeVoiceId,
  prependMemo,
  renameMemo,
  removeMemo,
  normalizeVoiceMemos,
  seedVoiceMemos,
  memoForRecording,
  buildWavBytes,
  fmtDuration,
  fmtStamp,
  fmtClock,
  defaultRecordingTitle,
  type VoiceMemo,
} from "../lib/voiceMemos";
import {
  startVoiceRecording,
  type ActiveRecording,
} from "../lib/voiceRecorder";

function Row({
  m,
  playing,
  editing,
  draftTitle,
  onTitleChange,
  onPlay,
  onRename,
  onDelete,
  onCommit,
}: {
  m: VoiceMemo;
  playing: boolean;
  editing: boolean;
  draftTitle: string;
  onTitleChange: (v: string) => void;
  onPlay: () => void;
  onRename: () => void;
  onDelete: () => void;
  onCommit: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className={ROW}>
      <button
        onClick={onPlay}
        aria-label={playing ? t("vm.pause") : t("vm.play")}
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent text-white active:scale-90"
      >
        {playing ? "❚❚" : "▶"}
      </button>
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            autoFocus
            value={draftTitle}
            onChange={(e) => onTitleChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCommit();
            }}
            onBlur={onCommit}
            aria-label={t("vm.titlePlaceholder")}
            className="w-full rounded-md bg-black/5 px-1.5 py-0.5 text-sm outline-none ring-1 ring-accent dark:bg-white/10"
          />
        ) : (
          <p className={"truncate text-[15px] " + (playing ? "text-accent" : "text-neutral-800 dark:text-neutral-100")}>
            {m.title}
          </p>
        )}
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {fmtDuration(m.durationMs)} · {fmtStamp(m.createdAt)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button onClick={onRename} aria-label={t("vm.rename")} className="text-base text-accent active:scale-90">
          ✎
        </button>
        <button onClick={onDelete} aria-label={t("vm.delete")} className="text-base text-danger active:scale-90">
          🗑
        </button>
      </div>
    </div>
  );
}

export default function VoiceMemosApp() {
  const { t } = useI18n();
  const mic = useCapability("vmemos", "microphone");
  const [memos, setMemos] = useState<VoiceMemo[]>(() => {
    const m = normalizeVoiceMemos(readStoreValue<unknown>(VMEMOS_KEY, []));
    if (m.length) return m;
    const s = seedVoiceMemos(Date.now());
    writeStoreValue(VMEMOS_KEY, s);
    return s;
  });
  const persist = (next: VoiceMemo[]) => {
    const c = normalizeVoiceMemos(next);
    writeStoreValue(VMEMOS_KEY, c);
    setMemos(c);
  };

  const [recording, setRecording] = useState(false);
  const [startAt, setStartAt] = useState(0);
  const [, setBeat] = useState(0); // ticks the recording clock
  const recRef = useRef<ActiveRecording | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!recording) return;
    const id = window.setInterval(() => setBeat(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [recording]);
  const elapsed = recording ? Date.now() - startAt : 0;

  const start = async () => {
    setError(null);
    if (!mic.granted) mic.allow(); // consent, then capture below
    try {
      const r = await startVoiceRecording();
      recRef.current = r;
      setStartAt(Date.now());
      setRecording(true);
    } catch {
      setError(t("vm.errUnavailable"));
    }
  };
  const stop = async () => {
    const r = recRef.current;
    recRef.current = null;
    setRecording(false);
    if (!r) return;
    try {
      const res = await r.stop(); // binary, codec-compressed (Opus) blob
      const now = Date.now();
      const id = makeVoiceId(now);
      // Store the audio as a BINARY blob (no base64 inflation), then record only
      // the metadata in the KV store.
      try {
        await defaultMediaStore().put(id, res.blob);
      } catch {
        setError(t("vm.errNoSpace"));
        return;
      }
      persist(
        prependMemo(
          memos,
          memoForRecording({
            id,
            title: defaultRecordingTitle(now),
            createdAt: now,
            durationMs: Math.max(0, now - startAt),
            sizeBytes: res.blob.size,
            mime: res.mime,
          }),
        ),
      );
    } catch {
      setError(t("vm.errMic"));
    }
  };
  const deleteMemo = (m: VoiceMemo) => {
    persist(removeMemo(memos, m.id));
    // Free the binary audio (no-op for regenerable seeds).
    if (m.audio.kind === "recorded") void defaultMediaStore().del(m.id);
  };

  // Rename (inline input) support.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const beginRename = (m: VoiceMemo) => {
    setEditingId(m.id);
    setDraftTitle(m.title);
  };
  const endRename = (save: boolean) => {
    if (save && editingId) persist(renameMemo(memos, editingId, draftTitle));
    setEditingId(null);
  };

  // Playback: one shared <audio> fed by a Blob object URL (binary audio from the
  // MediaStore, or a synthesized WAV for seeds); detach & stop on unmount.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  // If the user leaves mid-recording, stop & release the microphone.
  useEffect(() => {
    return () => {
      const r = recRef.current;
      recRef.current = null;
      if (r) void r.stop().catch(() => undefined);
      const a = audioRef.current;
      if (a) a.pause();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
      audioRef.current = null;
    };
  }, []);

  /** Resolve a memo to a playable Blob (object) URL, or "" if unavailable. */
  const audioUrlFor = async (m: VoiceMemo): Promise<string> => {
    if (m.audio.kind === "seed") {
      const bytes = buildWavBytes({ seconds: m.audio.seconds, sampleRate: 8000, toneHz: m.audio.toneHz, amplitude: 0.3 });
      const audio = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      return URL.createObjectURL(new Blob([audio], { type: "audio/wav" }));
    }
    const blob = await defaultMediaStore().get(m.id);
    return blob ? URL.createObjectURL(blob) : "";
  };

  const togglePlay = (m: VoiceMemo) => {
    if (playingId === m.id) {
      audioRef.current?.pause();
      setPlayingId(null);
      return;
    }
    const a = audioRef.current ?? (audioRef.current = document.createElement("audio"));
    a.onended = () => setPlayingId(null);
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    void audioUrlFor(m).then((url) => {
      if (!url) return;
      urlRef.current = url;
      a.src = url;
      void a.play().then(() => setPlayingId(m.id)).catch(() => setPlayingId(null));
    });
  };

  return (
    <div className="flex h-full flex-col px-3 py-3">
      {/* recorder */}
      <div className="flex shrink-0 flex-col items-center gap-1.5 pb-2">
        {!recording ? (
          <button
            onClick={() => void start()}
            aria-label={t("vm.record")}
            className="grid h-20 w-20 place-items-center rounded-full bg-danger text-4xl text-white shadow-lg ring-4 ring-danger/25 active:scale-95"
          >
            ●
          </button>
        ) : (
          <button
            onClick={() => void stop()}
            aria-label={t("vm.stop")}
            className="grid h-20 w-20 place-items-center rounded-full border-4 border-danger bg-danger/10 active:scale-95"
          >
            <span className="block h-9 w-9 rounded-md bg-white" />
          </button>
        )}
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {recording
            ? `${t("vm.recording")} · ${fmtClock(elapsed)}`
            : mic.refused
              ? t("vm.micDenied")
              : t("vm.startHint")}
        </p>
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>

      {/* memos */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={GROUP}>
          {memos.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm opacity-50">{t("vm.empty")}</p>
          ) : (
            memos.map((m, i) => (
              <div key={m.id}>
                {i > 0 && <div className={SUB} />}
                <Row
                  m={m}
                  playing={playingId === m.id}
                  editing={editingId === m.id}
                  draftTitle={draftTitle}
                  onTitleChange={setDraftTitle}
                  onPlay={() => togglePlay(m)}
                  onRename={() => beginRename(m)}
                  onDelete={() => deleteMemo(m)}
                  onCommit={() => endRename(true)}
                />
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

