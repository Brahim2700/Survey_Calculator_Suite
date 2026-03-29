// src/utils/geoid.js
// Efficient geoid sampling with automatic on-demand loading

import { fromArrayBuffer, fromBlob } from 'geotiff';

const gridCache = new Map();
const loadingPromises = new Map(); // Prevent duplicate loads
let geoidIndexPromise = null;
let geoidIndexCache = null;

// Grid URLs for on-demand loading
const GRID_URLS = {
  'RAF20': '/geoid/fr_ign_RAF20.tif',
  'RAF18b': '/geoid/fr_ign_RAF18b.tif',
  'RAF18': '/geoid/fr_ign_RAF18.tif',
  'RAF09': '/geoid/fr_ign_RAF09.tif',
  'EGM96': '/geoid/us_nga_egm96_15.tif',
  'EGM2008': '/geoid/us_nga_egm08_25.tif',
};

const resolveGeoidUrl = (url) => {
  if (!url) return url;
  try {
    const base = (import.meta?.env?.BASE_URL || '/').replace(/\\+/g, '/');
    const normalized = `${base.replace(/\/?$/, '/')}${url.replace(/^\//, '')}`;
    return normalized;
  } catch {
    return url;
  }
};

async function loadGeoidIndex() {
  if (geoidIndexCache) return geoidIndexCache;
  if (geoidIndexPromise) return geoidIndexPromise;

  geoidIndexPromise = (async () => {
    try {
      const indexUrl = resolveGeoidUrl('/geoid/index.json');
      const res = await fetch(indexUrl);
      if (!res.ok) throw new Error(`Failed to fetch geoid index (${res.status})`);
      const data = await res.json();
      geoidIndexCache = Array.isArray(data) ? data : [];
      return geoidIndexCache;
    } catch (err) {
      console.warn('Geoid index fetch failed, falling back to defaults:', err.message);
      geoidIndexCache = Object.keys(GRID_URLS).map((name) => ({ name, url: GRID_URLS[name] }));
      return geoidIndexCache;
    } finally {
      geoidIndexPromise = null;
    }
  })();

  return geoidIndexPromise;
}

export async function getAvailableGeoidGrids() {
  return loadGeoidIndex();
}

