import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { getCadBackendStatus, parseCadUpload } from './cadService.js';
import { prescanCadBuffer } from './cadPrescanService.js';

const app = express();
const port = Number(process.env.PORT || process.env.CAD_API_PORT || 4000);
const uploadLimitMb = Number(process.env.CAD_MAX_UPLOAD_MB || 100);
const allowedOrigins = String(process.env.CAD_ALLOWED_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: uploadLimitMb * 1024 * 1024 },
});
const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: uploadLimitMb * 1024 * 1024 },
});
const chunkRootDir = path.join(tmpdir(), 'survey-cad-chunks');
const progressiveCadJobs = new Map();
const PROGRESSIVE_JOB_MAX_AGE_MS = 20 * 60 * 1000;
const UPLOAD_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createProgressiveJob({ buffer, parseArgs, preScan, baseMode }) {
  const jobId = randomUUID();
  const job = {
    id: jobId,
    status: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    baseMode,
    targetMode: 'full',
    payload: null,
    error: null,
  };
  progressiveCadJobs.set(jobId, job);

  setImmediate(async () => {
    const current = progressiveCadJobs.get(jobId);
    if (!current) return;
    current.status = 'processing';
    current.updatedAt = Date.now();
    try {
      const fullResult = await parseCadUpload({
        ...parseArgs,
        buffer,
        pointsOnly: false,
        processingMode: 'full',
      });
      current.payload = normalizeCadParseResponse(fullResult, preScan || null);
      current.status = 'ready';
      current.updatedAt = Date.now();
    } catch (err) {
      current.status = 'error';
      current.error = err?.message || 'Progressive CAD refinement failed.';
      current.updatedAt = Date.now();
    }
  });

  return jobId;
}

function withProgressiveMetadata(payload, jobId, baseMode) {
  if (!jobId) return payload;
  return {
    ...payload,
    progressive: {
      jobId,
      status: 'queued',
      baseMode,
      targetMode: 'full',
      pollPath: `/api/cad/refine/${jobId}`,
    },
  };
}

async function ensureChunkRootDir() {
  await fs.mkdir(chunkRootDir, { recursive: true });
}

