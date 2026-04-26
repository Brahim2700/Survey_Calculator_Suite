const CAD_API_BASE_URL = import.meta.env.VITE_CAD_API_BASE_URL || '/api/cad';

// Maximum file size the client will attempt to upload (must be ≤ server limit).
// The server enforces 100 MB via CAD_MAX_UPLOAD_MB; we keep the same cap here
// to produce a friendly error message before the request is even sent.
const CAD_UPLOAD_MAX_BYTES = 100 * 1024 * 1024; // 100 MB

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

export async function parseCadFileViaBackend(file, options = {}) {
  if (file.size > CAD_UPLOAD_MAX_BYTES) {
    throw new Error(
      `File "${file.name}" is ${(file.size / (1024 * 1024)).toFixed(0)} MB, which exceeds the ` +
      `${CAD_UPLOAD_MAX_BYTES / (1024 * 1024)} MB upload limit. ` +
      `Please reduce the file size or split it into smaller drawings.`
    );
  }

  const formData = new FormData();
  formData.append('file', file);
  formData.append('pointsOnly', options.pointsOnly ? 'true' : 'false');

  let response;
  try {
    response = await fetch(`${CAD_API_BASE_URL}/parse`, {
      method: 'POST',
      body: formData,
    });
  } catch {
    throw new Error(buildBackendUnavailableMessage());
  }

  const payload = await parseJsonSafely(response);
  if (!response.ok) {
    throw new Error(payload?.message || buildBackendUnavailableMessage());
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