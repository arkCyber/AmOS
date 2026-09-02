import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { readStoreValue, writeStoreValue } from "../lib/amosStore";
import { MSG_KEY, appendMessage, seedMessages, type Msg } from "../lib/messages";
import { KEYS, backspace, pushKey } from "../lib/phone";
import { MUSIC_KEY, seedTracks, stepIndex, type Track } from "../lib/music";

const DURATION = 24; // demo seconds per track

/* ---- Messages (persisted amos.messages) ---- */
export function MessagesApp() {
  const { t } = useI18n();
  const CONTACT = "小安";
  const [msgs, setMsgs] = useState<Msg[]>(() => {
    const l = readStoreValue<Msg[]>(MSG_KEY, []);
    if (l.length) return l;
    const s = seedMessages(Date.now());
    writeStoreValue(MSG_KEY, s);
    return s;
  });
  const [text, setText] = useState("");
  const persist = (l: Msg[]) => {
    writeStoreValue(MSG_KEY, l);
    setMsgs(l);
  };
  const send = () => {
    const v = text.trim();
    if (!v) return;
    persist(appendMessage(msgs, v, Date.now()));
    setText("");
  };
  return (
    <div className="flex h-full flex-col p-3">
      <div className="flex-1 space-y-2 overflow-auto">
        {msgs.map((m, i) => (
          <div
            key={i}
            className={
              "max-w-[78%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm " +
              (m.from === "me"
                ? "ml-auto bg-accent text-white"
                : "bg-neutral-300 text-neutral-900 dark:bg-neutral-700 dark:text-white")
            }
          >
            {m.text}
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={t("message.placeholder", { name: CONTACT })}
          className="flex-1 rounded-full bg-neutral-200 px-3 py-2 text-sm outline-none dark:bg-neutral-800"
        />
        <button onClick={send} className="rounded-full bg-accent px-4 text-sm text-white">
          ➤
        </button>
      </div>
    </div>
  );
}

/* ---- Phone dialer ---- */
export function PhoneApp() {
  const { t } = useI18n();
  const [num, setNum] = useState("");
  const [calling, setCalling] = useState(false);
  const tap = (k: string) => !calling && setNum(pushKey(num, k));
  return (
    <div className="flex h-full flex-col items-center p-3">
      <div className="py-6 text-3xl tabular-nums tracking-widest">{num || "—"}</div>
      {calling ? (
        <div className="flex flex-col items-center gap-6 py-10">
          <p className="text-2xl font-thin">
            {t("phone.call")} {num}…
          </p>
          <button
            onClick={() => setCalling(false)}
            className="h-16 w-16 rounded-full bg-danger text-2xl text-white"
            aria-label="end"
          >
            ✕
          </button>
        </div>
      ) : (
        <>
          <div className="grid w-full max-w-xs grid-cols-3 gap-2">
            {KEYS.map((k) => (
              <button
                key={k}
                onClick={() => tap(k)}
                className="h-12 rounded-full bg-neutral-200 text-xl dark:bg-neutral-700"
              >
                {k}
              </button>
            ))}
          </div>
          <div className="mt-4 flex items-center justify-center gap-6">
            <button onClick={() => setNum(backspace(num))} className="text-xl opacity-70" aria-label="backspace">
              ⌫
            </button>
            <button
              onClick={() => num && setCalling(true)}
              disabled={!num}
              className="h-16 w-16 rounded-full bg-green-500 text-2xl text-white disabled:opacity-40"
              aria-label="call"
            >
              {t("phone.call")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ---- Music (list + play/pause + prev/next + progress timer) ---- */
export function MusicApp() {
  const { t } = useI18n();
  const [tracks] = useState<Track[]>(() => {
    const l = readStoreValue<Track[]>(MUSIC_KEY, []);
    if (l.length) return l;
    const s = seedTracks();
    writeStoreValue(MUSIC_KEY, s);
    return s;
  });
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [sec, setSec] = useState(0);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setSec((prev) => {
        if (prev >= DURATION) {
          setIdx((i) => stepIndex(i, Math.max(tracks.length, 1), 1));
          return 0;
        }
        return prev + 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [playing, tracks.length]);

  const track = tracks[idx];
  const select = (i: number) => {
    setIdx(stepIndex(i, Math.max(tracks.length, 1), 0));
    setSec(0);
  };
  const step = (d: number) => {
    setIdx((i) => stepIndex(i, Math.max(tracks.length, 1), d));
    setSec(0);
  };
  return (
    <div className="p-4">
      <p className="text-center text-xs uppercase tracking-widest opacity-50">
        {playing ? t("music.playing") : "—"}
      </p>
      <div className="my-2 grid place-items-center rounded-3xl bg-gradient-to-br from-orange-400 to-pink-500 py-10 text-6xl">
        🎧
      </div>
      <p className="text-center text-lg font-semibold">{track?.title}</p>
      <p className="text-center text-xs opacity-60">{track?.artist}</p>
      <p className="text-center text-xs tabular-nums opacity-60">
        {sec}s / {DURATION}s
      </p>
      <div className="my-3 h-1 rounded bg-neutral-300 dark:bg-neutral-700">
        <div className="h-full rounded bg-accent" style={{ width: `${(sec / DURATION) * 100}%` }} />
      </div>
      <div className="flex items-center justify-center gap-4">
        <button onClick={() => step(-1)} className="rounded-full bg-neutral-300 px-4 py-2 dark:bg-neutral-700">
          ⏮
        </button>
        <button
          onClick={() => setPlaying((p) => !p)}
          className="grid h-16 w-16 place-items-center rounded-full bg-accent text-2xl text-white"
          aria-label={playing ? "pause" : "play"}
        >
          {playing ? "⏸" : "▶"}
        </button>
        <button onClick={() => step(1)} className="rounded-full bg-neutral-300 px-4 py-2 dark:bg-neutral-700">
          ⏭
        </button>
      </div>
      <div className="mt-4 space-y-1">
        {tracks.map((tr, i) => (
          <button
            key={tr.id}
            onClick={() => select(i)}
            className={
              "flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm " +
              (i === idx ? "bg-accent/20" : "hover:bg-neutral-200/50 dark:hover:bg-neutral-800/50")
            }
          >
            <span>{i === idx ? "▶" : "♪"}</span>
            <span className="flex-1 truncate">{tr.title}</span>
            <span className="text-xs opacity-60">{tr.artist}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

