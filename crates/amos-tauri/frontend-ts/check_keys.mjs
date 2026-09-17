import { zh } from "./src/i18n/locales/zh.ts";
import { en } from "./src/i18n/locales/en.ts";

const zhKeys = new Set(Object.keys(zh));
const enKeys = new Set(Object.keys(en));

const onlyInZh = [...zhKeys].filter(k => !enKeys.has(k));
const onlyInEn = [...enKeys].filter(k => !zhKeys.has(k));

console.log("Keys only in zh:", onlyInZh);
console.log("Keys only in en:", onlyInEn);
console.log("\nzh total:", zhKeys.size);
console.log("en total:", enKeys.size);
