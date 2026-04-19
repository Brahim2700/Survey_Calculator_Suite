// src/utils/crsDetection.js
// Smart CRS detection from coordinate values and metadata

import proj4 from 'proj4';
import CRS_LIST from '../crsList.js';

const CRS_BY_CODE = new Map(
  CRS_LIST
    .filter((entry) => entry?.code)
    .map((entry) => [entry.code, entry])
);

const ensureCrsDefinition = (crsCode) => {
  if (!crsCode) return false;
  const existing = proj4.defs(crsCode);
  if (existing) return true;
  const entry = CRS_BY_CODE.get(crsCode);
  if (!entry?.proj4def) return false;
  let proj4def = entry.proj4def;
  if (proj4def.includes('+nadgrids=')) {
    proj4def = proj4def.replace(/\+nadgrids=[^\s]+\s*/g, '');
  }
  proj4.defs(crsCode, proj4def);
  return true;
};

/**
 * Detect CRS from coordinate ranges and patterns
 * @param {Array} coordinates - Array of {x, y, z} objects
 * @param {Object} metadata - Optional metadata from file (crs, projection info)
 * @returns {Array} - Array of {code, name, confidence, reason} suggestions sorted by confidence
 */
export const detectCRS = (coordinates, metadata = {}) => {
  if (!coordinates || coordinates.length === 0) {
    return [];
  }

  const suggestions = [];

  // 1. Check metadata first (highest confidence)
  const metadataCrs = detectFromMetadata(metadata);
  if (metadataCrs) {
    suggestions.push(...metadataCrs);
  }

  // 2. Analyze coordinate ranges
  const bounds = calculateBounds(coordinates);
  const rangeSuggestions = detectFromRanges(bounds);
  suggestions.push(...rangeSuggestions);

  // 3. Additional heuristics: extents (national grids), UTM trial transforms, swapped coords
  try {
    suggestions.push(...detectByExtents(bounds));
    suggestions.push(...tryInferUtmFromBounds(coordinates, bounds));
    suggestions.push(...tryInferProjectedFromCatalog(bounds));
    const swap = detectSwapCoordinates(coordinates);
    if (swap) suggestions.push(swap);
  } catch {
    // best-effort heuristics
  }

  // 4. Remove duplicates and sort by confidence
  const uniqueSuggestions = deduplicateSuggestions(suggestions);

  return uniqueSuggestions.sort((a, b) => b.confidence - a.confidence).slice(0, 8);
};

const hasReferenceMetadata = (metadata = {}) => {
  const crsName = metadata?.crs?.properties?.name;
  return Boolean(
    (typeof crsName === 'string' && crsName.trim())
    || metadata?.projection
    || metadata?.proj4
    || metadata?.epsg
    || metadata?.srid
  );
};

/**
 * Assess whether coordinates are likely georeferenced or local engineering coordinates.
 * @param {Array} coordinates - Array of {x, y, z}
 * @param {Object} metadata - Optional file metadata
 * @param {Array|null} suggestionsInput - Optional CRS suggestions from detectCRS
 * @returns {Object}
 */
