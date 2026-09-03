import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { midOf } from "../lib/storeApps";
import { bridged, storeFind, type AppManifest } from "../lib/backend";

/**
 * Placeholder container for a store-installed (third-party) app tile.
 *
 * The store engine verifies & records installs, and the tile is on the home
 * screen, but no runtime host ("installer") is wired up yet — so opening one
 * shows its verified manifest as a stand-in until a real web-bundle host lands.
 */
export default function ExtApp({ id }: { id: string }) {
  const { t } = useI18n();
  const mid = midOf(id);
  const online = bridged();
  const [manifest, setManifest] = useState<AppManifest | null>(null);

  useEffect(() => {
    if (!online) return;
    let alive = true;
    void storeFind(mid).then((m) => {
      if (alive && m) setManifest(m);
    });
    return () => {
      alive = false;
    };
  }, [mid, online]);

  const name = manifest?.name ?? (mid.startsWith("store:") ? midOf(mid) : mid);
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

      <p className="max-w-xs text-[11px] leading-relaxed opacity-60">{t("extApp.notRun")}</p>
    </div>
  );
}
