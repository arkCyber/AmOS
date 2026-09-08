/**
 * A curated "larger world-clock" city index + pure search — React-free.
 *
 * The Clock app's world-clock picker lists 18 presets whose display names come
 * from i18n keys. For a genuinely larger directory, per-city i18n keys don't
 * scale, so this module carries bilingual display names (zh/en) alongside the
 * IANA zone, plus a pure, locale-aware search. It is the data source the
 * world-clock "add/search" UI can consume, and is fully headless-testable.
 */
export type CityRegion =
  | "asia"
  | "europe"
  | "americas"
  | "oceania"
  | "africa"
  | "middle_east";

export interface CityEntry {
  /** Valid IANA time-zone name, e.g. "Asia/Shanghai". */
  zone: string;
  zh: string;
  en: string;
  region: CityRegion;
}

/** Default search result cap (keep the dropdown bounded). */
export const CITY_SEARCH_LIMIT = 50;

/** The curated city index (zones are real IANA names usable by Intl). */
export const CITY_CATALOG: readonly CityEntry[] = [
  // Asia
  { zone: "Asia/Shanghai", zh: "上海/北京", en: "Beijing / Shanghai", region: "asia" },
  { zone: "Asia/Tokyo", zh: "东京", en: "Tokyo", region: "asia" },
  { zone: "Asia/Seoul", zh: "首尔", en: "Seoul", region: "asia" },
  { zone: "Asia/Singapore", zh: "新加坡", en: "Singapore", region: "asia" },
  { zone: "Asia/Bangkok", zh: "曼谷", en: "Bangkok", region: "asia" },
  { zone: "Asia/Hong_Kong", zh: "香港", en: "Hong Kong", region: "asia" },
  { zone: "Asia/Taipei", zh: "台北", en: "Taipei", region: "asia" },
  { zone: "Asia/Kolkata", zh: "孟买/新德里", en: "Mumbai / Delhi", region: "asia" },
  { zone: "Asia/Dubai", zh: "迪拜", en: "Dubai", region: "middle_east" },
  { zone: "Asia/Tehran", zh: "德黑兰", en: "Tehran", region: "middle_east" },
  { zone: "Asia/Jakarta", zh: "雅加达", en: "Jakarta", region: "asia" },
  { zone: "Asia/Manila", zh: "马尼拉", en: "Manila", region: "asia" },
  // Europe
  { zone: "Europe/London", zh: "伦敦", en: "London", region: "europe" },
  { zone: "Europe/Paris", zh: "巴黎", en: "Paris", region: "europe" },
  { zone: "Europe/Berlin", zh: "柏林", en: "Berlin", region: "europe" },
  { zone: "Europe/Rome", zh: "罗马", en: "Rome", region: "europe" },
  { zone: "Europe/Madrid", zh: "马德里", en: "Madrid", region: "europe" },
  { zone: "Europe/Amsterdam", zh: "阿姆斯特丹", en: "Amsterdam", region: "europe" },
  { zone: "Europe/Zurich", zh: "苏黎世", en: "Zurich", region: "europe" },
  { zone: "Europe/Vienna", zh: "维也纳", en: "Vienna", region: "europe" },
  { zone: "Europe/Stockholm", zh: "斯德哥尔摩", en: "Stockholm", region: "europe" },
  { zone: "Europe/Oslo", zh: "奥斯陆", en: "Oslo", region: "europe" },
  { zone: "Europe/Copenhagen", zh: "哥本哈根", en: "Copenhagen", region: "europe" },
  { zone: "Europe/Lisbon", zh: "里斯本", en: "Lisbon", region: "europe" },
  { zone: "Europe/Athens", zh: "雅典", en: "Athens", region: "europe" },
  { zone: "Europe/Warsaw", zh: "华沙", en: "Warsaw", region: "europe" },
  { zone: "Europe/Prague", zh: "布拉格", en: "Prague", region: "europe" },
  { zone: "Europe/Moscow", zh: "莫斯科", en: "Moscow", region: "europe" },
  { zone: "Europe/Istanbul", zh: "伊斯坦布尔", en: "Istanbul", region: "middle_east" },
  // Americas
  { zone: "America/New_York", zh: "纽约", en: "New York", region: "americas" },
  { zone: "America/Los_Angeles", zh: "洛杉矶", en: "Los Angeles", region: "americas" },
  { zone: "America/Chicago", zh: "芝加哥", en: "Chicago", region: "americas" },
  { zone: "America/Toronto", zh: "多伦多", en: "Toronto", region: "americas" },
  { zone: "America/Vancouver", zh: "温哥华", en: "Vancouver", region: "americas" },
  { zone: "America/Mexico_City", zh: "墨西哥城", en: "Mexico City", region: "americas" },
  { zone: "America/Denver", zh: "丹佛", en: "Denver", region: "americas" },
  { zone: "America/Phoenix", zh: "凤凰城", en: "Phoenix", region: "americas" },
  { zone: "America/Seattle", zh: "西雅图", en: "Seattle", region: "americas" },
  { zone: "America/Sao_Paulo", zh: "圣保罗", en: "São Paulo", region: "americas" },
  { zone: "America/Argentina/Buenos_Aires", zh: "布宜诺斯艾利斯", en: "Buenos Aires", region: "americas" },
  { zone: "America/Bogota", zh: "波哥大", en: "Bogotá", region: "americas" },
  { zone: "America/Lima", zh: "利马", en: "Lima", region: "americas" },
  { zone: "Pacific/Honolulu", zh: "檀香山", en: "Honolulu", region: "americas" },
  { zone: "America/Anchorage", zh: "安克雷奇", en: "Anchorage", region: "americas" },
  // Oceania
  { zone: "Australia/Sydney", zh: "悉尼", en: "Sydney", region: "oceania" },
  { zone: "Australia/Melbourne", zh: "墨尔本", en: "Melbourne", region: "oceania" },
  { zone: "Pacific/Auckland", zh: "奥克兰", en: "Auckland", region: "oceania" },
  // Africa
  { zone: "Africa/Cairo", zh: "开罗", en: "Cairo", region: "africa" },
  { zone: "Africa/Nairobi", zh: "内罗毕", en: "Nairobi", region: "africa" },
  { zone: "Africa/Lagos", zh: "拉各斯", en: "Lagos", region: "africa" },
  { zone: "Africa/Johannesburg", zh: "约翰内斯堡", en: "Johannesburg", region: "africa" },
];