export const assessReferenceSystem = (coordinates, metadata = {}, suggestionsInput = null) => {
  if (!coordinates || coordinates.length === 0) {
    return {
      status: 'unknown',
      isLocal: false,
      isAmbiguous: false,
      recommendedCrs: null,
      confidence: 0,
      reason: 'No coordinates available for CRS assessment',
    };
  }

  const suggestions = Array.isArray(suggestionsInput) ? suggestionsInput : detectCRS(coordinates, metadata);
  const top = suggestions[0] || null;
  const second = suggestions[1] || null;
  const topConfidence = top?.confidence || 0;
  const confidenceGap = top ? (topConfidence - (second?.confidence || 0)) : 0;
  const metadataDriven = hasReferenceMetadata(metadata);

  const bounds = calculateBounds(coordinates);
  const projectedLike = isProjected(bounds);
  const geographicLike = isGeographic(bounds);
  const smallNearOriginPlan = projectedLike
    && Math.abs(bounds.avgX) <= 200000
    && Math.abs(bounds.avgY) <= 200000
    && bounds.rangeX <= 50000
    && bounds.rangeY <= 50000;

  const weakTop = topConfidence < 0.68;
  const ambiguousTop = topConfidence < 0.9 && confidenceGap < 0.05;
  const localLikely = !metadataDriven && projectedLike && !geographicLike && (smallNearOriginPlan || suggestions.length === 0 || weakTop || ambiguousTop);

  if (localLikely) {
    const localReason = smallNearOriginPlan
      ? 'Projected coordinates are compact and near origin with no CRS metadata, which is typical of local engineering grids.'
      : 'No reliable CRS metadata and low-confidence projection match. Coordinates likely belong to a local engineering system.';
    return {
      status: 'local-unreferenced',
      isLocal: true,
      isAmbiguous: true,
      recommendedCrs: null,
      confidence: Math.max(0.65, 1 - topConfidence),
      reason: localReason,
    };
  }

  if (!top) {
    return {
      status: 'ambiguous',
      isLocal: false,
      isAmbiguous: true,
      recommendedCrs: null,
      confidence: 0,
      reason: 'No CRS candidates found from coordinate heuristics.',
    };
  }

  if (ambiguousTop) {
    return {
      status: 'ambiguous',
      isLocal: false,
      isAmbiguous: true,
      recommendedCrs: top.code,
      confidence: topConfidence,
      reason: `Top CRS candidates are close (${top.code} vs ${second?.code || 'n/a'}). Manual confirmation is recommended.`,
    };
  }

  return {
    status: 'referenced',
    isLocal: false,
    isAmbiguous: false,
    recommendedCrs: top.code,
    confidence: topConfidence,
    reason: top.reason || 'CRS heuristics indicate a referenced coordinate system.',
  };
};

/**
 * Extract CRS from file metadata
 */
const detectFromMetadata = (metadata) => {
  const suggestions = [];

  // GeoJSON crs property
  if (metadata.crs?.properties?.name) {
    const crsName = metadata.crs.properties.name;
    const epsgMatch = crsName.match(/EPSG[:\s]*(\d{4,5})/i);
    if (epsgMatch) {
      const code = `EPSG:${epsgMatch[1]}`;
      const crsInfo = CRS_LIST.find(c => c.code === code);
      if (crsInfo) {
        suggestions.push({
          code: code,
          name: crsInfo.name,
          confidence: 0.95,
          reason: 'Extracted from file metadata'
        });
      }
    }
  }

  // OGC URN format
  if (metadata.crs?.properties?.name?.includes('urn:ogc:def:crs')) {
    const urnMatch = metadata.crs.properties.name.match(/EPSG[:\s]*[:\s]*(\d{4,5})/i);
    if (urnMatch) {
      const code = `EPSG:${urnMatch[1]}`;
      const crsInfo = CRS_LIST.find(c => c.code === code);
      if (crsInfo) {
        suggestions.push({
          code: code,
          name: crsInfo.name,
          confidence: 0.95,
          reason: 'Extracted from OGC URN'
        });
      }
    }
  }

  // Custom projection string
  if (metadata.projection || metadata.proj4) {
    const proj4def = metadata.projection || metadata.proj4;
    // Try to match against known CRS definitions
    const matchingCrs = CRS_LIST.find(crs => {
      if (!crs.proj4def) return false;
      // Simple string similarity
      return crs.proj4def === proj4def;
    });
    
    if (matchingCrs) {
      suggestions.push({
        code: matchingCrs.code,
        name: matchingCrs.name,
        confidence: 0.90,
        reason: 'Matched proj4 definition'
      });
    }
  }

  return suggestions;
};

/**
 * Calculate coordinate bounds
 */
const calculateBounds = (coordinates) => {
  const xs = coordinates.map(c => parseFloat(c.x)).filter(v => Number.isFinite(v));
  const ys = coordinates.map(c => parseFloat(c.y)).filter(v => Number.isFinite(v));

  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
    rangeX: Math.max(...xs) - Math.min(...xs),
    rangeY: Math.max(...ys) - Math.min(...ys),
    avgX: xs.reduce((a, b) => a + b, 0) / xs.length,
    avgY: ys.reduce((a, b) => a + b, 0) / ys.length,
  };
};

/**
 * Detect CRS from coordinate ranges
 */
const detectFromRanges = (bounds) => {
  const suggestions = [];

  // Geographic coordinates (lat/lon)
  if (isGeographic(bounds)) {
    suggestions.push(...detectGeographic(bounds));
  }

  // Projected coordinates
  if (isProjected(bounds)) {
    suggestions.push(...detectProjected(bounds));
  }

  return suggestions;
};

