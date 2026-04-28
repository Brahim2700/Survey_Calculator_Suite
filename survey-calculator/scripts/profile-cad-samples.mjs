/**
 * CAD Sample Profiler — times every parse phase for each DWG in public/samples/.
 * Usage: node scripts/profile-cad-samples.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCadUpload } from '../server/cadService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.resolve(__dirname, '../public/samples');

const FILES = [
  'RD561.dwg',
  'RD561-dessin_fondsPlan.dwg',
  'Projet Niglo 3D.dwg',
];

const hrt = () => Number(process.hrtime.bigint()) / 1e6; // ms

async function profileFile(name) {
  const filePath = path.join(SAMPLES_DIR, name);
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    console.warn(`  SKIP (not found): ${name}`);
    return null;
  }

  const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`FILE: ${name}  (${sizeMB} MB)`);
  console.log('='.repeat(60));

  const buffer = await fs.readFile(filePath);

  // parseCadUpload is the real server path (DWG conversion + DXF parse)
  const t0 = hrt();
  let result;
  try {
    result = await parseCadUpload({ buffer, originalName: name, fileSizeBytes: stat.size, pointsOnly: false });
  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
    return { name, sizeMB, error: err.message };
  }
  const totalMs = (hrt() - t0).toFixed(0);  const rows = result?.rows ?? [];
  const geo = result?.geometry ?? {};
  const diag = result?.diagnostics ?? {};

  const lineCount = (geo.lines ?? []).length;
  const polyCount = (geo.polylines ?? []).length;
  const textCount = (geo.texts ?? []).length;
  const surfCount = (geo.surfaces ?? []).length;
  const expandedCount = diag?.resolution?.expandedEntityCount ?? '?';

  // Measure JSON serialisation cost
  const t1 = hrt();
  const json = JSON.stringify(result);
  const jsonMs = (hrt() - t1).toFixed(0);
  const jsonKB = (Buffer.byteLength(json) / 1024).toFixed(0);

  console.log(`  Total parse+convert time : ${totalMs} ms`);
  console.log(`  JSON serialise time       : ${jsonMs} ms`);
  console.log(`  JSON payload size         : ${jsonKB} KB`);
  console.log(`  Points (rows)             : ${rows.length}`);
  console.log(`  Expanded entities         : ${expandedCount}`);
  console.log(`  Lines                     : ${lineCount}`);
  console.log(`  Polylines                 : ${polyCount}`);
  console.log(`  Texts                     : ${textCount}`);
  console.log(`  Surfaces                  : ${surfCount}`);
  if (diag?.resolution) {
    console.log(`  Block inserts expanded    : ${diag.resolution.expandedInsertCount}`);
    console.log(`  Max block nesting depth   : ${diag.resolution.nestedInsertDepthMax}`);
  }

  return {
    name, sizeMB, totalMs: Number(totalMs), jsonMs: Number(jsonMs), jsonKB: Number(jsonKB),
    rows: rows.length, entities: expandedCount, lines: lineCount, polylines: polyCount,
  };
}

async function main() {
  console.log('\nCAD Sample Profiler\n');
  const results = [];
  for (const file of FILES) {
    const r = await profileFile(file);
    if (r) results.push(r);
  }

  console.log('\n\n=== SUMMARY ===');
  console.log(`${'File'.padEnd(35)} ${'MB'.padStart(6)} ${'Parse ms'.padStart(9)} ${'JSON ms'.padStart(8)} ${'KB'.padStart(8)} ${'Rows'.padStart(8)} ${'Entities'.padStart(10)}`);
  console.log('-'.repeat(90));
  for (const r of results) {
    if (r.error) {
      console.log(`${r.name.padEnd(35)} ${r.sizeMB.padStart(6)}  ERROR: ${r.error}`);
    } else {
      console.log(
        `${r.name.padEnd(35)} ${String(r.sizeMB).padStart(6)} ${String(r.totalMs).padStart(9)} ${String(r.jsonMs).padStart(8)} ${String(r.jsonKB).padStart(8)} ${String(r.rows).padStart(8)} ${String(r.entities).padStart(10)}`
      );
    }
  }
}

main().catch((err) => {
  console.error('Profiler crashed:', err);
  process.exit(1);
});
