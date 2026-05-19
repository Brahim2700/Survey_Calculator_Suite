import fs from 'node:fs/promises';
import path from 'node:path';
import { parseCadUpload } from '../server/cadService.js';

const candidates = [
  path.resolve('public/samples/RD561.dwg'),
  path.resolve('public/samples/RD561-dessin_fondsPlan.dwg'),
  path.resolve('public/samples/sample_urban_plan_l93.dxf'),
];

const toHistogram = (items, key = 'code') => {
  const out = {};
  (Array.isArray(items) ? items : []).forEach((item) => {
    const k = String(item?.[key] || 'unknown');
    out[k] = (out[k] || 0) + 1;
  });
  return out;
};

for (const samplePath of candidates) {
  try {
    const buffer = await fs.readFile(samplePath);
    const result = await parseCadUpload({
      buffer,
      originalName: path.basename(samplePath),
      fileSizeBytes: buffer.byteLength,
      pointsOnly: false,
      processingMode: 'full',
    });

    const payload = {
      file: path.basename(samplePath),
      processingRoute: result?.inspection?.processingRoute || null,
      entityTypeCounts: result?.diagnostics?.entityTypeCounts || {},
      geometryCounts: {
        lines: Array.isArray(result?.geometry?.lines) ? result.geometry.lines.length : 0,
        polylines: Array.isArray(result?.geometry?.polylines) ? result.geometry.polylines.length : 0,
        arcs: Array.isArray(result?.geometry?.arcs) ? result.geometry.arcs.length : 0,
        circles: Array.isArray(result?.geometry?.circles) ? result.geometry.circles.length : 0,
        ellipses: Array.isArray(result?.geometry?.ellipses) ? result.geometry.ellipses.length : 0,
        splines: Array.isArray(result?.geometry?.splines) ? result.geometry.splines.length : 0,
      },
      curveSummary: result?.geometry?.curveSummary || null,
      curveDiagnosticCodes: toHistogram(result?.geometry?.curveDiagnostics, 'code'),
      preScanProxySignal: Boolean((result?.preScan?.signals || []).some((s) => s?.code === 'proxy-entity-detected')),
      preScanSignals: Array.isArray(result?.preScan?.signals) ? result.preScan.signals.map((s) => s.code) : [],
      warnings: Array.isArray(result?.warnings) ? result.warnings : [],
    };

    console.log(JSON.stringify(payload, null, 2));
    process.exit(0);
  } catch (err) {
    // Continue to next sample candidate
    console.error(`Failed for ${samplePath}: ${err.message || String(err)}`);
  }
}

process.exit(1);

