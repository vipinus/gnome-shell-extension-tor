// countries.js — static list of common Tor exit countries for the picker.
//
// Not every ISO country runs Tor exit relays. Shipping a curated list of
// ~30 jurisdictions that reliably have exits keeps the menu short and
// avoids UX disappointment from picking a country that can't route.
// Users who want an exotic code can set `default-exit-country` directly
// via gsettings or the prefs UI.

export const ANY_COUNTRY = {code: '', name: 'Any (default)'};

export const COUNTRIES = [
    ANY_COUNTRY,
    {code: 'us', name: 'United States'},
    {code: 'de', name: 'Germany'},
    {code: 'nl', name: 'Netherlands'},
    {code: 'fr', name: 'France'},
    {code: 'ch', name: 'Switzerland'},
    {code: 'se', name: 'Sweden'},
    {code: 'gb', name: 'United Kingdom'},
    {code: 'ca', name: 'Canada'},
    {code: 'fi', name: 'Finland'},
    {code: 'no', name: 'Norway'},
    {code: 'at', name: 'Austria'},
    {code: 'be', name: 'Belgium'},
    {code: 'dk', name: 'Denmark'},
    {code: 'ie', name: 'Ireland'},
    {code: 'it', name: 'Italy'},
    {code: 'es', name: 'Spain'},
    {code: 'pt', name: 'Portugal'},
    {code: 'cz', name: 'Czechia'},
    {code: 'pl', name: 'Poland'},
    {code: 'ro', name: 'Romania'},
    {code: 'bg', name: 'Bulgaria'},
    {code: 'lu', name: 'Luxembourg'},
    {code: 'is', name: 'Iceland'},
    {code: 'ee', name: 'Estonia'},
    {code: 'lv', name: 'Latvia'},
    {code: 'lt', name: 'Lithuania'},
    {code: 'au', name: 'Australia'},
    {code: 'nz', name: 'New Zealand'},
    {code: 'jp', name: 'Japan'},
    {code: 'sg', name: 'Singapore'},
    {code: 'hk', name: 'Hong Kong'},
];

export function countryName(code) {
    if (!code) return ANY_COUNTRY.name;
    const c = COUNTRIES.find(x => x.code === code.toLowerCase());
    return c ? c.name : code.toUpperCase();
}

/**
 * ISO 国家码 → 国旗 emoji。两个字母各自映射到「区域指示符」码位
 * （U+1F1E6 起对应 A），连写就是一面国旗。
 *
 * 推导而不是逐个写死 30 个 emoji：写死的话新增一个国家要同时改两处，
 * 漏掉时不会报错，只会少一面旗——这种缺陷没人会去逐行核对。
 *
 * ⚠️ 前提是 COUNTRIES 里的 code 都是 ISO 3166-1 alpha-2。Tor 的 ExitNodes
 * 用的正是这套，所以英国是 gb 而不是 uk；写成 uk 会推出一对不构成国旗的
 * 码位，在界面上显示成两个方块字母而不是报错。
 */
export function countryFlag(code) {
    const cc = (code || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc)) return '';
    return String.fromCodePoint(
        ...[...cc].map(ch => 0x1F1E6 + ch.charCodeAt(0) - 65));
}

/**
 * 选择器里显示的一行。
 *
 * 「Any」没有国家可言，用地球符号占位——不留空是为了让所有行的文字左边缘
 * 对齐，否则它会比其余行往左突出一截。
 *
 * ⚠️ Windows 之外的桌面基本都有国旗字体；万一没有，emoji 会退化成两个字母
 * （"US"），仍然是有用信息，属于可接受的降级。
 */
export function countryLabel(code) {
    return `${countryFlag(code) || '\u{1F310}'}  ${countryName(code)}`;
}
