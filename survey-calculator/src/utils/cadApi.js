const CAD_API_BASE_URL = import.meta.env.VITE_CAD_API_BASE_URL || '/api/cad';

// Maximum file size the client will attempt to upload (must be ≤ server limit).
// The server enforces 100 MB via CAD_MAX_UPLOAD_MB; we keep the same cap here
// to produce a friendly error message before the request is even sent.
const CAD_UPLOAD_MAX_BYTES = 100 * 1024 * 1024; // 100 MB
const CAD_CHUNK_MODE_MIN_BYTES = Number(import.meta.env.VITE_CAD_CHUNK_MODE_MIN_MB || 20) * 1024 * 1024;
const CAD_UPLOAD_CHUNK_BYTES = Number(import.meta.env.VITE_CAD_UPLOAD_CHUNK_MB || 5) * 1024 * 1024;
const CAD_MAX_CHUNK_RETRIES = 3;
const CAD_COMPLEX_FILE_BYTES = Number(import.meta.env.VITE_CAD_COMPLEX_FILE_MB || 6) * 1024 * 1024;
const CAD_PREVIEW_MODE_MIN_BYTES = Number(import.meta.env.VITE_CAD_PREVIEW_MODE_MB || 30) * 1024 * 1024;
const CAD_RECOVERY_MODE_MIN_BYTES = Number(import.meta.env.VITE_CAD_RECOVERY_MODE_MB || 80) * 1024 * 1024;

// How long to wait for the CAD backend to respond (upload + conversion + parse).
// Native DWG conversion via ODA/LibreDWG can take 30-90 s for large files.
const CAD_REQUEST_TIMEOUT_MS = 150_000; // 2.5 minutes
const CAD_COMPLEX_REQUEST_TIMEOUT_MS = Number(import.meta.env.VITE_CAD_COMPLEX_TIMEOUT_MS || 480_000); // 8 minutes

let cadUploadWorkerInstance = null;

function buildBackendUnavailableMessage() {
  return `Native DWG import requires the CAD backend service. Current CAD API target: ${CAD_API_BASE_URL}. Use the hosted CAD API or start "npm run dev:server" for local development.`;
}

async function parseJsonSafely(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function getCadUploadWorker() {
  if (typeof Worker === 'undefined') return null;
  if (cadUploadWorkerInstance) return cadUploadWorkerInstance;
  cadUploadWorkerInstance = new Worker(new URL('../workers/cadUploadWorker.js', import.meta.url), {
    type: 'module',
  });
  return cadUploadWorkerInstance;
}

function runCadWorkerTask(task, payload = {}, signal) {
  const worker = getCadUploadWorker();
  if (!worker) {
    return Promise.resolve(null);
  }

  const taskId = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    const onError = (err) => {
      cleanup();
      reject(err instanceof Error ? err : new Error('CAD upload worker failed.'));
    };

    const onMessage = (event) => {
      const message = event.data || {};
      if (message.taskId !== taskId) return;

      cleanup();
      if (message.type === 'result') {
        resolve(message.payload || null);
        return;
      }

      reject(new Error(message.error || 'CAD upload worker task failed.'));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.postMessage({ taskId, task, payload });
  });
}

async function buildChunkUploadPlan(file, { signal, onProgress } = {}) {
  const workerPlan = await runCadWorkerTask('analyze-and-plan', {
    file,
    chunkBytes: CAD_UPLOAD_CHUNK_BYTES,
    previewThresholdBytes: CAD_PREVIEW_MODE_MIN_BYTES,
    recoveryThresholdBytes: CAD_RECOVERY_MODE_MIN_BYTES,
  }, signal).catch(() => null);

  if (workerPlan) {
    if (typeof onProgress === 'function') {
      onProgress(`Upload planner worker ready. Recommended mode: ${workerPlan.processingMode}.`);
      if (workerPlan.processingModeConfidenceReason) {
        onProgress(`Preflight confidence: ${workerPlan.processingModeConfidence} (${workerPlan.processingModeConfidenceReason})`);
      }
    }
    return workerPlan;
  }

  const totalChunks = Math.ceil(file.size / CAD_UPLOAD_CHUNK_BYTES);
  const chunks = [];
  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * CAD_UPLOAD_CHUNK_BYTES;
    const end = Math.min(start + CAD_UPLOAD_CHUNK_BYTES, file.size);
    chunks.push({ index, start, end });
  }

  const processingMode = file.size >= CAD_RECOVERY_MODE_MIN_BYTES
    ? 'recovery'
    : file.size >= CAD_PREVIEW_MODE_MIN_BYTES
      ? 'preview'
      : 'full';

  return {
    totalChunks,
    chunks,
    processingMode,
    signatureHex: '',
    fileHashFNV64: '',
    formatHint: 'unknown',
    processingModeConfidence: 'low',
    processingModeConfidenceReason: `Mode ${processingMode} selected from size thresholds only.`,
  };
}

