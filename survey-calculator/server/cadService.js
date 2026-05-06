import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { exec as execCallback, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { parseDxfTextContent, isLikelyDxfData, isLikelyNativeDwgData } from '../src/utils/cadShared.js';

const execAsync = promisify(execCallback);
function computeSha256Hex(bufferLike) {
  const hash = createHash('sha256');
  hash.update(bufferLike);
  return hash.digest('hex');
}
const MAX_COMMAND_OUTPUT = 1024 * 1024 * 8;
const DEFAULT_DWG2DXF_PATHS = [
  '/usr/bin/dwg2dxf',
  '/usr/local/bin/dwg2dxf',
  '/opt/homebrew/bin/dwg2dxf',
];

function getFileExtension(fileName = '') {
  return path.extname(fileName).toLowerCase();
}

function getBaseName(fileName = 'drawing') {
  return path.basename(fileName, path.extname(fileName)).replace(/[^a-z0-9._-]+/gi, '_') || 'drawing';
}

function resolveDwg2DxfPath() {
  const configured = process.env.DWG2DXF_PATH;
  if (configured && existsSync(configured)) return configured;
  return DEFAULT_DWG2DXF_PATHS.find((p) => existsSync(p)) || null;
}

function getAvailableConverterModes() {
  const modes = [];
  if (resolveDwg2DxfPath()) modes.push('libredwg');
  if (process.env.DWG_CONVERTER_COMMAND) modes.push('custom');
  return modes;
}

function getConfiguredConverterMode() {
  return getAvailableConverterModes()[0] || 'none';
}

function buildConverterSetupHint() {
  return 'No DWG converter found. In production (Docker) LibreDWG (dwg2dxf) is installed automatically. Configure DWG2DXF_PATH or DWG_CONVERTER_COMMAND on this runtime.';
}

/**
 * Normalize DXF text so there is exactly one well-formed EOF marker at the end.
 * Some DWG converters (including LibreDWG and custom pipelines) produce truncated output (missing EOF) or
 * append binary/extra content after the EOF group, both of which crash dxf-parser.
 *
 * DXF EOF format (each on its own line, optional leading spaces):
 *   0
 *   EOF
 */
function sanitizeDxfEof(text) {
  if (typeof text !== 'string') return text;

  // Find the first occurrence of "0\nEOF" (with optional surrounding whitespace/CR)
  // DXF group codes are line-based: code line, then value line.
  // Match patterns like: "\n  0\r\nEOF" or "\n0\nEOF" etc.
  const eofRe = /\r?\n[ \t]*0[ \t]*\r?\n[ \t]*EOF[ \t]*/i;
  const match = eofRe.exec(text);

  if (match) {
    // Truncate everything after EOF and normalise to a clean ending
    const eofEnd = match.index + match[0].length;
    const truncated = text.slice(0, eofEnd).trimEnd() + '\n  0\nEOF\n';
    return truncated !== text ? truncated : text;
  }

  // No EOF marker found — append one
  return text.trimEnd() + '\n  0\nEOF\n';
}

function stripUtfBom(text) {
  if (typeof text !== 'string') return text;
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function normalizeDxfLineEndings(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function sanitizeNulBytes(text) {
  if (typeof text !== 'string') return text;
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code !== 0) out += text[i];
  }
  return out;
}

function stripNonPrintableControlChars(text) {
  if (typeof text !== 'string') return text;
  // Keep tabs/newlines/CR; remove other control chars that can destabilize parser tokenization.
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const isAllowedWhitespace = code === 9 || code === 10 || code === 13;
    const isControl = code < 32 || code === 127;
    if (!isControl || isAllowedWhitespace) {
      out += text[i];
    }
  }
  return out;
}

function normalizeBooleanGroupValues(text) {
  if (typeof text !== 'string' || text.length === 0) return text;

  const normalized = normalizeDxfLineEndings(text);
  const lines = normalized.split('\n');
  for (let i = 0; i < lines.length - 1; i += 2) {
    const code = Number.parseInt(String(lines[i] || '').trim(), 10);
    if (!Number.isInteger(code) || code < 290 || code > 299) continue;

    const valueRaw = String(lines[i + 1] || '').trim();
    if (valueRaw === '0' || valueRaw === '1') continue;

    const numeric = Number.parseFloat(valueRaw);
    if (Number.isFinite(numeric)) {
      lines[i + 1] = numeric === 0 ? '0' : '1';
    }
  }

  return lines.join('\n');
}

function buildDxfRepairCandidates(rawText) {
  const base = typeof rawText === 'string' ? rawText : String(rawText || '');
  const step1 = stripUtfBom(base);
  const step2 = sanitizeNulBytes(step1);
  const step3 = normalizeDxfLineEndings(step2);
  const step4 = sanitizeDxfEof(step3);
  const step5 = sanitizeDxfEof(stripNonPrintableControlChars(step3));
  const step6 = sanitizeDxfEof(normalizeBooleanGroupValues(step5));

  return [
    {
      id: 'raw',
      text: base,
      repairsApplied: [],
    },
    {
      id: 'normalized',
      text: step3,
      repairsApplied: ['strip-utf-bom', 'remove-nul-bytes', 'normalize-line-endings'],
    },
    {
      id: 'normalized-eof',
      text: step4,
      repairsApplied: ['strip-utf-bom', 'remove-nul-bytes', 'normalize-line-endings', 'repair-eof'],
    },
    {
      id: 'aggressive-control-strip',
      text: step5,
      repairsApplied: ['strip-utf-bom', 'remove-nul-bytes', 'normalize-line-endings', 'strip-control-chars', 'repair-eof'],
    },
    {
      id: 'boolean-group-normalize',
      text: step6,
      repairsApplied: ['strip-utf-bom', 'remove-nul-bytes', 'normalize-line-endings', 'strip-control-chars', 'normalize-boolean-group-values', 'repair-eof'],
    },
  ];
}

