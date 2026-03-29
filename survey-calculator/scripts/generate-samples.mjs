// scripts/generate-samples.mjs
// Generates downloadable sample files for import testing: XLSX and Shapefile ZIP
// Outputs to public/samples/

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { read, utils, write } from 'xlsx';
import shpwrite from 'shp-write';

const __dirname = dirname(fileURLToPath(import.meta.url));
const samplesDir = join(__dirname, '..', 'public', 'samples');

const points = [
  { id: 'Sydney', lon: 151.2093, lat: -33.8688, h: 75 },
  { id: 'Melbourne', lon: 144.9631, lat: -37.8136, h: 45 },
  { id: 'Brisbane', lon: 153.0281, lat: -27.4698, h: 80 },
  { id: 'Perth', lon: 115.8605, lat: -31.9505, h: 20 },
];

async function generateXLSX() {
  const rows = points.map(p => ({
    id: p.id,
    lon: p.lon,
    lat: p.lat,
    h: p.h,
    WKT: `POINT(${p.lon} ${p.lat} ${p.h})`,
    SRID: 'EPSG:4326',
  }));
  const ws = utils.json_to_sheet(rows);
  const wb = utils.book_new();
  utils.book_append_sheet(wb, ws, 'points');
  const buf = write(wb, { type: 'buffer', bookType: 'xlsx' });
  const outPath = join(samplesDir, 'sample.xlsx');
  await writeFile(outPath, buf);
  console.log('Wrote', outPath);
}

async function generateShapefileZip() {
  const fc = {
    type: 'FeatureCollection',
    features: points.map(p => ({
      type: 'Feature',
      properties: { id: p.id, h: p.h },
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] }
    })),
  };

  const zipAB = shpwrite.zip(fc, {
    folder: 'samples',
    types: { point: 'points' },
    prj: 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,' +
         'AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,' +
         'AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9102"]],' +
         'AUTHORITY["EPSG","4326"]]'
  });
  const buf = Buffer.from(zipAB);
  const outPath = join(samplesDir, 'sample_shapefile.zip');
  await writeFile(outPath, buf);
  console.log('Wrote', outPath);
}

await generateXLSX();
await generateShapefileZip();