async function uploadCadFileInChunks(file, { signal, onProgress } = {}) {
  const uploadId = crypto.randomUUID();
  const plan = await buildChunkUploadPlan(file, { signal, onProgress });
  const totalChunks = Number(plan?.totalChunks || 0);
  const chunks = Array.isArray(plan?.chunks) ? plan.chunks : [];

  if (totalChunks <= 0 || chunks.length === 0) {
    throw new Error('Failed to build a valid CAD chunk upload plan.');
  }

  if (typeof onProgress === 'function' && plan.signatureHex) {
    onProgress(`File stream preflight signature: ${plan.signatureHex}`);
  }
  if (typeof onProgress === 'function' && plan.fileHashFNV64) {
    onProgress(`Computed upload integrity hash (fnv64): ${plan.fileHashFNV64}`);
  }

  for (let index = 0; index < chunks.length; index += 1) {
    const chunkSpec = chunks[index];
    const chunk = file.slice(chunkSpec.start, chunkSpec.end);

    let success = false;
    for (let attempt = 1; attempt <= CAD_MAX_CHUNK_RETRIES; attempt += 1) {
      try {
        const formData = new FormData();
        formData.append('uploadId', uploadId);
        formData.append('fileName', file.name);
        formData.append('chunkIndex', String(chunkSpec.index));
        formData.append('totalChunks', String(totalChunks));
        formData.append('chunk', chunk, `${file.name}.part.${chunkSpec.index}`);

        const response = await fetch(`${CAD_API_BASE_URL}/upload/chunk`, {
          method: 'POST',
          body: formData,
          signal,
        });

        if (!response.ok) {
          const payload = await parseJsonSafely(response);
          throw new Error(payload?.message || `Chunk ${chunkSpec.index + 1}/${totalChunks} upload failed.`);
        }

        success = true;
        break;
      } catch (err) {
        if (attempt === CAD_MAX_CHUNK_RETRIES) throw err;
        await new Promise((resolve) => setTimeout(resolve, attempt * 800));
      }
    }

    if (!success) {
      throw new Error(`Chunk ${chunkSpec.index + 1}/${totalChunks} upload failed.`);
    }

    if (typeof onProgress === 'function') {
      const pct = Math.round(((chunkSpec.index + 1) / totalChunks) * 100);
      onProgress(`Uploading CAD in chunks (${chunkSpec.index + 1}/${totalChunks}) — ${pct}%`);
    }
  }

  return {
    uploadId,
    totalChunks,
    processingMode: plan.processingMode || 'full',
    fileHashFNV64: plan.fileHashFNV64 || '',
    formatHint: plan.formatHint || 'unknown',
    processingModeConfidence: plan.processingModeConfidence || 'low',
    processingModeConfidenceReason: plan.processingModeConfidenceReason || '',
  };
}