/**
 * Check if coordinates are geographic (lat/lon)
 */
const isGeographic = (bounds) => {
  const { minX, maxX, minY, maxY } = bounds;
  
  // Latitude must be in [-90, 90], longitude in [-180, 180]
  return (
    minX >= -180 && maxX <= 180 &&
    minY >= -90 && maxY <= 90 &&
    Math.abs(minX) <= 180 && Math.abs(maxX) <= 180 &&
    Math.abs(minY) <= 90 && Math.abs(maxY) <= 90
  );
};

/**
 * Check if coordinates are projected
 */
const isProjected = (bounds) => {
  const { minX, maxX, minY, maxY } = bounds;
  
  // Projected coordinates typically have large values
  return (
    (Math.abs(minX) > 180 || Math.abs(maxX) > 180 ||
     Math.abs(minY) > 90 || Math.abs(maxY) > 90) &&
    // But not astronomically large
    Math.abs(minX) < 50000000 && Math.abs(maxX) < 50000000 &&
    Math.abs(minY) < 50000000 && Math.abs(maxY) < 50000000
  );
};

/**
 * Detect geographic CRS
 */
const detectGeographic = (bounds) => {
  const suggestions = [];
  const { avgX, avgY } = bounds;

  // Most common: WGS84
  suggestions.push({
    code: 'EPSG:4326',
    name: 'WGS 84 (GPS)',
    confidence: 0.80,
    reason: `Geographic coordinates (lon: ${avgX.toFixed(2)}, lat: ${avgY.toFixed(2)})`
  });

  // Europe region
  if (avgX >= -10 && avgX <= 40 && avgY >= 35 && avgY <= 70) {
    suggestions.push({
      code: 'EPSG:4258',
      name: 'ETRS89',
      confidence: 0.70,
      reason: 'Coordinates within Europe region'
    });
  }

  // North America
  if (avgX >= -130 && avgX <= -60 && avgY >= 25 && avgY <= 50) {
    suggestions.push({
      code: 'EPSG:4269',
      name: 'NAD83',
      confidence: 0.70,
      reason: 'Coordinates within North America region'
    });
  }

  // France region
  if (avgX >= -5 && avgX <= 10 && avgY >= 41 && avgY <= 51) {
    suggestions.push({
      code: 'EPSG:4171',
      name: 'RGF93 (France)',
      confidence: 0.75,
      reason: 'Coordinates within France region'
    });
  }

  return suggestions;
};

// Extents-based projection tables (France Lambert examples)
const FR_LAMBERT_EXTENTS = [
  { code: 'EPSG:2154', name: 'RGF93 / Lambert-93', xmin: 0, xmax: 1300000, ymin: 6000000, ymax: 7200000, confidence: 0.88 },
  // Lambert II étendue (extended Lambert II area)
  { code: 'EPSG:27562', name: 'Lambert II (étendue)', xmin: 0, xmax: 1200000, ymin: 1600000, ymax: 2700000, confidence: 0.62 },
  { code: 'EPSG:27561', name: 'Lambert I (France nord)', xmin: 0, xmax: 1200000, ymin: -700000, ymax: 400000, confidence: 0.62 },
  { code: 'EPSG:27562', name: 'Lambert II (France centre)', xmin: 0, xmax: 1200000, ymin: -400000, ymax: 700000, confidence: 0.62 },
  { code: 'EPSG:27563', name: 'Lambert III (France sud)', xmin: 0, xmax: 1200000, ymin: -100000, ymax: 1000000, confidence: 0.62 },
  { code: 'EPSG:27564', name: 'Lambert IV (Corse)', xmin: -600000, xmax: 600000, ymin: 100000, ymax: 1200000, confidence: 0.62 },
  { code: 'EPSG:27560', name: 'Lambert OACI', xmin: 100000, xmax: 1300000, ymin: -200000, ymax: 900000, confidence: 0.62 },
  // Add UTM rough extents for France zones
  { code: 'EPSG:32630', name: 'UTM 30N', xmin: 300000, xmax: 1600000, ymin: 4600000, ymax: 5700000, confidence: 0.74 },
  { code: 'EPSG:32631', name: 'UTM 31N', xmin: -200000, xmax: 1100000, ymin: 4500000, ymax: 5700000, confidence: 0.74 },
  { code: 'EPSG:32632', name: 'UTM 32N', xmin: -600000, xmax: 5300000, ymin: 4500000, ymax: 5700000, confidence: 0.74 }
];