function analyzeGeometryDensity(parsedPayload, fileSizeBytes = 0) {
  const geometry = parsedPayload?.geometry || {};
  const rows = Array.isArray(parsedPayload?.rows) ? parsedPayload.rows : [];
  const lines = Array.isArray(geometry.lines) ? geometry.lines.length : 0;
  const polylines = Array.isArray(geometry.polylines) ? geometry.polylines.length : 0;
  const hatches = Array.isArray(geometry.hatches) ? geometry.hatches.length : 0;
  const texts = Array.isArray(geometry.texts) ? geometry.texts.length : 0;
  const surfaces = Array.isArray(geometry.surfaces) ? geometry.surfaces.length : 0;
  const estimatedVertices = (Array.isArray(geometry.polylines) ? geometry.polylines : []).reduce((sum, pl) => {
    const count = Array.isArray(pl?.vertices) ? pl.vertices.length : 0;
    return sum + count;
  }, 0);

  const complexityScore =
    (rows.length * 1)
    + (lines * 2)
    + (polylines * 4)
    + (hatches * 6)
    + (texts * 1)
    + (surfaces * 8)
    + Math.ceil(estimatedVertices / 8)
    + Math.ceil(Number(fileSizeBytes || 0) / (1024 * 1024));

  const lodTier = complexityScore > 120000
    ? 'ultra'
    : complexityScore > 45000
      ? 'heavy'
      : complexityScore > 15000
        ? 'medium'
        : 'light';

  return {
    complexityScore,
    lodTier,
    entities: {
      points: rows.length,
      lines,
      polylines,
      hatches,
      texts,
      surfaces,
      estimatedVertices,
    },
    renderRecommendations: {
      simplifyPolylines: lodTier === 'ultra' || lodTier === 'heavy',
      preferHatchSolidPreview: lodTier === 'ultra',
      labelBudgetTier: lodTier,
    },
  };
}

function parseDxfWithRepairStrategy(dxfText, options, { sourceTag = 'dxf' } = {}) {
  const candidates = buildDxfRepairCandidates(dxfText);
  const errors = [];

  for (const candidate of candidates) {
    try {
      const parsed = parseDxfTextContent(candidate.text, options);
      return {
        parsed,
        repair: {
          sourceTag,
          passId: candidate.id,
          recovered: candidate.id !== 'raw',
          repairsApplied: candidate.repairsApplied,
          attempts: candidates.length,
          errors,
        },
      };
    } catch (err) {
      errors.push(`${candidate.id}: ${err.message || String(err)}`);
    }
  }

  throw new Error(`DXF parse failed after ${candidates.length} repair attempts. ${errors.join(' | ')}`);
}

function buildModeRetryOrder(requestedMode = 'full', pointsOnly = false) {
  const mode = String(requestedMode || 'full').toLowerCase();
  if (pointsOnly) return [mode];

  const order = [];
  const pushMode = (value) => {
    const v = String(value || '').toLowerCase();
    if (!v) return;
    if (!['full', 'preview', 'recovery'].includes(v)) return;
    if (!order.includes(v)) order.push(v);
  };

  if (mode === 'recovery') {
    pushMode('recovery');
    pushMode('preview');
    pushMode('full');
    return order;
  }

  if (mode === 'preview') {
    pushMode('preview');
    pushMode('recovery');
    pushMode('full');
    return order;
  }

  pushMode('full');
  pushMode('preview');
  pushMode('recovery');
  return order;
}

function parseCadTextWithModeRetry(dxfText, baseOptions, requestedMode = 'full', { sourceTag = 'dxf' } = {}) {
  const modeOrder = buildModeRetryOrder(requestedMode, Boolean(baseOptions?.pointsOnly));
  const modeErrors = [];

  for (const mode of modeOrder) {
    const optionsForMode = { ...baseOptions, processingMode: mode };
    try {
      const result = parseDxfWithRepairStrategy(dxfText, optionsForMode, {
        sourceTag: `${sourceTag}:${mode}`,
      });
      return {
        ...result,
        modeUsed: mode,
        requestedMode,
        modeAttempts: modeOrder,
        modeErrors,
        modeFallbackUsed: mode !== requestedMode,
      };
    } catch (err) {
      modeErrors.push(`${mode}: ${err.message || String(err)}`);
    }
  }

  throw new Error(`CAD parse failed across processing modes (${modeOrder.join(', ')}). ${modeErrors.join(' | ')}`);
}

