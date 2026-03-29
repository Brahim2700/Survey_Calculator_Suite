import fs from 'fs/promises';
import path from 'path';
import { detectCRS } from '../src/utils/crsDetection.js';

const samplePath = path.resolve(new URL(import.meta.url).pathname, '..', 'public', 'samples', 'sample_crs_detection.csv');

async function readCSV(p) {
  const txt = await fs.readFile(p, 'utf8');
  const lines = txt.split(/\r?\n/).filter(Boolean);
  const header = lines.shift().split(',').map(h => h.trim());
  const rows = lines.map(l => {
    const cols = l.split(',');
    const obj = {};
    header.forEach((h, i) => obj[h] = cols[i]);
    return obj;
  });
  return rows;
}

(async () => {
  try {
    // read sample CSV
    const csvPath = path.resolve(process.cwd(), 'public', 'samples', 'sample_crs_detection.csv');
    const rows = await readCSV(csvPath);

    const coords = rows.map(r => ({ x: Number(r.x), y: Number(r.y) }));

    console.log('Running detectCRS on sample file (aggregated)...');
    const suggestions = detectCRS(coords, {});
    console.log('Top suggestions:');
    console.table(suggestions);

    console.log('\nPer-row quick checks:');
    for (const r of rows) {
      const crs = detectCRS([{ x: Number(r.x), y: Number(r.y) }], {});
      console.log(r.id, '=>', crs[0] ? `${crs[0].code} (${(crs[0].confidence*100).toFixed(0)}%) ${crs[0].reason || ''}` : 'No suggestion');
    }

    process.exit(0);
  } catch (err) {
    console.error('Test failed:', err);
    process.exit(2);
  }
})();
