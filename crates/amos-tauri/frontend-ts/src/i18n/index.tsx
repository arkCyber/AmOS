import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Locale } from "./types";
import { isLocale } from "./types";
import { zh, type MessageKey, type ZhDict } from "./locales/zh";
import { en } from "./locales/en";
import { AMOS_LOCALE_CHANGED_EVENT } from "../svelte/ui-events";

export const LOCALE_KEY = "amos-ui.locale";

const DICTS: Record<Locale, ZhDict> = { zh, en };

/** Pure lookup + {param} interpolation — exported for tests. */
export function translate(dict: ZhDict, key: string, params?: Record<string, string | number>): string {
  const raw = (dict as Record<string, string>)[key];
  const base = raw ?? key;
  if (!params) return base;
  return base.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`));
}

interface I18nValue {
  locale: Locale;
  t: (key: MessageKey | string, params?: Record<string, string | number>) => string;
  setLocale: (l: Locale) => void;
  /** html lang attribute helper */
  htmlLang: string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(LOCALE_KEY);
    } catch {
      /* ignore */
    }
    return isLocale(stored) ? stored : "zh";
  });

  const dict = DICTS[locale];

  useEffect(() => {
    try {
      window.localStorage.setItem(LOCALE_KEY, locale);
      window.Amos?.storeWrite?.(LOCALE_KEY, locale);
      document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    } catch {
      /* ignore */
    }
  }, [locale]);

  // A Svelte screen (e.g. the Svelte Settings screen) can switch the language by
  // writing amos-ui.locale; re-sync this context live so the React shell follows.
  useEffect(() => {
    const onChanged = (e: Event) => {
      const l = (e as CustomEvent<string>).detail;
      if (isLocale(l)) setLocaleState(l);
    };
    window.addEventListener(AMOS_LOCALE_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(AMOS_LOCALE_CHANGED_EVENT, onChanged);
  }, []);

  const t = useCallback<I18nValue["t"]>(
    (key, params) => translate(dict, key, params),
    [dict],
  );
  const setLocale = useCallback((l: Locale) => setLocaleState(l), []);
  const htmlLang = locale === "zh" ? "zh-CN" : "en";

  const value = useMemo<I18nValue>(() => ({ locale, t, setLocale, htmlLang }), [locale, t, setLocale, htmlLang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within <I18nProvider>");
  return ctx;
}
