import CRS_LIST from '../src/crsList.js';

const COUNTRY_PATTERNS = {
  France: ['france', 'corsica', 'metropolitaine'],
  Australia: ['australia'],
  'New Zealand': ['new zealand'],
  USA: ['united states', 'usa', 'u.s.', 'alaska', 'hawaii', 'puerto rico'],
  Canada: ['canada', 'quebec', 'alberta', 'ontario', 'british columbia'],
  UK: ['united kingdom', 'uk', 'great britain', 'england', 'scotland', 'wales'],
  Germany: ['germany'],
  Spain: ['spain'],
  Italy: ['italy'],
  Belgium: ['belgium'],
  Netherlands: ['netherlands'],
  Switzerland: ['switzerland'],
  Austria: ['austria'],
  Portugal: ['portugal'],
  Ireland: ['ireland'],
  Poland: ['poland'],
  Czechia: ['czech', 'czechia'],
  Denmark: ['denmark'],
  Sweden: ['sweden'],
  Norway: ['norway'],
  Finland: ['finland'],
  Morocco: ['morocco'],
  Algeria: ['algeria'],
  Tunisia: ['tunisia'],
  Egypt: ['egypt'],
  'South Africa': ['south africa'],
  Kenya: ['kenya'],
  Nigeria: ['nigeria'],
  'Saudi Arabia': ['saudi arabia'],
  UAE: ['united arab emirates', 'uae'],
  Qatar: ['qatar'],
  Oman: ['oman'],
  Japan: ['japan'],
  China: ['china', 'hong kong', 'taiwan', 'macau'],
  India: ['india'],
  Malaysia: ['malaysia'],
  Thailand: ['thailand'],
  Singapore: ['singapore'],
  Indonesia: ['indonesia'],
  Philippines: ['philippines'],
  Brazil: ['brazil'],
  Argentina: ['argentina'],
  Chile: ['chile'],
  Mexico: ['mexico'],
  'New Caledonia': ['new caledonia'],
  Fiji: ['fiji'],
  Global: ['world', 'global'],
};

const COUNTRY_TO_CONTINENT = {
  France: 'Europe',
  UK: 'Europe',
  Germany: 'Europe',
  Spain: 'Europe',
  Italy: 'Europe',
  Belgium: 'Europe',
  Netherlands: 'Europe',
  Switzerland: 'Europe',
  Austria: 'Europe',
  Portugal: 'Europe',
  Ireland: 'Europe',
  Poland: 'Europe',
  Czechia: 'Europe',
  Denmark: 'Europe',
  Sweden: 'Europe',
  Norway: 'Europe',
  Finland: 'Europe',
  USA: 'North America',
  Canada: 'North America',
  Mexico: 'North America',
  Brazil: 'South America',
  Argentina: 'South America',
  Chile: 'South America',
  Morocco: 'Africa',
  Algeria: 'Africa',
  Tunisia: 'Africa',
  Egypt: 'Africa',
  'South Africa': 'Africa',
  Kenya: 'Africa',
  Nigeria: 'Africa',
  'Saudi Arabia': 'Middle East',
  UAE: 'Middle East',
  Qatar: 'Middle East',
  Oman: 'Middle East',
  Japan: 'Asia',
  China: 'Asia',
  India: 'Asia',
  Malaysia: 'Asia',
  Thailand: 'Asia',
  Singapore: 'Asia',
  Indonesia: 'Asia',
  Philippines: 'Asia',
  Australia: 'Oceania',
  'New Zealand': 'Oceania',
  'New Caledonia': 'Oceania',
  Fiji: 'Oceania',
  Global: 'Global',
};

const detectCountries = (crs) => {
  const text = `${crs.label || ''} ${crs.region || ''}`.toLowerCase();
  const found = [];
  for (const [country, patterns] of Object.entries(COUNTRY_PATTERNS)) {
    if (patterns.some((p) => text.includes(p))) {
      found.push(country);
    }
  }
  return found.length ? found : ['Other'];
};

const getCategory = (crs) => {
  const code = (crs.code || '').toUpperCase();
  const label = (crs.label || '').toLowerCase();
  const proj4def = (crs.proj4def || '').toLowerCase();

  if (proj4def.includes('+proj=longlat') || crs.type === 'geographic') return 'geographic';
  if (code.includes('32') || label.includes('utm')) return 'utm';
  if (label.includes('transverse mercator') || proj4def.includes('+proj=tmerc')) return 'tm';
  if (label.includes('lambert') || proj4def.includes('+proj=lcc')) return 'conic';
  if (crs.type === 'projected') return 'projected';
  return 'other';
};

const runFilter = ({ type, continent, country }) => {
  return CRS_LIST.filter((crs) => {
    const category = getCategory(crs);

    if (type !== 'all') {
      if (type === 'projected') {
        if (category === 'geographic' || category === 'other') return false;
      } else if (category !== type) {
        return false;
      }
    }

    const countries = detectCountries(crs);

    if (continent !== 'all') {
      const okContinent = countries.some((c) => (COUNTRY_TO_CONTINENT[c] || 'Other') === continent);
      if (!okContinent) return false;
    }

    if (country !== 'all') {
      if (!countries.includes(country)) {
        return false;
      }
      if (countries.length > 1) {
        return false;
      }
    }

    return true;
  });
};

const scenarios = [
  { name: 'Projected + Europe + France', type: 'projected', continent: 'Europe', country: 'France' },
  { name: 'All + Oceania + Australia', type: 'all', continent: 'Oceania', country: 'Australia' },
  { name: 'Conic + Europe + France', type: 'conic', continent: 'Europe', country: 'France' },
];

for (const s of scenarios) {
  const rows = runFilter(s);
  console.log(`\n=== ${s.name} ===`);
  console.log(`Count: ${rows.length}`);
  rows.slice(0, 15).forEach((r) => console.log(`${r.code} | ${r.label}`));
}

const franceProjected = runFilter({ type: 'projected', continent: 'Europe', country: 'France' });
const franceCC = franceProjected.filter((r) => /\bCC\d\d\b/i.test(r.label));
const franceLambert = franceProjected.filter((r) => /lambert/i.test(r.label));

console.log('\n=== France projected details ===');
console.log(`Projected in France: ${franceProjected.length}`);
console.log(`CCxx subset: ${franceCC.length}`);
console.log(`Lambert subset: ${franceLambert.length}`);