// Additional common grids / zones (approximate extents)
FR_LAMBERT_EXTENTS.push(
  { code: 'EPSG:25830', name: 'ETRS89 / UTM zone 30N', xmin: 300000, xmax: 1600000, ymin: 4600000, ymax: 5700000, confidence: 0.72 },
  { code: 'EPSG:25831', name: 'ETRS89 / UTM zone 31N', xmin: -200000, xmax: 1100000, ymin: 4500000, ymax: 5700000, confidence: 0.72 },
  { code: 'EPSG:25832', name: 'ETRS89 / UTM zone 32N', xmin: -600000, xmax: 5300000, ymin: 4500000, ymax: 5700000, confidence: 0.72 },
  { code: 'EPSG:3035', name: 'ETRS89 / LAEA Europe', xmin: -4000000, xmax: 9000000, ymin: -4000000, ymax: 9000000, confidence: 0.7 },
  { code: 'EPSG:21781', name: 'CH1903 / LV03 (Switzerland)', xmin: 480000, xmax: 840000, ymin: 60000, ymax: 310000, confidence: 0.87 },
  { code: 'EPSG:28992', name: 'Amersfoort / RD New (Netherlands)', xmin: -250000, xmax: 850000, ymin: 250000, ymax: 625000, confidence: 0.84 },
  { code: 'EPSG:27700', name: 'OSGB 1936 / British National Grid', xmin: 0, xmax: 700000, ymin: 0, ymax: 1300000, confidence: 0.86 },
  { code: 'EPSG:2157', name: 'IRENET95 / Irish Transverse Mercator', xmin: 350000, xmax: 900000, ymin: 550000, ymax: 1000000, confidence: 0.86 }
);

for (let zone = 42; zone <= 50; zone += 1) {
  const y0 = 1200000 + ((zone - 42) * 1000000);
  FR_LAMBERT_EXTENTS.push({
    code: `EPSG:${3900 + zone}`,
    name: `RGF93 / CC${zone}`,
    xmin: 700000,
    xmax: 2700000,
    ymin: y0 - 800000,
    ymax: y0 + 800000,
    confidence: 0.9,
  });
}

const extentConfidence = (entry, swapped = false) => {
  const base = Number.isFinite(entry?.confidence) ? entry.confidence : 0.76;
  const adjusted = swapped ? Math.min(0.92, base + 0.04) : base;
  return adjusted;
};

const detectByExtents = (bounds, table = FR_LAMBERT_EXTENTS) => {
  if (!isProjected(bounds)) return [];

  const hits = [];
  const { avgX, avgY } = bounds;
  for (const p of table) {
    // Match if average point falls inside extents OR full bounds are contained in extents
    const avgInside = (avgX >= p.xmin && avgX <= p.xmax && avgY >= p.ymin && avgY <= p.ymax);
    const fullContained = (bounds.minX >= p.xmin && bounds.maxX <= p.xmax && bounds.minY >= p.ymin && bounds.maxY <= p.ymax);
    if (avgInside || fullContained) {
      hits.push({ code: p.code, name: p.name, confidence: extentConfidence(p, false), reason: 'Within projection extents' });
      continue;
    }

    const avgInsideSwapped = (avgY >= p.xmin && avgY <= p.xmax && avgX >= p.ymin && avgX <= p.ymax);
    const fullContainedSwapped = (bounds.minY >= p.xmin && bounds.maxY <= p.xmax && bounds.minX >= p.ymin && bounds.maxX <= p.ymax);
    if (avgInsideSwapped || fullContainedSwapped) {
      hits.push({
        code: p.code,
        name: p.name,
        confidence: extentConfidence(p, true),
        reason: 'Within projection extents after swapping X/Y axes',
      });
    }
  }
  return hits;
};

const UTM_X_RANGE = [100000, 900000];
const UTM_Y_RANGE = [0, 10000000];

const isWithinRange = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const parseProj4Token = (proj4def, tokenName) => {
  if (typeof proj4def !== 'string' || !proj4def) return null;
  const match = proj4def.match(new RegExp(`(?:^|\\s)\\+${tokenName}=([^\\s]+)`));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
};

