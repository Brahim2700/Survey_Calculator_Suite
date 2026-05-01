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
const DEFAULT_ODA_PATHS = [
  'C:\\Program Files\\ODA\\ODAFileConverter 27.1.0\\ODAFileConverter.exe',
  'C:\\Program Files\\ODA\\ODAFileConverter.exe',
  'C:\\Program Files (x86)\\ODA\\ODAFileConverter.exe',
];

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

function resolveOdaConverterPath() {
  const configuredPath = process.env.ODA_FILE_CONVERTER_PATH;
  if (configuredPath && existsSync(configuredPath)) {
    return configuredPath;
  }

  return DEFAULT_ODA_PATHS.find((candidate) => existsSync(candidate)) || null;
}

function getAvailableConverterModes() {
  const modes = [];
  if (resolveDwg2DxfPath()) modes.push('libredwg');
  if (resolveOdaConverterPath()) modes.push('oda');
  if (process.env.DWG_CONVERTER_COMMAND) modes.push('custom');
  return modes;
}

function getConfiguredConverterMode() {
  return getAvailableConverterModes()[0] || 'none';
}

function buildConverterSetupHint() {
  return 'No DWG converter found. In production (Docker) LibreDWG (dwg2dxf) is installed automatically. For local Windows dev, install ODA File Converter or set ODA_FILE_CONVERTER_PATH.';
}

