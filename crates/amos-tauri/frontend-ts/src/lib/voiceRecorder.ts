/* Voice Memos recording engine — thin seam over the Web platform so the UI never
 * touches MediaRecorder/getUserMedia directly and the failure surface is clean.
 * (Real capture needs a mic + a secure/bridged context; the headless tests cover
 * the domain and CRUD instead of driving hardware.) */

export class RecordingUnavailableError extends Error {}
export class MicDeniedError extends Error {}

export interface CaptureResult {
  blob: Blob;
  mime: string;
}
export interface ActiveRecording {
  /** Stop capture and resolve the final audio blob (tracks are released). */
  stop: () => Promise<CaptureResult>;
}

function pickMime(): string | undefined {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/wav"];
  for (const c of candidates) {
    try {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      /* ignore unsupported */
    }
  }
  return undefined;
}

/** Start recording from the microphone. Throws {@link RecordingUnavailableError}
 *  when capture isn't available, or {@link MicDeniedError} when refused. */
export async function startVoiceRecording(): Promise<ActiveRecording> {
  const md = (navigator as Navigator & { mediaDevices?: MediaDevices }).mediaDevices;
  if (!md?.getUserMedia || typeof MediaRecorder === "undefined") {
    throw new RecordingUnavailableError("voice capture unavailable");
  }
  let stream: MediaStream;
  try {
    stream = await md.getUserMedia({ audio: true });
  } catch {
    throw new MicDeniedError("microphone denied");
  }
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  rec.start();
  const stop = () =>
    new Promise<CaptureResult>((resolve) => {
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = rec.mimeType || mime || "audio/webm";
        resolve({ blob: new Blob(chunks, { type }), mime: type });
      };
      if (rec.state !== "inactive") rec.stop();
    });
  return { stop };
}

/** Read a Blob as a `data:` URL (what the amos store persists). */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(typeof fr.result === "string" ? fr.result : "");
    fr.onerror = () => reject(fr.error ?? new Error("could not read audio"));
    fr.readAsDataURL(blob);
  });
}