function buildEntityTypeFamilyCounts(diagnostics = {}) {
  const map = diagnostics?.entityTypeCounts && typeof diagnostics.entityTypeCounts === 'object'
    ? diagnostics.entityTypeCounts
    : {};

  let points = 0;
  let lines = 0;
  let polylines = 0;
  let hatches = 0;
  let texts = 0;
  let surfaces = 0;

  Object.entries(map).forEach(([rawType, rawCount]) => {
    const type = String(rawType || '').toUpperCase();
    const count = Number(rawCount) || 0;
    if (count <= 0) return;
    if (['POINT'].includes(type)) {
      points += count;
    } else if (['LINE', 'XLINE', 'RAY', '3DLINE'].includes(type)) {
      lines += count;
    } else if (['POLYLINE', 'LWPOLYLINE', 'SPLINE', 'ARC', 'CIRCLE', 'ELLIPSE'].includes(type)) {
      polylines += count;
    } else if (['HATCH'].includes(type)) {
      hatches += count;
    } else if (['TEXT', 'MTEXT', 'ATTRIB', 'ATTDEF'].includes(type)) {
      texts += count;
    } else if (['3DFACE', 'PLANESURFACE', 'REGION', 'MESH', 'POLYFACE', 'TIN'].includes(type)) {
      surfaces += count;
    }
  });

  return { points, lines, polylines, hatches, texts, surfaces };
}

function computeCadFidelityProfile({ geometry = {}, rows = [], diagnostics = {}, requestedMode = 'full', modeUsed = 'full', parseRepair = null }) {
  const extracted = {
    points: Array.isArray(rows) ? rows.length : 0,
    lines: Array.isArray(geometry?.lines) ? geometry.lines.length : 0,
    polylines: Array.isArray(geometry?.polylines) ? geometry.polylines.length : 0,
    hatches: Array.isArray(geometry?.hatches) ? geometry.hatches.length : 0,
    texts: Array.isArray(geometry?.texts) ? geometry.texts.length : 0,
    surfaces: Array.isArray(geometry?.surfaces) ? geometry.surfaces.length : 0,
  };

  const expected = buildEntityTypeFamilyCounts(diagnostics);
  const weights = {
    points: 1.0,
    lines: 1.1,
    polylines: 1.2,
    hatches: 1.3,
    texts: 0.8,
    surfaces: 1.4,
  };

  const familyCoverage = {};
  let weightedCoverage = 0;
  let weightedTotal = 0;

  Object.keys(weights).forEach((family) => {
    const expectedCount = Number(expected[family] || 0);
    const extractedCount = Number(extracted[family] || 0);
    const coverage = expectedCount > 0
      ? Math.max(0, Math.min(1, extractedCount / expectedCount))
      : (extractedCount > 0 ? 1 : null);
    familyCoverage[family] = {
      expected: expectedCount,
      extracted: extractedCount,
      coverage,
    };
    if (coverage !== null) {
      const w = weights[family];
      weightedCoverage += coverage * w;
      weightedTotal += w;
    }
  });

  const unresolvedRefs = Number(diagnostics?.references?.unresolvedXrefs?.length || 0)
    + Number(diagnostics?.references?.unresolvedBlockRefs?.length || 0)
    + Number(diagnostics?.references?.cyclicBlockRefs?.length || 0);
  const repairPenalty = parseRepair?.recovered ? 0.04 : 0;
  const modePenalty = requestedMode !== modeUsed ? 0.08 : 0;
  const referencePenalty = Math.min(0.22, unresolvedRefs * 0.01);

  const rawScore = weightedTotal > 0 ? (weightedCoverage / weightedTotal) : 0;
  const adjustedScore = Math.max(0, Math.min(1, rawScore - repairPenalty - modePenalty - referencePenalty));

  return {
    requestedMode,
    modeUsed,
    modeFallbackUsed: requestedMode !== modeUsed,
    score: Number((adjustedScore * 100).toFixed(2)),
    rawScore: Number((rawScore * 100).toFixed(2)),
    penalties: {
      repairPenalty: Number((repairPenalty * 100).toFixed(2)),
      modePenalty: Number((modePenalty * 100).toFixed(2)),
      referencePenalty: Number((referencePenalty * 100).toFixed(2)),
    },
    familyCoverage,
  };
}

function summarizeCadRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { rowCount: 0 };
  }

  const xs = rows.map((row) => Number(row.x)).filter(Number.isFinite);
  const ys = rows.map((row) => Number(row.y)).filter(Number.isFinite);
  const zs = rows.map((row) => Number(row.z)).filter(Number.isFinite);
  const detectedFromCrs = rows.find((row) => row.detectedFromCrs)?.detectedFromCrs || null;

  const getMinMax = (values) => {
    if (!values.length) return { min: null, max: null };
    let min = values[0];
    let max = values[0];
    for (const value of values) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
    return { min, max };
  };

  const xRange = getMinMax(xs);
  const yRange = getMinMax(ys);
  const zRange = getMinMax(zs);

  return {
    rowCount: rows.length,
    detectedFromCrs,
    bounds: {
      minX: xRange.min,
      maxX: xRange.max,
      minY: yRange.min,
      maxY: yRange.max,
      minZ: zRange.min,
      maxZ: zRange.max,
    },
  };
}

