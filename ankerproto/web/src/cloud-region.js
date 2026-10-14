// Anker's regional routing, as documented by the open-source anker-solix-api.
// Locale supplies a default; it does not prove the account's registration region.
export function cloudRegionDefaults(locales = [], timezone = '') {
  const globalCountries = 'DZ LB SY EG LY TN MA JO PS AR AU BR HK IN MX NG NZ RU ZA KR TW US CA'.split(' ');
  const europeanCountries = 'DE BE GR EL LT PT BG ES LU CZ FR HU SI DK HR MT SK IT NL FI EE CY AT SE IE LV PL GB UK IS NO LI CH BA ME MD MK GE AL RS TR UA XK AM BY AZ'.split(' ');
  let country = '';
  // A Brazilian time zone is a stronger default than a browser's UI language.
  if (['America/Sao_Paulo', 'America/Fortaleza', 'America/Recife', 'America/Bahia', 'America/Manaus', 'America/Belem', 'America/Cuiaba', 'America/Porto_Velho', 'America/Boa_Vista', 'America/Rio_Branco', 'America/Maceio', 'America/Araguaina', 'America/Campo_Grande', 'America/Noronha', 'Brazil/East'].includes(timezone)) country = 'BR';
  if (!country) for (const locale of locales) {
    try { country = new Intl.Locale(locale.replaceAll('_', '-')).region || ''; } catch { continue; }
    if (country) break;
  }
  const region = globalCountries.includes(country) ? 'com' : europeanCountries.includes(country) ? 'eu' : '';
  return { country, region };
}
