import fs from 'node:fs/promises';
import path from 'node:path';

import { parseCadUpload } from '../server/cadService.js';
import { prescanCadBuffer } from '../server/cadPrescanService.js';

const args = process.argv.slice(2);

const argValue = (name, fallback = '') => {
  const idx = args.findIndex((arg) => arg === `--${name}`);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return fallback;
};

const requiredFile = argValue('file', process.env.CAD_TARGET_FILE || '');
const minRows = Number(argValue('minRows', process.env.CAD_TARGET_MIN_ROWS || '1'));
const allowGeomFallback = String(argValue('allowGeomFallback', process.env.CAD_TARGET_ALLOW_GEOM_FALLBACK || 'false')).toLowerCase() === 'true';

const countGeometry = (geometry) => {
  if (!geometry || typeof geometry !== 'object') return 0;
  const lines = Array.isArray(geometry.lines) ? geometry.lines.length : 0;
  const polylines = Array.isArray(geometry.polylines) ? geometry.polylines.length : 0;
  const texts = Array.isArray(geometry.texts) ? geometry.texts.length : 0;
  const surfaces = Array.isArray(geometry.surfaces) ? geometry.surfaces.length : 0;
  return lines + polylines + texts + surfaces;
};

async function main() {
  if (!requiredFile) {
    console.error('Missing target file. Use --file "<path-to-dxf-or-dwg>" or set CAD_TARGET_FILE.');
    process.exit(1);
  }

  const fullPath = path.resolve(process.cwd(), requiredFile);
  const fileName = path.basename(fullPath);
  const stat = await fs.stat(fullPath);
  const buffer = await fs.readFile(fullPath);

  const pre = prescanCadBuffer({
    buffer,
    originalName: fileName,
    fileSizeBytes: stat.size,
  });

  const parsed = await parseCadUpload({
    buffer,
    originalName: fileName,
    fileSizeBytes: stat.size,
    pointsOnly: false,
    strictExistingPointsOnly: true,
    processingMode: pre.recommendedMode,
    preScan: pre,
  });

  const rows = Array.isArray(parsed?.rows) ? parsed.rows.length : 0;
  const geom = countGeometry(parsed?.geometry);
  const degraded = Boolean(parsed?.inspection?.degradedFallback);
  const route = parsed?.inspection?.processingRoute || 'unknown';
  const converter = parsed?.inspection?.converterModeUsed || parsed?.inspection?.preferredConverterMode || 'n/a';

  console.log(`Target file: ${fullPath}`);
  console.log(`Rows: ${rows}`);
  console.log(`Geometry entities: ${geom}`);
  console.log(`Route: ${route}`);
  console.log(`Converter: ${converter}`);
  console.log(`Degraded fallback: ${degraded}`);

  if (degraded) {
    console.error('FAIL: degraded fallback is active (converter path failed).');
    process.exit(1);
  }

  if (rows >= minRows) {
    console.log(`PASS: rows (${rows}) >= minRows (${minRows}).`);
    return;
  }

  if (allowGeomFallback && geom > 0) {
    console.log(`PASS (fallback): rows below minRows but geometry entities (${geom}) are available.`);
    return;
  }

  console.error(`FAIL: rows (${rows}) < minRows (${minRows}).`);
  process.exit(1);
}

main().catch((err) => {
  console.error('cad-target-regression crashed:', err?.message || err);
  process.exit(1);
});
