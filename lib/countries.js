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