function buildCadReferenceWarnings(diagnostics) {
  const warnings = [];
  const unresolvedBlockRefs = Array.isArray(diagnostics?.references?.unresolvedBlockRefs)
    ? diagnostics.references.unresolvedBlockRefs
    : [];
  const unresolvedXrefs = Array.isArray(diagnostics?.references?.unresolvedXrefs)
    ? diagnostics.references.unresolvedXrefs
    : [];
  const cyclicBlockRefs = Array.isArray(diagnostics?.references?.cyclicBlockRefs)
    ? diagnostics.references.cyclicBlockRefs
    : [];
  const transformWarnings = Array.isArray(diagnostics?.resolution?.transformWarnings)
    ? diagnostics.resolution.transformWarnings
    : [];

  if (unresolvedBlockRefs.length > 0) {
    warnings.push(`Skipped ${unresolvedBlockRefs.length} CAD block reference${unresolvedBlockRefs.length === 1 ? '' : 's'} because the referenced block definition was missing.`);
  }
  if (unresolvedXrefs.length > 0) {
    warnings.push(`Detected ${unresolvedXrefs.length} unresolved XREF reference${unresolvedXrefs.length === 1 ? '' : 's'} after conversion. Bind or package XREFs before export for complete DWG/DXF import.`);
  }
  if (cyclicBlockRefs.length > 0) {
    warnings.push(`Detected ${cyclicBlockRefs.length} cyclic block reference${cyclicBlockRefs.length === 1 ? '' : 's'} and skipped recursive expansion to avoid infinite loops.`);
  }
  transformWarnings.forEach((warning) => warnings.push(warning));

  return warnings;
}

function shouldAllowDegradedDwgFallback() {
  const raw = String(process.env.CAD_ALLOW_DWG_DEGRADED_FALLBACK || '0').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'no';
}

function replaceTemplateTokens(template, vars) {
  return template.replace(/\{(inputPath|inputDir|inputFileName|outputDir|outputDxfPath|outputBaseName)\}/g, (_, key) => vars[key] || '');
}

