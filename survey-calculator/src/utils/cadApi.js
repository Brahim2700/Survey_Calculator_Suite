const CAD_API_BASE_URL = import.meta.env.VITE_CAD_API_BASE_URL || '/api/cad';

function buildBackendUnavailableMessage() {
  return 'Native DWG import requires the CAD backend service. Start it with "npm run dev:server" and configure a DWG converter command.';
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
  if (!response.ok) throw new Error('CAD backend health check failed.');
  return response.json();
}