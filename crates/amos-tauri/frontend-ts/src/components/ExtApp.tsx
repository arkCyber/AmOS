import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { midOf } from "../lib/storeApps";
import { bridged, storeBundleResource, storeFind, type AppManifest } from "../lib/backend";
import {
  decodeBase64Text,
  inlineBundle,
  listLocalRefs,
  toDataUrl,
} from "../lib/bundle";

type Mode = "loading" | "host" | "manifest" | "error";

/**
 * Runtime host for a store-installed (third-party) app.
 *
 * When the app was installed from a web-bundle (`tar.gz` with `index.html` +
 * assets), we fetch it file-by-file over the appstore bridge (base64), inline
 * its relative assets into one self-contained document, and render it in a
 * **sandboxed `srcdoc` iframe** (`allow-scripts`, no same-origin → it can't
 * reach the OS shell). If the app has no web interface (manifest-only install,
 * or daemon offline), we fall back to showing its verified manifest.
 */
export default function ExtApp({ id }: { id: string }) {
  const { t } = useI18n();
  const mid = midOf(id);
  const online = bridged();
  const alive = useRef(true);

  const [manifest, setManifest] = useState<AppManifest | null>(null);
  const [mode, setMode] = useState<Mode>(online ? "loading" : "manifest");
  const [doc, setDoc] = useState<string | null>(null);
  const [error, setError] = useState<string>("");

  const load = useCallback(async () => {
    if (!online) {
      setMode("manifest");
      return;
    }
    setMode("loading");
    setError("");
    try {
      const m = await storeFind(mid);
      if (!alive.current) return;
      if (m) setManifest(m);

      const entry = await storeBundleResource(mid, "index.html");
      if (!alive.current) return;
      if (!entry) {
        // No web interface on disk → this is a manifest-only install.
        setMode("manifest");
        return;
      }

      const html = decodeBase64Text(entry.base64);
      const paths = listLocalRefs(html);
      const assets = new Map<string, string>();
      for (const p of paths) {
        const res = await storeBundleResource(mid, p);
        if (res) assets.set(p, toDataUrl(res.mime, res.base64));
      }
      if (!alive.current) return;
      setDoc(inlineBundle(html, assets));
      setMode("host");
    } catch (e) {
      if (!alive.current) return;
      setMode("error");
      setError(String(e));
    }
  }, [mid, online]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const name = manifest?.name ?? (mid.startsWith("store:") ? midOf(mid) : mid);

  if (mode === "host" && doc !== null) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-black/10 px-4 py-2 dark:border-white/10">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-sm font-medium">{name}</span>
            <span className="truncate rounded-full bg-black/5 px-2 py-0.5 text-[10px] opacity-60 dark:bg-white/10">
              {t("extApp.hostRunning")}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-lg bg-white/40 px-2 py-1 text-[11px] opacity-80 ring-1 ring-black/10 dark:bg-white/10 dark:ring-white/10"
          >
            {t("extApp.hostReload")}
          </button>
        </div>
        <iframe
          title={name}
          sandbox="allow-scripts"
          srcDoc={doc}
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      </div>
    );
  }

  const icon = name ? Array.from(name)[0] : "🧩";

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="grid h-20 w-20 place-items-center rounded-[24px] bg-white/70 text-5xl shadow ring-1 ring-black/10 dark:bg-white/10 dark:ring-white/10">
        {manifest?.name ? Array.from(manifest.name)[0]?.toUpperCase() ?? "🧩" : icon}
      </div>
      <div>
        <div className="text-lg font-medium">{name}</div>
        <div className="text-[11px] opacity-50">{mid}</div>
      </div>

      {mode === "loading" && (
        <p className="text-[12px] opacity-60">{t("extApp.hostLoading")}</p>
      )}
      {mode === "error" && (
        <p role="alert" className="max-w-xs text-[11px] leading-relaxed text-red-600">
          {t("extApp.hostError", { msg: error || "?" })}
        </p>
      )}
      {mode === "manifest" && (
        <>
          <dl className="w-full max-w-xs space-y-1 rounded-2xl bg-white/50 p-3 text-left text-xs ring-1 ring-black/5 dark:bg-white/[0.06] dark:ring-white/10">
            <div className="flex justify-between gap-3">
              <dt className="opacity-50">{t("extApp.author")}</dt>
              <dd>{manifest?.author || "—"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="opacity-50">{t("extApp.version")}</dt>
              <dd>
                {manifest
                  ? `${manifest.version.major}.${manifest.version.minor}.${manifest.version.patch}`
                  : "—"}
              </dd>
            </div>
          </dl>
          <p className="max-w-xs text-[11px] leading-relaxed opacity-60">
            {t("extApp.notWeb")}
          </p>
        </>
      )}
    </div>
  );
}