const getCrsProjectionHints = (crsCode) => {
  const crs = CRS_BY_CODE.get(crsCode);
  if (!crs?.proj4def) return null;

  const projNameMatch = crs.proj4def.match(/(?:^|\s)\+proj=([^\s]+)/);
  const zoneMatch = crs.proj4def.match(/(?:^|\s)\+zone=(\d{1,2})/);
  const x0 = parseProj4Token(crs.proj4def, 'x_0');
  const y0 = parseProj4Token(crs.proj4def, 'y_0');
  const lat0 = parseProj4Token(crs.proj4def, 'lat_0');
  let lon0 = parseProj4Token(crs.proj4def, 'lon_0');
  const zone = zoneMatch ? Number(zoneMatch[1]) : null;
  if (!Number.isFinite(lon0) && Number.isFinite(zone)) {
    lon0 = ((zone - 1) * 6) - 180 + 3;
  }

  return {
    x0,
    y0,
    lat0,
    lon0,
    zone,
    south: /(?:^|\s)\+south(?:\s|$)/.test(crs.proj4def),
    projName: projNameMatch?.[1] || null,
  };
};

const lonDelta = (lon, refLon) => {
  if (!Number.isFinite(lon) || !Number.isFinite(refLon)) return null;
  return Math.abs((((lon - refLon) + 180) % 360 + 360) % 360 - 180);
};

const clampScore = (value, min, max) => Math.max(min, Math.min(max, value));

const scoreAxisOrientationForCrs = (crsCode, first, second) => {
  if (!ensureCrsDefinition(crsCode)) return Number.NEGATIVE_INFINITY;
  const hints = getCrsProjectionHints(crsCode);
  let score = 0;

  if (hints?.x0 !== null && hints?.y0 !== null) {
    const directDistance = Math.abs(first - hints.x0) + Math.abs(second - hints.y0);
    const inverseDistance = Math.abs(first - hints.y0) + Math.abs(second - hints.x0);
    if (Number.isFinite(directDistance) && Number.isFinite(inverseDistance)) {
      if (directDistance + 1 < inverseDistance) score += 1.25;
      if (inverseDistance + 1 < directDistance) score -= 1.25;
    }
  }

  try {
    const [lon, lat] = proj4(crsCode, 'EPSG:4326', [first, second]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return Number.NEGATIVE_INFINITY;
    }

    score += 1;

    const lonDiff = lonDelta(lon, hints?.lon0);
    if (Number.isFinite(lonDiff)) {
      score += Math.max(0, (18 - lonDiff) / 18);
    }

    if (Number.isFinite(hints?.lat0)) {
      const latDiff = Math.abs(lat - hints.lat0);
      score += Math.max(0, (18 - latDiff) / 18);
    }

    if (hints?.projName === 'utm' && Number.isFinite(hints.zone)) {
      const zoneCenterLon = ((hints.zone - 1) * 6) - 180 + 3;
      const zoneDiff = lonDelta(lon, zoneCenterLon);
      if (Number.isFinite(zoneDiff)) {
        score += Math.max(0, (6 - zoneDiff) / 6);
      }
      if (hints.south && lat < 0) score += 0.35;
      if (!hints.south && lat >= 0) score += 0.35;
    }
  } catch {
    return Number.NEGATIVE_INFINITY;
  }

  return score;
};

const buildProjectedCatalogCandidates = () => CRS_LIST
  .filter((entry) => entry?.type === 'projected' && entry?.code && entry?.proj4def)
  .map((entry) => {
    const hints = getCrsProjectionHints(entry.code);
    if (!hints) return null;
    return {
      code: entry.code,
      name: entry.label || entry.name || entry.code,
      hints,
    };
  })
  .filter(Boolean);

const PROJECTED_CATALOG_CANDIDATES = buildProjectedCatalogCandidates();

