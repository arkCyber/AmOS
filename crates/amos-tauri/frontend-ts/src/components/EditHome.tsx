import { useI18n } from "../i18n";
import { appTitleKey } from "../apps";
import { hideFromHome, restoreToHome, type HomeLayout } from "../lib/amosStore";

export default function EditHome({
  layout,
  onChange,
  onDone,
}: {
  layout: HomeLayout;
  onChange: (l: HomeLayout) => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const label = (id: string) => {
    const k = appTitleKey(id);
    return k ? t(k) : id;
  };
  const shown = [...layout.page, ...layout.dock].filter((id) => appTitleKey(id) !== null);

  return (
    <div className="flex h-full flex-col p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs opacity-60">{t("edit.hint")}</p>
        <button onClick={onDone} className="rounded-full bg-accent px-4 py-1 text-sm text-white">
          {t("edit.done")}
        </button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {shown.map((id) => (
          <div key={id} className="relative">
            <button
              onClick={() => onChange(hideFromHome(layout, id))}
              className="grid h-16 w-16 place-items-center rounded-2xl bg-neutral-300 text-2xl dark:bg-neutral-700"
              aria-label={`remove ${id}`}
            >
              🧩
            </button>
            <span className="absolute -left-1 -top-1 grid h-5 w-5 place-items-center rounded-full bg-danger text-xs text-white">
              ✕
            </span>
            <span className="mt-1 block w-16 truncate text-center text-[10px]">{label(id)}</span>
          </div>
        ))}
      </div>

      {layout.hidden.length > 0 && (
        <div className="mt-6">
          <p className="text-xs opacity-60">{t("edit.hidden")}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {layout.hidden.filter((id) => appTitleKey(id) !== null).map((id) => (
              <button
                key={id}
                onClick={() => onChange(restoreToHome(layout, id))}
                className="flex items-center gap-1 rounded-full bg-neutral-300 px-3 py-1 text-xs dark:bg-neutral-700"
              >
                ＋ {label(id)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