function parseIntegerOrNull(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

async function cleanupUploadDir(uploadId) {
  const uploadDir = path.join(chunkRootDir, uploadId);
  await fs.rm(uploadDir, { recursive: true, force: true });
}

async function readChunkMeta(uploadId) {
  const uploadDir = path.join(chunkRootDir, uploadId);
  const metaPath = path.join(uploadDir, 'meta.json');
  const raw = await fs.readFile(metaPath, 'utf8');
  return { uploadDir, metaPath, meta: JSON.parse(raw) };
}

async function writeChunkMeta(uploadId, meta) {
  const uploadDir = path.join(chunkRootDir, uploadId);
  await fs.mkdir(uploadDir, { recursive: true });
  const metaPath = path.join(uploadDir, 'meta.json');
  await fs.writeFile(metaPath, JSON.stringify(meta), 'utf8');
}

async function assembleChunksToFile(uploadDir, totalChunks, outputPath) {
  await fs.rm(outputPath, { force: true });

  try {
    for (let i = 0; i < totalChunks; i += 1) {
      const partPath = path.join(uploadDir, `${i}.part`);
      await fs.access(partPath);

      const readStream = createReadStream(partPath);
      const writeStream = createWriteStream(outputPath, { flags: i === 0 ? 'w' : 'a' });
      await pipeline(readStream, writeStream);
    }
  } catch (err) {
    await fs.rm(outputPath, { force: true });
    throw err;
  }
}

async function hashFileSha256(filePath) {
  const hash = createHash('sha256');
  const rs = createReadStream(filePath);
  for await (const chunk of rs) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function hashesEqualHex(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

const FNV64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const FNV64_MASK = 0xffffffffffffffffn;

function fnv1a64Update(hash, bytes) {
  let next = hash;
  for (let i = 0; i < bytes.length; i += 1) {
    next ^= BigInt(bytes[i]);
    next = (next * FNV64_PRIME) & FNV64_MASK;
  }
  return next;
}

function toFNV64Hex(hash) {
  return hash.toString(16).padStart(16, '0');
}

async function hashFileFNV64(filePath) {
  let hash = FNV64_OFFSET_BASIS;
  const rs = createReadStream(filePath);
  for await (const chunk of rs) {
    hash = fnv1a64Update(hash, chunk);
  }
  return toFNV64Hex(hash);
}

const PROCESSING_MODE_RANK = {
  full: 0,
  preview: 1,
  recovery: 2,
};

function mergeProcessingMode(clientMode, prescanMode) {
  const clientRank = PROCESSING_MODE_RANK[clientMode] ?? 0;
  const prescanRank = PROCESSING_MODE_RANK[prescanMode] ?? 0;
  return clientRank >= prescanRank ? clientMode : prescanMode;
}

function buildFallbackSceneFromLegacy(payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const geometry = payload?.geometry || {};
  const sourceFormat = String(payload?.sourceFormat || 'unknown');
  const inspection = payload?.inspection || {};

  return {
    sceneId: `legacy-${Date.now()}`,
    createdAt: new Date().toISOString(),
    source: {
      fileName: String(inspection?.fileName || ''),
      fileHashSha256: inspection?.assembledHashSha256 || null,
      sourceFormat,
      processingRoute: String(inspection?.processingRoute || 'unknown'),
      converterModeUsed: inspection?.converterModeUsed || null,
      converterAttemptedModes: Array.isArray(inspection?.converterAttemptedModes) ? inspection.converterAttemptedModes : [],
      degradedFallback: Boolean(inspection?.degradedFallback),
    },
    georef: {
      sourceCrs: null,
      detectedFromCrs: inspection?.detectedFromCrs || null,
      axisNormalized: false,
      transformConfidence: 'low',
      transformReason: '',
      boundsSource: {
        minX: Number.isFinite(inspection?.bounds?.minX) ? inspection.bounds.minX : null,
        maxX: Number.isFinite(inspection?.bounds?.maxX) ? inspection.bounds.maxX : null,
        minY: Number.isFinite(inspection?.bounds?.minY) ? inspection.bounds.minY : null,
        maxY: Number.isFinite(inspection?.bounds?.maxY) ? inspection.bounds.maxY : null,
        minZ: Number.isFinite(inspection?.bounds?.minZ) ? inspection.bounds.minZ : null,
        maxZ: Number.isFinite(inspection?.bounds?.maxZ) ? inspection.bounds.maxZ : null,
      },
      boundsWgs84: { minX: null, maxX: null, minY: null, maxY: null, minZ: null, maxZ: null },
    },
    entities: {
      points: rows,
      lines: Array.isArray(geometry?.lines) ? geometry.lines : [],
      polylines: Array.isArray(geometry?.polylines) ? geometry.polylines : [],
      texts: Array.isArray(geometry?.texts) ? geometry.texts : [],
      hatches: Array.isArray(geometry?.hatches) ? geometry.hatches : [],
      surfaces: Array.isArray(geometry?.surfaces) ? geometry.surfaces : [],
    },
    topology: {
      unresolvedXrefs: Array.isArray(inspection?.unresolvedXrefs) ? inspection.unresolvedXrefs : [],
      missingBlockRefs: Array.isArray(inspection?.missingBlockRefs) ? inspection.missingBlockRefs : [],
      cyclicBlockRefs: Array.isArray(inspection?.cyclicBlockRefs) ? inspection.cyclicBlockRefs : [],
      insertsExpanded: 0,
    },
    diagnostics: {
      qualityScore: 0,
      validationSummary: inspection?.validation || null,
      hatchSummary: inspection?.hatchSummary || null,
      issues: [],
      severityBuckets: { error: 0, warning: 0, info: 0 },
    },
    display: {
      layerSummary: inspection?.layerSummary || null,
      styleHints: {},
      lodHints2d: {},
      lodHints3d: {},
    },
    exportHints: {
      preferredExportFormat: 'dxf',
      knownLosses: [],
      roundtripSafe: !inspection?.degradedFallback,
    },
  };
}

function normalizeCadParseResponse(payload, preScan = null) {
  const normalized = {
    ...payload,
    rows: Array.isArray(payload?.rows) ? payload.rows : [],
    geometry: payload?.geometry || { lines: [], polylines: [], texts: [], hatches: [], surfaces: [] },
    sourceFormat: String(payload?.sourceFormat || 'unknown'),
    warnings: Array.isArray(payload?.warnings) ? payload.warnings : [],
    inspection: payload?.inspection || null,
    preScan: preScan || payload?.preScan || null,
    sceneVersion: String(payload?.sceneVersion || '1.0'),
    scene: payload?.scene || buildFallbackSceneFromLegacy(payload),
  };

  return normalized;
}

app.use(helmet());

app.use(cors({
  origin(origin, callback) {
    // When no origins are configured, only allow requests with no origin (same-origin / server-to-server).
    // Set CAD_ALLOWED_ORIGINS to explicitly permit browser origins.
    if (!origin) {
      callback(null, true);
      return;
    }
    if (allowedOrigins.length > 0 && allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`Origin not allowed by CAD API CORS policy: ${origin}`));
  },
}));

const parseRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many CAD parse requests. Please wait before retrying.' },
});

const uploadRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many upload requests. Please wait before retrying.' },
});

const generalRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

app.get('/api/cad/health', generalRateLimit, (_req, res) => {
  res.json(getCadBackendStatus());
});

