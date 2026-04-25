import { calculateGeodesicDistance } from './calculations';

const IGN_ALTI_API_BASE_URL = import.meta.env.VITE_IGN_ALTI_API_BASE_URL || 'https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest';
const IGN_ALTI_RESOURCE = import.meta.env.VITE_IGN_ALTI_RESOURCE || 'ign_rge_alti_wld';
const IGN_NO_DATA_VALUE = -99999;

// Providers exposed for the switcher UI
export const ELEVATION_PROVIDERS = [
  {
    id: 'ign',
    label: 'IGN GeoPlateforme',
    description: 'France — RGE ALTI® / BD ALTI®, 1–25 m resolution',
    flag: '🇫🇷',
    coverage: 'France (best accuracy)',
  },
  {
    id: 'opentopodata-srtm30m',
    label: 'OpenTopoData · SRTM 30 m',
    description: 'Global (~60°N–60°S), USGS SRTM, ~30 m resolution',
    flag: '🌍',
    coverage: 'Global (lat −60 to +60)',
  },
  {
    id: 'opentopodata-aster30m',
    label: 'OpenTopoData · ASTER 30 m',
    description: 'Global, NASA ASTER, ~30 m resolution',
    flag: '🌏',
    coverage: 'Global',
  },
  {
    id: 'opentopodata-eudem25m',
    label: 'OpenTopoData · EU-DEM 25 m',
    description: 'Europe, EEA EU-DEM, ~25 m resolution',
    flag: '🇪🇺',
    coverage: 'Europe',
  },
  {
    id: 'measured',
    label: 'Measured heights only',
    description: 'Use the ellipsoidal/orthometric heights of the selected points (no DEM)',
    flag: '📐',
    coverage: 'Any — offline',
  },
];

const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));

const toFiniteElevation = (value) => {
  const elevation = Number(value);
  return Number.isFinite(elevation) ? elevation : null;
};

export const buildElevationProfileData = (rawPoints, options = {}) => {
  const points = Array.isArray(rawPoints)
    ? rawPoints.filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng) && Number.isFinite(point?.elevation))
    : [];

  if (points.length < 2) return null;

  const profilePoints = [];
  let cumulativeDistance = 0;
  let positiveGain = 0;
  let negativeGain = 0;
  let maxSlopePercent = Number.NEGATIVE_INFINITY;
  let minSlopePercent = Number.POSITIVE_INFINITY;

  points.forEach((point, index) => {
    if (index > 0) {
      const previousPoint = points[index - 1];
      const distanceResult = calculateGeodesicDistance(previousPoint.lat, previousPoint.lng, point.lat, point.lng);
      const segmentDistance = Number(distanceResult?.distance) || 0;
      const elevationDelta = point.elevation - previousPoint.elevation;

      cumulativeDistance += segmentDistance;
      if (elevationDelta > 0) positiveGain += elevationDelta;
      if (elevationDelta < 0) negativeGain += Math.abs(elevationDelta);

      if (segmentDistance > 0) {
        const slopePercent = (elevationDelta / segmentDistance) * 100;
        maxSlopePercent = Math.max(maxSlopePercent, slopePercent);
        minSlopePercent = Math.min(minSlopePercent, slopePercent);
      }
    }

    profilePoints.push({
      index,
      lat: point.lat,
      lng: point.lng,
      elevation: point.elevation,
      distance: cumulativeDistance,
      label: String(point.label || point.sourceLabel || `Point ${index + 1}`),
    });
  });

  const elevations = profilePoints.map((point) => point.elevation);
  const minElev = Math.min(...elevations);
  const maxElev = Math.max(...elevations);
  const avgElev = elevations.reduce((sum, value) => sum + value, 0) / elevations.length;
  const elevRange = Math.max(maxElev - minElev, 1);

  return {
    points: profilePoints,
    minElev,
    maxElev,
    avgElev,
    elevRange,
    totalDistance: cumulativeDistance,
    positiveGain,
    negativeGain,
    maxSlopePercent: Number.isFinite(maxSlopePercent) ? maxSlopePercent : 0,
    minSlopePercent: Number.isFinite(minSlopePercent) ? minSlopePercent : 0,
    sourceLabel: options.sourceLabel || 'Measured point heights',
    sampled: Boolean(options.sampled),
    selectedPointCount: Number(options.selectedPointCount) || profilePoints.length,
  };
};

export async function fetchIgnElevationProfile(measurePoints, options = {}) {
  const points = Array.isArray(measurePoints)
    ? measurePoints.filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng))
    : [];

  if (points.length < 2) {
    throw new Error('At least two measurement points are required to request an elevation profile.');
  }

  let selectedDistance = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previousPoint = points[index - 1];
    const currentPoint = points[index];
    const distanceResult = calculateGeodesicDistance(previousPoint.lat, previousPoint.lng, currentPoint.lat, currentPoint.lng);
    selectedDistance += Number(distanceResult?.distance) || 0;
  }

  const sampling = clampNumber(Math.round(selectedDistance / 25), 32, 400);
  const params = new URLSearchParams({
    lon: points.map((point) => point.lng).join('|'),
    lat: points.map((point) => point.lat).join('|'),
    resource: options.resource || IGN_ALTI_RESOURCE,
    delimiter: '|',
    indent: 'false',
    measures: 'false',
    zonly: 'false',
    profile_mode: options.profileMode || 'accurate',
    sampling: String(options.sampling || sampling),
  });

  const response = await fetch(`${IGN_ALTI_API_BASE_URL}/elevationLine.json?${params.toString()}`, {
    signal: options.signal,
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(payload?.message || `IGN elevation profile request failed (${response.status}).`);
  }

  const sampledPoints = Array.isArray(payload?.elevations)
    ? payload.elevations
        .map((item, index) => ({
          index,
          lat: Number(item?.lat),
          lng: Number(item?.lon),
          elevation: toFiniteElevation(item?.z),
          label: `Sample ${index + 1}`,
        }))
        .filter((point) => point.elevation !== null && point.elevation !== IGN_NO_DATA_VALUE)
    : [];

  if (sampledPoints.length < 2) {
    throw new Error('IGN did not return enough elevation samples for this profile.');
  }

  const profileData = buildElevationProfileData(sampledPoints, {
    sourceLabel: 'IGN GeoPlateforme profile',
    sampled: true,
    selectedPointCount: points.length,
  });

  if (!profileData) {
    throw new Error('Unable to build profile data from IGN elevation samples.');
  }

  return {
    ...profileData,
    selectedDistance,
    requestedSampling: Number(options.sampling || sampling),
    resource: options.resource || IGN_ALTI_RESOURCE,
    positiveHeightDifference: Number(payload?.height_differences?.positive) || profileData.positiveGain,
    negativeHeightDifference: Number(payload?.height_differences?.negative) || profileData.negativeGain,
  };
}