/**
 * Normalize DXF text so there is exactly one well-formed EOF marker at the end.
 * Some DWG converters (ODA, LibreDWG) produce truncated output (missing EOF) or
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

async function runOdaConverter(vars, timeoutMs, version = null) {
  const converterPath = resolveOdaConverterPath();
  if (!converterPath) {
    throw new Error(buildConverterSetupHint());
  }
  const outputVersion = version || process.env.ODA_OUTPUT_VERSION || 'ACAD2018';
  const args = [
    vars.inputDir,
    vars.outputDir,
    outputVersion,
    'DXF',
    process.env.ODA_RECURSIVE === '1' ? '1' : '0',
    process.env.ODA_AUDIT === '1' ? '1' : '0',
    vars.inputFileName,
  ];
  await runSpawnedCommand(converterPath, args, timeoutMs);
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

  // Prefer LibreDWG first for speed/cost, then ODA fallback for advanced files.
  const ordered = [];
  if (availableModes.includes('libredwg')) ordered.push('libredwg');
  if (availableModes.includes('oda')) ordered.push('oda');
  if (availableModes.includes('custom')) ordered.push('custom');
  return ordered;
}

async function executeConversionMode(converterMode, vars, timeoutMs, inputSizeBytes) {
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
  } else if (converterMode === 'oda') {
    // Try primary ODA format; if output is suspiciously small, retry older versions.
    const ODA_FALLBACK_VERSIONS = ['ACAD2018', 'ACAD2010', 'ACAD2000'];
    let odaSucceeded = false;
    for (const odaVersion of ODA_FALLBACK_VERSIONS) {
      await fs.rm(vars.outputDir, { recursive: true, force: true });
      await fs.mkdir(vars.outputDir, { recursive: true });
      try {
        await runOdaConverter(vars, timeoutMs, odaVersion);
      } catch {
        // ODA sometimes exits non-zero but still writes a usable DXF.
      }
      const candidatePath = await findFirstDxfFile(vars.outputDir, vars.outputDxfPath);
      if (candidatePath) {
        const stat = await fs.stat(candidatePath).catch(() => null);
        const minAcceptableBytes = Math.max(1024, inputSizeBytes * 0.02);
        if (stat && stat.size >= minAcceptableBytes) {
          odaSucceeded = true;
          break;
        }
      }
    }
    if (!odaSucceeded) {
      throw new Error('ODA converter failed to produce a usable DXF output for all attempted format versions (ACAD2018, ACAD2010, ACAD2000). The DWG file may contain unsupported entities.');
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
        const { searchDir, preferredPath, converterStdout } = await executeConversionMode(converterMode, vars, timeoutMs, buffer.length);
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
    converterMode === 'oda' ? resolveOdaConverterPath() :
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

export async function parseCadUpload({
  buffer,
  originalName,
  fileSizeBytes = 0,
  pointsOnly = false,
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
  const options = { pointsOnly, returnPayload: true };
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

  const availableConverterModes = getAvailableConverterModes();
  const preScanRecommendedEngine = preScan?.recommendedEngine || null;
  if (preScanRecommendedEngine && availableConverterModes.includes(preScanRecommendedEngine)) {
    preferredConverterMode = preScanRecommendedEngine;
  } else if (preScanRecommendedEngine && !availableConverterModes.includes(preScanRecommendedEngine)) {
    warnings.push(`Server pre-scan recommended engine ${preScanRecommendedEngine}, but it is not available in this runtime.`);
  }

  if (ext === '.dxf') {
    const parsed = parseDxfTextContent(Buffer.from(data).toString('utf8'), options);
    rows = parsed.rows;
    geometry = parsed.geometry || null;
    diagnostics = parsed.diagnostics || null;
    processingRoute = 'local-dxf';
  } else if (!isLikelyNativeDwgData(data) && isLikelyDxfData(data)) {
    const parsed = parseDxfTextContent(Buffer.from(data).toString('utf8'), options);
    rows = parsed.rows;
    geometry = parsed.geometry || null;
    diagnostics = parsed.diagnostics || null;
    warnings = ['The uploaded .dwg file contained DXF text and was parsed without converter assistance.'];
    processingRoute = 'dwg-dxf-text';
  } else {
    const conversionResult = await convertDwgBufferToDxfText(Buffer.from(data), originalName, preferredConverterMode);
    const rawDxfText = conversionResult.dxfText;
    converterModeUsed = conversionResult.modeUsed;
    converterAttemptedModes = conversionResult.attemptedModes || [];
    converterAttemptErrors = conversionResult.attemptErrors || [];
    // Pre-process DXF text: ensure there is exactly one EOF marker and nothing after it.
    // Some converters produce extra content after EOF or omit it entirely.
    const dxfText = sanitizeDxfEof(rawDxfText);
    const dxfPatched = dxfText !== rawDxfText;
    let parsedDxf;
    try {
      parsedDxf = parseDxfTextContent(dxfText, options);
    } catch (err) {
      // Last-resort: if still failing due to an EOF-related parse error, try once more
      // without the EOF patch (original text) in case our edit broke something.
      const isEof = /unexpected end|eof|end of input|after EOF/i.test(String(err.message || err));
      if (!isEof) throw err;
      throw new Error(`Failed to parse DXF converted from DWG: ${err.message}`);
    }
    rows = parsedDxf.rows;
    geometry = parsedDxf.geometry || null;
    diagnostics = parsedDxf.diagnostics || null;
    if (dxfPatched) {
      warnings = ['DXF output from converter was malformed (missing or extra content after EOF). File was recovered automatically.'];
    }
    if (converterAttemptedModes.length > 1 && converterModeUsed && converterModeUsed !== converterAttemptedModes[0]) {
      const fallbackReason = converterAttemptErrors[0] || `Primary converter ${converterAttemptedModes[0]} failed.`;
      warnings.push(`CAD conversion fell back from ${converterAttemptedModes[0]} to ${converterModeUsed} for this file.`);
      warnings.push(`Fallback reason: ${fallbackReason}`);
      console.warn(`[CAD] converter fallback ${converterAttemptedModes[0]} -> ${converterModeUsed} for ${originalName}: ${fallbackReason}`);
    }
    usedConverter = true;
    processingRoute = converterModeUsed ? `dwg-converted-${converterModeUsed}` : 'dwg-converted';
  }

  if (processingMode === 'preview') {
    warnings.push('Preview mode was used. Output may omit some heavy entities until a full/recovery pass is run.');
  }
  if (processingMode === 'recovery') {
    warnings.push('Recovery mode was used due to file complexity. Review diagnostics and unresolved entities before relying on full fidelity.');
  }
  if (pointsOnly) {
    warnings.push('Points-only extraction was used. Non-point CAD entities can be skipped in this output.');
  }

  warnings = [...warnings, ...buildCadReferenceWarnings(diagnostics)];

  return {
    sourceFormat: ext.slice(1),
    rows,
    geometry,
    diagnostics,
    warnings,
    inspection: {
      fileName: originalName,
      extension: ext,
      processingMode,
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
      processingRoute,
      diagnostics,
      detectedFromCrs: diagnostics?.detectedFromCrs || rows.find((row) => row?.detectedFromCrs)?.detectedFromCrs || null,
      validation: geometry?.validation || diagnostics?.validation || null,
      layerSummary: geometry?.layerSummary || diagnostics?.layerSummary || null,
      repairs: geometry?.repairs || diagnostics?.repairs || null,
      unresolvedXrefs: diagnostics?.references?.unresolvedXrefs || [],
      missingBlockRefs: diagnostics?.references?.unresolvedBlockRefs || [],
      cyclicBlockRefs: diagnostics?.references?.cyclicBlockRefs || [],
      ...summarizeCadRows(rows),
    },
  };
}