app.get('/api/cad/refine/:jobId', generalRateLimit, (req, res) => {
  const jobId = String(req.params?.jobId || '').trim();
  const job = progressiveCadJobs.get(jobId);
  if (!job) {
    res.status(404).json({ status: 'missing', message: 'Progressive CAD job not found or expired.' });
    return;
  }

  if (job.status === 'ready') {
    res.json({
      status: 'ready',
      payload: job.payload,
    });
    return;
  }

  if (job.status === 'error') {
    res.json({
      status: 'error',
      message: job.error || 'Progressive CAD refinement failed.',
    });
    return;
  }

  res.status(202).json({
    status: job.status,
    baseMode: job.baseMode,
    targetMode: job.targetMode,
  });
});

app.post('/api/cad/prescan', uploadRateLimit, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ message: 'No CAD file was uploaded for pre-scan.' });
      return;
    }

    const result = prescanCadBuffer({
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      fileSizeBytes: req.file.size,
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message || 'CAD pre-scan failed.' });
  }
});

app.post('/api/cad/upload/chunk', uploadRateLimit, chunkUpload.single('chunk'), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ message: 'No chunk data was uploaded.' });
      return;
    }

    await ensureChunkRootDir();

    const uploadId = String(req.body?.uploadId || '').trim();
    const fileName = String(req.body?.fileName || '').trim();
    const chunkIndex = parseIntegerOrNull(req.body?.chunkIndex);
    const totalChunks = parseIntegerOrNull(req.body?.totalChunks);

    if (!UPLOAD_ID_REGEX.test(uploadId)) {
      res.status(400).json({ message: 'Invalid uploadId format.' });
      return;
    }

    if (!uploadId || !fileName || chunkIndex === null || totalChunks === null || totalChunks <= 0 || chunkIndex < 0 || chunkIndex >= totalChunks) {
      res.status(400).json({ message: 'Invalid chunk metadata.' });
      return;
    }

    const uploadDir = path.join(chunkRootDir, uploadId);
    await fs.mkdir(uploadDir, { recursive: true });

    const { meta } = await (async () => {
      try {
        return await readChunkMeta(uploadId);
      } catch {
        const newMeta = {
          uploadId,
          fileName,
          totalChunks,
          createdAt: Date.now(),
          received: {},
          pointsOnly: false,
        };
        await writeChunkMeta(uploadId, newMeta);
        return { meta: newMeta };
      }
    })();

    if (meta.fileName !== fileName || meta.totalChunks !== totalChunks) {
      res.status(400).json({ message: 'Chunk metadata mismatch for existing upload session.' });
      return;
    }

    const chunkPath = path.join(uploadDir, `${chunkIndex}.part`);
    await fs.writeFile(chunkPath, req.file.buffer);
    meta.received[String(chunkIndex)] = req.file.size;
    await writeChunkMeta(uploadId, meta);

    const receivedChunks = Object.keys(meta.received).length;
    res.json({
      ok: true,
      uploadId,
      receivedChunks,
      totalChunks,
      complete: receivedChunks === totalChunks,
    });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Chunk upload failed.' });
  }
});

app.post('/api/cad/upload/complete', uploadRateLimit, express.json({ limit: '1mb' }), async (req, res) => {
  const uploadId = String(req.body?.uploadId || '').trim();
  const fileName = String(req.body?.fileName || '').trim();
  const pointsOnly = String(req.body?.pointsOnly || '').toLowerCase() === 'true';
  const strictExistingPointsOnly = String(req.body?.strictExistingPointsOnly || '').toLowerCase() !== 'false';
  const processingMode = String(req.body?.processingMode || 'full').trim() || 'full';
  const expectedFileHashFNV64 = String(req.body?.expectedFileHashFNV64 || '').trim();
  const preflightFormatHint = String(req.body?.preflightFormatHint || 'unknown').trim() || 'unknown';
  const preflightModeConfidence = String(req.body?.preflightModeConfidence || 'low').trim() || 'low';
  const preflightModeConfidenceReason = String(req.body?.preflightModeConfidenceReason || '').trim();

  if (!UPLOAD_ID_REGEX.test(uploadId)) {
    res.status(400).json({ message: 'Invalid uploadId format.' });
    return;
  }

  if (!uploadId || !fileName) {
    res.status(400).json({ message: 'Missing upload completion metadata.' });
    return;
  }

  try {
    const { uploadDir, meta } = await readChunkMeta(uploadId);
    if (meta.fileName !== fileName) {
      res.status(400).json({ message: 'Upload completion metadata mismatch.' });
      return;
    }

    const expected = Number(meta.totalChunks);
    const assembledPath = path.join(uploadDir, '__assembled.upload');
    await assembleChunksToFile(uploadDir, expected, assembledPath);
    const assembledHashFNV64 = await hashFileFNV64(assembledPath);
    const assembledHashSha256 = await hashFileSha256(assembledPath);

    if (expectedFileHashFNV64 && !hashesEqualHex(assembledHashFNV64, expectedFileHashFNV64)) {
      const mismatch = new Error('Chunk integrity check failed: assembled file hash does not match client hash.');
      mismatch.statusCode = 409;
      throw mismatch;
    }

    const combined = await fs.readFile(assembledPath);
    const preScan = prescanCadBuffer({
      buffer: combined,
      originalName: fileName,
      fileSizeBytes: combined.length,
    });
    const effectiveProcessingMode = mergeProcessingMode(processingMode, preScan.recommendedMode);

    const parseArgs = {
      buffer: combined,
      originalName: fileName,
      fileSizeBytes: combined.length,
      strictExistingPointsOnly,
      expectedFileHashFNV64,
      assembledHashFNV64,
      assembledHashSha256,
      preflightFormatHint,
      preflightModeConfidence,
      preflightModeConfidenceReason,
      preScan,
    };

    const result = await parseCadUpload({
      ...parseArgs,
      pointsOnly,
      processingMode: effectiveProcessingMode,
    });

    const shouldScheduleProgressive = !pointsOnly && effectiveProcessingMode !== 'full';
    const progressiveJobId = shouldScheduleProgressive
      ? createProgressiveJob({
        buffer: Buffer.from(combined),
        parseArgs,
        preScan,
        baseMode: effectiveProcessingMode,
      })
      : null;

    await cleanupUploadDir(uploadId);

    const normalizedPayload = normalizeCadParseResponse(result, preScan);
    res.json(withProgressiveMetadata(normalizedPayload, progressiveJobId, effectiveProcessingMode));
  } catch (err) {
    await cleanupUploadDir(uploadId);
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({
      message: err.message || 'Chunk completion parsing failed.',
    });
  }
});