const chooseCatalogShortlist = (bounds) => {
  const { avgX, avgY } = bounds;
  if (!Number.isFinite(avgX) || !Number.isFinite(avgY)) return [];

  return PROJECTED_CATALOG_CANDIDATES
    .map((candidate) => {
      const x0 = candidate.hints?.x0;
      const y0 = candidate.hints?.y0;
      let closeness = Number.POSITIVE_INFINITY;

      if (Number.isFinite(x0) && Number.isFinite(y0)) {
        const normalDistance = Math.abs(avgX - x0) + Math.abs(avgY - y0);
        const swappedDistance = Math.abs(avgY - x0) + Math.abs(avgX - y0);
        closeness = Math.min(normalDistance, swappedDistance);
      } else if (candidate.hints?.projName === 'utm') {
        const eastingDistance = Math.min(Math.abs(avgX - 500000), Math.abs(avgY - 500000));
        closeness = eastingDistance;
      }

      return {
        ...candidate,
        closeness,
      };
    })
    .filter((candidate) => Number.isFinite(candidate.closeness))
    .filter((candidate) => {
      if (candidate.hints?.projName === 'utm') return true;
      return candidate.closeness <= 3000000;
    })
    .sort((a, b) => a.closeness - b.closeness)
    .slice(0, 100);
};

const tryInferProjectedFromCatalog = (bounds) => {
  const suggestions = [];
  if (!isProjected(bounds)) return suggestions;

  const shortlist = chooseCatalogShortlist(bounds);
  shortlist.forEach((candidate) => {
    const normalScore = scoreAxisOrientationForCrs(candidate.code, bounds.avgX, bounds.avgY);
    const swappedScore = scoreAxisOrientationForCrs(candidate.code, bounds.avgY, bounds.avgX);
    const bestScore = Math.max(normalScore, swappedScore);

    if (!Number.isFinite(bestScore) || bestScore < 1.85) return;

    const swapped = swappedScore > normalScore + 0.75;
    const closenessPenalty = Math.min((candidate.closeness || 0) / 2000000, 0.45);
    const confidence = clampScore(0.45 + ((bestScore - 1.85) * 0.08) - closenessPenalty, 0.35, 0.72);
    suggestions.push({
      code: candidate.code,
      name: candidate.name,
      confidence,
      reason: swapped
        ? 'Catalog plausibility suggests swapped projected axes'
        : 'Catalog plausibility from projection parameters',
    });
  });

  return deduplicateSuggestions(suggestions)
    .filter((entry) => entry.confidence >= 0.6)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 4);
};

const getAxisExtentRulesForCrs = (crsCode) => {
  const extentMatches = FR_LAMBERT_EXTENTS.filter((entry) => entry.code === crsCode);
  if (extentMatches.length > 0) {
    return extentMatches.map((entry) => ({
      xmin: entry.xmin,
      xmax: entry.xmax,
      ymin: entry.ymin,
      ymax: entry.ymax,
    }));
  }

  if (/^EPSG:(326|327)\d{2}$/.test(crsCode) || /^EPSG:258(2\d|3[0-2])$/.test(crsCode)) {
    return [{ xmin: UTM_X_RANGE[0], xmax: UTM_X_RANGE[1], ymin: UTM_Y_RANGE[0], ymax: UTM_Y_RANGE[1] }];
  }

  return [];
};

export const shouldSwapCoordinateAxesForCrs = (crsCode, x, y) => {
  if (!crsCode || !Number.isFinite(x) || !Number.isFinite(y)) return false;

  const extentRules = getAxisExtentRulesForCrs(crsCode);
  if (extentRules.length > 0) {
    let normalMatchCount = 0;
    let swappedMatchCount = 0;
    extentRules.forEach((rule) => {
      if (isWithinRange(x, rule.xmin, rule.xmax) && isWithinRange(y, rule.ymin, rule.ymax)) {
        normalMatchCount += 1;
      }
      if (isWithinRange(y, rule.xmin, rule.xmax) && isWithinRange(x, rule.ymin, rule.ymax)) {
        swappedMatchCount += 1;
      }
    });

    if (swappedMatchCount > 0 && normalMatchCount === 0) return true;
    if (normalMatchCount > 0 && swappedMatchCount === 0) return false;
  }

  const normalScore = scoreAxisOrientationForCrs(crsCode, x, y);
  const swappedScore = scoreAxisOrientationForCrs(crsCode, y, x);
  if (!Number.isFinite(swappedScore)) return false;
  if (!Number.isFinite(normalScore)) return true;

  return swappedScore > normalScore + 0.75;
};

export const normalizeCoordinateAxesForCrs = (crsCode, x, y) => (
  shouldSwapCoordinateAxesForCrs(crsCode, x, y) ? [y, x] : [x, y]
);

/**
 * Try to infer UTM zone by trial-transforming average/projected coordinates
 * Returns suggestions array
 */
