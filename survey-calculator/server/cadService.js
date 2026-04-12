import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { exec as execCallback, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { parseDxfTextContent, isLikelyDxfData, isLikelyNativeDwgData } from '../src/utils/cadShared.js';

const execAsync = promisify(execCallback);
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

function getConfiguredConverterMode() {
  // LibreDWG (dwg2dxf) is preferred — free, open-source, installed in Docker
  if (resolveDwg2DxfPath()) return 'libredwg';
  // ODA is fallback for Windows local dev
  if (resolveOdaConverterPath()) return 'oda';
  if (process.env.DWG_CONVERTER_COMMAND) return 'custom';
  return 'none';
}

function buildConverterSetupHint() {
  return 'No DWG converter found. In production (Docker) LibreDWG (dwg2dxf) is installed automatically. For local Windows dev, install ODA File Converter or set ODA_FILE_CONVERTER_PATH.';
}

function summarizeCadRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { rowCount: 0 };
  }

  const xs = rows.map((row) => Number(row.x)).filter(Number.isFinite);
  const ys = rows.map((row) => Number(row.y)).filter(Number.isFinite);
  const zs = rows.map((row) => Number(row.z)).filter(Number.isFinite);
  const detectedFromCrs = rows.find((row) => row.detectedFromCrs)?.detectedFromCrs || null;

  return {
    rowCount: rows.length,
    detectedFromCrs,
    bounds: {
      minX: xs.length ? Math.min(...xs) : null,
      maxX: xs.length ? Math.max(...xs) : null,
      minY: ys.length ? Math.min(...ys) : null,
      maxY: ys.length ? Math.max(...ys) : null,
      minZ: zs.length ? Math.min(...zs) : null,
      maxZ: zs.length ? Math.max(...zs) : null,
    },
  };
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

async function runOdaConverter(vars, timeoutMs) {
  const converterPath = resolveOdaConverterPath();
  if (!converterPath) {
    throw new Error(buildConverterSetupHint());
  }
  const args = [
    vars.inputDir,
    vars.outputDir,
    process.env.ODA_OUTPUT_VERSION || 'ACAD2018',
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

async function convertDwgBufferToDxfText(buffer, originalName) {
  const converterMode = getConfiguredConverterMode();
  if (converterMode === 'none') {
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
    let searchDir = outputDir;
    let preferredPath = outputDxfPath;
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
      await runOdaConverter(vars, timeoutMs);
    } else {
      await runCustomConverter(vars, timeoutMs);
    }

    const convertedPath = await findFirstDxfFile(searchDir, preferredPath);
    if (!convertedPath) {
      // Some dwg2dxf builds can emit DXF to stdout; accept that as fallback.
      if (converterMode === 'libredwg' && isLikelyDxfData(converterStdout)) {
        return converterStdout;
      }
      throw new Error('The DWG converter finished without producing a DXF file.');
    }

    return await fs.readFile(convertedPath, 'utf8');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

export function getCadBackendStatus() {
  const converterMode = getConfiguredConverterMode();
  const converterPath =
    converterMode === 'libredwg' ? resolveDwg2DxfPath() :
    converterMode === 'oda' ? resolveOdaConverterPath() :
    null;
  return {
    ok: true,
    converterMode,
    dwgEnabled: converterMode !== 'none',
    converterPath,
    uploadLimitMb: Number(process.env.CAD_MAX_UPLOAD_MB || 100),
    setupHint: buildConverterSetupHint(),
  };
}

export async function parseCadUpload({ buffer, originalName, fileSizeBytes = 0, pointsOnly = false }) {
  const ext = getFileExtension(originalName);
  if (!['.dxf', '.dwg'].includes(ext)) {
    const error = new Error(`Unsupported CAD file type: ${ext || 'unknown'}`);
    error.statusCode = 400;
    throw error;
  }

  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const options = { pointsOnly, returnPayload: true };
  let rows;
  let geometry = null;
  let diagnostics = null;
  let warnings = [];
  let usedConverter = false;
  let processingRoute = 'client';

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
    const dxfText = await convertDwgBufferToDxfText(Buffer.from(data), originalName);
    const parsed = parseDxfTextContent(dxfText, options);
    rows = parsed.rows;
    geometry = parsed.geometry || null;
    diagnostics = parsed.diagnostics || null;
    usedConverter = true;
    processingRoute = 'dwg-converted';
  }

  return {
    sourceFormat: ext.slice(1),
    rows,
    geometry,
    diagnostics,
    warnings,
    inspection: {
      fileName: originalName,
      extension: ext,
      fileSizeBytes,
      nativeDwg: ext === '.dwg' && isLikelyNativeDwgData(data),
      usedConverter,
      processingRoute,
      diagnostics,
      ...summarizeCadRows(rows),
    },
  };
}