/** Lowercased, trimmed query for matching. */
export function normalizeCityQuery(q: string): string {
  return (q ?? "").trim().toLowerCase();
}

/** Resolve a catalog entry by its IANA zone. */
export function resolveCity(zone: string): CityEntry | undefined {
  return CITY_CATALOG.find((c) => c.zone === zone);
}

/**
 * Locale-aware search over the city index. Matches the locale's display name or
 * the IANA zone (case-insensitive substring). Optionally excludes zones already
 * added, and bounds the result. Sorted by the localized name.
 */
export function searchCities(
  query: string,
  locale: "zh" | "en",
  exclude?: ReadonlySet<string>,
  limit: number = CITY_SEARCH_LIMIT,
): CityEntry[] {
  const q = normalizeCityQuery(query);
  const localeName = (c: CityEntry) => (locale === "zh" ? c.zh : c.en);
  const matches = (c: CityEntry): boolean => {
    if (exclude?.has(c.zone)) return false;
    if (!q) return true;
    if (localeName(c).toLowerCase().includes(q)) return true;
    return c.zone.toLowerCase().includes(q);
  };
  return CITY_CATALOG.filter(matches)
    .slice(0, limit)
    .sort((a, b) => localeName(a).localeCompare(localeName(b), locale === "zh" ? "zh-Hans" : "en"));
}