export async function loadGeoidGrid(name, url) {
  if (gridCache.has(name)) return gridCache.get(name);
  
  // If already loading, wait for that promise
  if (loadingPromises.has(name)) {
    return loadingPromises.get(name);
  }

  const finalUrl = resolveGeoidUrl(url);

  const fetchGeoidArrayBuffer = async () => {
    let response = await fetch(finalUrl, { cache: 'no-cache' });
    if (!response.ok || response.status === 304) {
      // Retry with reload to avoid cached empty bodies
      response = await fetch(finalUrl, { cache: 'reload' });
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const reportedLength = response.headers.get('content-length');
    if (arrayBuffer.byteLength === 0) {
      throw new Error(`Empty response (content-length: ${reportedLength || 'unknown'})`);
    }
    return { arrayBuffer, reportedLength };
  };

  const loadPromise = (async () => {
    console.log(`Loading geoid grid: ${name} from ${finalUrl}`);
    try {
      const { arrayBuffer, reportedLength } = await fetchGeoidArrayBuffer();
      console.log(`Fetched ${name}: ${arrayBuffer.byteLength} bytes (content-length: ${reportedLength || 'unknown'})`);

      const tiff = await fromArrayBuffer(arrayBuffer);
      const image = await tiff.getImage();

      const width = image.getWidth();
      const height = image.getHeight();
      const bbox = image.getBoundingBox();

      const entry = { image, width, height, bbox, url };
      gridCache.set(name, entry);
      loadingPromises.delete(name);
      console.log(`Successfully loaded geoid grid: ${name} (${width}x${height})`);
      return entry;
    } catch (e) {
      loadingPromises.delete(name);
      const errorMsg = e.message || String(e);
      console.error(`Failed to load geoid grid ${name}:`, errorMsg);
      throw new Error(`Failed to load ${name} from ${finalUrl}: ${errorMsg}`);
    }
  })();

  loadingPromises.set(name, loadPromise);
  return loadPromise;
}

export async function loadGeoidGridFromFile(name, file) {
  if (gridCache.has(name)) return gridCache.get(name);
  if (loadingPromises.has(name)) return loadingPromises.get(name);

  const loadPromise = (async () => {
    const tiff = await fromBlob(file);
    const image = await tiff.getImage();
    const width = image.getWidth();
    const height = image.getHeight();
    const bbox = image.getBoundingBox();
    const entry = { image, width, height, bbox, url: 'local-upload' };
    gridCache.set(name, entry);
    loadingPromises.delete(name);
    return entry;
  })();

  loadingPromises.set(name, loadPromise);
  return loadPromise;
}

export async function ensureGeoidGrid(name, url) {
  if (gridCache.has(name)) return gridCache.get(name);

  let finalUrl = url;
  if (!finalUrl) {
    const idx = await loadGeoidIndex();
    const item = Array.isArray(idx) ? idx.find((g) => g.name === name) : null;
    finalUrl = item?.url || GRID_URLS[name];
  }

  finalUrl = resolveGeoidUrl(finalUrl);

  if (!finalUrl) throw new Error(`No URL found for geoid grid ${name}`);
  return loadGeoidGrid(name, finalUrl);
}

export function getLoadedGrids() {
  return Array.from(gridCache.keys());
}

export function isGeoidGridLoaded(name) {
  return gridCache.has(name);
}

export async function getGeoidUndulation(name, lonDeg, latDeg) {
  const grid = gridCache.get(name);
  if (!grid) throw new Error(`Grid ${name} not loaded`);

  const { image, width, height, bbox } = grid;
  const [minX, minY, maxX, maxY] = bbox;

  const lon = Math.min(Math.max(lonDeg, minX), maxX);
  const lat = Math.min(Math.max(latDeg, minY), maxY);

  const xNorm = (lon - minX) / (maxX - minX);
  const yNorm = (lat - minY) / (maxY - minY);

  const xPix = xNorm * (width - 1);
  const yPix = (1 - yNorm) * (height - 1);

  const x0 = clamp(Math.floor(xPix), 0, width - 2);
  const y0 = clamp(Math.floor(yPix), 0, height - 2);
  const x1 = x0 + 1;
  const y1 = y0 + 1;

  const t = xPix - x0;
  const u = yPix - y0;

  const arr = await image.readRasters({
    window: [x0, y0, x1 + 1, y1 + 1],
    samples: [0],
    interleave: true,
  });

  if (!arr || arr.length < 4) {
    throw new Error(`Failed to read raster window for ${name} at (${lon}, ${lat})`);
  }

  const n00 = arr[0];
  const n10 = arr[1];
  const n01 = arr[2];
  const n11 = arr[3];

  const nTop = n00 * (1 - t) + n10 * t;
  const nBottom = n01 * (1 - t) + n11 * t;
  const N = nTop * (1 - u) + nBottom * u;

  return N;
}

export async function ellipsoidalToOrthometric(name, lonDeg, latDeg, hMeters) {
  const N = await getGeoidUndulation(name, lonDeg, latDeg);
  return { H: hMeters - N, N };
}

export async function orthometricToEllipsoidal(name, lonDeg, latDeg, Hmeters) {
  const N = await getGeoidUndulation(name, lonDeg, latDeg);
  return { h: Hmeters + N, N };
}

/**
 * Smart grid selection with auto-loading.
 * Returns the best grid name for the location and ensures it's loaded.
 */
export async function selectGeoidGrid(lonDeg, latDeg) {
  const pref = ['RAF20', 'RAF18b', 'RAF18', 'RAF09', 'EGM96'];

  const idx = await loadGeoidIndex();

  // Check already-loaded grids first
  for (const name of pref) {
    const g = gridCache.get(name);
    if (g) {
      const [minX, minY, maxX, maxY] = g.bbox;
      if (lonDeg >= minX && lonDeg <= maxX && latDeg >= minY && latDeg <= maxY) {
        return name;
      }
    }
  }

  // Try loading RAF grids (France) if lon/lat is in France region
  if (lonDeg >= -5 && lonDeg <= 10 && latDeg >= 41 && latDeg <= 52) {
    for (const name of ['RAF20', 'RAF18b', 'RAF18', 'RAF09']) {
      if (gridCache.has(name)) continue; // Already checked above
      try {
        const url = idx.find((g) => g.name === name)?.url || GRID_URLS[name];
        await ensureGeoidGrid(name, url);
        const g = gridCache.get(name);
        const [minX, minY, maxX, maxY] = g.bbox;
        if (lonDeg >= minX && lonDeg <= maxX && latDeg >= minY && latDeg <= maxY) {
          return name;
        }
      } catch (e) {
        console.warn(`Failed to load ${name}:`, e.message);
        continue;
      }
    }
  }

  // Fall back to EGM96 (smaller global grid)
  if (!gridCache.has('EGM96')) {
    try {
      const url = idx.find((g) => g.name === 'EGM96')?.url || GRID_URLS['EGM96'];
      console.log(`Attempting to load EGM96 from: ${url}`);
      await ensureGeoidGrid('EGM96', url);
    } catch (e) {
      const detailedMsg = e.message || 'Unknown error';
      console.error(`Failed to load EGM96: ${detailedMsg}`);
      throw new Error(`Failed to load geoid grid: ${detailedMsg}. Make sure geoid files are accessible.`);
    }
  }
  return 'EGM96';
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}