async function runSpawnedCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timeoutId = setTimeout(() => {
      child.kill();
      reject(new Error(`DWG converter timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timeoutId);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr || stdout || `DWG converter exited with code ${code}.`));
    });
  });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runLibreDwgConverter(vars, timeoutMs) {
  const dwg2dxfPath = resolveDwg2DxfPath();
  if (!dwg2dxfPath) {
    throw new Error('dwg2dxf binary not found. Check DEFAULT_DWG2DXF_PATHS or set DWG2DXF_PATH env var.');
  }

  const defaultNeighborPath = path.join(vars.inputDir, `${vars.outputBaseName}.dxf`);
  const attempts = [
    { args: [vars.inputPath, vars.outputDxfPath], expected: vars.outputDxfPath },
    { args: ['-o', vars.outputDxfPath, vars.inputPath], expected: vars.outputDxfPath },
    { args: [vars.inputPath], expected: defaultNeighborPath },
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const result = await runSpawnedCommand(dwg2dxfPath, attempt.args, timeoutMs);
      if (await fileExists(attempt.expected)) {
        return { ...result, outputPath: attempt.expected };
      }
      if (isLikelyDxfData(result.stdout)) {
        return { ...result, outputPath: null };
      }
    } catch (err) {
      // Some files emit warnings or non-zero exits; still accept if output file exists.
      if (await fileExists(attempt.expected)) {
        return { stdout: '', stderr: err.message || '', outputPath: attempt.expected };
      }
      lastError = err;
    }
  }

  if (lastError) throw lastError;
  throw new Error('dwg2dxf completed but did not produce a readable DXF output.');
}

async function runCustomConverter(vars, timeoutMs) {
  const commandTemplate = process.env.DWG_CONVERTER_COMMAND;
  const command = replaceTemplateTokens(commandTemplate, vars);
  await execAsync(command, {
    timeout: timeoutMs,
    maxBuffer: MAX_COMMAND_OUTPUT,
    windowsHide: true,
  });
}

async function findFirstDxfFile(dirPath, preferredPath) {
  try {
    await fs.access(preferredPath);
    return preferredPath;
  } catch {
    // Search fallback below.
  }

  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFirstDxfFile(fullPath, preferredPath);
      if (nested) return nested;
      continue;
    }

    if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.dxf') {
      return fullPath;
    }
  }

  return null;
}

function buildConversionAttemptOrder(preferredMode = null) {
  const availableModes = getAvailableConverterModes();
  if (preferredMode) {
    return availableModes.includes(preferredMode) ? [preferredMode] : [];
  }

  // Prefer LibreDWG first for speed/cost, then custom fallback.
  const ordered = [];
  if (availableModes.includes('libredwg')) ordered.push('libredwg');
  if (availableModes.includes('custom')) ordered.push('custom');
  return ordered;
}

async function executeConversionMode(converterMode, vars, timeoutMs) {
  let searchDir = vars.outputDir;
  let preferredPath = vars.outputDxfPath;
  let converterStdout = '';

  if (converterMode === 'libredwg') {
    // LibreDWG CLI syntax differs across versions; run converter with fallbacks.
    const result = await runLibreDwgConverter(vars, timeoutMs);
    converterStdout = result?.stdout || '';
    if (result?.outputPath) {
      preferredPath = result.outputPath;
      searchDir = path.dirname(result.outputPath);
    }
  } else if (converterMode === 'custom') {
    await runCustomConverter(vars, timeoutMs);
  } else {
    throw new Error(`Unsupported converter mode: ${converterMode}`);
  }

  return { searchDir, preferredPath, converterStdout };
}

async function convertDwgBufferToDxfText(buffer, originalName, preferredMode = null) {
  const attemptOrder = buildConversionAttemptOrder(preferredMode);
  if (attemptOrder.length === 0) {
    const error = new Error(`DWG backend is installed but no converter is configured. ${buildConverterSetupHint()}`);
    error.statusCode = 501;
    throw error;
  }

  const timeoutMs = Number(process.env.DWG_CONVERTER_TIMEOUT_MS || 120000);
  const tempRoot = await fs.mkdtemp(path.join(tmpdir(), 'survey-cad-'));
  const baseName = `${getBaseName(originalName)}-${randomUUID()}`;
  const inputPath = path.join(tempRoot, `${baseName}.dwg`);
  const outputDir = path.join(tempRoot, 'converted');
  const outputDxfPath = path.join(outputDir, `${baseName}.dxf`);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(inputPath, buffer);

  const vars = {
    inputPath,
    inputDir: path.dirname(inputPath),
    inputFileName: path.basename(inputPath),
    outputDir,
    outputDxfPath,
    outputBaseName: baseName,
  };

  try {
    const conversionErrors = [];
    for (const converterMode of attemptOrder) {
      try {
        const { searchDir, preferredPath, converterStdout } = await executeConversionMode(converterMode, vars, timeoutMs);
        const convertedPath = await findFirstDxfFile(searchDir, preferredPath);
        if (!convertedPath) {
          // Some dwg2dxf builds can emit DXF to stdout; accept that as fallback.
          if (converterMode === 'libredwg' && isLikelyDxfData(converterStdout)) {
            return {
              dxfText: converterStdout,
              modeUsed: converterMode,
              attemptedModes: attemptOrder,
              attemptErrors: conversionErrors,
            };
          }
          throw new Error('The DWG converter finished without producing a DXF file.');
        }

        return {
          dxfText: await fs.readFile(convertedPath, 'utf8'),
          modeUsed: converterMode,
          attemptedModes: attemptOrder,
          attemptErrors: conversionErrors,
        };
      } catch (err) {
        conversionErrors.push(`${converterMode}: ${err.message || String(err)}`);
      }
    }

    throw new Error(`All DWG converter attempts failed. ${conversionErrors.join(' | ')}`);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

export function getCadBackendStatus() {
  const availableConverterModes = getAvailableConverterModes();
  const converterMode = getConfiguredConverterMode();
  const converterPath =
    converterMode === 'libredwg' ? resolveDwg2DxfPath() :
    null;
  return {
    ok: true,
    converterMode,
    availableConverterModes,
    dwgEnabled: converterMode !== 'none',
    converterPath,
    uploadLimitMb: Number(process.env.CAD_MAX_UPLOAD_MB || 100),
    setupHint: converterMode === 'none' ? buildConverterSetupHint() : null,
  };
}

function createNullBounds() {
  return {
    minX: null,
    maxX: null,
    minY: null,
    maxY: null,
    minZ: null,
    maxZ: null,
  };
}

function normalizeCadGeometry(geometry) {
  return {
    lines: Array.isArray(geometry?.lines) ? geometry.lines : [],
    polylines: Array.isArray(geometry?.polylines) ? geometry.polylines : [],
    texts: Array.isArray(geometry?.texts) ? geometry.texts : [],
    hatches: Array.isArray(geometry?.hatches) ? geometry.hatches : [],
    surfaces: Array.isArray(geometry?.surfaces) ? geometry.surfaces : [],
  };
}

function buildSceneIssues({ warnings = [], inspection = null, preScan = null, geometry = null }) {
  const issues = [];
  let issueSeq = 1;

  for (const warning of warnings) {
    issues.push({
      id: `warn-${issueSeq++}`,
      code: 'cad-warning',
      severity: 'warning',
      title: 'CAD warning',
      detail: String(warning || '').trim() || 'CAD warning generated during import.',
      entityRef: null,
    });
  }

  const validationNotifications = Array.isArray(geometry?.validation?.notifications)
    ? geometry.validation.notifications
    : [];
  for (const item of validationNotifications) {
    const severity = String(item?.severity || 'info').toLowerCase();
    issues.push({
      id: `validation-${issueSeq++}`,
      code: String(item?.code || 'cad-validation'),
      severity: severity === 'error' || severity === 'warning' ? severity : 'info',
      title: String(item?.message || item?.code || 'CAD validation').slice(0, 120),
      detail: String(item?.detail || item?.message || '').trim() || 'Validation notice emitted by CAD parser.',
      entityRef: null,
    });
  }

  const preScanSignals = Array.isArray(preScan?.signals) ? preScan.signals : [];
  for (const signal of preScanSignals) {
    const signalWeight = Number(signal?.weight || 0);
    const signalSeverity = signalWeight >= 12 ? 'warning' : 'info';
    issues.push({
      id: `prescan-${issueSeq++}`,
      code: String(signal?.code || 'cad-prescan-signal'),
      severity: signalSeverity,
      title: 'CAD pre-scan signal',
      detail: String(signal?.detail || signal?.code || 'CAD pre-scan signal detected.'),
      entityRef: null,
    });
  }

  if (inspection?.degradedFallback) {
    issues.push({
      id: `degraded-${issueSeq++}`,
      code: 'cad-degraded-fallback',
      severity: 'error',
      title: 'Degraded CAD fallback',
      detail: 'DWG conversion failed and degraded diagnostics-only fallback was returned.',
      entityRef: null,
    });
  }

  return issues;
}

function summarizeIssueSeverities(issues = []) {
  const buckets = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) {
    const severity = String(issue?.severity || 'info').toLowerCase();
    if (severity === 'error') buckets.error += 1;
    else if (severity === 'warning') buckets.warning += 1;
    else buckets.info += 1;
  }
  return buckets;
}

function computeSceneQualityScore({ issues = [], degradedFallback = false }) {
  const buckets = summarizeIssueSeverities(issues);
  const penalty = (buckets.error * 18) + (buckets.warning * 6) + (buckets.info * 2) + (degradedFallback ? 20 : 0);
  return Math.max(0, Math.min(100, 100 - penalty));
}

function buildCanonicalCadScene({ sourceFormat, originalName, rows, geometry, inspection, preScan, warnings }) {
  const normalizedGeometry = normalizeCadGeometry(geometry);
  const sourceBounds = {
    minX: Number.isFinite(inspection?.bounds?.minX) ? inspection.bounds.minX : null,
    maxX: Number.isFinite(inspection?.bounds?.maxX) ? inspection.bounds.maxX : null,
    minY: Number.isFinite(inspection?.bounds?.minY) ? inspection.bounds.minY : null,
    maxY: Number.isFinite(inspection?.bounds?.maxY) ? inspection.bounds.maxY : null,
    minZ: Number.isFinite(inspection?.bounds?.minZ) ? inspection.bounds.minZ : null,
    maxZ: Number.isFinite(inspection?.bounds?.maxZ) ? inspection.bounds.maxZ : null,
  };

  const issues = buildSceneIssues({ warnings, inspection, preScan, geometry });
  const severityBuckets = summarizeIssueSeverities(issues);
  const qualityScore = computeSceneQualityScore({ issues, degradedFallback: Boolean(inspection?.degradedFallback) });

  const sourceCrsCandidate = rows.find((row) => row?.sourceCrs)?.sourceCrs
    || rows.find((row) => row?.fromCrs)?.fromCrs
    || null;

  const knownLosses = issues
    .filter((item) => item.severity === 'error' || item.severity === 'warning')
    .map((item) => `${item.code}: ${item.detail}`)
    .slice(0, 30);

  return {
    sceneId: randomUUID(),
    createdAt: new Date().toISOString(),
    source: {
      fileName: originalName,
      fileHashSha256: inspection?.assembledHashSha256 || null,
      sourceFormat: String(sourceFormat || 'unknown'),
      processingRoute: String(inspection?.processingRoute || 'unknown'),
      converterModeUsed: inspection?.converterModeUsed || null,
      converterAttemptedModes: Array.isArray(inspection?.converterAttemptedModes) ? inspection.converterAttemptedModes : [],
      degradedFallback: Boolean(inspection?.degradedFallback),
    },
    georef: {
      sourceCrs: sourceCrsCandidate,
      detectedFromCrs: inspection?.detectedFromCrs || null,
      axisNormalized: false,
      transformConfidence: 'low',
      transformReason: '',
      boundsSource: sourceBounds,
      boundsWgs84: createNullBounds(),
    },
    entities: {
      points: Array.isArray(rows) ? rows : [],
      lines: normalizedGeometry.lines,
      polylines: normalizedGeometry.polylines,
      texts: normalizedGeometry.texts,
      hatches: normalizedGeometry.hatches,
      surfaces: normalizedGeometry.surfaces,
    },
    topology: {
      unresolvedXrefs: Array.isArray(inspection?.unresolvedXrefs) ? inspection.unresolvedXrefs : [],
      missingBlockRefs: Array.isArray(inspection?.missingBlockRefs) ? inspection.missingBlockRefs : [],
      cyclicBlockRefs: Array.isArray(inspection?.cyclicBlockRefs) ? inspection.cyclicBlockRefs : [],
      insertsExpanded: Number(inspection?.diagnostics?.resolution?.expandedInsertCount || 0),
    },
    diagnostics: {
      qualityScore,
      validationSummary: inspection?.validation || null,
      hatchSummary: inspection?.hatchSummary || null,
      issues,
      severityBuckets,
    },
    display: {
      layerSummary: inspection?.layerSummary || null,
      styleHints: {},
      lodHints2d: {},
      lodHints3d: {},
    },
    exportHints: {
      preferredExportFormat: 'dxf',
      knownLosses,
      roundtripSafe: !inspection?.degradedFallback && severityBuckets.error === 0,
    },
  };
}

export async function parseCadUpload({
  buffer,
  originalName,
  fileSizeBytes = 0,
  pointsOnly = false,
  strictExistingPointsOnly = true,
  processingMode = 'full',
  expectedFileHashFNV64 = '',
  assembledHashFNV64 = '',
  assembledHashSha256 = '',
  preflightFormatHint = 'unknown',
  preflightModeConfidence = 'low',
  preflightModeConfidenceReason = '',
  preScan = null,
}) {
  const ext = getFileExtension(originalName);
  if (!['.dxf', '.dwg'].includes(ext)) {
    const error = new Error(`Unsupported CAD file type: ${ext || 'unknown'}`);
    error.statusCode = 400;
    throw error;
  }

  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const resolvedFileHashSha256 = assembledHashSha256 || computeSha256Hex(Buffer.from(data));
  const resolvedFileHashFNV64 = assembledHashFNV64 || null;
  const options = { pointsOnly, strictExistingPointsOnly, returnPayload: true, processingMode };
  let rows;
  let geometry = null;
  let diagnostics = null;
  let warnings = [];
  let usedConverter = false;
  let processingRoute = 'client';
  let converterModeUsed = null;
  let converterAttemptedModes = [];
  let converterAttemptErrors = [];
  let preferredConverterMode = null;
  let degradedFallback = false;
  let parseRepair = null;
  const requestedProcessingMode = processingMode;
  let processingModeUsed = processingMode;
  let parseModeAttempts = [processingMode];
  let parseModeErrors = [];

  const availableConverterModes = getAvailableConverterModes();
  const preScanRecommendedEngine = preScan?.recommendedEngine || null;
  if (preScanRecommendedEngine && availableConverterModes.includes(preScanRecommendedEngine)) {
    preferredConverterMode = preScanRecommendedEngine;
  } else if (preScanRecommendedEngine && !availableConverterModes.includes(preScanRecommendedEngine)) {
    warnings.push(`Server pre-scan recommended engine ${preScanRecommendedEngine}, but it is not available in this runtime.`);
  }

  if (ext === '.dxf') {
    const parsedResult = parseCadTextWithModeRetry(Buffer.from(data).toString('utf8'), options, requestedProcessingMode, { sourceTag: 'direct-dxf' });
    const parsed = parsedResult.parsed;
    parseRepair = parsedResult.repair;
    processingModeUsed = parsedResult.modeUsed;
    parseModeAttempts = parsedResult.modeAttempts || parseModeAttempts;
    parseModeErrors = parsedResult.modeErrors || parseModeErrors;
    rows = parsed.rows;
    geometry = parsed.geometry || null;
    diagnostics = parsed.diagnostics || null;
    processingRoute = 'local-dxf';
  } else if (!isLikelyNativeDwgData(data) && isLikelyDxfData(data)) {
    const parsedResult = parseCadTextWithModeRetry(Buffer.from(data).toString('utf8'), options, requestedProcessingMode, { sourceTag: 'dwg-dxf-text' });
    const parsed = parsedResult.parsed;
    parseRepair = parsedResult.repair;
    processingModeUsed = parsedResult.modeUsed;
    parseModeAttempts = parsedResult.modeAttempts || parseModeAttempts;
    parseModeErrors = parsedResult.modeErrors || parseModeErrors;
    rows = parsed.rows;
    geometry = parsed.geometry || null;
    diagnostics = parsed.diagnostics || null;
    warnings = ['The uploaded .dwg file contained DXF text and was parsed without converter assistance.'];
    processingRoute = 'dwg-dxf-text';
  } else {
    try {
      const conversionResult = await convertDwgBufferToDxfText(Buffer.from(data), originalName, preferredConverterMode);
      const rawDxfText = conversionResult.dxfText;
      converterModeUsed = conversionResult.modeUsed;
      converterAttemptedModes = conversionResult.attemptedModes || [];
      converterAttemptErrors = conversionResult.attemptErrors || [];
      const parsedResult = parseCadTextWithModeRetry(rawDxfText, options, requestedProcessingMode, { sourceTag: 'dwg-converted' });
      const parsedDxf = parsedResult.parsed;
      parseRepair = parsedResult.repair;
      processingModeUsed = parsedResult.modeUsed;
      parseModeAttempts = parsedResult.modeAttempts || parseModeAttempts;
      parseModeErrors = parsedResult.modeErrors || parseModeErrors;
      rows = parsedDxf.rows;
      geometry = parsedDxf.geometry || null;
      diagnostics = parsedDxf.diagnostics || null;
      if (converterAttemptedModes.length > 1 && converterModeUsed && converterModeUsed !== converterAttemptedModes[0]) {
        const fallbackReason = converterAttemptErrors[0] || `Primary converter ${converterAttemptedModes[0]} failed.`;
        warnings.push(`CAD conversion fell back from ${converterAttemptedModes[0]} to ${converterModeUsed} for this file.`);
        warnings.push(`Fallback reason: ${fallbackReason}`);
        console.warn(`[CAD] converter fallback ${converterAttemptedModes[0]} -> ${converterModeUsed} for ${originalName}: ${fallbackReason}`);
      }
      usedConverter = true;
      processingRoute = converterModeUsed ? `dwg-converted-${converterModeUsed}` : 'dwg-converted';
    } catch (err) {
      if (!shouldAllowDegradedDwgFallback()) {
        throw err;
      }

      degradedFallback = true;
      rows = [];
      geometry = {
        lines: [],
        polylines: [],
        texts: [],
        surfaces: [],
        layerSummary: null,
        validation: {
          notifications: [
            {
              severity: 'warning',
              code: 'cad-conversion-degraded-fallback',
              message: 'DWG conversion failed. Returned degraded diagnostics-only response so the workflow can continue.',
            },
          ],
        },
        notifications: [],
        repairs: null,
        localPreview: false,
      };
      diagnostics = {
        references: {
          unresolvedBlockRefs: [],
          unresolvedXrefs: [],
          cyclicBlockRefs: [],
        },
        resolution: {
          expandedInsertCount: 0,
          expandedEntityCount: 0,
          nestedInsertDepthMax: 0,
          transformWarnings: [],
        },
      };
      warnings.push(`DWG conversion failed and degraded fallback was applied: ${err.message || String(err)}`);
      warnings.push('No CAD entities were extracted from this file. Run manual review or alternate converter workflow.');
      converterAttemptErrors = [err.message || String(err)];
      processingRoute = 'dwg-conversion-failed-degraded';
    }
  }

  if (processingModeUsed === 'preview') {
    warnings.push('Preview mode was used. Output may omit some heavy entities until a full/recovery pass is run.');
  }
  if (processingModeUsed === 'recovery') {
    warnings.push('Recovery mode was used due to file complexity. Review diagnostics and unresolved entities before relying on full fidelity.');
  }
  if (pointsOnly) {
    warnings.push('Points-only extraction was used. Non-point CAD entities can be skipped in this output.');
  }

  warnings = [...warnings, ...buildCadReferenceWarnings(diagnostics)];

  const inspection = {
    fileName: originalName,
    extension: ext,
    processingMode: processingModeUsed,
    requestedProcessingMode,
    preflightFormatHint,
    preflightModeConfidence,
    preflightModeConfidenceReason,
    preScan,
    fileSizeBytes,
    expectedFileHashFNV64: expectedFileHashFNV64 || null,
    expectedFileHashSha256: null,
    assembledHashFNV64: resolvedFileHashFNV64,
    assembledHashSha256: resolvedFileHashSha256 || null,
    fileHashAlgorithm: expectedFileHashFNV64 ? 'fnv1a64' : 'none',
    integrityVerified: Boolean(expectedFileHashFNV64 && resolvedFileHashFNV64 && String(expectedFileHashFNV64).toLowerCase() === String(resolvedFileHashFNV64).toLowerCase()),
    nativeDwg: ext === '.dwg' && isLikelyNativeDwgData(data),
    usedConverter,
    preferredConverterMode,
    converterModeUsed,
    converterAttemptedModes,
    converterAttemptErrors,
    parseModeAttempts,
    parseModeErrors,
    parseRepair,
    degradedFallback,
    processingRoute,
    diagnostics,
    detectedFromCrs: diagnostics?.detectedFromCrs || rows.find((row) => row?.detectedFromCrs)?.detectedFromCrs || null,
    validation: geometry?.validation || diagnostics?.validation || null,
    layerSummary: geometry?.layerSummary || diagnostics?.layerSummary || null,
    hatchSummary: geometry?.hatchSummary || null,
    hatchDiagnosticsSummary: geometry?.hatchSummary?.diagnostics || {
      total: Array.isArray(geometry?.hatchDiagnostics) ? geometry.hatchDiagnostics.length : 0,
      warnings: Array.isArray(geometry?.hatchDiagnostics)
        ? geometry.hatchDiagnostics.filter((diag) => String(diag?.severity || '').toLowerCase() === 'warning').length
        : 0,
      errors: Array.isArray(geometry?.hatchDiagnostics)
        ? geometry.hatchDiagnostics.filter((diag) => String(diag?.severity || '').toLowerCase() === 'error').length
        : 0,
    },
    hatchRenderHints: geometry?.renderHints?.hatch || null,
    repairs: geometry?.repairs || diagnostics?.repairs || null,
    performanceProfile: analyzeGeometryDensity({ rows, geometry }, fileSizeBytes),
    fidelityProfile: computeCadFidelityProfile({
      geometry,
      rows,
      diagnostics,
      requestedMode: requestedProcessingMode,
      modeUsed: processingModeUsed,
      parseRepair,
    }),
    unresolvedXrefs: diagnostics?.references?.unresolvedXrefs || [],
    missingBlockRefs: diagnostics?.references?.unresolvedBlockRefs || [],
    cyclicBlockRefs: diagnostics?.references?.cyclicBlockRefs || [],
    ...summarizeCadRows(rows),
  };

  if (geometry && typeof geometry === 'object') {
    geometry.performanceProfile = inspection.performanceProfile;
    geometry.fidelityProfile = inspection.fidelityProfile;
    geometry.renderHints = {
      ...(geometry.renderHints || {}),
      performanceProfile: inspection.performanceProfile,
      fidelityProfile: inspection.fidelityProfile,
    };
  }

  const sourceFormat = ext.slice(1);
  const scene = buildCanonicalCadScene({
    sourceFormat,
    originalName,
    rows,
    geometry,
    inspection,
    preScan,
    warnings,
  });

  return {
    sceneVersion: '1.0',
    scene,
    sourceFormat,
    rows,
    geometry,
    diagnostics,
    warnings,
    inspection,
  };
}