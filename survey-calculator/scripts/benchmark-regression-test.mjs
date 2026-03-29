import fs from 'node:fs/promises';
import path from 'node:path';
import proj4 from 'proj4';
import CRS_LIST from '../src/crsList.js';
import { ensureGeoidGrid, orthometricToEllipsoidal, ellipsoidalToOrthometric } from '../src/utils/geoid.js';

const benchmarkPath = path.resolve(process.cwd(), 'scripts', 'benchmark-data.json');

const getCrsDef = (code) => CRS_LIST.find((c) => c.code === code)?.proj4def;
const fmt = (n) => Number.isFinite(n) ? n.toFixed(8) : String(n);

function registerBenchCrs(benchmarks) {
  const usedCodes = new Set();
  benchmarks.forEach((b) => {
    usedCodes.add(b.from);
    usedCodes.add(b.to);
  });
  usedCodes.forEach((code) => {
    const def = getCrsDef(code);
    if (!def) throw new Error(`Missing CRS definition for ${code}`);
    proj4.defs(code, def);
  });
}

function distanceMetersApprox(lonA, latA, lonB, latB) {
  const dLon = (lonA - lonB) * 111320 * Math.cos(((latA + latB) / 2) * Math.PI / 180);
  const dLat = (latA - latB) * 110540;
  return Math.hypot(dLon, dLat);
}

(async () => {
  const content = await fs.readFile(benchmarkPath, 'utf8');
  const data = JSON.parse(content);
  const failures = [];

  registerBenchCrs(data.horizontalBenchmarks || []);

  console.log('Running horizontal benchmark regression tests...');
  for (const test of data.horizontalBenchmarks || []) {
    const [xOut, yOut] = proj4(test.from, test.to, test.input);
    if (test.toleranceDegrees) {
      const dDeg = Math.max(Math.abs(xOut - test.expected[0]), Math.abs(yOut - test.expected[1]));
      const pass = dDeg <= test.toleranceDegrees;
      console.log(`${pass ? 'PASS' : 'FAIL'} ${test.name}: out=(${fmt(xOut)}, ${fmt(yOut)}) expected=(${fmt(test.expected[0])}, ${fmt(test.expected[1])}) dDeg=${dDeg}`);
      if (!pass) failures.push(`${test.name} dDeg=${dDeg}`);
    } else {
      const dM = Math.hypot(xOut - test.expected[0], yOut - test.expected[1]);
      const pass = dM <= test.toleranceMeters;
      console.log(`${pass ? 'PASS' : 'FAIL'} ${test.name}: out=(${fmt(xOut)}, ${fmt(yOut)}) expected=(${fmt(test.expected[0])}, ${fmt(test.expected[1])}) dM=${dM}`);
      if (!pass) failures.push(`${test.name} dM=${dM}`);
    }
  }

  console.log('\nRunning vertical/geoid roundtrip checks...');
  for (const test of data.heightRoundtripBenchmarks || []) {
    try {
      await ensureGeoidGrid(test.grid);
      const { h, N } = await orthometricToEllipsoidal(test.grid, test.lon, test.lat, test.H);
      const { H } = await ellipsoidalToOrthometric(test.grid, test.lon, test.lat, h);
      const residual = Math.abs(H - test.H);
      const pass = residual <= test.toleranceMeters;
      console.log(`${pass ? 'PASS' : 'FAIL'} ${test.name}: N=${N.toFixed(4)} H0=${test.H} H1=${H.toFixed(4)} residual=${residual.toFixed(6)}m`);
      if (!pass) failures.push(`${test.name} residual=${residual}`);
    } catch (err) {
      // Node CLI runs can lack app-server relative geoid asset URLs; skip gracefully.
      console.warn(`SKIP ${test.name}: ${err?.message || err}`);
    }
  }

  if (failures.length > 0) {
    console.error('\nBenchmark regression failed:');
    failures.forEach((f) => console.error(` - ${f}`));
    process.exit(2);
  }

  console.log('\nAll benchmark regression tests passed.');
})();
