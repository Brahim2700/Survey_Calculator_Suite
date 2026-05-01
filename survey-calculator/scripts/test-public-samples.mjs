import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCadUpload } from '../server/cadService.js';
import { prescanCadBuffer } from '../server/cadPrescanService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const samplesDir = path.resolve(__dirname, '../public/samples');

const CAD_EXT = new Set(['.dwg', '.dxf']);

const asMB = (bytes) => (bytes / (1024 * 1024)).toFixed(2);

async function testCadFile(fileName) {
  const fullPath = path.join(samplesDir, fileName);
  const stat = await fs.stat(fullPath);
  const buffer = await fs.readFile(fullPath);

  const pre = prescanCadBuffer({
    buffer,
    originalName: fileName,
    fileSizeBytes: stat.size,
  });

  try {
    const result = await parseCadUpload({
      buffer,
      originalName: fileName,
      fileSizeBytes: stat.size,
      pointsOnly: false,
      processingMode: pre.recommendedMode,
      preScan: pre,
    });

    return {
      fileName,
      sizeMB: asMB(stat.size),
      ok: true,
      rows: Array.isArray(result?.rows) ? result.rows.length : 0,
      mode: result?.inspection?.processingMode || pre.recommendedMode,
      route: result?.inspection?.processingRoute || 'unknown',
      engine: result?.inspection?.converterModeUsed || result?.inspection?.preferredConverterMode || 'n/a',
      risk: pre.riskScore,
      warnings: Array.isArray(result?.warnings) ? result.warnings.length : 0,
    };
  } catch (err) {
    return {
      fileName,
      sizeMB: asMB(stat.size),
      ok: false,
      mode: pre.recommendedMode,
      risk: pre.riskScore,
      error: err.message || String(err),
    };
  }
}

async function run() {
  const entries = await fs.readdir(samplesDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const cadFiles = files.filter((name) => CAD_EXT.has(path.extname(name).toLowerCase()));

  console.log(`Testing CAD sample files in ${samplesDir}`);
  console.log(`Detected ${cadFiles.length} CAD sample file(s).`);

  const results = [];
  for (const file of cadFiles) {
    const result = await testCadFile(file);
    results.push(result);

    if (result.ok) {
      console.log(`OK  ${result.fileName} | ${result.sizeMB} MB | rows=${result.rows} | mode=${result.mode} | risk=${result.risk} | route=${result.route}`);
    } else {
      console.log(`ERR ${result.fileName} | ${result.sizeMB} MB | mode=${result.mode} | risk=${result.risk} | ${result.error}`);
    }
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  console.log('\nSummary');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error('Sample-file test runner crashed:', err);
  process.exit(1);
});
