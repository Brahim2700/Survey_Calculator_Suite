import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCadUpload } from '../server/cadService.js';
import { prescanCadBuffer } from '../server/cadPrescanService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.resolve(__dirname, '../public/samples');
const CAD_EXT = new Set(['.dwg', '.dxf']);

const args = process.argv.slice(2);
const targetDir = path.resolve(process.cwd(), args[0] || DEFAULT_DIR);

const asMB = (bytes) => (bytes / (1024 * 1024)).toFixed(2);

const countGeometry = (geometry) => {
  if (!geometry || typeof geometry !== 'object') return 0;
  const lines = Array.isArray(geometry.lines) ? geometry.lines.length : 0;
  const polylines = Array.isArray(geometry.polylines) ? geometry.polylines.length : 0;
  const texts = Array.isArray(geometry.texts) ? geometry.texts.length : 0;
  const surfaces = Array.isArray(geometry.surfaces) ? geometry.surfaces.length : 0;
  return lines + polylines + texts + surfaces;
};

const classifyResult = (result) => {
  if (!result.ok) return 'FAIL';
  if (result.degradedFallback) return 'WARN';
  if (result.rows > 0) return 'PASS';
  if (result.geometryEntities > 0) return 'WARN';
  return 'FAIL';
};

async function runOne(filePath, fileName) {
  const stat = await fs.stat(filePath);
  const buffer = await fs.readFile(filePath);

  const pre = prescanCadBuffer({
    buffer,
    originalName: fileName,
    fileSizeBytes: stat.size,
  });

  try {
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
    const geometryEntities = countGeometry(parsed?.geometry);
    const degradedFallback = Boolean(parsed?.inspection?.degradedFallback);
    const route = parsed?.inspection?.processingRoute || 'unknown';
    const converter = parsed?.inspection?.converterModeUsed || parsed?.inspection?.preferredConverterMode || 'n/a';
    const warnings = Array.isArray(parsed?.warnings) ? parsed.warnings : [];

    const result = {
      fileName,
      sizeMB: asMB(stat.size),
      ok: true,
      rows,
      geometryEntities,
      degradedFallback,
      route,
      converter,
      risk: pre.riskScore,
      warningCount: warnings.length,
      warningText: warnings.slice(0, 2).join(' | '),
    };

    return {
      ...result,
      status: classifyResult(result),
    };
  } catch (err) {
    const result = {
      fileName,
      sizeMB: asMB(stat.size),
      ok: false,
      rows: 0,
      geometryEntities: 0,
      degradedFallback: false,
      route: 'error',
      converter: 'n/a',
      risk: pre.riskScore,
      warningCount: 0,
      warningText: String(err?.message || err),
    };
    return {
      ...result,
      status: classifyResult(result),
    };
  }
}

async function main() {
  const entries = await fs.readdir(targetDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => CAD_EXT.has(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    console.error(`No DXF/DWG files found in ${targetDir}`);
    process.exit(1);
  }

  console.log(`CAD compatibility matrix for ${targetDir}`);
  console.log(`Files: ${files.length}`);

  const results = [];
  for (const name of files) {
    const fullPath = path.join(targetDir, name);
    const row = await runOne(fullPath, name);
    results.push(row);

    console.log([
      row.status.padEnd(4, ' '),
      name,
      `size=${row.sizeMB}MB`,
      `rows=${row.rows}`,
      `geom=${row.geometryEntities}`,
      `route=${row.route}`,
      `converter=${row.converter}`,
      `risk=${row.risk}`,
      row.degradedFallback ? 'degraded=true' : 'degraded=false',
    ].join(' | '));

    if (row.warningText) {
      console.log(`      note: ${row.warningText}`);
    }
  }

  const pass = results.filter((r) => r.status === 'PASS').length;
  const warn = results.filter((r) => r.status === 'WARN').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;

  console.log('\nSummary');
  console.log(`PASS: ${pass}`);
  console.log(`WARN: ${warn}`);
  console.log(`FAIL: ${fail}`);

  const outputPath = path.resolve(process.cwd(), 'cad-compat-matrix.json');
  await fs.writeFile(outputPath, `${JSON.stringify({ targetDir, results }, null, 2)}\n`, 'utf8');
  console.log(`JSON report written: ${outputPath}`);

  if (fail > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('cad-compat-matrix crashed:', err);
  process.exit(1);
});