const tryInferUtmFromBounds = (coordinates, bounds) => {
  const suggestions = [];
  if (!coordinates || coordinates.length === 0) return suggestions;
  const { avgX, avgY } = bounds;

  // Only attempt when values look projected (large numeric ranges)
  if (!(Math.abs(avgX) > 10000 || Math.abs(avgY) > 10000)) return suggestions;

  // Try candidate UTM zones 1..60 for both hemispheres
  for (let zone = 1; zone <= 60; zone++) {
    const zoneStr = String(zone).padStart(2, '0');
    for (const hemi of ['N', 'S']) {
      const code = hemi === 'N' ? `EPSG:326${zoneStr}` : `EPSG:327${zoneStr}`;
      try {
        if (!ensureCrsDefinition(code)) continue;
        // Transform projected avg to geographic lon/lat
        const [lon, lat] = proj4(code, 'EPSG:4326', [avgX, avgY]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        // central meridian for zone
        const cm = (zone - 1) * 6 - 180 + 3;
        const lonDiff = Math.abs(((lon - cm + 180 + 360) % 360) - 180);
        // Score based on closeness to central meridian and reasonable latitude
        if (lat <= 90 && lat >= -90 && lonDiff < 6) {
          const confidence = Math.max(0.46, 0.64 - lonDiff / 15);
          suggestions.push({ code, name: `WGS 84 / UTM zone ${zone}${hemi}`, confidence, reason: 'Trial transform plausibility' });
        }
      } catch {
        // ignore transform failures
      }
    }
  }

  // Deduplicate by code keeping highest confidence
  return deduplicateSuggestions(suggestions).slice(0, 6);
};

/**
 * Detect if coordinates are likely swapped lon/lat (i.e., lat and lon reversed)
 */
const detectSwapCoordinates = (coordinates) => {
  if (!coordinates || coordinates.length === 0) return null;
  let swappedValid = 0;
  let normalValid = 0;
  const sample = coordinates.slice(0, 20);
  for (const c of sample) {
    const x = parseFloat(c.x);
    const y = parseFloat(c.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    // normal: x lon in [-180,180], y lat in [-90,90]
    if (x >= -180 && x <= 180 && y >= -90 && y <= 90) normalValid++;
    // swapped: swap x/y
    if (y >= -180 && y <= 180 && x >= -90 && x <= 90) swappedValid++;
  }
  if (swappedValid > normalValid && swappedValid >= Math.max(2, sample.length / 3)) {
    return { code: 'EPSG:4326', name: 'WGS84 (swapped lon/lat)', confidence: 0.7, reason: 'Coordinates likely have lon/lat swapped' };
  }
  return null;
};

/**
 * Detect projected CRS
 */
const detectProjected = (bounds) => {
  const suggestions = [];
  const { minX, maxX, minY, maxY, avgX, avgY } = bounds;

  // UTM detection
  const utmSuggestions = detectUTM(bounds);
  suggestions.push(...utmSuggestions);

  // Lambert Conformal Conic (France)
  if (avgX >= 0 && avgX <= 1500000 && avgY >= 6000000 && avgY <= 7200000) {
    suggestions.push({
      code: 'EPSG:2154',
      name: 'RGF93 / Lambert-93 (France)',
      confidence: 0.85,
      reason: `Easting ~${Math.round(avgX/1000)}km, Northing ~${Math.round(avgY/1000)}km matches Lambert-93`
    });
  }

  // Web Mercator
  if (Math.abs(minX) < 20037509 && Math.abs(maxX) < 20037509 &&
      Math.abs(minY) < 20037509 && Math.abs(maxY) < 20037509 &&
      (Math.abs(avgX) > 100000 || Math.abs(avgY) > 100000)) {
    suggestions.push({
      code: 'EPSG:3857',
      name: 'Web Mercator (Google Maps)',
      confidence: 0.75,
      reason: 'Coordinates within Web Mercator bounds'
    });
  }

  // British National Grid
  if (avgX >= 0 && avgX <= 700000 && avgY >= 0 && avgY <= 1300000) {
    suggestions.push({
      code: 'EPSG:27700',
      name: 'OSGB 1936 / British National Grid',
      confidence: 0.80,
      reason: 'Coordinates match British National Grid extents'
    });
  }

  // Irish Grid
  if (avgX >= 0 && avgX <= 500000 && avgY >= 0 && avgY <= 500000) {
    suggestions.push({
      code: 'EPSG:29903',
      name: 'TM75 / Irish Grid',
      confidence: 0.70,
      reason: 'Coordinates match Irish Grid extents'
    });
  }

  return suggestions;
};

/**
 * Detect UTM zone from projected coordinates
 */
const detectUTM = (bounds) => {
  const suggestions = [];
  const { avgX, avgY } = bounds;

  // UTM coordinates typically:
  // - Easting: 160,000 to 840,000 (500,000 ± 340,000)
  // - Northing: 0 to 10,000,000 (northern hemisphere) or 0 to 10,000,000 (southern from equator)

  // Check if X is in UTM easting range
  const isUtmEasting = avgX >= 100000 && avgX <= 900000;
  
  // Check if Y is in UTM northing range
  const isUtmNorthing = (avgY >= 0 && avgY <= 10000000);

  if (isUtmEasting && isUtmNorthing) {
    // Estimate hemisphere
    const isNorthern = avgY > 1000000; // Southern hemisphere typically starts from equator
    
    // Estimate zone from easting (very rough - would need actual lon/lat)
    // Central meridian is at 500,000 easting
    // Each zone is 6° wide
    // We can't accurately determine zone without lon, so suggest common ones
    
    if (isNorthern) {
      // Suggest based on typical ranges
      // Europe: zones 28-38
      if (avgX >= 200000 && avgX <= 800000 && avgY >= 4000000 && avgY <= 6500000) {
        suggestions.push({
          code: 'EPSG:32631',
          name: 'WGS 84 / UTM zone 31N',
          confidence: 0.48,
          reason: `UTM Northern (E: ${Math.round(avgX/1000)}km, N: ${Math.round(avgY/1000)}km)`
        });
        suggestions.push({
          code: 'EPSG:32632',
          name: 'WGS 84 / UTM zone 32N',
          confidence: 0.45,
          reason: 'UTM Northern - adjacent zone'
        });
        suggestions.push({
          code: 'EPSG:32630',
          name: 'WGS 84 / UTM zone 30N',
          confidence: 0.45,
          reason: 'UTM Northern - adjacent zone'
        });
      } else {
        // Generic northern UTM
        suggestions.push({
          code: 'EPSG:32633',
          name: 'WGS 84 / UTM zone 33N',
          confidence: 0.42,
          reason: 'UTM Northern hemisphere'
        });
      }
    } else {
      // Southern hemisphere
      suggestions.push({
        code: 'EPSG:32733',
        name: 'WGS 84 / UTM zone 33S',
        confidence: 0.42,
        reason: 'UTM Southern hemisphere'
      });
    }
  }

  return suggestions;
};



/**
 * Remove duplicate CRS suggestions
 */
const deduplicateSuggestions = (suggestions) => {
  const seen = new Map();
  
  suggestions.forEach(s => {
    if (!seen.has(s.code) || seen.get(s.code).confidence < s.confidence) {
      seen.set(s.code, s);
    }
  });
  
  return Array.from(seen.values());
};

/**
 * Validate detected CRS by attempting transformation
 * @param {Array} coordinates - Sample coordinates
 * @param {String} detectedCrs - Detected CRS code
 * @returns {Boolean} - True if transformation is valid
 */
export const validateDetectedCRS = (coordinates, detectedCrs) => {
  if (!coordinates || coordinates.length === 0) return false;
  
  try {
    if (!ensureCrsDefinition(detectedCrs)) return false;
    // Try to transform first coordinate to WGS84
    const firstCoord = coordinates[0];
    const x = parseFloat(firstCoord.x);
    const y = parseFloat(firstCoord.y);
    
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    
    const [lon, lat] = proj4(detectedCrs, 'EPSG:4326', [x, y]);
    
    // Check if result is valid geographic coordinates
    return (
      Number.isFinite(lon) && Number.isFinite(lat) &&
      lon >= -180 && lon <= 180 &&
      lat >= -90 && lat <= 90
    );
  } catch {
    return false;
  }
};

/**
 * Auto-detect CRS from a single coordinate pair
 * @param {Number} x - X coordinate
 * @param {Number} y - Y coordinate
 * @returns {Array} - Suggestions
 */
export const detectCRSFromSinglePoint = (x, y) => {
  return detectCRS([{ x, y }]);
};
