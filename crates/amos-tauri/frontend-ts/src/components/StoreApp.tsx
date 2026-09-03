import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import {
  bridged,
  storeCatalog,
  storeInstall,
  storeInstalled,
  storeUninstall,
  storeUpgrade,
  type AppManifest,
  type AppVersion,
  type InstalledApp,
} from "../lib/backend";
import { notifyStoreTilesChanged } from "../lib/storeApps";

/// App Store over the amos-appstore bridge: browse the (offline-demo or remote)
/// catalog and install / update / uninstall. Gracefully shows an offline notice
/// when not running inside the Tauri shell (bridge calls return null).
export default function StoreApp() {
  const { t } = useI18n();
  const online = bridged();

  const [catalog, setCatalog] = useState<AppManifest[] | null>(null);
  const [installed, setInstalled] = useState<InstalledApp[] | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  async function load() {
    const [cat, inst] = await Promise.all([storeCatalog(), storeInstalled()]);
    if (cat !== null) setCatalog(cat);
    if (inst !== null) setInstalled(inst);
  }
  useEffect(() => {
    if (!online) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  const installedMap = new Map((installed ?? []).map((a) => [a.manifest.id, a]));

  async function run(action: () => Promise<unknown>, id: string) {
    setActing(id);
    try {
      await action();
    } finally {
      setActing(null);
    }
    await load();
    notifyStoreTilesChanged(); // home-screen tiles (dynamic registry) refresh
  }

  if (!online) {
    return (
      <div className="p-6 text-center text-sm opacity-70">{t("store.offline")}</div>
    );
  }
  if (catalog === null) {
    return <div className="p-6 text-center text-sm opacity-50">…</div>;
  }
  if (catalog.length === 0) {
    return <div className="p-6 text-center text-sm opacity-70">{t("store.empty")}</div>;
  }

  return (
    <div className="p-4">
      <div className="px-1 pb-2 text-[11px] uppercase tracking-wide opacity-50">
        {t("store.tagline")}
      </div>

      <div className="space-y-2">
        {catalog.map((app) => {
          const own = installedMap.get(app.id);
          const updatable = own !== undefined && verLt(own.manifest.version, app.version);
          const busy = acting === app.id;
          const verLabel = fmtVer(app.version);
          return (
            <div
              key={app.id}
              className="rounded-2xl bg-white/60 p-3 shadow-sm ring-1 ring-black/5 dark:bg-white/[0.06] dark:ring-white/10"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{app.name}</div>
                  <div className="mt-0.5 truncate text-[11px] opacity-50">
                    {app.id} · {app.author} · {t("store.version", { version: verLabel })}
                  </div>
                  <div className="mt-1 text-xs opacity-70">{app.summary || "—"}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {own && !updatable && (
                    <span className="rounded-full bg-green-500/15 px-2.5 py-1 text-xs font-medium text-green-600 dark:text-green-400">
                      {t("store.installed")}
                    </span>
                  )}
                  {updatable && (
                    <button
                      disabled={busy}
                      onClick={() => run(() => storeUpgrade(app.id), app.id)}
                      className="rounded-full bg-accent px-3 py-1 text-xs text-white disabled:opacity-40"
                    >
                      {busy ? "…" : t("store.update")}
                    </button>
                  )}
                  {!own && (
                    <button
                      disabled={busy}
                      onClick={() => run(() => storeInstall(app.id), app.id)}
                      className="rounded-full bg-accent px-3 py-1 text-xs text-white disabled:opacity-40"
                    >
                      {busy ? "…" : t("store.install")}
                    </button>
                  )}
                  {own && (
                    <button
                      disabled={busy}
                      onClick={() => run(() => storeUninstall(app.id), app.id)}
                      aria-label={t("store.uninstall")}
                      className="rounded-full bg-neutral-200 px-2.5 py-1 text-xs opacity-70 disabled:opacity-40 dark:bg-neutral-700"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 rounded-2xl bg-white/40 px-3 py-2 text-[11px] opacity-60 dark:bg-white/[0.04]">
        {t("store.myApps")}: {installed?.length ?? 0}
      </div>
    </div>
  );
}

/// Compare two semantic versions numerically; a pre-release sorts before its
/// release. `true` when `a` is strictly older than `b`.
function verLt(a: AppVersion, b: AppVersion): boolean {
  if (a.major !== b.major) return a.major < b.major;
  if (a.minor !== b.minor) return a.minor < b.minor;
  if (a.patch !== b.patch) return a.patch < b.patch;
  const preA = a.pre != null;
  const preB = b.pre != null;
  if (preA !== preB) return preA; // release beats its pre-release
  if (!preA) return false; // equal releases
  return (a.pre ?? "") < (b.pre ?? "");
}

/// "1.2.0" from an `AppVersion` (major.minor.patch) for display.
function fmtVer(v: AppVersion): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}