async function uploadCadAndParseChunked(file, options = {}, signal) {
  const { onProgress } = options;
  const {
    uploadId,
    processingMode,
    fileHashFNV64,
    formatHint,
    processingModeConfidence,
    processingModeConfidenceReason,
  } = await uploadCadFileInChunks(file, { signal, onProgress });

  if (typeof onProgress === 'function') {
    onProgress('Upload complete. Finalizing and parsing CAD geometry...');
  }

  const response = await fetch(`${CAD_API_BASE_URL}/upload/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uploadId,
      fileName: file.name,
      pointsOnly: options.pointsOnly ? 'true' : 'false',
      processingMode: options.processingMode || processingMode || 'full',
      expectedFileHashFNV64: fileHashFNV64 || '',
      preflightFormatHint: options.preflightFormatHint || formatHint || 'unknown',
      preflightModeConfidence: options.preflightModeConfidence || processingModeConfidence || 'low',
      preflightModeConfidenceReason: options.preflightModeConfidenceReason || processingModeConfidenceReason || '',
    }),
    signal,
  });

  const payload = await parseJsonSafely(response);
  if (!response.ok) {
    throw new Error(payload?.message || 'CAD chunk upload finalization failed.');
  }
  return payload;
}

async function uploadCadAndParseDirect(file, options = {}, signal) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('pointsOnly', options.pointsOnly ? 'true' : 'false');
  formData.append('processingMode', options.processingMode || 'full');
  if (options.expectedFileHashFNV64) formData.append('expectedFileHashFNV64', options.expectedFileHashFNV64);
  if (options.preflightFormatHint) formData.append('preflightFormatHint', options.preflightFormatHint);
  if (options.preflightModeConfidence) formData.append('preflightModeConfidence', options.preflightModeConfidence);
  if (options.preflightModeConfidenceReason) formData.append('preflightModeConfidenceReason', options.preflightModeConfidenceReason);

  const response = await fetch(`${CAD_API_BASE_URL}/parse`, {
    method: 'POST',
    body: formData,
    signal,
  });

  const payload = await parseJsonSafely(response);
  if (!response.ok) {
    throw new Error(payload?.message || buildBackendUnavailableMessage());
  }

  return payload;
}

export async function parseCadFileViaBackend(file, options = {}) {
  if (file.size > CAD_UPLOAD_MAX_BYTES) {
    throw new Error(
      `File "${file.name}" is ${(file.size / (1024 * 1024)).toFixed(0)} MB, which exceeds the ` +
      `${CAD_UPLOAD_MAX_BYTES / (1024 * 1024)} MB upload limit. ` +
      `Please reduce the file size or split it into smaller drawings.`
    );
  }

  // --- Timed progress messages so the user knows the app is working ---
  const { onProgress } = options;
  const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1);
  const progressMessages = [
    [0,    `Uploading ${fileSizeMB} MB to CAD backend…`],
    [5000, 'Waiting for DWG-to-DXF conversion to start…'],
    [15000,'Converting DWG file — this can take 20–60 s for large drawings…'],
    [40000,'Still converting — complex drawings may take up to 2 minutes…'],
    [90000,'Almost there — parsing the converted geometry…'],
  ];
  const progressTimers = [];
  if (typeof onProgress === 'function') {
    for (const [delay, msg] of progressMessages) {
      progressTimers.push(setTimeout(() => onProgress(msg), delay));
    }
  }

  const requestTimeoutMs = file.size >= CAD_COMPLEX_FILE_BYTES
    ? CAD_COMPLEX_REQUEST_TIMEOUT_MS
    : CAD_REQUEST_TIMEOUT_MS;
  const runParseAttempt = async (attemptOptions, signal) => {
    const modeFromSize = file.size >= CAD_RECOVERY_MODE_MIN_BYTES
      ? 'recovery'
      : file.size >= CAD_PREVIEW_MODE_MIN_BYTES
        ? 'preview'
        : 'full';
    const needsDirectPreflight = file.size < CAD_CHUNK_MODE_MIN_BYTES
      && !attemptOptions?.expectedFileHashFNV64;
    const preflightPlan = needsDirectPreflight
      ? await buildChunkUploadPlan(file, { signal, onProgress }).catch(() => null)
      : null;

    const nextOptions = {
      ...attemptOptions,
      processingMode: attemptOptions?.processingMode || modeFromSize,
      expectedFileHashFNV64: attemptOptions?.expectedFileHashFNV64 || preflightPlan?.fileHashFNV64 || '',
      preflightFormatHint: attemptOptions?.preflightFormatHint || preflightPlan?.formatHint || 'unknown',
      preflightModeConfidence: attemptOptions?.preflightModeConfidence || preflightPlan?.processingModeConfidence || 'low',
      preflightModeConfidenceReason: attemptOptions?.preflightModeConfidenceReason || preflightPlan?.processingModeConfidenceReason || '',
    };

    if (file.size >= CAD_CHUNK_MODE_MIN_BYTES) {
      if (typeof onProgress === 'function') {
        onProgress(`Large CAD detected (${fileSizeMB} MB). Switching to chunked upload mode (${nextOptions.processingMode}).`);
      }
      try {
        return await uploadCadAndParseChunked(file, nextOptions, signal);
      } catch {
        if (typeof onProgress === 'function') {
          onProgress('Chunked upload unavailable on current backend. Falling back to direct upload...');
        }
        return uploadCadAndParseDirect(file, nextOptions, signal);
      }
    }
    return uploadCadAndParseDirect(file, nextOptions, signal);
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);

  let payload;
  try {
    payload = await runParseAttempt(options, controller.signal);
  } catch (err) {
    if (err?.name === 'AbortError' && !options.pointsOnly) {
      if (typeof onProgress === 'function') {
        onProgress('Full CAD extraction is taking too long. Retrying in fast preview mode (points only)...');
      }
      const fallbackController = new AbortController();
      const fallbackTimeoutId = setTimeout(() => fallbackController.abort(), requestTimeoutMs);
      try {
        payload = await runParseAttempt({ ...options, pointsOnly: true }, fallbackController.signal);
      } finally {
        clearTimeout(fallbackTimeoutId);
      }
    } else if (err?.name === 'AbortError') {
      throw new Error(
        `The CAD backend did not respond within ${Math.round(requestTimeoutMs / 1000)} seconds. ` +
        `This can happen with very complex DWG files. Try enabling points-only preview first, then refine layers.`
      );
    } else if (err?.message) {
      throw new Error(err.message);
    } else {
      throw new Error(buildBackendUnavailableMessage());
    }
  } finally {
    clearTimeout(timeoutId);
    for (const t of progressTimers) clearTimeout(t);
  }

  if (!Array.isArray(payload?.rows)) {
    throw new Error('CAD backend returned an invalid response.');
  }

  return options.returnPayload ? payload : payload.rows;
}

export async function getCadBackendStatus() {
  const response = await fetch(`${CAD_API_BASE_URL}/health`);
  if (!response.ok) throw new Error(`CAD backend health check failed for ${CAD_API_BASE_URL}.`);
  return response.json();
}