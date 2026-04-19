import proj4 from 'proj4';
import CRS_LIST from '../src/crsList.js';
import { detectCRS, shouldSwapCoordinateAxesForCrs } from '../src/utils/crsDetection.js';

const findCrs = (code) => CRS_LIST.find((entry) => entry.code === code);

const registerAllDefs = () => {
  CRS_LIST.forEach((entry) => {
    if (entry?.code && entry?.proj4def) {
      const safeDef = entry.proj4def.replace(/\+nadgrids=[^\s]+\s*/g, '');
      proj4.defs(entry.code, safeDef);
    }
  });
};

const createProjectedCluster = (crsCode, lon, lat) => {
  const offsets = [
    [0, 0],
    [0.02, 0.01],
    [-0.02, -0.015],
  ];

  return offsets.map(([dLon, dLat], idx) => {
    const [x, y] = proj4('EPSG:4326', crsCode, [lon + dLon, lat + dLat]);
    return { id: `${crsCode}_${idx + 1}`, x, y };
  });
};

const topCodes = (suggestions, take = 5) => (Array.isArray(suggestions) ? suggestions.slice(0, take).map((item) => item.code) : []);

const runCase = (name, expectedCode, points, topN = 5, validator = null) => {
  const suggestions = detectCRS(points, {});
  const codes = topCodes(suggestions, topN);
  const ok = typeof validator === 'function' ? validator(codes, suggestions) : codes.includes(expectedCode);
  return { name, expectedCode, ok, codes, suggestions: suggestions.slice(0, topN) };
};

const main = async () => {
  registerAllDefs();

  const failures = [];
  const results = [];

  const ccCases = [
    ['EPSG:3942', 3.0, 42.35],
    ['EPSG:3943', 3.0, 43.35],
    ['EPSG:3944', 3.0, 44.0],
    ['EPSG:3945', 3.0, 45.0],
    ['EPSG:3946', 3.0, 46.0],
    ['EPSG:3947', 3.0, 47.0],
    ['EPSG:3948', 3.0, 48.0],
    ['EPSG:3949', 3.0, 49.0],
    ['EPSG:3950', 3.0, 50.1],
  ];

  ccCases.forEach(([code, lon, lat]) => {
    const crs = findCrs(code);
    if (!crs) return;
    const points = createProjectedCluster(code, lon, lat);
    const outcome = runCase(`French CC zone ${code}`, code, points, 3);
    results.push(outcome);
    if (!outcome.ok) failures.push(outcome);
  });

  const globalCases = [
    {
      sourceCode: 'EPSG:27700',
      expectedCode: 'EPSG:27700',
      lon: -1.5,
      lat: 52.6,
      validator: (codes) => codes.includes('EPSG:27700'),
    },
    {
      sourceCode: 'EPSG:2157',
      expectedCode: 'EPSG:2157',
      lon: -8.0,
      lat: 53.5,
      validator: (codes) => codes.includes('EPSG:2157'),
    },
    {
      sourceCode: 'EPSG:21781',
      expectedCode: 'EPSG:21781',
      lon: 8.25,
      lat: 46.8,
      validator: (codes) => codes.includes('EPSG:21781'),
    },
    {
      sourceCode: 'EPSG:28992',
      expectedCode: 'EPSG:28992',
      lon: 5.3,
      lat: 52.1,
      validator: (codes) => codes.includes('EPSG:28992'),
    },
    {
      sourceCode: 'EPSG:28355',
      expectedCode: 'UTM-family (EPSG:327xx or EPSG:28355)',
      lon: 147.0,
      lat: -35.0,
      validator: (codes) => codes.includes('EPSG:28355') || codes.some((code) => /^EPSG:327\d{2}$/.test(code)),
    },
    {
      sourceCode: 'EPSG:32631',
      expectedCode: 'UTM-family (EPSG:326xx or EPSG:327xx)',
      lon: 3.0,
      lat: 46.5,
      validator: (codes) => codes.some((code) => /^EPSG:32[67]\d{2}$/.test(code)),
    },
    {
      sourceCode: 'EPSG:32734',
      expectedCode: 'UTM-family (EPSG:326xx or EPSG:327xx)',
      lon: 23.0,
      lat: -29.0,
      validator: (codes) => codes.some((code) => /^EPSG:32[67]\d{2}$/.test(code)),
    },
  ];

  globalCases.forEach(({ sourceCode, expectedCode, lon, lat, validator }) => {
    const crs = findCrs(sourceCode);
    if (!crs) return;
    const points = createProjectedCluster(sourceCode, lon, lat);
    const outcome = runCase(`Global projected ${sourceCode}`, expectedCode, points, 5, validator);
    results.push(outcome);
    if (!outcome.ok) failures.push(outcome);
  });

  const lambert93PriorityPoints = [
    { x: 850000, y: 6600000 },
    { x: 852000, y: 6601500 },
    { x: 848500, y: 6599000 },
  ];
  const lambertPriorityOutcome = runCase(
    'Lambert-93 priority over overlapping CC extents',
    'EPSG:2154',
    lambert93PriorityPoints,
    4,
    (_codes, suggestions) => suggestions?.[0]?.code === 'EPSG:2154'
  );
  results.push(lambertPriorityOutcome);
  if (!lambertPriorityOutcome.ok) failures.push(lambertPriorityOutcome);

  const l93Swapped = {
    x: 6577325.343,
    y: 837221.572,
  };
  const axisSwapOutcome = shouldSwapCoordinateAxesForCrs('EPSG:2154', l93Swapped.x, l93Swapped.y);
  const axisNormalOutcome = shouldSwapCoordinateAxesForCrs('EPSG:2154', l93Swapped.y, l93Swapped.x);
  const axisChecksPass = axisSwapOutcome === true && axisNormalOutcome === false;

  console.log('--- CRS Detection Regression Results ---');
  results.forEach((entry) => {
    const status = entry.ok ? 'PASS' : 'FAIL';
    console.log(`${status} | ${entry.name} | expected=${entry.expectedCode} | top=${entry.codes.join(', ')}`);
  });

  console.log('--- Axis Checks ---');
  console.log(`PASS expected true for swapped Lambert-93: ${axisSwapOutcome}`);
  console.log(`PASS expected false for normal Lambert-93: ${axisNormalOutcome === false}`);

  if (!axisChecksPass) {
    failures.push({
      name: 'Axis normalization check EPSG:2154',
      expectedCode: 'swap=true and normal=false',
      ok: false,
      codes: [String(axisSwapOutcome), String(axisNormalOutcome)],
      suggestions: [],
    });
  }

  if (failures.length > 0) {
    console.error(`\nRegression FAILED: ${failures.length} case(s).`);
    failures.forEach((entry) => {
      console.error(`- ${entry.name}: expected ${entry.expectedCode}, got ${entry.codes.join(', ') || 'n/a'}`);
    });
    process.exit(2);
  }

  console.log(`\nRegression PASSED: ${results.length} detection cases + axis checks.`);
};

main().catch((err) => {
  console.error('Regression script failed:', err);
  process.exit(2);
});