app.post('/api/cad/parse', parseRateLimit, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ message: 'No CAD file was uploaded.' });
      return;
    }

    const preScan = prescanCadBuffer({
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      fileSizeBytes: req.file.size,
    });
    const clientMode = String(req.body?.processingMode || 'full').trim() || 'full';
    const effectiveProcessingMode = mergeProcessingMode(clientMode, preScan.recommendedMode);

    const parseArgs = {
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      fileSizeBytes: req.file.size,
      strictExistingPointsOnly: String(req.body?.strictExistingPointsOnly || '').toLowerCase() !== 'false',
      expectedFileHashFNV64: String(req.body?.expectedFileHashFNV64 || '').trim(),
      preflightFormatHint: String(req.body?.preflightFormatHint || 'unknown').trim() || 'unknown',
      preflightModeConfidence: String(req.body?.preflightModeConfidence || 'low').trim() || 'low',
      preflightModeConfidenceReason: String(req.body?.preflightModeConfidenceReason || '').trim(),
      preScan,
    };

    const pointsOnly = String(req.body?.pointsOnly || '').toLowerCase() === 'true';
    const result = await parseCadUpload({
      ...parseArgs,
      pointsOnly,
      processingMode: effectiveProcessingMode,
    });

    const shouldScheduleProgressive = !pointsOnly && effectiveProcessingMode !== 'full';
    const progressiveJobId = shouldScheduleProgressive
      ? createProgressiveJob({
        buffer: Buffer.from(req.file.buffer),
        parseArgs,
        preScan,
        baseMode: effectiveProcessingMode,
      })
      : null;

    const normalizedPayload = normalizeCadParseResponse(result, preScan);
    res.json(withProgressiveMetadata(normalizedPayload, progressiveJobId, effectiveProcessingMode));
  } catch (err) {
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({
      message: err.message || 'CAD parsing failed.',
    });
  }
});

// Periodically remove orphaned chunk directories older than 2 hours.
const CHUNK_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
const CHUNK_MAX_AGE_MS = 2 * 60 * 60 * 1000;
setInterval(async () => {
  try {
    const entries = await fs.readdir(chunkRootDir, { withFileTypes: true }).catch(() => []);
    const now = Date.now();
    await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          const dirPath = path.join(chunkRootDir, e.name);
          const stat = await fs.stat(dirPath).catch(() => null);
          if (stat && now - stat.mtimeMs > CHUNK_MAX_AGE_MS) {
            await fs.rm(dirPath, { recursive: true, force: true });
          }
        }),
    );

    for (const [jobId, job] of progressiveCadJobs.entries()) {
      if (!job || (now - Number(job.updatedAt || job.createdAt || now)) > PROGRESSIVE_JOB_MAX_AGE_MS) {
        progressiveCadJobs.delete(jobId);
      }
    }
  } catch {
    // Cleanup errors are non-fatal.
  }
}, CHUNK_CLEANUP_INTERVAL_MS);

app.listen(port, () => {
  console.log(`CAD backend listening on http://localhost:${port}`);
});