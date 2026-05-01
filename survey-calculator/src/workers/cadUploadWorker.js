const toHex = (bytes) => Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
const FNV64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const FNV64_MASK = 0xffffffffffffffffn;

function chooseProcessingMode(fileSize, previewThresholdBytes, recoveryThresholdBytes) {
  if (fileSize >= recoveryThresholdBytes) return 'recovery';
  if (fileSize >= previewThresholdBytes) return 'preview';
  return 'full';
}

function buildChunkSpecs(fileSize, chunkBytes) {
  const safeChunkSize = Math.max(256 * 1024, Number(chunkBytes) || 5 * 1024 * 1024);
  const totalChunks = Math.ceil(fileSize / safeChunkSize);
  const chunks = [];

  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * safeChunkSize;
    const end = Math.min(start + safeChunkSize, fileSize);
    chunks.push({ index, start, end, size: end - start });
  }

  return { totalChunks, chunks, chunkBytes: safeChunkSize };
}

function fnv1a64Update(hash, bytes) {
  let next = hash;
  for (let i = 0; i < bytes.length; i += 1) {
    next ^= BigInt(bytes[i]);
    next = (next * FNV64_PRIME) & FNV64_MASK;
  }
  return next;
}

function toFNV64Hex(hash) {
  const hex = hash.toString(16);
  return hex.padStart(16, '0');
}

async function readStreamSignature(file) {
  if (!file || typeof file.stream !== 'function') return '';

  const reader = file.stream().getReader();
  try {
    const { value } = await reader.read();
    if (!value || value.length === 0) return '';
    const prefix = value.slice(0, Math.min(8, value.length));
    return toHex(prefix);
  } finally {
    reader.releaseLock();
  }
}

async function computeStreamFNV64(file) {
  if (!file || typeof file.stream !== 'function') return '';

  const reader = file.stream().getReader();
  let hash = FNV64_OFFSET_BASIS;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) {
        hash = fnv1a64Update(hash, value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return toFNV64Hex(hash);
}

function deriveFormatHint(fileName, signatureHex) {
  const ext = String(fileName || '').toLowerCase().split('.').pop();
  const sig = String(signatureHex || '').toLowerCase();

  // DWG files typically start with AC10xx in ASCII (hex 41 43 31 30).
  if (sig.startsWith('41433130')) return 'dwg';
  if (ext === 'dwg') return 'dwg';
  if (ext === 'dxf') return 'dxf';
  return 'unknown';
}

function deriveModeConfidence(processingMode, formatHint) {
  // Size-only mode hints are intentionally conservative for DWG/proxy-heavy files.
  if (formatHint === 'dwg') {
    return {
      level: 'low',
      reason: `Mode ${processingMode} selected from size thresholds only. DWG complexity/proxy content may require fallback to recovery.`,
    };
  }
  if (formatHint === 'dxf') {
    return {
      level: 'medium',
      reason: `Mode ${processingMode} selected from size thresholds and DXF signature hints.`,
    };
  }
  return {
    level: 'low',
    reason: `Mode ${processingMode} selected from size thresholds only.`,
  };
}

self.onmessage = async (event) => {
  const { taskId, task, payload } = event.data || {};

  try {
    if (task !== 'analyze-and-plan') {
      throw new Error(`Unsupported worker task: ${task}`);
    }

    const file = payload?.file;
    if (!file || !Number.isFinite(file.size)) {
      throw new Error('Worker received invalid file payload.');
    }

    const previewThresholdBytes = Math.max(1, Number(payload?.previewThresholdBytes) || 30 * 1024 * 1024);
    const recoveryThresholdBytes = Math.max(previewThresholdBytes, Number(payload?.recoveryThresholdBytes) || 80 * 1024 * 1024);
    const processingMode = chooseProcessingMode(file.size, previewThresholdBytes, recoveryThresholdBytes);
    const chunkPlan = buildChunkSpecs(file.size, payload?.chunkBytes);
    const signatureHex = await readStreamSignature(file);
    const fileHashFNV64 = await computeStreamFNV64(file);
    const formatHint = deriveFormatHint(file.name, signatureHex);
    const confidence = deriveModeConfidence(processingMode, formatHint);

    self.postMessage({
      type: 'result',
      taskId,
      payload: {
        ...chunkPlan,
        processingMode,
        signatureHex,
        fileHashFNV64,
        formatHint,
        processingModeConfidence: confidence.level,
        processingModeConfidenceReason: confidence.reason,
      },
    });
  } catch (err) {
    self.postMessage({
      type: 'error',
      taskId,
      error: err?.message || String(err),
    });
  }
};