// ── OpenTopoData provider ─────────────────────────────────────────────────────
// Free public API: https://api.opentopodata.org  (100 pts/req, 1 req/s, 1000/day)
const OTD_DATASET_IDS = {
  'opentopodata-srtm30m': 'srtm30m',
  'opentopodata-aster30m': 'aster30m',
  'opentopodata-eudem25m': 'eudem25m',
};

export async function fetchOpenTopoDataProfile(measurePoints, providerId, options = {}) {
  const points = Array.isArray(measurePoints)
    ? measurePoints.filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng))
    : [];

  if (points.length < 2) {
    throw new Error('At least two measurement points are required.');
  }

  const dataset = OTD_DATASET_IDS[providerId];
  if (!dataset) throw new Error(`Unknown OpenTopoData provider: ${providerId}`);

  // Compute total distance to choose sampling density
  let selectedDistance = 0;
  for (let i = 1; i < points.length; i += 1) {
    const dr = calculateGeodesicDistance(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
    selectedDistance += Number(dr?.distance) || 0;
  }

  // Densify the line: interpolate intermediate lat/lng steps capped at 100 pts
  const targetSamples = Math.min(Math.max(Math.round(selectedDistance / 30), 20), 100);
  const samplesPerSegment = Math.max(1, Math.floor(targetSamples / (points.length - 1)));

  const locationPairs = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const count = (i === points.length - 2) ? samplesPerSegment + 1 : samplesPerSegment;
    for (let s = 0; s < count; s += 1) {
      const t = s / (samplesPerSegment);
      const lat = p1.lat + (p2.lat - p1.lat) * t;
      const lng = p1.lng + (p2.lng - p1.lng) * t;
      const key = `${lat.toFixed(7)},${lng.toFixed(7)}`;
      if (!locationPairs.find((loc) => loc.key === key)) {
        locationPairs.push({ lat, lng, key });
      }
    }
  }
  // Always include the final point exactly
  const last = points[points.length - 1];
  locationPairs.push({ lat: last.lat, lng: last.lng, key: `${last.lat.toFixed(7)},${last.lng.toFixed(7)}` });

  const locationsParam = locationPairs.map((l) => `${l.lat},${l.lng}`).join('|');
  const url = `https://api.opentopodata.org/v1/${dataset}?locations=${encodeURIComponent(locationsParam)}&interpolation=bilinear`;

  const response = await fetch(url, { signal: options.signal });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }

  if (!response.ok || payload?.status !== 'OK') {
    throw new Error(payload?.error || `OpenTopoData request failed (${response.status}).`);
  }

  const sampledPoints = Array.isArray(payload?.results)
    ? payload.results
        .map((item, index) => ({
          index,
          lat: Number(item?.location?.lat),
          lng: Number(item?.location?.lng),
          elevation: toFiniteElevation(item?.elevation),
          label: `Sample ${index + 1}`,
        }))
        .filter((p) => p.elevation !== null && p.elevation !== IGN_NO_DATA_VALUE)
    : [];

  if (sampledPoints.length < 2) {
    throw new Error('OpenTopoData did not return enough elevation samples for this profile.');
  }

  const profileData = buildElevationProfileData(sampledPoints, {
    sourceLabel: `OpenTopoData · ${dataset}`,
    sampled: true,
    selectedPointCount: points.length,
  });

  if (!profileData) throw new Error('Unable to build profile data from OpenTopoData samples.');

  return { ...profileData, selectedDistance };
}

// ── Unified dispatcher ────────────────────────────────────────────────────────
export async function fetchElevationProfile(measurePoints, providerId, options = {}) {
  if (providerId === 'ign') {
    return fetchIgnElevationProfile(measurePoints, options);
  }
  if (providerId === 'measured') {
    const pts = (Array.isArray(measurePoints) ? measurePoints : []).filter(
      (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng)
    );
    const result = buildElevationProfileData(
      pts.map((p, i) => ({
        lat: p.lat,
        lng: p.lng,
        elevation: Number(p?.height || 0),
        label: p.label || p.sourceLabel || `P${i + 1}`,
      })),
      { sourceLabel: 'Measured point heights', sampled: false, selectedPointCount: pts.length }
    );
    if (!result) throw new Error('Not enough valid measurement points.');
    return result;
  }
  if (providerId?.startsWith('opentopodata-')) {
    return fetchOpenTopoDataProfile(measurePoints, providerId, options);
  }
  throw new Error(`Unknown elevation provider: ${providerId}`);
}