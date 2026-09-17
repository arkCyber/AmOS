import { zh } from './src/i18n/locales/zh.ts';
import { en } from './src/i18n/locales/en.ts';

const zhKeys = Object.keys(zh).sort();
const enKeys = Object.keys(en).sort();

console.log('zh has', zhKeys.length, 'keys');
console.log('en has', enKeys.length, 'keys');

const inZhNotEn = zhKeys.filter(k => !enKeys.includes(k));
const inEnNotZh = enKeys.filter(k => !zhKeys.includes(k));

console.log('\nIn zh but not en:', inZhNotEn);
console.log('\nIn en but not zh:', inEnNotZh);
