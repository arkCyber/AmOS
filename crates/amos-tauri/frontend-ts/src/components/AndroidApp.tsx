import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import {
  bridged,
  getAndroidAppIcon,
  getAndroidApps,
  launchAndroidApp,
} from "../lib/backend";
import {
  addRecent,
  bytesToDataUri,
  displayName,
  readRecents,
  type AndroidApp,
  type AndroidRecent,
} from "../lib/android";

/**
 * 安卓应用 — lists legacy Android apps from the Waydroid/demo runtime (over the
 * shared gRPC pipe via the Rust `get_android_apps` command) and launches them on
 * tap. Degrades to a localized offline state when not running inside Tauri.
 */
export default function AndroidApp() {
  const { t } = useI18n();
  const online = bridged();
  const [apps, setApps] = useState<AndroidApp[]>([]);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [recent, setRecent] = useState<AndroidRecent[]>(() => readRecents());
  const [status, setStatus] = useState("");
  const [pkg, setPkg] = useState("");

  // Fetch the app list once when bridged.
  useEffect(() => {
    if (!online) {
      setStatus(t("android.offline"));
      return;
    }
    let alive = true;
    getAndroidApps()
      .then((list) => {
        if (!alive) return;
        if (!list || !list.length) {
          setStatus(t("android.empty"));
          return;
        }
        setApps(list);
        setStatus(`${list.length} ${t("android.count")}`);
      })
      .catch(() => {
        if (alive) setStatus(t("android.fetchError"));
      });
    return () => {
      alive = false;
    };
  }, [online, t]);

  // Best-effort icon fetch (PNG bytes -> data URI); falls back to the emoji tile.
  useEffect(() => {
    if (!online) return;
    let alive = true;
    apps.forEach((a) => {
      getAndroidAppIcon(a.package_name)
        .then((bytes) => {
          if (alive && bytes && bytes.length) {
            setIcons((m) => ({ ...m, [a.package_name]: bytesToDataUri(bytes) }));
          }
        })
        .catch(() => {
          /* keep the emoji fallback */
        });
    });
    return () => {
      alive = false;
    };
  }, [apps, online]);

  const doLaunch = async (p: string) => {
    const name = p.trim();
    if (!name) return;
    if (!online) {
      setStatus(t("android.offline"));
      return;
    }
    setStatus(`${t("android.launching")} ${name}…`);
    const r = await launchAndroidApp(name);
    if (!r) {
      setStatus(t("android.rpcError"));
      return;
    }
    if (r.success) {
      const next = addRecent(readRecents(), { package_name: name, name, ts: Date.now() });
      setRecent(next);
      setStatus(t("android.launched") + (r.window_id ? " · " + r.window_id : ""));
    } else {
      setStatus(t("android.launchFailed") + (r.error ? "：" + r.error : ""));
    }
  };

  return (
    <div className="flex h-full flex-col p-3">
      <p className="text-sm opacity-70">{status || t("android.loading")}</p>

      {recent.length > 0 && (
        <div className="mt-2">
          <p className="text-xs opacity-50">{t("android.recent")}</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {recent.map((r) => (
              <button
                key={r.package_name}
                onClick={() => void doLaunch(r.package_name)}
                className="rounded-full bg-neutral-200 px-3 py-1 text-xs dark:bg-neutral-700"
              >
                {displayName(r)}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 grid flex-1 auto-rows-min grid-cols-3 gap-x-2 gap-y-4 overflow-auto pb-2">
        {apps.map((a) => (
          <button
            key={a.package_name}
            onClick={() => void doLaunch(a.package_name)}
            className="flex flex-col items-center gap-1.5 outline-none active:scale-95"
          >
            <span className="relative grid h-14 w-14 place-items-center overflow-hidden rounded-[15px] bg-gradient-to-br from-[#2c6b49] to-[#00a854] text-3xl">
              {icons[a.package_name] ? (
                <img
                  alt={displayName(a)}
                  src={icons[a.package_name]}
                  className="absolute inset-0 h-full w-full object-cover"
                />
              ) : (
                <span>🤖</span>
              )}
            </span>
            <span className="max-w-full truncate text-center text-[11px] leading-tight text-neutral-800 dark:text-neutral-200">
              {displayName(a)}
            </span>
          </button>
        ))}
      </div>

      <div className="mt-3 flex gap-2">
        <input
          value={pkg}
          onChange={(e) => setPkg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void doLaunch(pkg);
          }}
          placeholder={t("android.placeholder")}
          className="flex-1 rounded-full bg-neutral-200 px-3 py-2 text-sm outline-none dark:bg-neutral-800"
        />
        <button
          onClick={() => void doLaunch(pkg)}
          className="rounded-full bg-accent px-4 text-sm text-white"
        >
          {t("android.launch")}
        </button>
      </div>
    </div>
  );
}
