const toHex = (bytes) => Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');

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

    self.postMessage({
      type: 'result',
      taskId,
      payload: {
        ...chunkPlan,
        processingMode,
        signatureHex,
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
