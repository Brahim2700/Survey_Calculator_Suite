// src/components/CoordinateConverter.jsx
// Main UI for converting coordinates between any two CRS (EPSG codes).
// Supports single-point and bulk conversion plus optional geoid height handling.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { detectCRSFromSinglePoint, detectCRS } from "../utils/crsDetection";
import proj4 from "proj4";
import CRS_LIST from "../crsList";
import CrsSearchSelector from "./CrsSearchSelector";
import GeoidLoader from "./GeoidLoader";
import { tryParseWKT, tryParseUTM, parseHemisphericNumber, parseGeoJSONFile, parseGPXFile, parseKMLFile, parseShapefileZip, parseXLSXFile, parseDXFFile, parseDWGFile } from "../utils/fileImport";
import { getCadBackendStatus } from "../utils/cadApi";
import { exportAsCSV, exportAsGeoJSON, exportAsKML, exportAsGPX, exportAsXLSX, exportAsWKT, exportAsDXF, exportAllFormats, downloadFile } from "../utils/exportData";
// Import the map visualization component
import MapVisualization from "./MapVisualization";
import { on, emit } from "../utils/eventBus";

// Lazy-load geoid utilities only when requested so the main bundle stays small
let geoidModulePromise = null;
const loadGeoidModule = () => {
  if (!geoidModulePromise) {
    geoidModulePromise = import("../utils/geoid");
  }
  return geoidModulePromise;
};

const formatBytes = (value) => {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
};

const buildCadInspectionSummary = (file, rows, status, payload = null) => {
  const xs = rows.map((row) => Number(row.x)).filter(Number.isFinite);
  const ys = rows.map((row) => Number(row.y)).filter(Number.isFinite);
  const zs = rows.map((row) => Number(row.z)).filter(Number.isFinite);
  const detectedFromCrs = rows.find((row) => row.detectedFromCrs)?.detectedFromCrs || payload?.inspection?.detectedFromCrs || null;
  const extension = `.${(file?.name.split('.')?.pop() || '').toLowerCase()}`;
  const route = payload?.inspection?.processingRoute
    || (extension === ".dwg" ? (status?.dwgEnabled ? "dwg-converted" : "dwg-backend-unavailable") : "local-dxf");

  return {
    fileName: file?.name || null,
    extension,
    fileSizeBytes: file?.size || 0,
    rowCount: rows.length,
    detectedFromCrs,
    warnings: payload?.warnings || [],
    nativeDwg: payload?.inspection?.nativeDwg || false,
    usedConverter: payload?.inspection?.usedConverter || false,
    processingRoute: route,
    bounds: {
      minX: xs.length ? Math.min(...xs) : null,
      maxX: xs.length ? Math.max(...xs) : null,
      minY: ys.length ? Math.min(...ys) : null,
      maxY: ys.length ? Math.max(...ys) : null,
      minZ: zs.length ? Math.min(...zs) : null,
      maxZ: zs.length ? Math.max(...zs) : null,
    },
    backendMode: status?.converterMode || "none",
    backendPath: status?.converterPath || null,
  };
};

// Register all CRS definitions for proj4 one time
const registerCRS = () => {
  CRS_LIST.forEach((crs) => {
    // Remove nadgrids parameter if it exists, as grid files may not be available
    let proj4def = crs.proj4def;
    if (proj4def && proj4def.includes('+nadgrids=')) {
      proj4def = proj4def.replace(/\+nadgrids=[^\s]+\s*/g, '');
      console.log(`Removed nadgrids from ${crs.code}`);
    }
    proj4.defs(crs.code, proj4def);
  });
};

// ---- UTM helpers ----
const isUtmCode = (code) => /^EPSG:(326|327)(0[1-9]|[1-5][0-9]|60)$/.test(code);
const parseUtmFromEpsg = (code) => {
  const m = /^EPSG:(326|327)(\d{2})$/.exec(code);
  if (!m) return null;
  const hemi = m[1] === "326" ? "N" : "S";
  const zone = parseInt(m[2], 10);
  return { zone, hemi };
};
const utmZoneFromLon = (lon) => Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
const hemisphereFromLat = (lat) => (lat >= 0 ? "N" : "S");
const isUtmValidForLat = (lat) => lat <= 84 && lat >= -80;
const upsSuggestion = (lat) => (lat > 84 ? "Use UPS North" : lat < -80 ? "Use UPS South" : null);

// ---- French CC (Conical Conformal) helpers ----
const isCcCode = (code) => /^EPSG:(3942|3943|3944|3945|3946|3947|3948|3949|3950)$/.test(code);
const parseCcFromEpsg = (code) => {
  const m = /^EPSG:(394[0-9])$/.exec(code);
  if (!m) return null;
  const zone = parseInt(m[1].slice(2), 10);
  return { zone };
};
const ccZoneFromLat = (lat) => {
  if (lat < 43) return 42;
  if (lat < 44) return 43;
  if (lat < 45) return 44;
  if (lat < 46) return 45;
  if (lat < 47) return 46;
  if (lat < 48) return 47;
  if (lat < 49) return 48;
  if (lat < 50) return 49;
  return 50;
};
const ccOptimalLatRange = (zone) => {
  const ranges = {
    42: [null, 43, 42.5],
    43: [null, 44, 43.5],
    44: [43, 45, 44],
    45: [44, 46, 45],
    46: [45, 47, 46],
    47: [46, 48, 47],
    48: [47, 49, 48],
    49: [48, 50, 49],
    50: [49, null, 50],
  };
  return ranges[zone] || [null, null, zone];
};

// ---- German Gauss-Krüger helpers ----
const isGkCode = (code) => /^EPSG:(31466|31467|31468|31469|31256|31257|31258|31259|31260|31261|31262|31263|31264|31265|31266|31267|31268|31269)$/.test(code);
const parseGkFromEpsg = (code) => {
  // German DHDN zones: 31466-31469 (zones 2-5)
  let m = /^EPSG:3146([6-9])$/.exec(code);
  if (m) {
    const zoneDigit = parseInt(m[1], 10);
    return { zone: zoneDigit - 4 }; // 6->2, 7->3, 8->4, 9->5
  }
  // Austrian zones: 31256-31269
  m = /^EPSG:3125([6-9])$/.exec(code);
  if (m) {
    const zoneDigit = parseInt(m[1], 10);
    return { zone: zoneDigit };
  }
  m = /^EPSG:3126([0-9])$/.exec(code);
  if (m) {
    const zoneDigit = parseInt(m[1], 10);
    return { zone: zoneDigit };
  }
  return null;
};
const gkZoneFromLon = (lon) => {
  // GK zones are 3-degree bands: 6°E (zone 2), 9°E (zone 3), 12°E (zone 4), 15°E (zone 5)
  const zones = [{ lon: 6, zone: 2 }, { lon: 9, zone: 3 }, { lon: 12, zone: 4 }, { lon: 15, zone: 5 }];
  for (const z of zones) {
    if (Math.abs(lon - z.lon) <= 1.5) return z.zone;
  }
  return null;
};

// ---- Spanish National Grid helpers ----
const isSpainCode = (code) => /^EPSG:(2062|2063|2064|2065|2066|2067|2068|2069|2070)$/.test(code);
const parseSpainFromEpsg = (code) => {
  const m = /^EPSG:20([0-9]{2})$/.exec(code);
  if (!m) return null;
  const zone = parseInt(m[1], 10);
  return { zone };
};
const spainZoneFromLonLat = (lon) => {
  // Spanish system based on UTM zones but customized
  return utmZoneFromLon(lon);
};

// ---- Australian MGA helpers ----
const isMgaCode = (code) => /^EPSG:(28348|28349|28350|28351|28352|28353|28354|28355|28356|28357|28358)$/.test(code);
const parseMgaFromEpsg = (code) => {
  const m = /^EPSG:2835([0-9])$/.exec(code);
  if (!m) return null;
  const zone = parseInt(m[1], 10);
  return { zone };
};
const mgaZoneFromLon = (lon) => {
  // MGA zones: 48-58 (6-degree bands from 114°E to 156°E)
  return Math.min(58, Math.max(48, Math.floor((lon + 180) / 6) + 1));
};

// ---- Canadian UTM helpers ----
const _parseCanadaFromEpsg = (code) => {
  const m = /^EPSG:(296[0-4]|2955|2927)$/.exec(code);
  if (!m) return null;
  const zone = parseInt(m[1].slice(-1), 10) || parseInt(m[1].slice(-2), 10);
  return { zone };
};

// ---- British National Grid ----
const isBngCode = (code) => code === "EPSG:27700";
const getBngInfo = (lon, lat) => {
  const inUK = lon >= -8 && lon <= 2 && lat >= 49 && lat <= 60;
  return { inUK, suggested: "BNG", outOfArea: !inUK };
};

// ---- Irish Grid ----
const isIgCode = (code) => code === "EPSG:29900";
const getIgInfo = (lon, lat) => {
  const inIreland = lon >= -10.5 && lon <= -5.5 && lat >= 51.5 && lat <= 55.5;
  return { inIreland, suggested: "IGS", outOfArea: !inIreland };
};

// ---- Japanese Zones ----
const isJgdCode = (code) => /^EPSG:(2443|2444|2445|2446|2447|2448|2449|2450|2451)$/.test(code);
const parseJgdFromEpsg = (code) => {
  const m = /^EPSG:244([0-9])$/.exec(code);
  if (!m) return null;
  const zone = parseInt(m[1], 10);
  return { zone };
};
const jgdZoneFromLon = (lon) => {
  // JGD zones 1-9: 3-degree bands starting from 123°E
  if (lon < 123) return null;
  return Math.min(9, Math.max(1, Math.floor((lon - 123) / 3) + 1));
};

// ---- South Africa Gauss Conform ----
const isSaGaussCode = (code) => /^EPSG:(2045|2046|2047|2048|2049|2050|2051|2052|2053|2054)$/.test(code);
const parseSaGaussFromEpsg = (code) => {
  const m = /^EPSG:20([0-9]{2})$/.exec(code);
  if (!m) return null;
  const zoneNum = parseInt(m[1], 10);
  if (zoneNum >= 45 && zoneNum <= 54) {
    return { zone: zoneNum - 44 }; // Convert EPSG to zone 1-10
  }
  return null;
};
const saGaussZoneFromLon = (lon) => {
  // South Africa Gauss Conform: 10 zones, 2-degree bands from 12°E to 32°E
  if (lon < 12 || lon > 32) return null;
  return Math.min(10, Math.max(1, Math.floor((lon - 12) / 2) + 1));
};

// ---- Egypt Local Systems ----
const isEgyptCode = (code) => /^EPSG:(2089|3889|20137|20138)$/.test(code);
const getEgyptInfo = (lon, lat) => {
  const inEgypt = lon >= 24 && lon <= 37 && lat >= 22 && lat <= 32;
  return { inEgypt, region: "Egypt", outOfArea: !inEgypt };
};

// ---- Morocco Local Systems ----
const isMoroccoCode = (code) => /^EPSG:(2305|2306|2307|2308|2309|2310|2311|2312|2313|2314)$/.test(code);
const getMoroccoInfo = (lon, lat) => {
  const inMorocco = lon >= -13 && lon <= -1 && lat >= 27 && lat <= 36;
  return { inMorocco, region: "Morocco", outOfArea: !inMorocco };
};

// ---- Algeria Local Systems ----
const isAlgeriaCode = (code) => /^EPSG:(2340|2341|30729|30730|30731|30732|30791|30792)$/.test(code);
const getAlgeriaInfo = (lon, lat) => {
  const inAlgeria = lon >= -8 && lon <= 12 && lat >= 19 && lat <= 37;
  return { inAlgeria, region: "Algeria", outOfArea: !inAlgeria };
};

// ---- Tunisia Local Systems ----
const isTunisiaCode = (code) => /^EPSG:(2038|2039|3857|22332|22333)$/.test(code);
const getTunisiaInfo = (lon, lat) => {
  const inTunisia = lon >= 8 && lon <= 12 && lat >= 30 && lat <= 38;
  return { inTunisia, region: "Tunisia", outOfArea: !inTunisia };
};

// ---- Generic zone-based CRS detection ----
const getSuggestedZoneInfo = (lon, lat, toCrs) => {
  if (isUtmCode(toCrs)) {
    const suggested = { zone: utmZoneFromLon(lon), hemi: hemisphereFromLat(lat) };
    const selected = parseUtmFromEpsg(toCrs);
    const mismatch = selected && (selected.zone !== suggested.zone || selected.hemi !== suggested.hemi);
    const ups = isUtmValidForLat(lat) ? null : upsSuggestion(lat);
    return { type: "utm", suggested, selected, mismatch, ups };
  } else if (isCcCode(toCrs)) {
    const suggested = ccZoneFromLat(lat);
    const selected = parseCcFromEpsg(toCrs);
    const selectedZone = selected ? selected.zone : null;
    const mismatch = selectedZone && selectedZone !== suggested;
    const [minLat, maxLat, centerLat] = ccOptimalLatRange(suggested);
    const outOfBand = lat < minLat || lat > maxLat;
    return { type: "cc", suggested, selectedZone, mismatch, centerLat, minLat, maxLat, outOfBand };
  } else if (isGkCode(toCrs)) {
    const suggested = gkZoneFromLon(lon);
    const selected = parseGkFromEpsg(toCrs);
    const mismatch = suggested && selected && selected.zone !== suggested;
    return { type: "gk", suggested, selected: selected?.zone, mismatch, region: "Germany" };
  } else if (isSpainCode(toCrs)) {
    const suggested = spainZoneFromLonLat(lon, lat);
    const selected = parseSpainFromEpsg(toCrs);
    const mismatch = selected && selected.zone !== suggested;
    return { type: "spain", suggested, selected: selected?.zone, mismatch, region: "Spain" };
  } else if (isMgaCode(toCrs)) {
    const suggested = mgaZoneFromLon(lon);
    const selected = parseMgaFromEpsg(toCrs);
    const mismatch = selected && selected.zone !== suggested;
    return { type: "mga", suggested, selected: selected?.zone, mismatch, region: "Australia" };
  } else if (isBngCode(toCrs)) {
    const info = getBngInfo(lon, lat);
    return { type: "bng", ...info, region: "Britain" };
  } else if (isIgCode(toCrs)) {
    const info = getIgInfo(lon, lat);
    return { type: "ig", ...info, region: "Ireland" };
  } else if (isJgdCode(toCrs)) {
    const suggested = jgdZoneFromLon(lon);
    const selected = parseJgdFromEpsg(toCrs);
    const mismatch = suggested && selected && selected.zone !== suggested;
    return { type: "jgd", suggested, selected: selected?.zone, mismatch, region: "Japan" };
  } else if (isSaGaussCode(toCrs)) {
    const suggested = saGaussZoneFromLon(lon);
    const selected = parseSaGaussFromEpsg(toCrs);
    const mismatch = suggested && selected && selected.zone !== suggested;
    return { type: "sagauss", suggested, selected: selected?.zone, mismatch, region: "South Africa" };
  } else if (isEgyptCode(toCrs)) {
    const info = getEgyptInfo(lon, lat);
    return { type: "egypt", ...info };
  } else if (isMoroccoCode(toCrs)) {
    const info = getMoroccoInfo(lon, lat);
    return { type: "morocco", ...info };
  } else if (isAlgeriaCode(toCrs)) {
    const info = getAlgeriaInfo(lon, lat);
    return { type: "algeria", ...info };
  } else if (isTunisiaCode(toCrs)) {
    const info = getTunisiaInfo(lon, lat);
    return { type: "tunisia", ...info };
  }
  return null;
};

// Format helpers
const fmtNum = (v, digits) => (Number.isFinite(v) ? v.toFixed(digits) : "");

// Determine if a CRS is geographic (lat/lon) or projected (cartesian)
const isGeographic = (crsCode) => {
  const crs = CRS_LIST.find((c) => c.code === crsCode);
  return crs ? crs.type === "geographic" : false;
};

// Get transformation accuracy/uncertainty for CRS pair (in cm)
const getTransformationAccuracy = (fromCrs, toCrs) => {
  // Default accuracy estimates for common transformations
  const accuracyMap = {
    // Geographic to/from geographic (same datum)
    'EPSG:4326_EPSG:4326': { accuracy: 0, confidence: 'Perfect (same CRS)' },
    'EPSG:4258_EPSG:4326': { accuracy: 1, confidence: 'Excellent' }, // ETRS89 to WGS84
    'EPSG:4269_EPSG:4326': { accuracy: 2, confidence: 'Very Good' }, // NAD83 to WGS84
    
    // Geographic to projected (France)
    'EPSG:4326_EPSG:2154': { accuracy: 15, confidence: 'Good' }, // WGS84 to Lambert-93
    'EPSG:4258_EPSG:2154': { accuracy: 5, confidence: 'Excellent' }, // ETRS89 to Lambert-93
    'EPSG:2154_EPSG:4326': { accuracy: 15, confidence: 'Good' }, // Lambert-93 to WGS84
    'EPSG:2154_EPSG:4258': { accuracy: 5, confidence: 'Excellent' }, // Lambert-93 to ETRS89
    
    // UTM transformations
    'EPSG:4326_EPSG:32633': { accuracy: 10, confidence: 'Good' }, // WGS84 to UTM 33N
    'EPSG:4258_EPSG:32633': { accuracy: 5, confidence: 'Excellent' }, // ETRS89 to UTM 33N
    
    // Default estimates by transformation type
    'GEO_TO_GEO_SAME_DATUM': { accuracy: 1, confidence: 'Excellent' },
    'GEO_TO_PROJECTED_EU': { accuracy: 10, confidence: 'Good' },
    'GEO_TO_PROJECTED_OTHER': { accuracy: 25, confidence: 'Fair' },
    'PROJECTED_TO_GEO': { accuracy: 15, confidence: 'Good' },
    'PROJECTED_TO_PROJECTED': { accuracy: 20, confidence: 'Fair' },
  };

  const key = `${fromCrs}_${toCrs}`;
  if (accuracyMap[key]) return accuracyMap[key];
  
  // Guess by CRS types
  const fromIsGeo = fromCrs.startsWith('EPSG:4');
  const toIsGeo = toCrs.startsWith('EPSG:4');
  
  if (fromIsGeo && toIsGeo) {
    // Both geographic - check if same datum
    if (fromCrs === toCrs) return { accuracy: 0, confidence: 'Perfect' };
    if (['EPSG:4258', 'EPSG:4326'].includes(fromCrs) && ['EPSG:4258', 'EPSG:4326'].includes(toCrs)) {
      return { accuracy: 1, confidence: 'Excellent' };
    }
    return { accuracy: 5, confidence: 'Very Good' };
  }
  
  if (fromIsGeo && !toIsGeo) {
    // Geographic to projected
    if (toCrs.includes('2154') || toCrs.includes('2193')) return { accuracy: 10, confidence: 'Good' };
    if (toCrs.includes('326') || toCrs.includes('327')) return { accuracy: 15, confidence: 'Good' }; // UTM
    return { accuracy: 25, confidence: 'Fair' };
  }
  
  if (!fromIsGeo && toIsGeo) {
    // Projected to geographic
    return { accuracy: 15, confidence: 'Good' };
  }
  
  // Projected to projected
  return { accuracy: 20, confidence: 'Fair' };
};

// Get coordinate labels for input/output based on CRS type and height type
const getCoordinateLabels = (fromCrs, toCrs, inputZType, outputZType) => {
  const fromIsGeo = isGeographic(fromCrs);
  const toIsGeo = isGeographic(toCrs);

  const inputHeightLabel = inputZType === "ellipsoidal" ? "h (ellipsoid)" : "H (orthometric)";
  const outputHeightLabel = outputZType === "ellipsoidal" ? "h (ellipsoid)" : "H (orthometric)";

  // Input labels
  const inputXLabel = fromIsGeo ? "Longitude" : "Easting (X)";
  const inputYLabel = fromIsGeo ? "Latitude" : "Northing (Y)";

  // Output labels
  const outputXLabel = toIsGeo ? "Longitude" : "Easting (X)";
  const outputYLabel = toIsGeo ? "Latitude" : "Northing (Y)";

  return {
    inputXLabel,
    inputYLabel,
    inputHeightLabel,
    outputXLabel,
    outputYLabel,
    outputHeightLabel,
  };
};


const splitCoordinateLine = (line) => {
  const trimmed = String(line || "").trim();
  if (!trimmed) return [];

  if (trimmed.includes("\t")) {
    return trimmed.split("\t").map((t) => t.trim()).filter(Boolean);
  }

  const separators = [",", ";", "|"];
  const separatorCounts = separators
    .map((sep) => ({ sep, count: (trimmed.match(new RegExp(`\\${sep}`, "g")) || []).length }))
    .sort((a, b) => b.count - a.count);

  if (separatorCounts[0].count > 0) {
    return trimmed.split(separatorCounts[0].sep).map((t) => t.trim()).filter(Boolean);
  }

  return trimmed.split(/\s+/).filter(Boolean);
};

const parseBulkLine = (line, fromCrsCode, inputFormat) => {
  // Accept delimited or whitespace-separated lines: [ID] x y [z]
  // If first token is non-numeric, treat as ID/point name/code
  const tokens = splitCoordinateLine(line);
  if (tokens.length < 2) return null;
  
  let id = null;
  let startIdx = 0;
  
  // WKT whole-line support
  const wkt = tryParseWKT(line);
  if (wkt) {
    return { id: null, x: wkt.x, y: wkt.y, z: wkt.z, detectedFromCrs: wkt.detectedFromCrs };
  }

  // UTM line support (zone+hemisphere leading token or EPSG326/327)
  const utm = tryParseUTM(tokens);
  if (utm) {
    return { id: null, x: utm.x, y: utm.y, z: utm.z, detectedFromCrs: utm.detectedFromCrs };
  }

  // Check if first token is non-numeric (point name/ID)
  const firstNorm = normalizeNumericToken(tokens[0]);
  const firstIsNumeric = !isNaN(parseFloat(firstNorm)) && isFinite(firstNorm);
  if (!firstIsNumeric && tokens.length >= 3) {
    // First column is ID/point name
    id = tokens[0];
    startIdx = 1;
  }
  
  // Parse coordinates - handle DMS if geographic CRS and DMS format
  let x, y;
  const isGeographic = CRS_LIST.find((c) => c.code === fromCrsCode)?.type === "geographic";
  if (isGeographic && inputFormat === "DMS") {
    x = parseDMSToDD(tokens[startIdx]);
    y = parseDMSToDD(tokens[startIdx + 1]);
  } else {
    // Allow hemispheric suffixes (e.g., 48.8566N, 2.3522E)
    const xHem = parseHemisphericNumber(tokens[startIdx]);
    const yHem = parseHemisphericNumber(tokens[startIdx + 1]);
    x = (xHem ?? parseFloat(normalizeNumericToken(tokens[startIdx])));
    y = (yHem ?? parseFloat(normalizeNumericToken(tokens[startIdx + 1])));
  }
  
  const z = tokens[startIdx + 2] !== undefined ? parseFloat(normalizeNumericToken(tokens[startIdx + 2])) : null;
  
  if ([x, y].some((n) => Number.isNaN(n))) return null;
  return { id, x, y, z: Number.isNaN(z) ? null : z };
};

const normalizeNumericToken = (value) => {
  if (value === undefined || value === null) return value;
  return String(value)
    .replace(/\u00A0|\u202F/g, ' ')
    .replace(/\s+/g, '')
    .replace(',', '.');
};

// Parse header to map columns and infer height type (ellipsoidal h vs orthometric H)
// Recognized terms (case-insensitive):
//  - X/Easting/Longitude/Lon
//  - Y/Northing/Latitude/Lat
//  - Z/H/Height/OrthometricHeight/Elevation (orthometric)
//  - h/EllipsoidalHeight/GeodeticHeight/Ellipsoidal (ellipsoidal)
const parseHeaderMapping = (line) => {
  const cols = splitCoordinateLine(line);
  let xIdx = -1;
  let yIdx = -1;
  let zIdx = -1;
  let zType = null; // 'ellipsoidal' | 'orthometric'
  let zTypeSource = null; // 'explicit' | 'assumed'
  let headerFromCrs = null;
  let headerToCrs = null;
  let hasLonHeader = false;
  let hasLatHeader = false;

  // Normalize for matching
  const normalize = (col) => col.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const normCols = cols.map(normalize);

  normCols.forEach((c, i) => {
    const rawCol = cols[i];
    if (xIdx === -1 && ["x", "easting", "lon", "longitude", "long"].some((term) => c === term)) {
      xIdx = i;
      if (["lon", "longitude", "long"].some((term) => c === term)) hasLonHeader = true;
    }
    else if (yIdx === -1 && ["y", "northing", "lat", "latitude"].some((term) => c === term)) {
      yIdx = i;
      if (["lat", "latitude"].some((term) => c === term)) hasLatHeader = true;
    }
    else if (zIdx === -1 && ["h", "ellipsoidal", "ellipsoidalheight", "geodeticheight"].some((term) => c === term)) {
      zIdx = i; zType = "ellipsoidal"; zTypeSource = "explicit";
    } else if (zIdx === -1 && ["orthometric", "orthometricheight"].some((term) => c === term || c.includes(term))) {
      zIdx = i; zType = "orthometric"; zTypeSource = "explicit";
    } else if (zIdx === -1 && ["z", "height", "elevation", "hgt"].some((term) => c === term || c.includes(term))) {
      // Generic height labels: assume orthometric but mark low confidence
      zIdx = i; zType = "orthometric"; zTypeSource = "assumed";
    } else if (/^epsg:\d{4,5}$/i.test(rawCol)) {
      const epsg = rawCol.toUpperCase();
      if (!headerFromCrs) headerFromCrs = epsg; else if (!headerToCrs) headerToCrs = epsg;
    }
  });

  // If we didn't find explicit x/y, assume first two columns are x,y
  if (xIdx === -1) xIdx = 0;
  if (yIdx === -1) yIdx = 1;
  // If z not found, leave as -1 (no height)

  const hasLetters = /[a-zA-Z]/.test(line);
  
  // Try to detect if first columns are non-numeric (point names/IDs)
  // If header wasn't explicitly matched but has letters, check if columns are numeric
  if (hasLetters && xIdx === 0 && yIdx === 1) {
    const tokens = splitCoordinateLine(line);
    if (tokens.length >= 2) {
      // Check if first token is non-numeric (likely a point name/ID)
      const firstIsNumeric = !isNaN(parseFloat(tokens[0])) && isFinite(tokens[0]);
      if (!firstIsNumeric && tokens.length >= 3) {
        // First column is likely a point name, shift indices
        xIdx = 1;
        yIdx = 2;
        // Check if there's a 4th column for Z (default to orthometric if not specified)
        if (tokens.length >= 4 && zIdx === -1) {
          zIdx = 3;
          zType = "orthometric"; // Default to orthometric for unnamed Z column
          zTypeSource = "assumed";
        } else if (zIdx >= 0) {
          zIdx = zIdx + 1; // Shift existing Z index
        }
      }
    }
  }
  
  return {
    hasHeader: hasLetters,
    xIdx,
    yIdx,
    zIdx,
    zType,
    zTypeSource,
    headerFromCrs,
    headerToCrs,
    hasLonLatHeader: hasLonHeader && hasLatHeader,
  };
};

// Helper function to generate placeholder examples based on CRS type
const getPlaceholderExamples = (crsCode, format = "DD") => {
  const crs = CRS_LIST.find((c) => c.code === crsCode);
  const isGeographic = crs?.type === "geographic";
  const isUtm = isUtmCode(crsCode);
  
  if (isGeographic) {
    if (format === "DMS") {
      return {
        x: "e.g., 2°21'08\"E or 2:21:08",
        y: "e.g., 48°51'24\"N or 48:51:24",
        z: "e.g., 35"
      };
    } else {
      return {
        x: "e.g., 2.3522",
        y: "e.g., 48.8566",
        z: "e.g., 35"
      };
    }
  } else if (isUtm) {
    return {
      x: "e.g., 448251.795",
      y: "e.g., 5411932.678",
      z: "e.g., 100"
    };
  } else {
    // For other projected systems
    return {
      x: "e.g., 652709.401",
      y: "e.g., 6859290.946",
      z: "e.g., 100"
    };
  }
};

// Helper function to parse DMS (Degrees/Minutes/Seconds) to Decimal Degrees
const parseDMSToDD = (dmsString) => {
  if (!dmsString || dmsString.toString().trim() === "") return "";
  
  // If it's already a number, return it as is
  const asNumber = parseFloat(dmsString);
  if (!isNaN(asNumber) && !dmsString.toString().match(/[dms°'"NSEW:]/i)) {
    return asNumber;
  }
  
  const str = dmsString.toString().trim().toUpperCase();
  
  // Check for direction (N, S, E, W)
  const isNegative = str.includes('S') || str.includes('W');
  
  // Try different DMS formats
  // Format 1: 48°51'24"N or 48°51'24"
  let match = str.match(/(-?\d+)[°d]\s*(\d+)['m]?\s*(\d+(?:\.\d+)?)["s]?/i);
  
  if (!match) {
    // Format 2: 48:51:24 (colon-separated)
    match = str.match(/(-?\d+):(\d+):(\d+(?:\.\d+)?)/);
  }
  
  if (!match) {
    // Format 3: 48 51 24 (space-separated)
    match = str.match(/(-?\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)/);
  }
  
  if (match) {
    const degrees = parseFloat(match[1]);
    const minutes = parseFloat(match[2]);
    const seconds = parseFloat(match[3]);
    
    let dd = Math.abs(degrees) + minutes / 60 + seconds / 3600;
    
    // Apply sign based on direction or original negative sign
    if (degrees < 0 || isNegative) {
      dd = -dd;
    }
    
    return dd;
  }
  
  // If no match, try to parse as a regular number
  return asNumber;
};

// Helper function to format Decimal Degrees to DMS string with hemisphere
// kind: 'lat' or 'lon' to choose N/S or E/W
const ddToDMS = (value, kind) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  const degrees = Math.floor(abs);
  const minutesFloat = (abs - degrees) * 60;
  const minutes = Math.floor(minutesFloat);
  const seconds = (minutesFloat - minutes) * 60;
  const secStr = seconds.toFixed(2);
  let hemi = "";
  if (kind === "lat") hemi = sign < 0 ? "S" : "N";
  if (kind === "lon") hemi = sign < 0 ? "W" : "E";
  return `${degrees}°${minutes}'${secStr}"${hemi}`;
};

const CoordinateConverter = () => {
  const TOP_DETECTION_LIMIT = 5;
  const [fromCrs, setFromCrs] = useState("EPSG:4326");
  const [toCrs, setToCrs] = useState("EPSG:2154");
  const [x, setX] = useState("");
  const [y, setY] = useState("");
  const [z, setZ] = useState("");
  const [inputFormat, setInputFormat] = useState("DD"); // DD, DMS, or AUTO
  const [outputFormat, setOutputFormat] = useState("DD"); // DD, DMS, or BOTH for geographic outputs
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const [bulkText, setBulkText] = useState("");
  const [bulkResults, setBulkResults] = useState([]);
  const [bulkProgress, setBulkProgress] = useState(null);
  const [bulkUploadFile, setBulkUploadFile] = useState(null);
  const [bulkUploadError, setBulkUploadError] = useState("");
  const [cadBackendStatus, setCadBackendStatus] = useState(null);
  const [cadBackendStatusError, setCadBackendStatusError] = useState("");
  const [cadInspection, setCadInspection] = useState(null);
  
  // CRS Detection State
  const [crsSuggestions, setCrsSuggestions] = useState([]);
  const [showCrsSuggestions, setShowCrsSuggestions] = useState(false);
  // Single-point detect CRS UI state
  const [detectSuggestions, setDetectSuggestions] = useState([]);
  const [showDetectSuggestions, setShowDetectSuggestions] = useState(false);
  const [detectLoading, setDetectLoading] = useState(false);
  const [showConfidenceTooltip, setShowConfidenceTooltip] = useState(false);
  const [lastDetectInput, setLastDetectInput] = useState(null);
  const [detectionMapMode, setDetectionMapMode] = useState("top"); // top | all
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showBulkResetConfirm, setShowBulkResetConfirm] = useState(false);
  const [, setBulkSummary] = useState(null);
  const [bulkIsConverting, setBulkIsConverting] = useState(false);
  const [presets, setPresets] = useState([]);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [presetScope, setPresetScope] = useState("project"); // project | global
  const [defaultPresetId, setDefaultPresetId] = useState("");
  const [inputVerticalDatum, setInputVerticalDatum] = useState("auto"); // auto | ellipsoidal | orthometric
  const [outputVerticalDatum, setOutputVerticalDatum] = useState("auto"); // auto | ellipsoidal | orthometric
  const [bulkFilterMode] = useState("all"); // all | failed | warned | selected
  const [selectedBulkRows, setSelectedBulkRows] = useState([]);
  const [showBulkTextInput, setShowBulkTextInput] = useState(false);
  const [benchmarkRows, setBenchmarkRows] = useState([]);
  const [benchmarkSummary, setBenchmarkSummary] = useState(null);
  const [benchmarkFile, setBenchmarkFile] = useState(null);
  const [benchmarkTolerance, setBenchmarkTolerance] = useState(1.0);

  const [utmInfo, setUtmInfo] = useState(null);
  const [zoneInfo, setZoneInfo] = useState(null);
  const [utmZoneManual, setUtmZoneManual] = useState(31);
  const [utmHemiManual, setUtmHemiManual] = useState("N");

  const [geoidMode, setGeoidMode] = useState("none"); // auto | manual | upload | none
  const [geoidName, setGeoidName] = useState("EGM96");
  const [availableGeoidGrids, setAvailableGeoidGrids] = useState([]);
  const [loadedGeoidGrids, setLoadedGeoidGrids] = useState([]);
  const [geoidUploadName, setGeoidUploadName] = useState("Uploaded");
  const [geoidUploadFile, setGeoidUploadFile] = useState(null);

  // Compute dynamic placeholders based on selected FROM CRS and input format
  const placeholders = useMemo(() => getPlaceholderExamples(fromCrs, inputFormat), [fromCrs, inputFormat]);

  // ---- 3D Visualization State ----
  // Show3DViewer: Toggle to display the 3D Earth visualization
  // Note: main map now lives in App-level sidebar; keep false to avoid duplicate maps here.
  const [show3DViewer, setShow3DViewer] = useState(false);
  const renderEmbeddedMap = false; // disable embedded map; sidebar map is authoritative
  // Points3DData: Array of point objects formatted for the 3D viewer
  // Each point includes: lat, lon, height, id, N (ondulation), geoidAboveEllipsoid
  const [points3DData, setPoints3DData] = useState([]);

  // Ref for bulk file input to allow programmatic reset
  const bulkFileInputRef = useRef(null);
  const benchmarkFileInputRef = useRef(null);
  const geoidUploadInputRef = useRef(null);
  const bulkCancelRef = useRef(false);
  const undoStackRef = useRef([]);
  const redoStackRef = useRef([]);
  // Auto-detect is enabled by default. Picking a From CRS manually locks it until reset.
  const fromCrsManualRef = useRef(false);

  const refreshCadStatus = useCallback(async () => {
    try {
      const status = await getCadBackendStatus();
      setCadBackendStatus(status);
      setCadBackendStatusError("");
      return status;
    } catch (err) {
      setCadBackendStatus(null);
      setCadBackendStatusError(err.message || "CAD backend unavailable");
      return null;
    }
  }, []);

  useEffect(() => {
    refreshCadStatus();
  }, [refreshCadStatus]);

  const getPresetStorageKey = useCallback((scope = presetScope) => {
    if (scope === "global") return "survey_calc_presets_global";
    const projectToken = (typeof window !== "undefined" ? window.location.pathname : "project")
      .replace(/[^a-z0-9]/gi, "_")
      .toLowerCase();
    return `survey_calc_presets_${projectToken}`;
  }, [presetScope]);

  const buildSnapshot = useCallback(() => ({
    fromCrs,
    toCrs,
    x,
    y,
    z,
    bulkText,
    inputFormat,
    outputFormat,
    inputVerticalDatum,
    outputVerticalDatum,
    geoidMode,
    geoidName,
  }), [fromCrs, toCrs, x, y, z, bulkText, inputFormat, outputFormat, inputVerticalDatum, outputVerticalDatum, geoidMode, geoidName]);

  const applySnapshot = useCallback((snapshot) => {
    if (!snapshot) return;
    setFromCrs(snapshot.fromCrs || "EPSG:4326");
    setToCrs(snapshot.toCrs || "EPSG:2154");
    setX(snapshot.x || "");
    setY(snapshot.y || "");
    setZ(snapshot.z || "");
    setBulkText(snapshot.bulkText || "");
    setInputFormat(snapshot.inputFormat || "DD");
    setOutputFormat(snapshot.outputFormat || "DD");
    setInputVerticalDatum(snapshot.inputVerticalDatum || "auto");
    setOutputVerticalDatum(snapshot.outputVerticalDatum || "auto");
    setGeoidMode(snapshot.geoidMode || "none");
    setGeoidName(snapshot.geoidName || "EGM96");
  }, []);

  const pushHistory = useCallback(() => {
    undoStackRef.current.push(buildSnapshot());
    if (undoStackRef.current.length > 50) undoStackRef.current.shift();
    redoStackRef.current = [];
  }, [buildSnapshot]);

  const handleUndo = useCallback(() => {
    if (undoStackRef.current.length === 0) return;
    const previous = undoStackRef.current.pop();
    redoStackRef.current.push(buildSnapshot());
    applySnapshot(previous);
  }, [applySnapshot, buildSnapshot]);

  const handleRedo = useCallback(() => {
    if (redoStackRef.current.length === 0) return;
    const next = redoStackRef.current.pop();
    undoStackRef.current.push(buildSnapshot());
    applySnapshot(next);
  }, [applySnapshot, buildSnapshot]);

  const buildExportMetadata = useCallback((rows = bulkResults) => {
    const accuracyInfo = getTransformationAccuracy(fromCrs, toCrs);
    const totalRows = rows.length;
    const errorRows = rows.filter((r) => String(r.outputX) === "ERROR").length;
    return {
      generatedAt: new Date().toISOString(),
      fromCrs,
      toCrs,
      geoidMode,
      geoidName,
      transformationAccuracyCm: accuracyInfo.accuracy,
      confidence: accuracyInfo.confidence,
      totalRows,
      successRows: totalRows - errorRows,
      errorRows,
    };
  }, [bulkResults, fromCrs, toCrs, geoidMode, geoidName]);

  const summarizeBulkResults = useCallback((rows) => {
    const total = rows.length;
    const failed = rows.filter((r) => String(r.outputX) === "ERROR");
    const outliers = rows.filter((r) => r.outlierWarning);
    const zoneWarnings = rows.filter((r) => r.utmWarning || r.ccWarning || r.otherZoneWarning);
    const byCategory = failed.reduce((acc, r) => {
      const key = r.errorCategory || "conversion";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    return {
      total,
      success: total - failed.length,
      failed: failed.length,
      outliers: outliers.length,
      zoneWarnings: zoneWarnings.length,
      categories: byCategory,
    };
  }, []);

  const setFromCrsManually = (code) => {
    if (!code) return;
    pushHistory();
    fromCrsManualRef.current = true;
    setFromCrs(code);
  };

  const setToCrsManually = (code) => {
    if (!code) return;
    pushHistory();
    setToCrs(code);
  };

  const setFromCrsAutomatically = (code) => {
    if (!code) return;
    if (fromCrsManualRef.current) return;
    setFromCrs(code);
  };

  const handleSwapCrs = () => {
    if (!fromCrs || !toCrs) return;
    pushHistory();
    const prevFrom = fromCrs;
    const prevTo = toCrs;
    fromCrsManualRef.current = true;
    setFromCrs(prevTo);
    setToCrs(prevFrom);
  };

  const runWorkerBulkConversion = useCallback((parsedRows) => {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("../workers/bulkConvertWorker.js", import.meta.url), { type: "module" });
      worker.onmessage = (evt) => {
        const msg = evt.data || {};
        if (msg.type === "progress") {
          setBulkProgress(`Worker converted ${msg.done}/${msg.total}`);
          return;
        }
        if (msg.type === "done") {
          worker.terminate();
          resolve(msg.rows || []);
          return;
        }
        if (msg.type === "error") {
          worker.terminate();
          reject(new Error(msg.message || "Worker conversion failed"));
        }
      };
      worker.onerror = (err) => {
        worker.terminate();
        reject(err);
      };
      worker.postMessage({
        parsed: parsedRows,
        fromCrs,
        toCrs,
        outputFormat,
      });
    });
  }, [fromCrs, toCrs, outputFormat]);

  // Auto-detect height type based on input CRS
  // Heuristic height-type inference with confidence flag
  // Note: EPSG horizontal codes rarely encode vertical datum; we infer based on CRS family.
  const inferHeightType = (crsCode) => {
    const crs = CRS_LIST.find((c) => c.code === crsCode);
    const code = crsCode?.toUpperCase() || "";
    const isGeographic = crs?.type === "geographic";

    // Strong signals for ellipsoidal: 3D WGS84/geocentric or explicit geographic 3D
    if (code === "EPSG:4979" || code === "EPSG:4978") return { type: "ellipsoidal", confidenceLow: false };
    if (isGeographic) return { type: "ellipsoidal", confidenceLow: false };

    // Common projected survey systems typically paired with orthometric heights (levelled + geoid)
    const likelyOrtho = [
      "EPSG:2154", // Lambert93
    ];
    // French CC zones (CC42..CC50): EPSG 3942-3950
    const isFrenchCC = /^EPSG:39(4[2-9]|50)$/.test(code);
    if (likelyOrtho.includes(code) || isFrenchCC) return { type: "orthometric", confidenceLow: false };

    // UTM / national grids / SPCS etc: default orthometric but mark low confidence
    const utmLike = /(UTM)|(ZONE\s?\d{1,2}[NS]?)|(LCC)|(TM)|(TME)|(GK)|(GAUSS)|(BNG)|(IG)|(MGA)|(JGD)|(ED50)|(NAD83)|(HARN)|(NSRS)|(SPCS)/i;
    const epsgRange = /^EPSG:(2\d{3}|3\d{3}|4\d{3})$/;
    if (utmLike.test(crs?.label || "") || epsgRange.test(code)) {
      return { type: "orthometric", confidenceLow: true };
    }

    // Fallback: assume orthometric with low confidence
    return { type: "orthometric", confidenceLow: true };
  };

  const resolveHeightType = (headerZType, crsCode) => {
    if (headerZType === "ellipsoidal" || headerZType === "orthometric") {
      return { type: headerZType, confidenceLow: false };
    }
    return inferHeightType(crsCode);
  };

  const resolveInputHeightType = (headerZType, crsCode) => {
    if (inputVerticalDatum !== "auto") {
      return { type: inputVerticalDatum, confidenceLow: false, userDefined: true };
    }
    return resolveHeightType(headerZType, crsCode);
  };

  const resolveOutputHeightType = (headerZType, crsCode) => {
    if (outputVerticalDatum !== "auto") {
      return { type: outputVerticalDatum, confidenceLow: false, userDefined: true };
    }
    return resolveHeightType(headerZType, crsCode);
  };

  /**
   * Prepare 3D visualization data from bulk results or single point result
   * Converts the coordinate converter results into a format suitable for Cesium visualization
   * 
   * @param {Array} results - Array of bulk conversion results or single result
   * @returns {Array} Array of point objects with lat, lon, height, ondulation, and geoid info
   */
  const prepare3DVisualizationData = (results) => {
    if (!results || results.length === 0) return [];

    // Determine if the output CRS is geographic; if not, reproject to WGS84 for mapping
    const toCrsDef = CRS_LIST.find((c) => c.code === toCrs);
    const toIsGeographic = toCrsDef ? toCrsDef.type === "geographic" : false;

    return results
      .map((row, idx) => {
        let lat;
        let lon;

        // Parse raw outputs (handle DMS-formatted outputs when To CRS is geographic)
        let rawX = parseFloat(row.outputX);
        let rawY = parseFloat(row.outputY);
        const toIsGeoOut = CRS_LIST.find((c) => c.code === toCrs)?.type === "geographic";
        if (toIsGeoOut) {
          if (!Number.isFinite(rawX)) {
            // Prefer DMS column when present, otherwise parse the outputX string
            rawX = row.outputXDms ? parseDMSToDD(row.outputXDms) : parseDMSToDD(row.outputX);
          }
          if (!Number.isFinite(rawY)) {
            rawY = row.outputYDms ? parseDMSToDD(row.outputYDms) : parseDMSToDD(row.outputY);
          }
        }

        // If the output CRS is projected, convert to geographic for the map
        if (!toIsGeographic && Number.isFinite(rawX) && Number.isFinite(rawY)) {
          try {
            const [lonOut, latOut] = proj4(toCrs, "EPSG:4326", [rawX, rawY]);
            lon = lonOut;
            lat = latOut;
            // Ensure latitude is in valid range [-90, 90]
            if (lat > 90 || lat < -90) {
              console.warn(`Invalid latitude ${lat} after projection, swapping coordinates`);
              [lon, lat] = [lat, lon];
            }
          } catch (err) {
            console.warn("Failed to reproject to WGS84 for visualization:", err?.message);
            lon = rawX;
            lat = rawY;
          }
        } else {
          // Already geographic
          lon = rawX;
          lat = rawY;
        }

        const height = row.outputZ ? parseFloat(row.outputZ) : 0;
        const hasValidHeight = height && !isNaN(height) && row.outputZ !== "ERROR" && row.outputZ !== "-";

        const N = row.N ? parseFloat(row.N) : null;
        const geoidAboveEllipsoid = N !== null ? N > 0 : undefined;

        return {
          id: row.id || `Point ${idx + 1}`,
          label: row.id || `Point ${idx + 1}`,
          lat,
          lng: lon,
          lon,
          height: hasValidHeight ? height : 0,
          N,
          ondulation: N,
          geoidUndulation: N,
          geoidAboveEllipsoid,
          originalData: row,
        };
      })
      .filter((pt) => Number.isFinite(pt.lat) && Number.isFinite(pt.lon));
  };

  const { type: inputHeightType } = resolveInputHeightType(null, fromCrs);

  // Memoize the 3D point select callback to prevent re-renders
  const handle3DPointSelect = useCallback(() => {
    // Point selection in 3D visualization
  }, []);

  // Memoize geoid load complete handler to prevent GeoidLoader re-renders
  const handleGeoidLoadComplete = useCallback((grids, errors) => {
    setLoadedGeoidGrids(grids);
    if (errors.length > 0) {
      console.warn("Some geoid grids failed to load:", errors);
    }
  }, []);

  // ---- Export Handlers ----
  const handleExportCSV = useCallback(() => {
    if (bulkResults.length === 0) {
      alert("No results to export");
      return;
    }
    try {
      const data = exportAsCSV(bulkResults, fromCrs, toCrs, geoidMode !== "none", buildExportMetadata());
      const filename = `coordinates_${new Date().toISOString().split('T')[0]}.csv`;
      downloadFile(data, filename, 'csv');
    } catch (err) {
      console.error('Export CSV failed:', err);
      alert('Export failed: ' + err.message);
    }
  }, [bulkResults, fromCrs, toCrs, geoidMode, buildExportMetadata]);

  const handleExportGeoJSON = useCallback(() => {
    if (bulkResults.length === 0) {
      alert("No results to export");
      return;
    }
    try {
      const data = exportAsGeoJSON(bulkResults, toCrs, geoidMode !== "none", buildExportMetadata());
      const filename = `coordinates_${new Date().toISOString().split('T')[0]}.geojson`;
      downloadFile(data, filename, 'geojson');
    } catch (err) {
      console.error('Export GeoJSON failed:', err);
      alert('Export failed: ' + err.message);
    }
  }, [bulkResults, toCrs, geoidMode, buildExportMetadata]);

  const handleExportKML = useCallback(() => {
    if (bulkResults.length === 0) {
      alert("No results to export");
      return;
    }
    try {
      const data = exportAsKML(bulkResults, toCrs, buildExportMetadata());
      const filename = `coordinates_${new Date().toISOString().split('T')[0]}.kml`;
      downloadFile(data, filename, 'kml');
    } catch (err) {
      console.error('Export KML failed:', err);
      alert('Export failed: ' + err.message);
    }
  }, [bulkResults, toCrs, buildExportMetadata]);

  const handleExportGPX = useCallback(() => {
    if (bulkResults.length === 0) {
      alert("No results to export");
      return;
    }
    try {
      const data = exportAsGPX(bulkResults, toCrs, buildExportMetadata());
      const filename = `coordinates_${new Date().toISOString().split('T')[0]}.gpx`;
      downloadFile(data, filename, 'gpx');
    } catch (err) {
      console.error('Export GPX failed:', err);
      alert('Export failed: ' + err.message);
    }
  }, [bulkResults, toCrs, buildExportMetadata]);

  const handleExportXLSX = useCallback(() => {
    if (bulkResults.length === 0) {
      alert("No results to export");
      return;
    }
    try {
      const workbook = exportAsXLSX(bulkResults, fromCrs, toCrs, geoidMode !== "none", buildExportMetadata());
      const filename = `coordinates_${new Date().toISOString().split('T')[0]}.xlsx`;
      downloadFile(workbook, filename, 'xlsx');
    } catch (err) {
      console.error('Export XLSX failed:', err);
      alert('Export failed: ' + err.message);
    }
  }, [bulkResults, fromCrs, toCrs, geoidMode, buildExportMetadata]);

  const handleExportWKT = useCallback(() => {
    if (bulkResults.length === 0) {
      alert("No results to export");
      return;
    }
    try {
      const data = exportAsWKT(bulkResults, buildExportMetadata());
      const filename = `coordinates_${new Date().toISOString().split('T')[0]}.wkt`;
      downloadFile(data, filename, 'txt');
    } catch (err) {
      console.error('Export WKT failed:', err);
      alert('Export failed: ' + err.message);
    }
  }, [bulkResults, buildExportMetadata]);

  const handleExportDXF = useCallback(() => {
    if (bulkResults.length === 0) {
      alert("No results to export");
      return;
    }
    try {
      const data = exportAsDXF(bulkResults, buildExportMetadata());
      const filename = `coordinates_${new Date().toISOString().split('T')[0]}.dxf`;
      downloadFile(data, filename, 'dxf');
    } catch (err) {
      console.error('Export DXF failed:', err);
      alert('Export failed: ' + err.message);
    }
  }, [bulkResults, buildExportMetadata]);

  const handleExportAll = useCallback(async () => {
    if (bulkResults.length === 0) {
      alert("No results to export");
      return;
    }
    try {
      await exportAllFormats(bulkResults, fromCrs, toCrs, geoidMode !== "none", buildExportMetadata());
    } catch (err) {
      console.error('Export All failed:', err);
      alert('Export failed: ' + err.message);
    }
  }, [bulkResults, fromCrs, toCrs, geoidMode, buildExportMetadata]);

  const handleExportBenchmarkReport = useCallback(() => {
    if (!benchmarkSummary || benchmarkRows.length === 0) {
      alert("Run Benchmark / Reference Validation first.");
      return;
    }

    const esc = (v) => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    const generatedAt = new Date().toISOString();
    const statusResidualLabel = benchmarkSummary.compared3d > 0 ? "residual3d" : "residual2d";
    const summaryLines = [
      ["generatedAt", generatedAt],
      ["fromCrs", fromCrs],
      ["toCrs", toCrs],
      ["tolerance", benchmarkTolerance],
      ["comparedRows", benchmarkSummary.compared],
      ["meanResidual2d", benchmarkSummary.meanResidual],
      ["maxResidual2d", benchmarkSummary.maxResidual],
      ["comparedRows3d", benchmarkSummary.compared3d || 0],
      ["meanResidual3d", benchmarkSummary.meanResidual3d ?? ""],
      ["maxResidual3d", benchmarkSummary.maxResidual3d ?? ""],
      ["passCount", benchmarkSummary.passCount],
      ["failCount", benchmarkSummary.failCount],
      ["statusBasedOn", statusResidualLabel],
    ];

    const summaryBlock = [
      "section,key,value",
      ...summaryLines.map(([k, v]) => ["summary", k, v].map(esc).join(",")),
      "",
    ];

    const detailHeader = [
      "section",
      "pointId",
      "expectedX",
      "expectedY",
      "expectedZ",
      "outputX",
      "outputY",
      "outputZ",
      "dX",
      "dY",
      "dZ",
      "residual2d",
      "residual3d",
      "statusResidual",
      "status",
    ].join(",");

    const detailRows = benchmarkRows.map((r) => {
      const isPass = r.statusResidual <= benchmarkTolerance;
      return [
        "detail",
        r.id,
        r.expectedX,
        r.expectedY,
        r.expectedZ ?? "",
        r.outputX,
        r.outputY,
        r.outputZ ?? "",
        r.dx,
        r.dy,
        r.dz ?? "",
        r.dist,
        r.dist3d ?? "",
        r.statusResidual,
        isPass ? "PASS" : "FAIL",
      ].map(esc).join(",");
    });

    const csv = [...summaryBlock, detailHeader, ...detailRows].join("\n");
    const filename = `benchmark_report_${new Date().toISOString().split('T')[0]}.csv`;
    downloadFile(csv, filename, "csv");
  }, [benchmarkSummary, benchmarkRows, benchmarkTolerance, fromCrs, toCrs]);

  // Register CRS once
  useEffect(() => {
    registerCRS();
  }, []);

  // Discover available geoid grids once
  useEffect(() => {
    (async () => {
      try {
        const mod = await loadGeoidModule();
        const list = await mod.getAvailableGeoidGrids();
        setAvailableGeoidGrids(list);
      } catch (err) {
        console.warn("Failed to load geoid index:", err.message);
      }
    })();
  }, []);

  // Sync manual UTM controls with toCrs when it's a UTM zone
  useEffect(() => {
    if (isUtmCode(toCrs)) {
      const parsed = parseUtmFromEpsg(toCrs);
      if (parsed) {
        setUtmZoneManual(parsed.zone);
        setUtmHemiManual(parsed.hemi);
      }
    }
  }, [toCrs]);

  // Listen for distance tool pick mode events and auto-show map
  useEffect(() => {
    const off = on('distanceTool:pickMode', ({ target }) => {
      if (target && !show3DViewer) {
        setShow3DViewer(true);
        // Scroll to map section
        setTimeout(() => {
          const mapElement = document.querySelector('[data-map-section]');
          if (mapElement) {
            mapElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, 100);
      }
    });
    return () => off && off();
  }, [show3DViewer]);

  // Listen for points from distance tool and add them to map
  useEffect(() => {
    const off = on('distanceTool:pointsForMap', ({ points }) => {
      if (points && Array.isArray(points)) {
        // Add distance tool points to the points3DData for map display
        setPoints3DData(prevPoints => {
          // Remove any old distance tool points (A, B) and add new ones
          const filtered = prevPoints.filter(p => p.id !== 'A' && p.id !== 'B');
          return [...filtered, ...points];
        });
        // Show map if not already visible
        if (!show3DViewer) {
          setShow3DViewer(true);
        }
      }
    });
    return () => off && off();
  }, [show3DViewer]);

  // Emit converter points to the map when bulkResults change
  const buildMapPoints = useCallback((rows) => {
    const toIsGeo = CRS_LIST.find((c) => c.code === toCrs)?.type === "geographic";

    // Parse bulk output strings (DD or DMS) into numbers for mapping
    const parseOutputCoord = (val, rawVal) => {
      const toNumber = (v) => {
        if (v === undefined || v === null) return null;
        const num = Number.parseFloat(String(v).replace(/,/g, "").trim());
        return Number.isFinite(num) ? num : null;
      };

      const toDms = (v) => {
        if (v === undefined || v === null) return null;
        const s = String(v).trim();
        // If the value is in BOTH mode "DD (DMS)", prefer DD numeric prefix.
        if (s.includes("(")) return null;
        // DMS-only strings contain hemisphere or degree symbols.
        if (!/[NSEW°'":]/i.test(s)) return null;
        const dd = parseDMSToDD(s);
        return Number.isFinite(dd) ? dd : null;
      };

      // Prefer explicit DMS decoding before numeric parse to avoid parseFloat("4°...") => 4.
      const dmsFirst = toDms(val);
      if (dmsFirst !== null) return dmsFirst;

      // Try direct numeric parse (handles fixed-point outputs and values with thousands separators)
      const direct = toNumber(val);
      if (direct !== null) return direct;

      // Try DMS parsing (captures hemisphere letters like N/S/E/W)
      const dms = parseDMSToDD(val);
      if (Number.isFinite(dms)) return dms;

      // Fallback to raw numeric values when present
      const rawNum = toNumber(rawVal);
      if (rawNum !== null) return rawNum;

      const rawDms = parseDMSToDD(rawVal);
      if (Number.isFinite(rawDms)) return rawDms;

      return null;
    };

    return rows
      .filter(row => row.outputX !== "ERROR" && row.outputY !== "ERROR")
      .map((row) => {
        const x = parseOutputCoord(row.outputX ?? row.outputXDms, row.outputXRaw);
        const y = parseOutputCoord(row.outputY ?? row.outputYDms, row.outputYRaw);
        
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          console.warn(`[buildMapPoints] Row ${row.id}: invalid coordinates x=${x}, y=${y}`, { 
            outputX: row.outputX, 
            outputXRaw: row.outputXRaw,
            outputY: row.outputY, 
            outputYRaw: row.outputYRaw 
          });
          return null;
        }

        let lat = null;
        let lng = null;
        if (toIsGeo) {
          lng = x;
          lat = y;
        } else {
          try {
            const [lonWgs, latWgs] = proj4(toCrs, "EPSG:4326", [x, y]);
            if (!Number.isFinite(lonWgs) || !Number.isFinite(latWgs)) {
              console.warn(`[buildMapPoints] Row ${row.id}: reprojection failed`, { lonWgs, latWgs });
              return null;
            }
            lng = lonWgs;
            lat = latWgs;
          } catch (e) {
            console.warn(`[buildMapPoints] Row ${row.id}: Map projection failed:`, e.message);
            return null;
          }
        }

        const hasOutlier = Boolean(row.outlierWarning);
        const hasZoneWarning = Boolean(row.utmWarning || row.ccWarning || row.otherZoneWarning);
        const markerSeverity = hasOutlier ? "high" : (hasZoneWarning ? "medium" : "normal");
        const markerColor = hasOutlier ? "#dc2626" : (hasZoneWarning ? "#f59e0b" : null);

        const point = {
          id: String(row.id),
          lat,
          lng,
          height: row.outputZ ? parseFloat(row.outputZ.toString().replace(/,/g, "")) : 0,
          label: `Point ${row.id}`,
          geoidUndulation: row.N ? parseFloat(row.N.toString().replace(/,/g, "")) : 0,
          markerSeverity,
          markerColor,
          validationMessage: row.outlierWarning || row.utmWarning || row.ccWarning || row.otherZoneWarning || "",
        };
        
        console.debug(`[buildMapPoints] Row ${row.id}: created point`, point);
        return point;
      })
      .filter(Boolean);
  }, [toCrs]);

  const projectCadGeometryToWgs84 = useCallback((geometry, sourceCrs) => {
    const safeGeometry = {
      lines: Array.isArray(geometry?.lines) ? geometry.lines : [],
      polylines: Array.isArray(geometry?.polylines) ? geometry.polylines : [],
    };

    if (!safeGeometry.lines.length && !safeGeometry.polylines.length) {
      return { lines: [], polylines: [] };
    }

    const source = sourceCrs || 'EPSG:4326';
    const sourceDef = CRS_LIST.find((c) => c.code === source);
    const sourceIsGeo = sourceDef?.type === 'geographic' || source === 'EPSG:4326';

    const toLatLng = (x, y, z = 0) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      if (sourceIsGeo) {
        return [y, x, Number.isFinite(z) ? z : 0];
      }
      try {
        const [lon, lat] = proj4(source, 'EPSG:4326', [x, y]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        return [lat, lon, Number.isFinite(z) ? z : 0];
      } catch {
        return null;
      }
    };

    const lines = safeGeometry.lines
      .map((line) => {
        const s = Array.isArray(line?.start) ? line.start : [];
        const e = Array.isArray(line?.end) ? line.end : [];
        const start = toLatLng(Number(s[0]), Number(s[1]), Number(s[2] ?? 0));
        const end = toLatLng(Number(e[0]), Number(e[1]), Number(e[2] ?? 0));
        if (!start || !end) return null;
        return { ...line, start, end };
      })
      .filter(Boolean);

    const polylines = safeGeometry.polylines
      .map((poly) => {
        const points = (Array.isArray(poly?.points) ? poly.points : [])
          .map((p) => toLatLng(Number(p?.[0]), Number(p?.[1]), Number(p?.[2] ?? 0)))
          .filter(Boolean);
        if (points.length < 2) return null;
        return { ...poly, points };
      })
      .filter(Boolean);

    return { lines, polylines };
  }, []);

  // Auto-emit points after bulk conversion for map/sidebar consumers
  useEffect(() => {
    if (bulkResults && bulkResults.length > 0) {
      console.debug(`[useEffect] bulkResults changed: ${bulkResults.length} results`);
      const mapPoints = buildMapPoints(bulkResults);
      console.debug(`[useEffect] buildMapPoints returned ${mapPoints.length} plottable points`, mapPoints);
      
      // Validate all points before emitting
      const validPoints = mapPoints.filter(p => {
        const valid = p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
        if (!valid) {
          console.error('[useEffect] Filtering out invalid point:', p);
        }
        return valid;
      });
      
      console.debug(`[useEffect] After validation: ${validPoints.length} valid points`);
      if (validPoints.length > 0) {
        console.debug('[useEffect] Emitting valid points to map:', validPoints);
        emit("converter:pointsForMap", { points: validPoints });
      } else {
        console.warn('[useEffect] No valid points to emit, sending empty array');
        emit("converter:pointsForMap", { points: [] });
      }
    }
  }, [bulkResults, buildMapPoints]);

  // Update zone suggestion for single-point inputs (UTM, CC, etc.)
  useEffect(() => {
    const from = CRS_LIST.find((crs) => crs.code === fromCrs);
    const xNum = parseFloat(x);
    const yNum = parseFloat(y);
    if (!from || Number.isNaN(xNum) || Number.isNaN(yNum)) {
      setUtmInfo(null);
      setZoneInfo(null);
      return;
    }

    const updateZoneInfoFromPoint = (lon, lat) => {
      // UTM suggestions
      const utmSugg = { zone: utmZoneFromLon(lon), hemi: hemisphereFromLat(lat) };
      const utmSelected = parseUtmFromEpsg(toCrs);
      const utmMismatch = utmSelected && isUtmCode(toCrs) && (utmSelected.zone !== utmSugg.zone || utmSelected.hemi !== utmSugg.hemi);
      const ups = isUtmValidForLat(lat) ? null : upsSuggestion(lat);
      setUtmInfo({ suggested: utmSugg, selected: utmSelected, mismatch: utmMismatch, ups });

      // Generic zone info for all zone-based CRS
      const zoneData = getSuggestedZoneInfo(lon, lat, toCrs);
      setZoneInfo(zoneData);
    };

    if (from.type === "geographic") {
      updateZoneInfoFromPoint(xNum, yNum);
    } else {
      try {
        const [lon, lat] = proj4(from.code, "EPSG:4326", [xNum, yNum]);
        updateZoneInfoFromPoint(lon, lat);
      } catch {
        setUtmInfo(null);
        setZoneInfo(null);
      }
    }
  }, [x, y, fromCrs, toCrs]);

  // ---- Single-point conversion ----
  const handleSingleConvert = async () => {
    setError(null);
    try {
      // Parse input coordinates - handle DMS if format is DMS
      let xNum, yNum;
      if (inputFormat === "DMS" && CRS_LIST.find((c) => c.code === fromCrs)?.type === "geographic") {
        xNum = parseDMSToDD(x);
        yNum = parseDMSToDD(y);
      } else {
        xNum = parseFloat(x);
        yNum = parseFloat(y);
      }
      const zNum = parseFloat(z);
      if ([xNum, yNum].some((v) => Number.isNaN(v))) {
        throw new Error("Invalid numeric input");
      }

      const includeHeight = geoidMode !== "none" && !Number.isNaN(zNum);

      // Base horizontal transform
      let [xOut, yOut] = proj4(fromCrs, toCrs, [xNum, yNum]);
      let zOut = zNum;
      let Nsource = null;

      if (includeHeight) {
        const mod = await loadGeoidModule();
        try {
          if (geoidMode === "upload" && geoidUploadFile) {
            await mod.loadGeoidGridFromFile(geoidUploadName || "Uploaded", geoidUploadFile);
            setLoadedGeoidGrids((prev) => Array.from(new Set([...prev, geoidUploadName || "Uploaded"])));
          }

          if (geoidMode === "manual") {
            await mod.ensureGeoidGrid(geoidName);
          }

          let selectedGridName = geoidName;
          if (geoidMode === "auto") {
            // Auto-pick based on source lon/lat in WGS84
            const [lonSrc, latSrc] = proj4(fromCrs, "EPSG:4326", [xNum, yNum]);
            selectedGridName = await mod.selectGeoidGrid(lonSrc, latSrc);
            setGeoidName(selectedGridName);
          }

          const gridToUse = geoidMode === "upload" ? (geoidUploadName || "Uploaded") : selectedGridName;
        const [lon, lat] = proj4(fromCrs, "EPSG:4326", [xNum, yNum]);
        
        // Determine height types for both input and output CRS (header override not available in single)
        let { type: inputHType } = resolveInputHeightType(null, fromCrs);
        let { type: outputHType } = resolveOutputHeightType(null, toCrs);
        const fromIsProjected = CRS_LIST.find((c) => c.code === fromCrs)?.type === "projected";
        const toIsGeographic = CRS_LIST.find((c) => c.code === toCrs)?.type === "geographic";
        const fromIsGeographic = CRS_LIST.find((c) => c.code === fromCrs)?.type === "geographic";
        if (fromIsGeographic) {
          // GPS-like heights on geographic CRS are ellipsoidal by default
          inputHType = "ellipsoidal";
        }
        if (fromIsProjected && toIsGeographic && inputHType !== "ellipsoidal") {
          inputHType = "orthometric";
          outputHType = "ellipsoidal";
        }
        
        // Convert height based on input and output types
        if (inputHType === "orthometric" && outputHType === "ellipsoidal") {
          // H → h: add geoid undulation
          const { h, N } = await mod.orthometricToEllipsoidal(gridToUse, lon, lat, zNum);
          zOut = h;
          Nsource = N;
        } else if (inputHType === "ellipsoidal" && outputHType === "orthometric") {
          // h → H: subtract geoid undulation
          const { H, N } = await mod.ellipsoidalToOrthometric(gridToUse, lon, lat, zNum);
          zOut = H;
          Nsource = N;
        } else {
          // Same type: no conversion needed
          zOut = zNum;
          // Still calculate N for display
          const { N } = await mod.ellipsoidalToOrthometric(gridToUse, lon, lat, 0);
          Nsource = N;
        }
        } catch (geoidErr) {
          console.error("Geoid loading error:", geoidErr);
          throw new Error(`Geoid mode "${geoidMode}" failed: ${geoidErr.message}. Try switching to "None" or "Manual" mode with a different grid.`);
        }
      }

      setResult({
        xIn: xNum,
        yIn: yNum,
        xOut,
        yOut,
        zIn: includeHeight ? zNum : null,
        zOut: includeHeight ? zOut : null,
        N: includeHeight ? Nsource : null,
      });
      
      // Emit single point to map (with strict validation)
      const toIsGeo = CRS_LIST.find((c) => c.code === toCrs)?.type === "geographic";
      try {
        let mapPoint = null;
        
        if (toIsGeo && Number.isFinite(xOut) && Number.isFinite(yOut)) {
          // Geographic output: X=lon, Y=lat
          mapPoint = {
            id: "1",
            lat: Number(yOut),
            lng: Number(xOut),
            height: includeHeight && Number.isFinite(zOut) ? Number(zOut) : 0,
            label: 'Converted Point',
            geoidUndulation: includeHeight && Number.isFinite(Nsource) ? Number(Nsource) : 0
          };
          console.debug('[Single Convert] Created geographic point:', mapPoint);
        } else if (!toIsGeo && Number.isFinite(xOut) && Number.isFinite(yOut)) {
          // Projected output - convert to WGS84 for map
          const [lonMap, latMap] = proj4(toCrs, "EPSG:4326", [xOut, yOut]);
          if (Number.isFinite(lonMap) && Number.isFinite(latMap)) {
            mapPoint = {
              id: "1",
              lat: Number(latMap),
              lng: Number(lonMap),
              height: includeHeight && Number.isFinite(zOut) ? Number(zOut) : 0,
              label: 'Converted Point',
              geoidUndulation: includeHeight && Number.isFinite(Nsource) ? Number(Nsource) : 0
            };
            console.debug('[Single Convert] Created projected point (converted to WGS84):', mapPoint);
          } else {
            console.warn('[Single Convert] Reprojection resulted in invalid lat/lon:', { lonMap, latMap });
            mapPoint = null;
          }
        } else {
          console.warn('[Single Convert] Invalid output coordinates:', { xOut, yOut, xOutType: typeof xOut, yOutType: typeof yOut, toIsGeo });
          mapPoint = null;
        }
        
        // Only emit if we have a valid point
        if (mapPoint && Number.isFinite(mapPoint.lat) && Number.isFinite(mapPoint.lng)) {
          console.debug('[Single Convert] Emitting valid point:', mapPoint);
          emit("converter:pointsForMap", { points: [mapPoint] });
        } else {
          console.warn('[Single Convert] Not emitting - invalid point:', mapPoint);
          emit("converter:pointsForMap", { points: [] });
        }
      } catch (e) {
        console.error('[Single Convert] Failed to emit point to map:', e);
        emit("converter:pointsForMap", { points: [] });
      }
    } catch (err) {
      console.error(err);
      setError(err.message || "Conversion failed");
      setResult(null);
    }
  };

    // ---- Detect CRS for single input point ----
    const handleDetectCrs = async () => {
      setError(null);
      setDetectLoading(true);
      setShowDetectSuggestions(false);
      try {
        let xNum, yNum;
        if (inputFormat === "DMS" && CRS_LIST.find((c) => c.code === fromCrs)?.type === "geographic") {
          xNum = parseDMSToDD(x);
          yNum = parseDMSToDD(y);
        } else {
          xNum = parseFloat(x);
          yNum = parseFloat(y);
        }
        if ([xNum, yNum].some((v) => Number.isNaN(v))) {
          throw new Error("Invalid numeric input for detection");
        }

        const suggestions = await detectCRSFromSinglePoint(xNum, yNum);
        setDetectSuggestions(suggestions || []);
        setShowDetectSuggestions(true);
        setLastDetectInput({ x: xNum, y: yNum });
      
        if (suggestions && suggestions.length > 0) {
          localStorage.setItem("survey_calc_last_detected_crs", suggestions[0].code);
        }
    } catch (err) {
      setError(err.message || "CRS detection failed");
      setDetectSuggestions([]);
      setShowDetectSuggestions(false);
    } finally {
      setDetectLoading(false);
    }
  };
  
  // Load last detected CRS from localStorage on mount
  useEffect(() => {
    const lastDetected = localStorage.getItem("survey_calc_last_detected_crs");
    if (lastDetected && CRS_LIST.find((c) => c.code === lastDetected)) {
      console.log(`[Init] Loaded last detected CRS from localStorage: ${lastDetected}`);
    }
  }, []);

  useEffect(() => {
    try {
      const key = getPresetStorageKey();
      const saved = JSON.parse(localStorage.getItem(key) || "[]");
      const savedDefault = localStorage.getItem(`${key}_default`) || "";
      if (Array.isArray(saved)) {
        setPresets(saved);
        setSelectedPresetId(savedDefault || saved[0]?.id || "");
        setDefaultPresetId(savedDefault || "");
      }
    } catch (err) {
      console.warn("Failed to load presets:", err.message);
    }
  }, [presetScope, getPresetStorageKey]);

  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'z') {
        e.preventDefault();
        handleUndo();
      } else if (key === 'y') {
        e.preventDefault();
        handleRedo();
      } else if (key === 'e') {
        e.preventDefault();
        handleExportCSV();
      } else if (key === 's') {
        e.preventDefault();
        const name = window.prompt("Preset name:");
        if (!name) return;
        const preset = {
          id: `${Date.now()}`,
          name,
          fromCrs,
          toCrs,
          inputFormat,
          outputFormat,
          inputVerticalDatum,
          outputVerticalDatum,
          geoidMode,
          geoidName,
        };
        const next = [preset, ...presets].slice(0, 20);
        setPresets(next);
        setSelectedPresetId(preset.id);
        localStorage.setItem(getPresetStorageKey(), JSON.stringify(next));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleUndo, handleRedo, handleExportCSV, fromCrs, toCrs, inputFormat, outputFormat, inputVerticalDatum, outputVerticalDatum, geoidMode, geoidName, presets, getPresetStorageKey]);
  
  // Plot all detected CRS on map for visual comparison
  const handlePlotDetections = () => {
    if (!lastDetectInput || !detectSuggestions || detectSuggestions.length === 0) return;
    
    const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#ff8800', '#ff0088'];
    const mapPoints = [];
    const rankedSuggestions = [...detectSuggestions].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    const suggestionsToPlot = detectionMapMode === "top" ? rankedSuggestions.slice(0, TOP_DETECTION_LIMIT) : rankedSuggestions;
    
    suggestionsToPlot.forEach((suggestion, idx) => {
      try {
        const [lon, lat] = proj4(suggestion.code, 'EPSG:4326', [lastDetectInput.x, lastDetectInput.y]);
        if (Number.isFinite(lon) && Number.isFinite(lat)) {
          mapPoints.push({
            id: `detect_${idx}_${suggestion.code}`,
            lat,
            lng: lon,
            label: `${suggestion.code} (${Math.round(suggestion.confidence * 100)}%) ${suggestion.name}`,
            confidence: suggestion.confidence,
            height: 0,
            detectionMarker: true,
            color: colors[idx % colors.length]
          });
        }
      } catch (e) {
        console.warn(`Failed to plot ${suggestion.code}:`, e.message);
      }
    });
    
    if (mapPoints.length > 0) {
      console.log(`[PlotDetections] Emitting ${mapPoints.length} detected points to map (mode=${detectionMapMode})`);
      emit("converter:pointsForMap", { points: mapPoints, detectionMarkers: true });
    }
  };

  // ---- Bulk conversion ----
  const handleBulkConvert = async () => {
    // Check if file is uploaded, use file conversion, otherwise use text
    if (bulkUploadFile) {
      await handleBulkFileConvert(bulkUploadFile);
      return;
    }

    setBulkIsConverting(true);
    bulkCancelRef.current = false;
    setBulkProgress("Parsing input...");
    setBulkResults([]);
    setBulkSummary(null);
    setError(null);

    const lines = bulkText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const parsed = lines.map((line) => parseBulkLine(line, fromCrs, inputFormat));
    const badLine = parsed.findIndex((p) => p === null);
    if (badLine >= 0) {
      setBulkProgress(null);
      setBulkIsConverting(false);
      setError(`Could not parse line ${badLine + 1}`);
      return;
    }

    if (parsed.length >= 5000 && geoidMode === "none") {
      try {
        setBulkProgress(`Dispatching ${parsed.length} rows to worker...`);
        const workerRows = await runWorkerBulkConversion(parsed);
        setBulkResults(workerRows);
        setBulkSummary(summarizeBulkResults(workerRows));
        setPoints3DData(prepare3DVisualizationData(workerRows));
        setBulkProgress(null);
        setBulkIsConverting(false);
        return;
      } catch (workerErr) {
        console.warn("Worker conversion fallback to main thread:", workerErr.message);
      }
    }

    const includeHeight = geoidMode !== "none" && parsed.some((p) => p.z !== null);
    const needsGeoidConversion = geoidMode !== "none" && includeHeight;

    let geoidMod = null;
    let selectedGridName = geoidName;
    if (includeHeight) {
      try {
        geoidMod = await loadGeoidModule();
        if (geoidMode === "upload" && geoidUploadFile) {
          await geoidMod.loadGeoidGridFromFile(geoidUploadName || "Uploaded", geoidUploadFile);
          setLoadedGeoidGrids((prev) => Array.from(new Set([...prev, geoidUploadName || "Uploaded"])));
        }
        if (geoidMode === "manual") {
          await geoidMod.ensureGeoidGrid(geoidName);
        }
        if (geoidMode === "auto" && parsed.length > 0) {
          // For auto mode, pick grid based on first point's location
          const firstPt = parsed[0];
          const [lonFirst, latFirst] = proj4(fromCrs, "EPSG:4326", [firstPt.x, firstPt.y]);
          selectedGridName = await geoidMod.selectGeoidGrid(lonFirst, latFirst);
          setGeoidName(selectedGridName);
        }
      } catch (geoidErr) {
        console.error("Geoid module error:", geoidErr);
        const msg = geoidErr.message || String(geoidErr);
        setError(`Geoid ${geoidMode} mode failed: ${msg}. Switch to "None" mode to continue without height conversion, or try "Manual" mode with a specific grid.`);
        // Continue without geoid processing
        geoidMod = null;
      }
    }

    const results = [];
    const CHUNK_SIZE = 100;
    for (let i = 0; i < parsed.length; i += 1) {
      if (bulkCancelRef.current) {
        setBulkProgress(`Canceled at ${i}/${parsed.length}`);
        break;
      }
      const { id: pointId, x: xIn, y: yIn, z: zIn } = parsed[i];
      let xOut = null;
      let yOut = null;
      let zOut = zIn;
      let Nsource = null;

      try {
        [xOut, yOut] = proj4(fromCrs, toCrs, [xIn, yIn]);

        // Determine height types for both input and output CRS (header not available here)
        let { type: inputHType } = resolveInputHeightType(null, fromCrs);
        let { type: outputHType } = resolveOutputHeightType(null, toCrs);
        const fromIsProjected = CRS_LIST.find((c) => c.code === fromCrs)?.type === "projected";
        const toIsGeographic = CRS_LIST.find((c) => c.code === toCrs)?.type === "geographic";
        const fromIsGeographic = CRS_LIST.find((c) => c.code === fromCrs)?.type === "geographic";
        if (fromIsGeographic) {
          // Geographic sources default to ellipsoidal heights
          inputHType = "ellipsoidal";
        }
        if (fromIsProjected && toIsGeographic && inputHType !== "ellipsoidal") {
          inputHType = "orthometric";
          outputHType = "ellipsoidal";
        }

        if (includeHeight && zIn !== null) {
          if (needsGeoidConversion && geoidMod) {
            const gridName = geoidMode === "upload" ? (geoidUploadName || "Uploaded") : selectedGridName;
            const [lon, lat] = proj4(fromCrs, "EPSG:4326", [xIn, yIn]);
            
            // Convert height based on input and output types
            try {
              if (inputHType === "orthometric" && outputHType === "ellipsoidal") {
                // H → h: add geoid undulation
                const { h, N } = await geoidMod.orthometricToEllipsoidal(gridName, lon, lat, zIn);
                zOut = h;
                Nsource = N;
              } else if (inputHType === "ellipsoidal" && outputHType === "orthometric") {
                // h → H: subtract geoid undulation
                const { H, N } = await geoidMod.ellipsoidalToOrthometric(gridName, lon, lat, zIn);
                zOut = H;
                Nsource = N;
              } else {
                // Same type: no conversion needed
                zOut = zIn;
                // Still calculate N for display
                const { N } = await geoidMod.ellipsoidalToOrthometric(gridName, lon, lat, 0);
                Nsource = N;
              }
            } catch (geoidConvertErr) {
              console.warn(`Geoid conversion failed for point, using original height:`, geoidConvertErr.message);
              zOut = zIn;
            }
          } else {
            // No geoid conversion needed, just pass through the Z value
            zOut = zIn;
          }
        }

        const inputPrecision = fromCrs === "EPSG:4326" ? 8 : 4;
        const outputPrecision = toCrs === "EPSG:4326" ? 8 : 4;

        // Check for zone mismatch in bulk conversion (UTM, CC, or other regional systems)
        let utmWarning = null;
        let ccWarning = null;
        let otherZoneWarning = null;
        try {
          let convertedLon, convertedLat;
          // Convert to WGS84 for zone calculation
          const crsFrom = CRS_LIST.find((c) => c.code === fromCrs);
          if (crsFrom?.type === "geographic") {
            convertedLon = xIn;
            convertedLat = yIn;
          } else {
            [convertedLon, convertedLat] = proj4(fromCrs, "EPSG:4326", [xIn, yIn]);
          }
          
          if (isUtmCode(toCrs)) {
            const suggestedZone = utmZoneFromLon(convertedLon);
            const suggestedHemi = hemisphereFromLat(convertedLat);
            const selected = parseUtmFromEpsg(toCrs);
            if (selected && (selected.zone !== suggestedZone || selected.hemi !== suggestedHemi)) {
              utmWarning = `⚠ Suggested: ${suggestedZone}${suggestedHemi}`;
            }
          } else if (isCcCode(toCrs)) {
            const suggested = ccZoneFromLat(convertedLat);
            const selected = parseCcFromEpsg(toCrs);
            if (selected && selected.zone !== suggested) {
              ccWarning = `⚠ Suggested: CC${suggested}`;
            }
          } else if (isGkCode(toCrs)) {
            const suggested = gkZoneFromLon(convertedLon);
            const selected = parseGkFromEpsg(toCrs);
            if (suggested && selected && selected.zone !== suggested) {
              otherZoneWarning = `⚠ Suggested: Zone ${suggested}`;
            }
          } else if (isSpainCode(toCrs)) {
            const suggested = spainZoneFromLonLat(convertedLon, convertedLat);
            const selected = parseSpainFromEpsg(toCrs);
            if (selected && selected.zone !== suggested) {
              otherZoneWarning = `⚠ Suggested: Zone ${suggested}`;
            }
          } else if (isMgaCode(toCrs)) {
            const suggested = mgaZoneFromLon(convertedLon);
            const selected = parseMgaFromEpsg(toCrs);
            if (selected && selected.zone !== suggested) {
              otherZoneWarning = `⚠ Suggested: Zone ${suggested}`;
            }
          } else if (isJgdCode(toCrs)) {
            const suggested = jgdZoneFromLon(convertedLon);
            const selected = parseJgdFromEpsg(toCrs);
            if (suggested && selected && selected.zone !== suggested) {
              otherZoneWarning = `⚠ Suggested: Zone ${suggested}`;
            }
          } else if (isBngCode(toCrs)) {
            const { inUK } = getBngInfo(convertedLon, convertedLat);
            if (!inUK) {
              otherZoneWarning = `⚠ Outside UK coverage`;
            }
          } else if (isIgCode(toCrs)) {
            const { inIreland } = getIgInfo(convertedLon, convertedLat);
            if (!inIreland) {
              otherZoneWarning = `⚠ Outside Ireland coverage`;
            }
          } else if (isSaGaussCode(toCrs)) {
            const suggested = saGaussZoneFromLon(convertedLon);
            const selected = parseSaGaussFromEpsg(toCrs);
            if (suggested && selected && selected.zone !== suggested) {
              otherZoneWarning = `⚠ Suggested: Zone ${suggested}`;
            }
          } else if (isEgyptCode(toCrs)) {
            const { outOfArea } = getEgyptInfo(convertedLon, convertedLat);
            if (outOfArea) {
              otherZoneWarning = `⚠ Outside Egypt coverage`;
            }
          } else if (isMoroccoCode(toCrs)) {
            const { outOfArea } = getMoroccoInfo(convertedLon, convertedLat);
            if (outOfArea) {
              otherZoneWarning = `⚠ Outside Morocco coverage`;
            }
          } else if (isAlgeriaCode(toCrs)) {
            const { outOfArea } = getAlgeriaInfo(convertedLon, convertedLat);
            if (outOfArea) {
              otherZoneWarning = `⚠ Outside Algeria coverage`;
            }
          } else if (isTunisiaCode(toCrs)) {
            const { outOfArea } = getTunisiaInfo(convertedLon, convertedLat);
            if (outOfArea) {
              otherZoneWarning = `⚠ Outside Tunisia coverage`;
            }
          }
        } catch (err) {
          // Ignore errors in zone check, continue with conversion
          console.warn("Zone check failed:", err.message);
        }

        const toIsGeo = CRS_LIST.find((c) => c.code === toCrs)?.type === "geographic";
        const ddX = fmtNum(xOut, outputPrecision);
        const ddY = fmtNum(yOut, outputPrecision);
        const outXStr = toIsGeo
          ? (outputFormat === "BOTH" ? ddX : (outputFormat === "DMS" ? ddToDMS(xOut, "lon") : ddX))
          : fmtNum(xOut, outputPrecision);
        const outYStr = toIsGeo
          ? (outputFormat === "BOTH" ? ddY : (outputFormat === "DMS" ? ddToDMS(yOut, "lat") : ddY))
          : fmtNum(yOut, outputPrecision);
        const outXStrDms = toIsGeo ? ddToDMS(xOut, "lon") : undefined;
        const outYStrDms = toIsGeo ? ddToDMS(yOut, "lat") : undefined;
        let outlierWarning = null;
        try {
          const [lonOut, latOut] = proj4(toCrs, "EPSG:4326", [xOut, yOut]);
          if (!Number.isFinite(lonOut) || !Number.isFinite(latOut) || Math.abs(latOut) > 90 || Math.abs(lonOut) > 180) {
            outlierWarning = "⚠ Outlier: invalid geographic extent";
          }
        } catch {
          outlierWarning = null;
        }

        const row = {
          id: pointId || (i + 1),
          outputXRaw: xOut,
          outputYRaw: yOut,
          inputX: fmtNum(xIn, inputPrecision),
          inputY: fmtNum(yIn, inputPrecision),
          outputX: outXStr,
          outputY: outYStr,
          outputXDms: outputFormat === "BOTH" && toIsGeo ? outXStrDms : undefined,
          outputYDms: outputFormat === "BOTH" && toIsGeo ? outYStrDms : undefined,
          inputZType: inputHType,
          outputZType: outputHType,
          utmWarning,
          ccWarning,
          otherZoneWarning,
          outlierWarning,
        };

        if (includeHeight && zIn !== null) {
          row.inputZ = fmtNum(zIn, 4);
          row.outputZ = fmtNum(zOut, 4);
          if (Nsource !== null) row.N = fmtNum(Nsource, 4);
        }

        results.push(row);
      } catch (err) {
        const { type: effectiveHeightType } = resolveInputHeightType(null, fromCrs);
        const { type: outputHeightType } = resolveOutputHeightType(null, toCrs);
        const row = {
          id: pointId || (i + 1),
          inputX: fmtNum(xIn, 4),
          inputY: fmtNum(yIn, 4),
          outputX: "ERROR",
          outputY: err.message || "Conversion failed",
          errorCategory: "conversion",
          errorMessage: err.message || "Conversion failed",
          inputZType: effectiveHeightType,
          outputZType: outputHeightType,
        };
        if (includeHeight && zIn !== null) {
          row.inputZ = fmtNum(zIn, 4);
          row.outputZ = "-";
        }
        results.push(row);
      }

      if ((i + 1) % 50 === 0) {
        setBulkProgress(`Converted ${i + 1}/${parsed.length}`);
      }
      if ((i + 1) % CHUNK_SIZE === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    // Update bulk results table
    setBulkResults(results);
    setBulkSummary(summarizeBulkResults(results));
    // Prepare 3D visualization data from the conversion results
    const visualData = prepare3DVisualizationData(results);
    setPoints3DData(visualData);
    setBulkProgress(null);
    setBulkIsConverting(false);
  };

  const hasDataToClear = () => Boolean(
      x || y || z || bulkText || result || error || bulkUploadFile || bulkUploadError ||
      bulkResults.length > 0 || points3DData.length > 0 || bulkProgress ||
      crsSuggestions.length > 0 || showCrsSuggestions || detectSuggestions.length > 0 || showDetectSuggestions ||
      benchmarkFile || benchmarkSummary || benchmarkRows.length > 0 || selectedBulkRows.length > 0 ||
      showBulkTextInput || show3DViewer
    );

  const performResetAll = () => {
    pushHistory();
    setShowResetConfirm(false);
    setShowBulkResetConfirm(false);

    // Clear single point inputs and results
    setX("");
    setY("");
    setZ("");
    setResult(null);
    setError(null);

    // Clear bulk text conversion
    setBulkText("");

    // Clear bulk file conversion
    setBulkUploadFile(null);
    setBulkUploadError("");
    setCadInspection(null);
    setSelectedBulkRows([]);
    setShowBulkTextInput(false);

    // Clear CRS suggestions and detection suggestions
    setCrsSuggestions([]);
    setShowCrsSuggestions(false);
    setDetectSuggestions([]);
    setShowDetectSuggestions(false);
    fromCrsManualRef.current = false;

    // Clear benchmark/reference validation state
    setBenchmarkFile(null);
    setBenchmarkRows([]);
    setBenchmarkSummary(null);
    setBenchmarkTolerance(1.0);

    // Reset file input element
    if (bulkFileInputRef.current) {
      bulkFileInputRef.current.value = "";
    }
    if (benchmarkFileInputRef.current) {
      benchmarkFileInputRef.current.value = "";
    }

    // Clear bulk results and 3D map points
    setBulkResults([]);
    setBulkSummary(null);
    setPoints3DData([]);
    setShow3DViewer(false);
    setBulkProgress(null);
    setBulkIsConverting(false);
    bulkCancelRef.current = false;
    emit("converter:pointsForMap", { points: [] });
    emit("converter:cadGeometryForMap", { geometry: { lines: [], polylines: [] } });
    emit("converter:resetAll");
  };

  const handleResetAll = () => {
    if (hasDataToClear()) {
      setShowResetConfirm(true);
      return;
    }
    performResetAll();
  };

  const handleBulkResetAll = () => {
    if (hasDataToClear()) {
      setShowBulkResetConfirm(true);
      return;
    }
    performResetAll();
  };

  const applyBulkFileSelection = useCallback((file) => {
    setBulkUploadFile(file || null);
    setBulkUploadError("");
    setCadInspection(file ? {
      fileName: file.name,
      extension: `.${(file.name.split('.')?.pop() || '').toLowerCase()}`,
      fileSizeBytes: file.size,
      rowCount: null,
      detectedFromCrs: null,
      warnings: [],
      nativeDwg: false,
      usedConverter: false,
      processingRoute: null,
      bounds: null,
      backendMode: cadBackendStatus?.converterMode || "none",
      backendPath: cadBackendStatus?.converterPath || null,
    } : null);

    const ext = (file?.name?.split('.')?.pop() || '').toLowerCase();
    if (file && ["dwg", "dxf"].includes(ext)) {
      refreshCadStatus();
    }
    detectFileFormatsAndCRS(file);
  }, [cadBackendStatus, refreshCadStatus]);

  const handleLoadSampleDwg = useCallback(async () => {
    try {
      setBulkUploadError("");
      const response = await fetch('/samples/sample_test_text.dwg', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('Unable to load DWG sample file from /samples/sample_test_text.dwg');
      }
      const blob = await response.blob();
      const sampleFile = new File([blob], 'sample_test_text.dwg', {
        type: 'application/acad',
        lastModified: Date.now(),
      });
      applyBulkFileSelection(sampleFile);
    } catch (err) {
      setBulkUploadError(err.message || 'Failed to load DWG sample file.');
    }
  }, [applyBulkFileSelection]);

  // Detect CRS immediately when file is selected
  const detectFileFormatsAndCRS = async (file) => {
    if (!file) return;
    
    try {
      setShowCrsSuggestions(false); // Reset
      const ext = (file.name.split('.')?.pop() || '').toLowerCase();
      let rows = [];
      
      // Only parse structured formats (not CSV/TXT which don't have metadata)
      if (ext === "geojson" || ext === "json") {
        rows = await parseGeoJSONFile(file);
      } else if (ext === "gpx") {
        rows = await parseGPXFile(file);
      } else if (ext === "kml") {
        rows = await parseKMLFile(file);
      } else if (ext === "zip") {
        rows = await parseShapefileZip(file);
      } else if (ext === "xlsx" || ext === "xls") {
        rows = await parseXLSXFile(file);
      } else if (ext === "dxf") {
        rows = await parseDXFFile(file);
      } else if (ext === "dwg") {
        rows = await parseDWGFile(file);
      }
      
      if (rows && rows.length > 0) {
        // Extract CRS info
        const anyCrs = rows.find((r) => r.detectedFromCrs);
        console.log('[FileSelect] Detected CRS:', anyCrs?.detectedFromCrs);
        console.log('[FileSelect] CRS Suggestions:', anyCrs?.crsSuggestions);
        
        if (anyCrs?.detectedFromCrs) {
          setFromCrsAutomatically(anyCrs.detectedFromCrs);
        }
        
        // Show CRS suggestions immediately
        if (anyCrs?.crsSuggestions && anyCrs.crsSuggestions.length > 0) {
          setCrsSuggestions(anyCrs.crsSuggestions);
          setShowCrsSuggestions(true);
        }
      }
    } catch (err) {
      console.warn('CRS detection failed (non-fatal):', err.message);
      // Don't show error - user will see it when they click Convert
    }
  };

  const handleBulkFileConvert = async (fileArg) => {
    setBulkIsConverting(true);
    bulkCancelRef.current = false;
    setBulkUploadError("");
    setError(null);
    setBulkResults([]);
    setBulkSummary(null);
    const file = fileArg || bulkUploadFile;
    if (!file) {
      setBulkIsConverting(false);
      setBulkUploadError("Please select a supported file (.csv, .txt, .geojson, .json, .gpx, .kml, .zip, .xlsx, .xls, .dxf, .dwg). Native DWG requires the CAD backend service.");
      return;
    }

    try {
      let parsed = []; // Declare at the beginning before any use
      setBulkProgress("Reading file...");
      const ext = (file.name.split('.')?.pop() || '').toLowerCase();
      const latestCadStatus = ["dwg", "dxf"].includes(ext) ? await refreshCadStatus() : cadBackendStatus;
      let lines = [];
      if (["csv","txt"].includes(ext)) {
        const text = await file.text();
        const rawLines = text.split(/\r?\n/).map((l) => l.trim());
        lines = rawLines.filter((l) => l.length > 0);
      } else {
        let rows = [];
        let cadPayload = null;
        if (ext === "geojson" || ext === "json") {
          rows = await parseGeoJSONFile(file);
        } else if (ext === "gpx") {
          rows = await parseGPXFile(file);
        } else if (ext === "kml") {
          rows = await parseKMLFile(file);
        } else if (ext === "zip") {
          rows = await parseShapefileZip(file);
        } else if (ext === "xlsx" || ext === "xls") {
          rows = await parseXLSXFile(file);
        } else if (ext === "dxf") {
          cadPayload = await parseDXFFile(file, { returnPayload: true });
          rows = cadPayload.rows;
        } else if (ext === "dwg") {
          cadPayload = await parseDWGFile(file, { returnPayload: true });
          rows = cadPayload.rows;
        } else {
          throw new Error(`Unsupported file type: .${ext}`);
        }

        if (!rows || rows.length === 0) throw new Error("No point features found");
        
        // CRS detection already happened on file select, just use detected CRS
        const anyCrs = rows.find((r) => r.detectedFromCrs);
        if (anyCrs?.detectedFromCrs) setFromCrsAutomatically(anyCrs.detectedFromCrs);
        
        // For structured formats, use rows directly without converting to text
        // This preserves Z values and avoids re-parsing issues
        parsed = rows.map((r) => ({
          id: r.id ?? null,
          x: parseFloat(normalizeNumericToken(r.x)),
          y: parseFloat(normalizeNumericToken(r.y)),
          z: r.z !== null && r.z !== undefined ? parseFloat(normalizeNumericToken(r.z)) : null,
          zType: null,
          zTypeSource: null,
        })).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
        
        if (parsed.length === 0) throw new Error("No valid coordinates in file");

        if (["dxf", "dwg"].includes(ext)) {
          setCadInspection(buildCadInspectionSummary(file, rows, latestCadStatus, cadPayload));

          const sourceCrsForGeometry = rows.find((r) => r.detectedFromCrs)?.detectedFromCrs || fromCrs;
          const projectedGeometry = projectCadGeometryToWgs84(cadPayload?.geometry, sourceCrsForGeometry);
          emit("converter:cadGeometryForMap", { geometry: projectedGeometry });
        } else {
          emit("converter:cadGeometryForMap", { geometry: { lines: [], polylines: [] } });
        }
        
        // Skip the normal line-based parsing since we already have parsed coordinates
      }

      let mapping = {
        hasHeader: false,
        xIdx: 0,
        yIdx: 1,
        zIdx: -1,
        zType: null,
        zTypeSource: null,
        headerFromCrs: null,
        headerToCrs: null,
        hasLonLatHeader: false,
      };
      
      // Only parse header if we have CSV/text lines, not for structured formats
      if (lines.length > 0 && (["csv","txt"].includes(ext) || lines[0].match(/^[\d\s,-]+$/) === null)) {
        mapping = parseHeaderMapping(lines[0]);
        if (mapping.hasHeader) {
          lines = lines.slice(1);
        }
      }

      // Auto-set CRS from header tokens if present
      if (mapping.headerFromCrs) setFromCrsAutomatically(mapping.headerFromCrs);
      if (mapping.headerToCrs) setToCrs(mapping.headerToCrs);
      if (mapping.hasLonLatHeader) {
        setFromCrsAutomatically("EPSG:4326");
      }

      // If we already have parsed (from structured format), skip re-parsing
      if (parsed.length === 0) {
        parsed = lines.map((line) => {
          const fallback = parseBulkLine(line, fromCrs, inputFormat);

          if (!mapping.hasHeader) {
            if (!fallback) return null;
            return {
              id: fallback.id ?? null,
              x: fallback.x,
              y: fallback.y,
              z: fallback.z ?? null,
              zType: mapping.zType,
              zTypeSource: mapping.zTypeSource,
              detectedFromCrs: fallback.detectedFromCrs,
            };
          }

          const tokens = splitCoordinateLine(line);
          if (tokens.length < 2) return null;

          const xTok = tokens[mapping.xIdx];
          const yTok = tokens[mapping.yIdx];
          const zTok = mapping.zIdx >= 0 ? tokens[mapping.zIdx] : undefined;

          // Parse coordinates - handle DMS if geographic CRS and DMS format
          let xCoord;
          let yCoord;
          const isGeographic = CRS_LIST.find((c) => c.code === fromCrs)?.type === "geographic";
          if (isGeographic && inputFormat === "DMS") {
            xCoord = parseDMSToDD(xTok);
            yCoord = parseDMSToDD(yTok);
          } else {
            const xHem = parseHemisphericNumber(xTok);
            const yHem = parseHemisphericNumber(yTok);
            xCoord = xHem ?? parseFloat(normalizeNumericToken(xTok));
            yCoord = yHem ?? parseFloat(normalizeNumericToken(yTok));
          }

          const zCoord = zTok !== undefined ? parseFloat(normalizeNumericToken(zTok)) : null;
          if ([xCoord, yCoord].some((n) => Number.isNaN(n))) {
            // Header mapping may be wrong for this file; try generic parser as backup.
            if (!fallback) return null;
            return {
              id: fallback.id ?? null,
              x: fallback.x,
              y: fallback.y,
              z: fallback.z ?? null,
              zType: mapping.zType,
              zTypeSource: mapping.zTypeSource,
              detectedFromCrs: fallback.detectedFromCrs,
            };
          }

          const idIdx = tokens.findIndex((_, idx) => idx !== mapping.xIdx && idx !== mapping.yIdx && idx !== mapping.zIdx);
          const id = idIdx >= 0 ? tokens[idIdx] : (fallback?.id ?? null);

          return {
            id,
            x: xCoord,
            y: yCoord,
            z: Number.isNaN(zCoord) ? null : zCoord,
            zType: mapping.zType,
            zTypeSource: mapping.zTypeSource,
            detectedFromCrs: fallback?.detectedFromCrs,
          };
        });
      }
      
      const bad = parsed.findIndex((p) => p === null);
      if (bad >= 0) {
        throw new Error(`Could not parse line ${bad + 1}`);
      }

      if (parsed.length >= 5000 && geoidMode === "none") {
        setBulkProgress(`Dispatching ${parsed.length} rows to worker...`);
        const workerRows = await runWorkerBulkConversion(parsed);
        setBulkResults(workerRows);
        setBulkSummary(summarizeBulkResults(workerRows));
        setPoints3DData(prepare3DVisualizationData(workerRows));
        setBulkProgress(null);
        setBulkIsConverting(false);
        return;
      }

      // Auto-detect CRS for CSV/TXT files if not already set
      if ((["csv","txt"].includes(ext) && parsed.length > 0)) {
        // If header explicitly says Longitude/Latitude, trust geographic input and skip detector.
        if (!fromCrsManualRef.current && !mapping.hasLonLatHeader) {
          const coordinates = parsed.map(p => ({ x: p.x, y: p.y, z: p.z }));
          const crsSuggestions = detectCRS(coordinates, {});
          const detectedCrs = crsSuggestions.length > 0 ? crsSuggestions[0].code : null;
          
          if (detectedCrs) {
            setFromCrsAutomatically(detectedCrs);
          }
        }
      }

      const includeHeight = parsed.some((p) => p.z !== null);
      const needsGeoidConversion = geoidMode !== "none" && includeHeight;

      let geoidMod = null;
      let selectedGridName = geoidName;
      if (needsGeoidConversion) {
        try {
          geoidMod = await loadGeoidModule();
          if (geoidMode === "upload" && geoidUploadFile) {
            await geoidMod.loadGeoidGridFromFile(geoidUploadName || "Uploaded", geoidUploadFile);
            setLoadedGeoidGrids((prev) => Array.from(new Set([...prev, geoidUploadName || "Uploaded"])));
          }
          if (geoidMode === "manual") {
            await geoidMod.ensureGeoidGrid(geoidName);
          }
          if (geoidMode === "auto" && parsed.length > 0) {
            // For auto mode, pick grid based on first point's location
            const firstPt = parsed[0];
            const [lonFirst, latFirst] = proj4(fromCrs, "EPSG:4326", [firstPt.x, firstPt.y]);
            selectedGridName = await geoidMod.selectGeoidGrid(lonFirst, latFirst);
            setGeoidName(selectedGridName);
          }
        } catch (geoidErr) {
          console.error("Geoid module error:", geoidErr);
          setBulkUploadError(`Geoid processing error: ${geoidErr.message}. Heights will not be adjusted.`);
          // Continue without geoid processing
          geoidMod = null;
        }
      }

      const results = [];
      const CHUNK_SIZE = 100;
      for (let i = 0; i < parsed.length; i += 1) {
        if (bulkCancelRef.current) {
          setBulkProgress(`Canceled at ${i}/${parsed.length}`);
          break;
        }
        const { id: pointId, x: xIn, y: yIn, z: zIn, zType, zTypeSource } = parsed[i];
        let xOut = null;
        let yOut = null;
        let zOut = zIn;
        let Nsource = null;
        
        // Determine height type: prioritize header info, but fall back to CRS-based detection
        let effectiveZType = zType;
        let effectiveZSource = zTypeSource || mapping.zTypeSource;
        if (!effectiveZType) {
          // Header didn't specify type, auto-detect from input CRS
          const { type: inferredType } = resolveInputHeightType(null, fromCrs);
          effectiveZType = inferredType;
        }
        const fromIsGeographic = CRS_LIST.find((c) => c.code === fromCrs)?.type === "geographic";
        if (fromIsGeographic) {
          // If header only implied orthometric (generic height), treat as ellipsoidal so geoid applies
          if (effectiveZSource === "assumed") {
            effectiveZType = "ellipsoidal";
          } else if (!mapping.zType) {
            effectiveZType = "ellipsoidal";
          }
        }
        // Safety: if projecting to geographic and source is projected, default to orthometric unless header explicitly said ellipsoidal
        const fromIsProjected = CRS_LIST.find((c) => c.code === fromCrs)?.type === "projected";
        const toIsGeographic = CRS_LIST.find((c) => c.code === toCrs)?.type === "geographic";
        if (!mapping.zType && fromIsProjected && toIsGeographic && effectiveZType !== "ellipsoidal") {
          effectiveZType = "orthometric";
        }
        // Note: If header specified type, we use it even if it might conflict with CRS
        // This allows users to override if they have non-standard data

        try {
          [xOut, yOut] = proj4(fromCrs, toCrs, [xIn, yIn]);

            // Determine output height type
            let { type: outputHType } = resolveOutputHeightType(null, toCrs);
            const fromIsProjected = CRS_LIST.find((c) => c.code === fromCrs)?.type === "projected";
            const toIsGeographic = CRS_LIST.find((c) => c.code === toCrs)?.type === "geographic";
            if (!mapping.zType && fromIsProjected && toIsGeographic && effectiveZType !== "ellipsoidal") {
              outputHType = "ellipsoidal";
            }

          if (includeHeight && zIn !== null && geoidMod) {
            const gridName = geoidMode === "upload" ? (geoidUploadName || "Uploaded") : selectedGridName;
            const [lon, lat] = proj4(fromCrs, "EPSG:4326", [xIn, yIn]);
            
            // Convert based on input and output height types
            try {
              if (effectiveZType === "orthometric" && outputHType === "ellipsoidal") {
                // H → h: add geoid undulation
                const { h, N } = await geoidMod.orthometricToEllipsoidal(gridName, lon, lat, zIn);
                zOut = h;
                Nsource = N;
              } else if (effectiveZType === "ellipsoidal" && outputHType === "orthometric") {
                // h → H: subtract geoid undulation
                const { H, N } = await geoidMod.ellipsoidalToOrthometric(gridName, lon, lat, zIn);
                zOut = H;
                Nsource = N;
              } else {
                // Same type: no conversion needed
                zOut = zIn;
                // Still calculate N for display
                const { N } = await geoidMod.ellipsoidalToOrthometric(gridName, lon, lat, 0);
                Nsource = N;
              }
            } catch (geoidConvertErr) {
              console.warn(`Geoid conversion failed for point, using original height:`, geoidConvertErr.message);
              zOut = zIn;
            }
          }

          const inputPrecision = fromCrs === "EPSG:4326" ? 8 : 4;
          const outputPrecision = toCrs === "EPSG:4326" ? 8 : 4;

          // Check for zone mismatch in bulk conversion (UTM, CC, or other regional systems)
          let utmWarning = null;
          let ccWarning = null;
          let otherZoneWarning = null;
          try {
            let convertedLon, convertedLat;
            // Convert to WGS84 for zone calculation
            const crsFrom = CRS_LIST.find((c) => c.code === fromCrs);
            if (crsFrom?.type === "geographic") {
              convertedLon = xIn;
              convertedLat = yIn;
            } else {
              [convertedLon, convertedLat] = proj4(fromCrs, "EPSG:4326", [xIn, yIn]);
            }
            
            if (isUtmCode(toCrs)) {
              const suggestedZone = utmZoneFromLon(convertedLon);
              const suggestedHemi = hemisphereFromLat(convertedLat);
              const selected = parseUtmFromEpsg(toCrs);
              if (selected && (selected.zone !== suggestedZone || selected.hemi !== suggestedHemi)) {
                utmWarning = `⚠ Suggested: ${suggestedZone}${suggestedHemi}`;
              }
            } else if (isCcCode(toCrs)) {
              const suggested = ccZoneFromLat(convertedLat);
              const selected = parseCcFromEpsg(toCrs);
              if (selected && selected.zone !== suggested) {
                ccWarning = `⚠ Suggested: CC${suggested}`;
              }
            } else if (isGkCode(toCrs)) {
              const suggested = gkZoneFromLon(convertedLon);
              const selected = parseGkFromEpsg(toCrs);
              if (suggested && selected && selected.zone !== suggested) {
                otherZoneWarning = `⚠ Suggested: Zone ${suggested}`;
              }
            } else if (isSpainCode(toCrs)) {
              const suggested = spainZoneFromLonLat(convertedLon, convertedLat);
              const selected = parseSpainFromEpsg(toCrs);
              if (selected && selected.zone !== suggested) {
                otherZoneWarning = `⚠ Suggested: Zone ${suggested}`;
              }
            } else if (isMgaCode(toCrs)) {
              const suggested = mgaZoneFromLon(convertedLon);
              const selected = parseMgaFromEpsg(toCrs);
              if (selected && selected.zone !== suggested) {
                otherZoneWarning = `⚠ Suggested: Zone ${suggested}`;
              }
            } else if (isJgdCode(toCrs)) {
              const suggested = jgdZoneFromLon(convertedLon);
              const selected = parseJgdFromEpsg(toCrs);
              if (suggested && selected && selected.zone !== suggested) {
                otherZoneWarning = `⚠ Suggested: Zone ${suggested}`;
              }
            } else if (isBngCode(toCrs)) {
              const { inUK } = getBngInfo(convertedLon, convertedLat);
              if (!inUK) {
                otherZoneWarning = `⚠ Outside UK coverage`;
              }
            } else if (isIgCode(toCrs)) {
              const { inIreland } = getIgInfo(convertedLon, convertedLat);
              if (!inIreland) {
                otherZoneWarning = `⚠ Outside Ireland coverage`;
              }
            }
          } catch (err) {
            // Ignore errors in zone check, continue with conversion
            console.warn("Zone check failed:", err.message);
          }

          const toIsGeo = CRS_LIST.find((c) => c.code === toCrs)?.type === "geographic";
          const ddX = fmtNum(xOut, outputPrecision);
          const ddY = fmtNum(yOut, outputPrecision);
          const outXStr = toIsGeo
            ? (outputFormat === "BOTH" ? `${ddX} (${ddToDMS(xOut, "lon")})` : (outputFormat === "DMS" ? ddToDMS(xOut, "lon") : ddX))
            : fmtNum(xOut, outputPrecision);
          const outYStr = toIsGeo
            ? (outputFormat === "BOTH" ? `${ddY} (${ddToDMS(yOut, "lat")})` : (outputFormat === "DMS" ? ddToDMS(yOut, "lat") : ddY))
            : fmtNum(yOut, outputPrecision);
          let outlierWarning = null;
          try {
            const [lonOut, latOut] = proj4(toCrs, "EPSG:4326", [xOut, yOut]);
            if (!Number.isFinite(lonOut) || !Number.isFinite(latOut) || Math.abs(latOut) > 90 || Math.abs(lonOut) > 180) {
              outlierWarning = "⚠ Outlier: invalid geographic extent";
            }
          } catch {
            outlierWarning = null;
          }

          const row = {
            id: pointId || i + 1,
            inputX: fmtNum(xIn, inputPrecision),
            inputY: fmtNum(yIn, inputPrecision),
            outputX: outXStr,
            outputY: outYStr,
            inputZType: effectiveZType,
            outputZType: outputHType,
            utmWarning,
            ccWarning,
            otherZoneWarning,
            outlierWarning,
          };

          if (includeHeight && zIn !== null) {
            row.inputZ = fmtNum(zIn, 4);
            row.outputZ = fmtNum(zOut, 4);
            if (Nsource !== null) row.N = fmtNum(Nsource, 4);
          }

          results.push(row);
        } catch (err) {
          const { type: outputHType } = resolveOutputHeightType(null, toCrs);
          const row = {
            id: pointId || i + 1,
            inputX: fmtNum(xIn, 4),
            inputY: fmtNum(yIn, 4),
            outputX: "ERROR",
            outputY: err.message || "Conversion failed",
            errorCategory: "conversion",
            errorMessage: err.message || "Conversion failed",
            inputZType: effectiveZType,
            outputZType: outputHType,
          };
          if (includeHeight && zIn !== null) {
            row.inputZ = fmtNum(zIn, 4);
            row.outputZ = "-";
          }
          results.push(row);
        }

        if ((i + 1) % 50 === 0) {
          setBulkProgress(`Converted ${i + 1}/${parsed.length}`);
        }
        if ((i + 1) % CHUNK_SIZE === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      // Update bulk results table
      setBulkResults(results);
      setBulkSummary(summarizeBulkResults(results));
      // Prepare 3D visualization data from the conversion results
      const visualData = prepare3DVisualizationData(results);
      setPoints3DData(visualData);
      setBulkProgress(null);
      setBulkIsConverting(false);
    } catch (err) {
      setBulkProgress(null);
      setBulkIsConverting(false);
      setBulkUploadError(err.message || "Bulk file conversion failed");
    }
  };

  // ---- UI helpers ----
  const fromLabel = useMemo(() => CRS_LIST.find((c) => c.code === fromCrs)?.label || "", [fromCrs]);
  const toLabel = useMemo(() => CRS_LIST.find((c) => c.code === toCrs)?.label || "", [toCrs]);

  const savePreset = () => {
    const name = window.prompt("Preset name:");
    if (!name) return;
    const preset = {
      id: `${Date.now()}`,
      name,
      fromCrs,
      toCrs,
      inputFormat,
      outputFormat,
      inputVerticalDatum,
      outputVerticalDatum,
      geoidMode,
      geoidName,
    };
    const next = [preset, ...presets].slice(0, 20);
    setPresets(next);
    setSelectedPresetId(preset.id);
    localStorage.setItem(getPresetStorageKey(), JSON.stringify(next));
  };

  const loadPreset = (id) => {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    pushHistory();
    setFromCrsManually(preset.fromCrs);
    setToCrs(preset.toCrs);
    setInputFormat(preset.inputFormat || "DD");
    setOutputFormat(preset.outputFormat || "DD");
    setInputVerticalDatum(preset.inputVerticalDatum || "auto");
    setOutputVerticalDatum(preset.outputVerticalDatum || "auto");
    setGeoidMode(preset.geoidMode || "none");
    setGeoidName(preset.geoidName || "EGM96");
  };

  const deletePreset = (id) => {
    const next = presets.filter((p) => p.id !== id);
    setPresets(next);
    if (selectedPresetId === id) setSelectedPresetId(next[0]?.id || "");
    localStorage.setItem(getPresetStorageKey(), JSON.stringify(next));
    if (defaultPresetId === id) {
      setDefaultPresetId("");
      localStorage.removeItem(`${getPresetStorageKey()}_default`);
    }
  };

  const duplicatePreset = (id) => {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    const copy = { ...preset, id: `${Date.now()}`, name: `${preset.name} Copy` };
    const next = [copy, ...presets].slice(0, 20);
    setPresets(next);
    setSelectedPresetId(copy.id);
    localStorage.setItem(getPresetStorageKey(), JSON.stringify(next));
  };

  const renamePreset = (id) => {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    const name = window.prompt("Rename preset:", preset.name);
    if (!name) return;
    const next = presets.map((p) => (p.id === id ? { ...p, name } : p));
    setPresets(next);
    localStorage.setItem(getPresetStorageKey(), JSON.stringify(next));
  };

  const setAsDefaultPreset = (id) => {
    setDefaultPresetId(id);
    localStorage.setItem(`${getPresetStorageKey()}_default`, id);
  };

  const exportPresetsJson = () => {
    const data = JSON.stringify({ scope: presetScope, presets }, null, 2);
    downloadFile(data, `converter_presets_${presetScope}.json`, 'json');
  };

  const importPresetsJson = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const imported = Array.isArray(parsed?.presets) ? parsed.presets : (Array.isArray(parsed) ? parsed : []);
      if (imported.length === 0) {
        alert("No presets found in imported file.");
        return;
      }
      const normalized = imported
        .filter((p) => p?.name && p?.fromCrs && p?.toCrs)
        .map((p, idx) => ({ ...p, id: p.id || `${Date.now()}_${idx}` }));
      const next = [...normalized, ...presets].slice(0, 20);
      setPresets(next);
      setSelectedPresetId(next[0]?.id || "");
      localStorage.setItem(getPresetStorageKey(), JSON.stringify(next));
    } catch (err) {
      alert(`Preset import failed: ${err.message}`);
    }
  };

  const setUtmFromManualZoneHemi = (zone, hemi) => {
    setUtmZoneManual(zone);
    setUtmHemiManual(hemi);
    const epsg = `${hemi === "N" ? "EPSG:326" : "EPSG:327"}${String(zone).padStart(2, "0")}`;
    setToCrs(epsg);
  };

  const convertSingleBulkRow = async (row) => {
    const xIn = parseFloat(normalizeNumericToken(row.inputX));
    const yIn = parseFloat(normalizeNumericToken(row.inputY));
    const zIn = row.inputZ !== undefined && row.inputZ !== null && row.inputZ !== "" ? parseFloat(normalizeNumericToken(row.inputZ)) : null;
    if (!Number.isFinite(xIn) || !Number.isFinite(yIn)) {
      return {
        ...row,
        outputX: "ERROR",
        outputY: "Invalid edited input",
        errorCategory: "parsing",
        errorMessage: "Invalid edited input",
      };
    }
    try {
      const [xOut, yOut] = proj4(fromCrs, toCrs, [xIn, yIn]);
      const outPrec = toCrs === "EPSG:4326" ? 8 : 4;
      const toIsGeo = CRS_LIST.find((c) => c.code === toCrs)?.type === "geographic";
      const outX = toIsGeo && outputFormat === "DMS" ? ddToDMS(xOut, "lon") : fmtNum(xOut, outPrec);
      const outY = toIsGeo && outputFormat === "DMS" ? ddToDMS(yOut, "lat") : fmtNum(yOut, outPrec);
      return {
        ...row,
        outputX: outX,
        outputY: outY,
        outputXRaw: xOut,
        outputYRaw: yOut,
        outputZ: zIn !== null ? fmtNum(zIn, 4) : row.outputZ,
        errorCategory: undefined,
        errorMessage: undefined,
      };
    } catch (err) {
      return {
        ...row,
        outputX: "ERROR",
        outputY: err.message || "Conversion failed",
        errorCategory: "conversion",
        errorMessage: err.message || "Conversion failed",
      };
    }
  };

  const filteredBulkResults = useMemo(() => {
    if (bulkFilterMode === "failed") return bulkResults.filter((r) => String(r.outputX) === "ERROR");
    if (bulkFilterMode === "warned") return bulkResults.filter((r) => r.utmWarning || r.ccWarning || r.otherZoneWarning || r.outlierWarning);
    if (bulkFilterMode === "selected") return bulkResults.filter((r) => selectedBulkRows.includes(String(r.id)));
    return bulkResults;
  }, [bulkResults, bulkFilterMode, selectedBulkRows]);

  const updateBulkRowInput = (rowId, field, value) => {
    setBulkResults((prev) => prev.map((r) => (String(r.id) === String(rowId) ? { ...r, [field]: value } : r)));
  };

  const rerunBulkRow = async (rowId) => {
    const target = bulkResults.find((r) => String(r.id) === String(rowId));
    if (!target) return;
    const rerun = await convertSingleBulkRow(target);
    setBulkResults((prev) => prev.map((r) => (String(r.id) === String(rowId) ? rerun : r)));
  };

  const runBenchmarkValidation = async (fileArg) => {
    const file = fileArg || benchmarkFile;
    if (!file) return;
    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter(Boolean);
      const header = (lines.shift() || '').split(',').map((h) => h.replace(/^\uFEFF/, '').trim().toLowerCase());
      const idIdx = header.findIndex((h) => ['id', 'pointid', 'point_id', 'name'].includes(h));
      const exIdx = header.findIndex((h) => ['expectedx', 'expected_x', 'xexpected', 'x_expected'].includes(h));
      const eyIdx = header.findIndex((h) => ['expectedy', 'expected_y', 'yexpected', 'y_expected'].includes(h));
      const ezIdx = header.findIndex((h) => ['expectedz', 'expected_z', 'zexpected', 'z_expected', 'expectedh', 'expected_h', 'expectedheight', 'expected_height'].includes(h));
      if (idIdx < 0 || exIdx < 0 || eyIdx < 0) {
        alert("Benchmark file requires columns: id, expectedX, expectedY");
        return;
      }

      const parseOutputForBenchmark = (value, axis) => {
        if (Number.isFinite(value)) return value;
        const num = parseFloat(normalizeNumericToken(value));
        if (Number.isFinite(num)) return num;
        const dms = parseDMSToDD(String(value), axis);
        return Number.isFinite(dms) ? dms : NaN;
      };

      const expectedById = new Map();
      const expectedRows = [];
      lines.forEach((line) => {
        const cols = line.split(',');
        const zRaw = ezIdx >= 0 ? cols[ezIdx] : undefined;
        const zParsed = zRaw !== undefined ? parseFloat(normalizeNumericToken(zRaw)) : null;
        const row = {
          id: String(cols[idIdx]).trim(),
          x: parseFloat(normalizeNumericToken(cols[exIdx])),
          y: parseFloat(normalizeNumericToken(cols[eyIdx])),
          z: Number.isFinite(zParsed) ? zParsed : null,
        };
        expectedById.set(row.id, row);
        expectedRows.push(row);
      });

      const toIsGeo = CRS_LIST.find((c) => c.code === toCrs)?.type === "geographic";

      let rows = bulkResults
        .filter((r) => expectedById.has(String(r.id)) && String(r.outputX) !== "ERROR")
        .map((r) => {
          const exp = expectedById.get(String(r.id));
          const outX = parseOutputForBenchmark(r.outputXRaw ?? r.outputX, toIsGeo ? "lon" : "x");
          const outY = parseOutputForBenchmark(r.outputYRaw ?? r.outputY, toIsGeo ? "lat" : "y");
          const outZRaw = r.outputZ;
          const outZ = outZRaw !== null && outZRaw !== undefined && outZRaw !== "-"
            ? parseFloat(normalizeNumericToken(outZRaw))
            : NaN;
          if (!Number.isFinite(outX) || !Number.isFinite(outY) || !Number.isFinite(exp.x) || !Number.isFinite(exp.y)) return null;
          const dx = outX - exp.x;
          const dy = outY - exp.y;
          const dist = Math.hypot(dx, dy);
          const hasZ = Number.isFinite(exp.z) && Number.isFinite(outZ);
          const dz = hasZ ? (outZ - exp.z) : null;
          const dist3d = hasZ ? Math.sqrt((dx * dx) + (dy * dy) + (dz * dz)) : null;
          const statusResidual = Number.isFinite(dist3d) ? dist3d : dist;
          return {
            id: r.id,
            expectedX: exp.x,
            expectedY: exp.y,
            expectedZ: exp.z,
            outputX: outX,
            outputY: outY,
            outputZ: Number.isFinite(outZ) ? outZ : null,
            dx,
            dy,
            dz,
            dist,
            dist3d,
            statusResidual,
          };
        })
        .filter(Boolean);

      // Fallback: if IDs don't match, compare in row order.
      if (rows.length === 0 && expectedRows.length > 0) {
        const comparable = bulkResults.filter((r) => String(r.outputX) !== "ERROR");
        const n = Math.min(comparable.length, expectedRows.length);
        const ordered = [];
        for (let i = 0; i < n; i += 1) {
          const r = comparable[i];
          const exp = expectedRows[i];
          const outX = parseOutputForBenchmark(r.outputXRaw ?? r.outputX, toIsGeo ? "lon" : "x");
          const outY = parseOutputForBenchmark(r.outputYRaw ?? r.outputY, toIsGeo ? "lat" : "y");
          const outZRaw = r.outputZ;
          const outZ = outZRaw !== null && outZRaw !== undefined && outZRaw !== "-"
            ? parseFloat(normalizeNumericToken(outZRaw))
            : NaN;
          if (!Number.isFinite(outX) || !Number.isFinite(outY) || !Number.isFinite(exp.x) || !Number.isFinite(exp.y)) continue;
          const dx = outX - exp.x;
          const dy = outY - exp.y;
          const dist = Math.hypot(dx, dy);
          const hasZ = Number.isFinite(exp.z) && Number.isFinite(outZ);
          const dz = hasZ ? (outZ - exp.z) : null;
          const dist3d = hasZ ? Math.sqrt((dx * dx) + (dy * dy) + (dz * dz)) : null;
          const statusResidual = Number.isFinite(dist3d) ? dist3d : dist;
          ordered.push({
            id: r.id,
            expectedX: exp.x,
            expectedY: exp.y,
            expectedZ: exp.z,
            outputX: outX,
            outputY: outY,
            outputZ: Number.isFinite(outZ) ? outZ : null,
            dx,
            dy,
            dz,
            dist,
            dist3d,
            statusResidual,
          });
        }
        rows = ordered;
        if (rows.length > 0) {
          alert("Benchmark note: IDs did not match exactly, compared by row order.");
        }
      }

      if (rows.length === 0) {
        alert("No matching IDs between benchmark file and current bulk results.");
        return;
      }
      const maxResidual = Math.max(...rows.map((r) => r.dist));
      const meanResidual = rows.reduce((s, r) => s + r.dist, 0) / rows.length;
      const rows3d = rows.filter((r) => Number.isFinite(r.dist3d));
      const maxResidual3d = rows3d.length > 0 ? Math.max(...rows3d.map((r) => r.dist3d)) : null;
      const meanResidual3d = rows3d.length > 0 ? rows3d.reduce((s, r) => s + r.dist3d, 0) / rows3d.length : null;
      const passCount = rows.filter((r) => r.statusResidual <= benchmarkTolerance).length;
      const failCount = rows.length - passCount;
      setBenchmarkRows(rows);
      setBenchmarkSummary({
        compared: rows.length,
        maxResidual,
        meanResidual,
        maxResidual3d,
        meanResidual3d,
        compared3d: rows3d.length,
        passCount,
        failCount,
      });
    } catch (err) {
      alert(`Benchmark validation failed: ${err.message}`);
    }
  };

  return (
    <div style={{ width: "100%", maxWidth: "1100px", background: "var(--c-surface, #fff)", borderRadius: "var(--r-lg, 14px)", padding: "1.5rem", boxShadow: "var(--shadow-xl, 0 20px 60px rgba(0,0,0,.22))", display: "flex", flexDirection: "column", border: "1px solid rgba(255,255,255,.08)" }}>
      
      {/* CRS Detection Suggestions */}
      {showCrsSuggestions && crsSuggestions.length > 0 && (
        <div style={{
          background: "#e0f2fe",
          border: "2px solid #0ea5e9",
          borderRadius: "8px",
          padding: "1rem",
          marginBottom: "1.5rem",
          position: "relative"
        }}>
          <button 
            onClick={() => setShowCrsSuggestions(false)}
            style={{
              position: "absolute",
              top: "0.5rem",
              right: "0.5rem",
              background: "transparent",
              border: "none",
              fontSize: "1.2rem",
              cursor: "pointer",
              color: "#666"
            }}
          >
            ×
          </button>
          <h3 style={{ margin: "0 0 0.75rem 0", color: "#0369a1", fontSize: "1rem", fontWeight: 600 }}>
            🎯 CRS Auto-Detected
          </h3>
          <p style={{ margin: "0 0 0.75rem 0", fontSize: "0.9rem", color: "#555" }}>
            We detected the following coordinate systems. The top match has been auto-selected:
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {crsSuggestions.slice(0, 3).map((suggestion, idx) => (
              <div 
                key={suggestion.code}
                onClick={() => {
                  setFromCrsManually(suggestion.code);
                  setShowCrsSuggestions(false);
                }}
                style={{
                  background: idx === 0 ? "#bae6fd" : "#fff",
                  border: idx === 0 ? "2px solid #0284c7" : "1px solid #cbd5e1",
                  borderRadius: "6px",
                  padding: "0.75rem",
                  cursor: "pointer",
                  transition: "all 0.2s"
                }}
                onMouseOver={(e) => {
                  if (idx !== 0) {
                    e.currentTarget.style.background = "#f8fafc";
                    e.currentTarget.style.borderColor = "#94a3b8";
                  }
                }}
                onMouseOut={(e) => {
                  if (idx !== 0) {
                    e.currentTarget.style.background = "#fff";
                    e.currentTarget.style.borderColor = "#cbd5e1";
                  }
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <strong style={{ color: "#1e40af" }}>{suggestion.name}</strong>
                    <span style={{ marginLeft: "0.5rem", fontSize: "0.85rem", color: "#64748b" }}>
                      ({suggestion.code})
                    </span>
                    {idx === 0 && (
                      <span style={{
                        marginLeft: "0.5rem",
                        background: "#10b981",
                        color: "#fff",
                        padding: "0.15rem 0.5rem",
                        borderRadius: "4px",
                        fontSize: "0.75rem",
                        fontWeight: 600
                      }}>
                        SELECTED
                      </span>
                    )}
                  </div>
                  <div style={{
                    background: suggestion.confidence > 0.8 ? "#10b981" : suggestion.confidence > 0.6 ? "#f59e0b" : "#64748b",
                    color: "#fff",
                    padding: "0.25rem 0.6rem",
                    borderRadius: "4px",
                    fontSize: "0.75rem",
                    fontWeight: 600
                  }}>
                    {Math.round(suggestion.confidence * 100)}% match
                  </div>
                </div>
                <div style={{ marginTop: "0.35rem", fontSize: "0.85rem", color: "#64748b" }}>
                  {suggestion.reason}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      
      <div style={{ display: "flex", gap: "0.8rem", alignItems: "flex-end", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 260px", minWidth: "260px" }}>
          <CrsSearchSelector label="From CRS" value={fromCrs} onChange={setFromCrsManually} />
        </div>
        <button
          className="crs-swap-btn"
          onClick={handleSwapCrs}
          title="Swap From/To CRS"
          aria-label="Swap From and To CRS"
          style={{
            alignSelf: "center",
            marginBottom: "0.1rem",
            width: "44px",
            height: "44px",
            borderRadius: "999px",
            border: "1px solid #cbd5e1",
            background: "#f8fafc",
            color: "#1e293b",
            cursor: "pointer",
            fontSize: "1.2rem",
            fontWeight: 700,
            lineHeight: 1,
            transition: "background 160ms ease, box-shadow 160ms ease, transform 160ms ease",
          }}
        >
          ⇄
        </button>
        <div style={{ flex: "1 1 260px", minWidth: "260px" }}>
          <CrsSearchSelector label="To CRS" value={toCrs} onChange={setToCrsManually} />
        </div>
      </div>

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center", marginTop: "0.45rem" }}>
        <button onClick={handleUndo} aria-label="Undo last converter action" style={{ padding: "0.4rem 0.65rem", borderRadius: "6px", border: "1px solid #cbd5e1", background: "#fff", cursor: "pointer", fontWeight: 600 }}>Undo</button>
        <button onClick={handleRedo} aria-label="Redo last converter action" style={{ padding: "0.4rem 0.65rem", borderRadius: "6px", border: "1px solid #cbd5e1", background: "#fff", cursor: "pointer", fontWeight: 600 }}>Redo</button>
        <select value={presetScope} onChange={(e) => setPresetScope(e.target.value)} aria-label="Preset scope" style={{ padding: "0.42rem", borderRadius: "6px", border: "1px solid #cbd5e1" }}>
          <option value="project">Project Presets</option>
          <option value="global">Global Presets</option>
        </select>
        <button onClick={savePreset} aria-label="Save converter preset" style={{ padding: "0.4rem 0.65rem", borderRadius: "6px", border: "1px solid #cbd5e1", background: "#fff", cursor: "pointer", fontWeight: 600 }}>Save Preset</button>
        <button onClick={exportPresetsJson} aria-label="Export presets" style={{ padding: "0.4rem 0.65rem", borderRadius: "6px", border: "1px solid #cbd5e1", background: "#fff", cursor: "pointer", fontWeight: 600 }}>Export Presets</button>
        <label className="button-like-label" style={{ padding: "0.4rem 0.65rem", borderRadius: "6px", border: "1px solid #cbd5e1", background: "#fff", cursor: "pointer", fontWeight: 600 }}>
          Import Presets
          <input type="file" accept=".json" style={{ display: "none" }} onChange={(e) => importPresetsJson(e.target.files?.[0])} />
        </label>
        {presets.length > 0 && (
          <>
            <select
              aria-label="Load saved converter preset"
              value={selectedPresetId}
              onChange={(e) => setSelectedPresetId(e.target.value)}
              style={{ padding: "0.42rem", borderRadius: "6px", border: "1px solid #cbd5e1" }}
            >
              <option value="" disabled>Select preset...</option>
              {presets.map((p) => (<option key={p.id} value={p.id}>{p.name}{defaultPresetId === p.id ? " (default)" : ""} ({p.fromCrs} to {p.toCrs})</option>))}
            </select>
            <button onClick={() => selectedPresetId && loadPreset(selectedPresetId)} aria-label="Load selected preset" style={{ padding: "0.4rem 0.65rem", borderRadius: "6px", border: "1px solid #cbd5e1", background: "#fff", cursor: "pointer", fontWeight: 600 }}>Load</button>
            <button onClick={() => selectedPresetId && duplicatePreset(selectedPresetId)} aria-label="Duplicate selected preset" style={{ padding: "0.4rem 0.65rem", borderRadius: "6px", border: "1px solid #cbd5e1", background: "#fff", cursor: "pointer", fontWeight: 600 }}>Duplicate</button>
            <button onClick={() => selectedPresetId && renamePreset(selectedPresetId)} aria-label="Rename selected preset" style={{ padding: "0.4rem 0.65rem", borderRadius: "6px", border: "1px solid #cbd5e1", background: "#fff", cursor: "pointer", fontWeight: 600 }}>Rename</button>
            <button onClick={() => selectedPresetId && setAsDefaultPreset(selectedPresetId)} aria-label="Set selected as default preset" style={{ padding: "0.4rem 0.65rem", borderRadius: "6px", border: "1px solid #bbf7d0", background: "#ecfdf5", color: "#166534", cursor: "pointer", fontWeight: 600 }}>Set Default</button>
            <button onClick={() => selectedPresetId && deletePreset(selectedPresetId)} aria-label="Delete selected preset" style={{ padding: "0.4rem 0.65rem", borderRadius: "6px", border: "1px solid #fecaca", background: "#fff1f2", color: "#9f1239", cursor: "pointer", fontWeight: 600 }}>Delete</button>
          </>
        )}
      </div>

      <div style={{ marginTop: "0.6rem", padding: "0.65rem", borderRadius: "8px", background: "#f8fafc", border: "1px solid #e2e8f0" }}>
          <div style={{ fontWeight: 700, fontSize: "0.9rem", color: "var(--c-text, #0f172a)" }}>Vertical Datum Panel</div>
        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", marginTop: "0.35rem" }}>
          <label style={{ fontSize: "0.82rem" }}>
            Input vertical datum
            <select value={inputVerticalDatum} onChange={(e) => setInputVerticalDatum(e.target.value)} style={{ marginLeft: "0.35rem", padding: "0.3rem", borderRadius: "6px", border: "1px solid #cbd5e1" }}>
              <option value="auto">Auto</option>
              <option value="ellipsoidal">Ellipsoidal (h)</option>
              <option value="orthometric">Orthometric (H)</option>
            </select>
          </label>
          <label style={{ fontSize: "0.82rem" }}>
            Output vertical datum
            <select value={outputVerticalDatum} onChange={(e) => setOutputVerticalDatum(e.target.value)} style={{ marginLeft: "0.35rem", padding: "0.3rem", borderRadius: "6px", border: "1px solid #cbd5e1" }}>
              <option value="auto">Auto</option>
              <option value="ellipsoidal">Ellipsoidal (h)</option>
              <option value="orthometric">Orthometric (H)</option>
            </select>
          </label>
        </div>
        <div style={{ fontSize: "0.84rem", color: "#334155", marginTop: "0.25rem", display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: "0.35rem" }}>
          <div><strong>Input height type:</strong> {resolveInputHeightType(null, fromCrs).type}</div>
          <div><strong>Output height type:</strong> {resolveOutputHeightType(null, toCrs).type}</div>
          <div><strong>Geoid mode:</strong> {geoidMode}</div>
          <div><strong>Geoid grid:</strong> {geoidName || "N/A"}</div>
        </div>
      </div>

      <div style={{ marginTop: "0.9rem", marginBottom: "0.45rem", fontSize: "0.73rem", fontWeight: 700, color: "var(--c-text-secondary, #475569)", textTransform: "uppercase", letterSpacing: "0.06em", paddingBottom: "0.3rem", borderBottom: "2px solid var(--c-primary, #1d4ed8)" }}>
        Single Point Conversion
      </div>

      {CRS_LIST.find((c) => c.code === fromCrs)?.type === "geographic" && (
        <div style={{ marginTop: "1rem" }}>
          <label style={{ fontWeight: 600, marginRight: "1rem" }}>Input Format:</label>
          <select 
            value={inputFormat} 
            onChange={(e) => setInputFormat(e.target.value)}
            style={{ padding: "0.5rem", borderRadius: "6px", border: "1px solid #bbb", cursor: "pointer" }}
          >
            <option value="DD">Decimal Degrees (DD)</option>
            <option value="DMS">Degrees/Minutes/Seconds (DMS)</option>
          </select>
          <span style={{ marginLeft: "1rem", fontSize: "0.9rem", color: "#666" }}>
            {inputFormat === "DMS" && "Formats: 48°51'24\"N, 48:51:24, or 48 51 24"}
          </span>
        </div>
      )}

      {CRS_LIST.find((c) => c.code === toCrs)?.type === "geographic" && (
        <div style={{ marginTop: "0.75rem" }}>
          <label style={{ fontWeight: 600, marginRight: "1rem" }}>Output Format:</label>
          <select 
            value={outputFormat} 
            onChange={(e) => setOutputFormat(e.target.value)}
            style={{ padding: "0.5rem", borderRadius: "6px", border: "1px solid #bbb", cursor: "pointer" }}
          >
            <option value="DD">Decimal Degrees (DD)</option>
            <option value="DMS">Degrees/Minutes/Seconds (DMS)</option>
            <option value="BOTH">Both DD and DMS</option>
          </select>
          <span style={{ marginLeft: "1rem", fontSize: "0.9rem", color: "#666" }}>
            {outputFormat === "DMS" && "Shown with N/S/E/W (e.g., 48°51'24\"N)"}
            {outputFormat === "BOTH" && "Shows separate columns for DD and DMS"}
          </span>
        </div>
      )}

      <div style={{ marginTop: "1rem", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "0.9rem" }}>
        <div>
          <label style={{ fontWeight: 600 }}>X / Lon</label>
          <input type={inputFormat === "DMS" ? "text" : "number"} value={x} onChange={(e) => setX(e.target.value)} placeholder={placeholders.x} style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", border: "1px solid #bbb" }} />
        </div>
        <div>
          <label style={{ fontWeight: 600 }}>Y / Lat</label>
          <input type={inputFormat === "DMS" ? "text" : "number"} value={y} onChange={(e) => setY(e.target.value)} placeholder={placeholders.y} style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", border: "1px solid #bbb" }} />
        </div>
        <div>
          <label style={{ fontWeight: 600 }}>Height</label>
          <input type="number" value={z} onChange={(e) => setZ(e.target.value)} placeholder={placeholders.z} style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", border: "1px solid #bbb" }} />
        </div>
      </div>

      {utmInfo && (
        <div style={{ marginTop: "0.75rem", padding: "0.85rem", borderRadius: "8px", background: utmInfo.mismatch ? "#fef3c7" : "#ecfdf5", border: `2px solid ${utmInfo.mismatch ? "#f59e0b" : "#10b981"}` }}>
          <div style={{ fontWeight: 600, color: utmInfo.mismatch ? "#92400e" : "#065f46" }}>UTM guidance</div>
          <div style={{ fontSize: "0.9rem", marginTop: "0.3rem" }}>
            Suggested zone: <strong>{utmInfo.suggested.zone}{utmInfo.suggested.hemi}</strong>
            {utmInfo.selected && utmInfo.mismatch && (
              <span style={{ color: "#b45309", marginLeft: "0.5rem", fontWeight: 600 }}>⚠ Mismatch!</span>
            )}
          </div>
          <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.4rem", flexWrap: "wrap" }}>
            <button onClick={() => setUtmFromManualZoneHemi(utmInfo.suggested.zone, "N")} style={{ padding: "0.35rem 0.6rem", background: "#10b981", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "0.85rem" }}>Set North</button>
            <button onClick={() => setUtmFromManualZoneHemi(utmInfo.suggested.zone, "S")} style={{ padding: "0.35rem 0.6rem", background: "#10b981", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "0.85rem" }}>Set South</button>
          </div>
          {utmInfo.selected && utmInfo.mismatch && (
            <div style={{ color: "#b45309", fontSize: "0.9rem", marginTop: "0.4rem" }}>
              ⚠ Currently selected {utmInfo.selected.zone}{utmInfo.selected.hemi} differs from suggested.
            </div>
          )}
          {utmInfo.ups && (
            <div style={{ color: "#b91c1c", fontSize: "0.9rem", marginTop: "0.4rem" }}>
              ⚠ {utmInfo.ups}
            </div>
          )}
        </div>
      )}

      {zoneInfo && zoneInfo.type === "cc" && (
        <div style={{ marginTop: "0.75rem", padding: "0.85rem", borderRadius: "8px", background: zoneInfo.mismatch || zoneInfo.outOfBand ? "#fef3c7" : "#ecfdf5", border: `2px solid ${zoneInfo.mismatch || zoneInfo.outOfBand ? "#f59e0b" : "#10b981"}` }}>
          <div style={{ fontWeight: 600, color: zoneInfo.mismatch || zoneInfo.outOfBand ? "#92400e" : "#065f46" }}>French Lambert Zone Guidance</div>
          <div style={{ fontSize: "0.9rem", marginTop: "0.3rem" }}>
            Suggested zone: <strong>CC{zoneInfo.suggested}</strong> (center: {zoneInfo.centerLat}°N)
            {zoneInfo.mismatch && (
              <span style={{ color: "#b45309", marginLeft: "0.5rem", fontWeight: 600 }}>⚠ Wrong zone selected!</span>
            )}
          </div>
          <div style={{ fontSize: "0.85rem", marginTop: "0.4rem", color: "#16a34a" }}>
            {zoneInfo.minLat ? `Optimal band: ${zoneInfo.minLat}°N - ${zoneInfo.maxLat}°N` : `Optimal for latitude ≥ ${zoneInfo.maxLat || 49}°N`}
          </div>
          {zoneInfo.outOfBand && (
            <div style={{ color: "#b45309", fontSize: "0.9rem", marginTop: "0.4rem", fontWeight: 500 }}>
              ⚠ Location is near zone boundary - verify conversion accuracy
            </div>
          )}
        </div>
      )}

      {zoneInfo && (zoneInfo.type === "gk" || zoneInfo.type === "mga" || zoneInfo.type === "spain" || zoneInfo.type === "jgd" || zoneInfo.type === "sagauss") && (
        <div style={{ marginTop: "0.75rem", padding: "0.85rem", borderRadius: "8px", background: zoneInfo.mismatch ? "#fef3c7" : "#ecfdf5", border: `2px solid ${zoneInfo.mismatch ? "#f59e0b" : "#10b981"}` }}>
          <div style={{ fontWeight: 600, color: zoneInfo.mismatch ? "#92400e" : "#065f46" }}>{zoneInfo.region} Zone Guidance</div>
          <div style={{ fontSize: "0.9rem", marginTop: "0.3rem" }}>
            Suggested zone: <strong>Zone {zoneInfo.suggested}</strong>
            {zoneInfo.mismatch && (
              <span style={{ color: "#b45309", marginLeft: "0.5rem", fontWeight: 600 }}>⚠ Mismatch!</span>
            )}
          </div>
          {zoneInfo.mismatch && (
            <div style={{ color: "#b45309", fontSize: "0.9rem", marginTop: "0.4rem" }}>
              ⚠ Currently selected Zone {zoneInfo.selected} differs from suggested.
            </div>
          )}
        </div>
      )}

      {zoneInfo && (zoneInfo.type === "bng" || zoneInfo.type === "ig" || zoneInfo.type === "egypt" || zoneInfo.type === "morocco" || zoneInfo.type === "algeria" || zoneInfo.type === "tunisia") && (
        <div style={{ marginTop: "0.75rem", padding: "0.85rem", borderRadius: "8px", background: zoneInfo.outOfArea ? "#fee2e2" : "#ecfdf5", border: `2px solid ${zoneInfo.outOfArea ? "#ef4444" : "#10b981"}` }}>
          <div style={{ fontWeight: 600, color: zoneInfo.outOfArea ? "#7f1d1d" : "#065f46" }}>{zoneInfo.region} Grid</div>
          <div style={{ fontSize: "0.9rem", marginTop: "0.3rem" }}>
            {zoneInfo.outOfArea ? (
              <>
                <span style={{ color: "#dc2626" }}>⚠ Coordinates are outside {zoneInfo.region}</span>
                <div style={{ fontSize: "0.85rem", marginTop: "0.4rem" }}>
                  This CRS is designed for {zoneInfo.region} only. Results may be inaccurate.
                </div>
              </>
            ) : (
              <span>✓ Coordinates are within {zoneInfo.region}</span>
            )}
          </div>
        </div>
      )}

      <div style={{ marginTop: "1rem", display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "center" }}>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <label style={{ fontWeight: 600 }}>Geoid mode:</label>
          {" "}
          <select value={geoidMode} onChange={(e) => setGeoidMode(e.target.value)} style={{ padding: "0.45rem", borderRadius: "6px", border: "1px solid #bbb" }}>
            <option value="none">None (2D)</option>
            <option value="auto">Auto</option>
            <option value="manual">Manual</option>
            <option value="upload">Upload</option>
          </select>
        </div>
        
        {geoidMode !== "none" && (
          <div style={{ fontSize: "0.8rem", color: "#d97706", background: "#fffbeb", padding: "0.4rem 0.6rem", borderRadius: "4px", border: "1px solid #fcd34d" }}>
            ⚠️ Geoid processing requires large files. Set to "None" if experiencing slow performance.
          </div>
        )}

        {geoidMode === "manual" && (
          <select value={geoidName} onChange={(e) => setGeoidName(e.target.value)} style={{ padding: "0.45rem", borderRadius: "6px", border: "1px solid #bbb" }}>
            {availableGeoidGrids.map((g) => (
              <option key={g.name} value={g.name}>{g.name}</option>
            ))}
          </select>
        )}

        {geoidMode === "upload" && (
          <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
            <input ref={geoidUploadInputRef} type="file" accept=".tif,.tiff" style={{ display: "none" }} onChange={(e) => setGeoidUploadFile(e.target.files?.[0] || null)} />
            <button onClick={() => geoidUploadInputRef.current?.click()} style={{ padding: "0.4rem 0.9rem", background: "#f1f5f9", color: "#334155", border: "1px solid #cbd5e1", borderRadius: "6px", cursor: "pointer", fontWeight: 600 }}>
              Choose geoid file
            </button>
            {geoidUploadFile && <span style={{ fontSize: "0.85rem", color: "#059669", fontWeight: 500 }}>✓ {geoidUploadFile.name}</span>}
            <input type="text" value={geoidUploadName} onChange={(e) => setGeoidUploadName(e.target.value)} placeholder="Grid name" style={{ padding: "0.4rem", borderRadius: "6px", border: "1px solid #bbb" }} />
          </div>
        )}

        {isUtmCode(toCrs) && (
          <div style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
            <label>Set UTM:</label>
            <input type="number" min="1" max="60" value={utmZoneManual} onChange={(e) => setUtmFromManualZoneHemi(parseInt(e.target.value, 10) || 1, utmHemiManual)} style={{ width: "70px", padding: "0.35rem", borderRadius: "6px", border: "1px solid #bbb" }} />
            <select value={utmHemiManual} onChange={(e) => setUtmFromManualZoneHemi(utmZoneManual, e.target.value)} style={{ padding: "0.35rem", borderRadius: "6px", border: "1px solid #bbb" }}>
              <option value="N">N</option>
              <option value="S">S</option>
            </select>
          </div>
        )}
      </div>

      <div
        style={{
          marginTop: "1rem",
          display: "flex",
          gap: "0.9rem",
          flexWrap: "wrap",
          alignItems: "stretch",
          justifyContent: "space-between"
        }}
      >
        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", alignItems: "center" }}>
          <button onClick={handleSingleConvert} style={{ minWidth: "130px", padding: "0.65rem 0.9rem", background: "#2563eb", color: "#fff", border: "none", borderRadius: "8px", cursor: "pointer", fontWeight: 600 }}>Convert Single Point</button>
        </div>

        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ position: "relative", display: "flex", alignItems: "center", gap: "0.35rem" }}>
            <button onClick={handleDetectCrs} disabled={detectLoading} style={{ minWidth: "130px", padding: "0.65rem 0.9rem", background: "#6d28d9", color: "#fff", border: "none", borderRadius: "8px", cursor: "pointer", fontWeight: 600 }}>{detectLoading ? "Detecting..." : "Detect CRS"}</button>
            <span onMouseEnter={() => setShowConfidenceTooltip(true)} onMouseLeave={() => setShowConfidenceTooltip(false)} style={{ cursor: "help", fontWeight: 700, color: "#6d28d9" }}>?</span>
            {showConfidenceTooltip && (
              <div style={{
                position: "absolute",
                top: "2.5rem",
                left: 0,
                background: "#1f2937",
                color: "#fff",
                padding: "0.75rem",
                borderRadius: "6px",
                fontSize: "0.85rem",
                zIndex: 1000,
                minWidth: "280px",
                boxShadow: "0 4px 12px rgba(0,0,0,0.3)"
              }}>
                <div style={{ fontWeight: 700, marginBottom: "0.5rem" }}>Confidence Scale</div>
                <div style={{ marginBottom: "0.4rem" }}>90-100%: High - Extents-based match</div>
                <div style={{ marginBottom: "0.4rem" }}>75-89%: Good - UTM/metadata match</div>
                <div style={{ marginBottom: "0.4rem" }}>60-74%: Fair - Trial transform</div>
                <div>Below 60%: Low - Use with caution</div>
              </div>
            )}
          </div>
          <button
            onClick={handleResetAll}
            style={{
              minWidth: "130px",
              padding: "0.65rem 0.9rem",
              background: "#f8fafc",
              color: "#334155",
              border: "1px solid #cbd5e1",
              borderRadius: "8px",
              cursor: "pointer",
              fontWeight: 600
            }}
          >
            Reset Single
          </button>
        </div>
      </div>

      {showResetConfirm && (
        <div style={{ marginTop: "0.65rem", padding: "0.65rem 0.75rem", border: "1px solid #fecaca", background: "#fff1f2", borderRadius: "8px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
          <span style={{ color: "#9f1239", fontSize: "0.88rem", fontWeight: 600 }}>
            Reset the current single-point workflow and clear all results?
          </span>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <button
              onClick={() => setShowResetConfirm(false)}
              style={{ padding: "0.35rem 0.7rem", border: "1px solid #cbd5e1", borderRadius: "6px", background: "#fff", color: "#334155", cursor: "pointer", fontWeight: 600 }}
            >
              Cancel
            </button>
            <button
              onClick={performResetAll}
              style={{ padding: "0.35rem 0.7rem", border: "none", borderRadius: "6px", background: "#dc2626", color: "#fff", cursor: "pointer", fontWeight: 600 }}
            >
              Reset Now
            </button>
          </div>
        </div>
      )}

      {/* Detect suggestions dropdown */}
      {showDetectSuggestions && detectSuggestions && detectSuggestions.length > 0 && (
        <div style={{ marginTop: "0.5rem", border: '1px solid #e2e8f0', borderRadius: 8, padding: 8, background: '#fff', maxWidth: 720 }}>
          {(() => {
            const rankedForView = [...detectSuggestions].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
            const suggestionsForView = detectionMapMode === 'top'
              ? rankedForView.slice(0, TOP_DETECTION_LIMIT)
              : rankedForView;
            const topConfidence = rankedForView[0]?.confidence || 0;

            return (
              <>
          <div style={{ fontWeight: 700, marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            Detected CRS suggestions
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <div style={{ display: 'inline-flex', border: '1px solid #cbd5e1', borderRadius: 6, overflow: 'hidden' }}>
                <button
                  onClick={() => setDetectionMapMode('top')}
                  style={{
                    padding: '0.3rem 0.55rem',
                    border: 'none',
                    borderRight: '1px solid #cbd5e1',
                    background: detectionMapMode === 'top' ? '#1d4ed8' : '#fff',
                    color: detectionMapMode === 'top' ? '#fff' : '#334155',
                    cursor: 'pointer',
                    fontSize: '0.8rem',
                    fontWeight: 600
                  }}
                >
                  Top detections only
                </button>
                <button
                  onClick={() => setDetectionMapMode('all')}
                  style={{
                    padding: '0.3rem 0.55rem',
                    border: 'none',
                    background: detectionMapMode === 'all' ? '#1d4ed8' : '#fff',
                    color: detectionMapMode === 'all' ? '#fff' : '#334155',
                    cursor: 'pointer',
                    fontSize: '0.8rem',
                    fontWeight: 600
                  }}
                >
                  All detections
                </button>
              </div>
              <button onClick={handlePlotDetections} style={{ padding: '0.35rem 0.7rem', background: '#8b5cf6', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem' }}>
                Plot on Map
              </button>
            </div>
          </div>
          <div style={{ fontSize: '0.8rem', color: '#64748b', marginBottom: '0.35rem' }}>
            {detectionMapMode === 'top'
              ? `Top mode shows and plots the top ${Math.min(TOP_DETECTION_LIMIT, detectSuggestions.length)} highest-confidence detections.`
              : `All mode plots all ${detectSuggestions.length} detections.`}
          </div>
          {topConfidence < 0.75 && (
            <div style={{ marginBottom: '0.5rem', padding: '0.5rem 0.6rem', border: '1px solid #f59e0b', borderRadius: 6, background: '#fffbeb', color: '#92400e', fontSize: '0.82rem' }}>
              Low confidence detection. Review the top 3 suggestions and plot points on map before applying.
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {suggestionsForView.map((s) => (
              <div key={s.code} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 8px', borderRadius: 6, background: '#f8fafc' }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{s.code} — {s.name}</div>
                  <div style={{ fontSize: '0.85rem', color: '#475569' }}>{Math.round((s.confidence||0)*100)}% — {s.reason}</div>
                </div>
                <div>
                  <button onClick={() => { setFromCrsManually(s.code); setShowDetectSuggestions(false); }} style={{ padding: '0.35rem 0.6rem', background: '#10b981', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Use</button>
                </div>
              </div>
            ))}
          </div>
              </>
            );
          })()}
        </div>
      )}

      {error && (
        <div role="alert" aria-live="polite" style={{ marginTop: "0.75rem", padding: "0.75rem", background: "#fef2f2", border: "1px solid #fecdd3", borderRadius: "8px", color: "#b91c1c" }}>
          {error}
        </div>
      )}

      {bulkResults.length > 0 && (() => {
        const utmWarningsCount = bulkResults.filter((r) => r.utmWarning).length;
        const ccWarningsCount = bulkResults.filter((r) => r.ccWarning).length;
        const otherWarningsCount = bulkResults.filter((r) => r.otherZoneWarning).length;
        
        if (utmWarningsCount > 0 && isUtmCode(toCrs)) {
          return (
            <div style={{ marginTop: "0.75rem", padding: "0.75rem", borderRadius: "8px", background: "#fef3c7", border: "2px solid #f59e0b", color: "#92400e" }}>
              <div style={{ fontWeight: 700, marginBottom: "0.4rem" }}>⚠ UTM Zone Mismatch Warning</div>
              <div style={{ fontSize: "0.9rem" }}>
                {utmWarningsCount} of {bulkResults.length} point(s) have a zone mismatch. Selected zone <strong>{parseUtmFromEpsg(toCrs)?.zone}{parseUtmFromEpsg(toCrs)?.hemi}</strong> may not be optimal for all coordinates.
              </div>
              <div style={{ fontSize: "0.85rem", marginTop: "0.4rem", color: "#7c2d12" }}>
                Review the Zone column in the results table below for per-point suggestions.
              </div>
            </div>
          );
        }
        
        if (ccWarningsCount > 0 && isCcCode(toCrs)) {
          return (
            <div style={{ marginTop: "0.75rem", padding: "0.75rem", borderRadius: "8px", background: "#fef3c7", border: "2px solid #f59e0b", color: "#92400e" }}>
              <div style={{ fontWeight: 700, marginBottom: "0.4rem" }}>⚠ French Lambert Zone Mismatch Warning</div>
              <div style={{ fontSize: "0.9rem" }}>
                {ccWarningsCount} of {bulkResults.length} point(s) have a zone mismatch. Selected zone <strong>CC{parseCcFromEpsg(toCrs)?.zone}</strong> may not be optimal for all coordinates.
              </div>
              <div style={{ fontSize: "0.85rem", marginTop: "0.4rem", color: "#7c2d12" }}>
                Review the Zone column in the results table below for per-point suggestions.
              </div>
            </div>
          );
        }

        if (otherWarningsCount > 0 && (isGkCode(toCrs) || isSpainCode(toCrs) || isMgaCode(toCrs) || isJgdCode(toCrs) || isBngCode(toCrs) || isIgCode(toCrs) || isSaGaussCode(toCrs) || isEgyptCode(toCrs) || isMoroccoCode(toCrs) || isAlgeriaCode(toCrs) || isTunisiaCode(toCrs))) {
          const regionName = isBngCode(toCrs) ? "British National Grid" : isIgCode(toCrs) ? "Irish Grid" : 
                            isGkCode(toCrs) ? "German Gauss-Krüger" : isSpainCode(toCrs) ? "Spanish Grid" :
                            isMgaCode(toCrs) ? "Australian MGA" : isJgdCode(toCrs) ? "Japanese JGD" :
                            isSaGaussCode(toCrs) ? "South Africa Gauss Conform" : isEgyptCode(toCrs) ? "Egypt" :
                            isMoroccoCode(toCrs) ? "Morocco" : isAlgeriaCode(toCrs) ? "Algeria" : "Tunisia";
          return (
            <div style={{ marginTop: "0.75rem", padding: "0.75rem", borderRadius: "8px", background: "#fef3c7", border: "2px solid #f59e0b", color: "#92400e" }}>
              <div style={{ fontWeight: 700, marginBottom: "0.4rem" }}>⚠ {regionName} Zone Mismatch Warning</div>
              <div style={{ fontSize: "0.9rem" }}>
                {otherWarningsCount} of {bulkResults.length} point(s) have a zone mismatch or are outside the optimal zone.
              </div>
              <div style={{ fontSize: "0.85rem", marginTop: "0.4rem", color: "#7c2d12" }}>
                Review the Zone column in the results table below for per-point suggestions.
              </div>
            </div>
          );
        }
        return null;
      })()}

      {result && (
        <div style={{ marginTop: "1rem", padding: "0.85rem", borderRadius: "10px", background: "#eff6ff", border: "1px solid #bfdbfe" }}>
          <div style={{ fontWeight: 700, marginBottom: "0.4rem" }}>Single result</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "0.4rem" }}>
            <div><strong>Input:</strong> {fromCrs} ({fromLabel})</div>
            <div><strong>Output:</strong> {toCrs} ({toLabel})</div>
            {CRS_LIST.find((c) => c.code === toCrs)?.type === "geographic" ? (
              <>
                {outputFormat === "BOTH" ? (
                  <>
                    <div><strong>X (DD):</strong> {fmtNum(result.xOut, 8)}</div>
                    <div><strong>X (DMS):</strong> {ddToDMS(result.xOut, "lon")}</div>
                    <div><strong>Y (DD):</strong> {fmtNum(result.yOut, 8)}</div>
                    <div><strong>Y (DMS):</strong> {ddToDMS(result.yOut, "lat")}</div>
                  </>
                ) : (
                  <>
                    <div><strong>X:</strong> {outputFormat === "DMS" ? ddToDMS(result.xOut, "lon") : fmtNum(result.xOut, 8)}</div>
                    <div><strong>Y:</strong> {outputFormat === "DMS" ? ddToDMS(result.yOut, "lat") : fmtNum(result.yOut, 8)}</div>
                  </>
                )}
              </>
            ) : (
              <>
                <div><strong>X:</strong> {fmtNum(result.xOut, 4)}</div>
                <div><strong>Y:</strong> {fmtNum(result.yOut, 4)}</div>
              </>
            )}
            {result.zOut !== null && (
              <div>
                <strong>{inputHeightType === "orthometric" ? "h (ellipsoidal):" : "H (orthometric):"}</strong> {fmtNum(result.zOut, 4)}
              </div>
            )}
            {result.N !== null && (<div><strong>N:</strong> {fmtNum(result.N, 4)} (geoid)</div>)}
          </div>
        </div>
      )}

      <div style={{ marginTop: "1.2rem", marginBottom: "0.45rem", fontSize: "0.73rem", fontWeight: 700, color: "var(--c-text-secondary, #475569)", textTransform: "uppercase", letterSpacing: "0.06em", paddingBottom: "0.3rem", borderBottom: "2px solid var(--c-secondary, #0891b2)" }}>
        Bulk Conversion
      </div>

      <div style={{ marginTop: "0.6rem", border: "1px solid #dbeafe", borderRadius: "8px", background: "#f8fbff" }}>
        <button
          onClick={() => setShowBulkTextInput((v) => !v)}
          style={{
            width: "100%",
            textAlign: "left",
            padding: "0.6rem 0.75rem",
            border: "none",
            borderRadius: "8px",
            background: "transparent",
            color: "#1e3a8a",
            fontWeight: 700,
            cursor: "pointer"
          }}
        >
          {showBulkTextInput ? "Hide" : "Show"} Bulk input (one point per line: [ID] x y [z])
        </button>

        {showBulkTextInput && (
          <div style={{ padding: "0 0.75rem 0.75rem 0.75rem" }}>
            <textarea
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              rows={8}
              style={{ width: "100%", marginTop: "0.2rem", padding: "0.75rem", borderRadius: "8px", border: "1px solid #cbd5e1", fontFamily: "monospace" }}
              placeholder="2.35 48.85 50\n2.4 48.9 52\nPoint1 2.45 48.95 55"
            />
          </div>
        )}

        {bulkProgress && <div role="status" aria-live="polite" style={{ margin: "0 0.75rem 0.6rem 0.75rem", color: "#6b7280" }}>{bulkProgress}</div>}
      </div>

      <div style={{ marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <label style={{ fontWeight: 700 }}>Upload bulk file (CSV/TXT/GeoJSON/GPX/KML/ZIP/XLSX)</label>
        <div style={{ fontSize: "0.85rem", color: "#475569" }}>
          Supports files with optional point names/IDs in first column. Header keywords: X/Easting/Lon/Longitude, Y/Northing/Lat/Latitude, 
          Z/Height/Elevation/Hgt (orthometric), h/Ellipsoidal/GeodeticHeight (ellipsoidal), EPSG codes. Add <strong>h</strong> to force ellipsoidal or <strong>H</strong>/Height/Elevation to force orthometric.
        </div>
        <div style={{ fontSize: "0.85rem", color: "#334155", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "6px", padding: "0.6rem" }}>
          <strong>Format tips:</strong>
          <ul style={{ margin: "0.5rem 0 0 1rem" }}>
            <li>WKT/EWKT: <em>POINT(lon lat [h])</em> or <em>SRID=4326;POINT(...)</em></li>
            <li>UTM: <em>55S 334368.6336 6250948.3454 [H]</em> or <em>32756, X, Y, H</em></li>
            <li>DD with hemispheres: <em>48.8566N, 2.3522E, 35</em> or DMS <em>48°51'24"N, 2°21'08"E</em></li>
            <li>Files: .csv/.txt, .geojson/.json, .gpx, .kml, .zip (shapefile), .xlsx/.xls, .dxf, .dwg (native DWG via backend)</li>
          </ul>
          <div style={{ marginTop: "0.5rem" }}>
            Quick samples: 
            <a href="/samples/sample.csv" target="_blank" rel="noreferrer">CSV</a> · 
            <a href="/samples/sample.geojson" target="_blank" rel="noreferrer">GeoJSON</a> · 
            <a href="/samples/sample.gpx" target="_blank" rel="noreferrer">GPX</a> · 
              <a href="/samples/sample.kml" target="_blank" rel="noreferrer">KML</a> · 
              <a href="/samples/sample_test_text.dwg" target="_blank" rel="noreferrer">DWG test</a>
          </div>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <input ref={bulkFileInputRef} type="file" accept=".csv,.txt,.geojson,.json,.gpx,.kml,.zip,.xlsx,.xls,.dxf,.dwg" onChange={(e) => { 
            const f = e.target.files?.[0] || null; 
              applyBulkFileSelection(f);
          }} style={{ display: "none" }} />
          <button onClick={() => bulkFileInputRef.current?.click()} style={{ padding: "0.5rem 0.9rem", background: "#f1f5f9", color: "#334155", border: "1px solid #cbd5e1", borderRadius: "6px", cursor: "pointer" }}>
            Choose file
          </button>
            <button onClick={handleLoadSampleDwg} style={{ padding: "0.5rem 0.9rem", background: "#eef2ff", color: "#3730a3", border: "1px solid #c7d2fe", borderRadius: "6px", cursor: "pointer", fontWeight: 600 }}>
              Load DWG Sample
            </button>
          <button onClick={handleBulkConvert} style={{ padding: "0.5rem 0.9rem", background: "#0f766e", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: 600 }}>
            Convert File/Bulk
          </button>
          {bulkIsConverting && (
            <button
              onClick={() => { bulkCancelRef.current = true; }}
              style={{ padding: "0.5rem 0.9rem", background: "#fff1f2", color: "#9f1239", border: "1px solid #fecaca", borderRadius: "6px", cursor: "pointer", fontWeight: 600 }}
            >
              Cancel
            </button>
          )}
          <button
            onClick={handleBulkResetAll}
            style={{ padding: "0.5rem 0.9rem", background: "#f8fafc", color: "#334155", border: "1px solid #cbd5e1", borderRadius: "6px", cursor: "pointer", fontWeight: 600 }}
          >
            Reset Bulk
          </button>
          {bulkUploadFile && <span style={{ fontSize: "0.85rem", color: "#059669", fontWeight: 500 }}>✓ {bulkUploadFile.name}</span>}
        </div>
        {bulkUploadError && <div role="alert" style={{ color: "#b91c1c" }}>{bulkUploadError}</div>}
        <div style={{ display: "grid", gap: "0.55rem", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
          <div style={{ border: "1px solid #dbeafe", borderRadius: "8px", background: "#f8fbff", padding: "0.75rem" }}>
            <div style={{ fontWeight: 700, color: "#1d4ed8", fontSize: "0.76rem", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.35rem" }}>CAD Backend</div>
            <div style={{ fontSize: "0.84rem", color: "#334155" }}>
              Mode: <strong>{cadBackendStatus?.converterMode || "offline"}</strong>
            </div>
            <div style={{ fontSize: "0.84rem", color: cadBackendStatus?.dwgEnabled ? "#166534" : "#92400e" }}>
              {cadBackendStatus?.dwgEnabled ? "Native DWG conversion ready" : (cadBackendStatusError || cadBackendStatus?.setupHint || "Native DWG converter not available")}
            </div>
            {cadBackendStatus?.converterPath && (
              <div style={{ fontSize: "0.78rem", color: "#475569", marginTop: "0.35rem", wordBreak: "break-all" }}>
                {cadBackendStatus.converterPath}
              </div>
            )}
          </div>
          <div style={{ border: "1px solid #e2e8f0", borderRadius: "8px", background: "#ffffff", padding: "0.75rem" }}>
            <div style={{ fontWeight: 700, color: "#0f172a", fontSize: "0.76rem", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.35rem" }}>CAD Inspection</div>
            {!cadInspection && <div style={{ fontSize: "0.84rem", color: "#64748b" }}>Select and convert a DXF or DWG file to inspect file routing, detected CRS, and parsed bounds.</div>}
            {cadInspection && (
              <div style={{ display: "grid", gap: "0.18rem", fontSize: "0.84rem", color: "#334155" }}>
                <div><strong>{cadInspection.fileName}</strong> {cadInspection.extension ? `(${cadInspection.extension})` : ""}</div>
                <div>Size: {formatBytes(cadInspection.fileSizeBytes)}</div>
                <div>Route: {cadInspection.processingRoute || "pending"}</div>
                <div>Rows: {cadInspection.rowCount ?? "pending"}</div>
                <div>Detected CRS: {cadInspection.detectedFromCrs || "pending"}</div>
                {cadInspection.bounds && cadInspection.bounds.minX !== null && (
                  <div>
                    Bounds: X {cadInspection.bounds.minX.toFixed(3)} to {cadInspection.bounds.maxX.toFixed(3)} | Y {cadInspection.bounds.minY.toFixed(3)} to {cadInspection.bounds.maxY.toFixed(3)}
                  </div>
                )}
                {cadInspection.bounds && cadInspection.bounds.minZ !== null && (
                  <div>Z range: {cadInspection.bounds.minZ.toFixed(3)} to {cadInspection.bounds.maxZ.toFixed(3)}</div>
                )}
                {cadInspection.warnings?.length > 0 && (
                  <div style={{ color: "#92400e" }}>{cadInspection.warnings.join(" ")}</div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={{ marginTop: "0.6rem", padding: "0.7rem", border: "1px solid #dbeafe", borderRadius: "8px", background: "#f8fbff" }}>
        <div style={{ fontWeight: 700, color: "var(--c-primary, #1d4ed8)", marginBottom: "0.4rem", fontSize: "0.73rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>Benchmark / Reference Validation</div>
        <div style={{ fontSize: "0.82rem", color: "#334155", marginBottom: "0.45rem" }}>
          Upload CSV with columns: id, expectedX, expectedY and optional expectedZ to compare against current bulk outputs.
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <input
            ref={benchmarkFileInputRef}
            type="file"
            accept=".csv,.txt"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0] || null;
              setBenchmarkFile(f);
              setBenchmarkSummary(null);
              setBenchmarkRows([]);
            }}
          />
          <button
            onClick={() => benchmarkFileInputRef.current?.click()}
            style={{ padding: "0.45rem 0.9rem", background: "#f1f5f9", color: "#334155", border: "1px solid #cbd5e1", borderRadius: "6px", cursor: "pointer", fontWeight: 600 }}
          >
            Choose benchmark file
          </button>
          <label style={{ fontSize: "0.8rem", color: "#334155" }}>
            Tolerance
            <input
              type="number"
              min="0"
              step="0.0001"
              value={benchmarkTolerance}
              onChange={(e) => setBenchmarkTolerance(Math.max(0, Number(e.target.value) || 0))}
              style={{ marginLeft: "0.35rem", width: "90px", padding: "0.3rem", borderRadius: "6px", border: "1px solid #cbd5e1" }}
            />
          </label>
          <button
            onClick={() => runBenchmarkValidation()}
            disabled={!benchmarkFile || bulkResults.length === 0}
            style={{
              padding: "0.45rem 0.75rem",
              borderRadius: "6px",
              border: "1px solid #2563eb",
              background: !benchmarkFile || bulkResults.length === 0 ? "#dbeafe" : "#2563eb",
              color: !benchmarkFile || bulkResults.length === 0 ? "#1e3a8a" : "#fff",
              cursor: !benchmarkFile || bulkResults.length === 0 ? "not-allowed" : "pointer",
              fontWeight: 700,
              fontSize: "0.82rem"
            }}
          >
            Compare
          </button>
          {benchmarkFile && <span style={{ fontSize: "0.8rem", color: "#475569" }}>Selected: {benchmarkFile.name}</span>}
        </div>
        {benchmarkSummary && (
          <div style={{ marginTop: "0.45rem", fontSize: "0.82rem", color: "#1e3a8a" }}>
            Compared rows: {benchmarkSummary.compared}
            {" | "}Mean residual 2D: {benchmarkSummary.meanResidual.toFixed(4)}
            {" | "}Max residual 2D: {benchmarkSummary.maxResidual.toFixed(4)}
            {benchmarkSummary.compared3d > 0 ? ` | Mean residual 3D: ${benchmarkSummary.meanResidual3d.toFixed(4)} | Max residual 3D: ${benchmarkSummary.maxResidual3d.toFixed(4)}` : ""}
            {" | "}Pass: {benchmarkSummary.passCount}
            {" | "}Fail: {benchmarkSummary.failCount}
          </div>
        )}

        {benchmarkRows.length > 0 && (
          <div style={{ marginTop: "0.6rem", border: "1px solid #bfdbfe", borderRadius: "8px", overflow: "hidden", background: "#fff" }}>
            <div style={{ padding: "0.55rem 0.7rem", background: "#eff6ff", color: "#1e3a8a", fontWeight: 700, fontSize: "0.82rem" }}>
              Point-by-point benchmark details
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "920px", fontSize: "0.8rem" }}>
                <thead>
                  <tr style={{ background: "#f8fafc", color: "#334155" }}>
                    <th style={{ padding: "0.38rem 0.45rem", textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>Point</th>
                    <th style={{ padding: "0.38rem 0.45rem", textAlign: "right", borderBottom: "1px solid #e2e8f0" }}>Expected X</th>
                    <th style={{ padding: "0.38rem 0.45rem", textAlign: "right", borderBottom: "1px solid #e2e8f0" }}>Expected Y</th>
                    <th style={{ padding: "0.38rem 0.45rem", textAlign: "right", borderBottom: "1px solid #e2e8f0" }}>Expected Z</th>
                    <th style={{ padding: "0.38rem 0.45rem", textAlign: "right", borderBottom: "1px solid #e2e8f0" }}>Output X</th>
                    <th style={{ padding: "0.38rem 0.45rem", textAlign: "right", borderBottom: "1px solid #e2e8f0" }}>Output Y</th>
                    <th style={{ padding: "0.38rem 0.45rem", textAlign: "right", borderBottom: "1px solid #e2e8f0" }}>Output Z</th>
                    <th style={{ padding: "0.38rem 0.45rem", textAlign: "right", borderBottom: "1px solid #e2e8f0" }}>dX</th>
                    <th style={{ padding: "0.38rem 0.45rem", textAlign: "right", borderBottom: "1px solid #e2e8f0" }}>dY</th>
                    <th style={{ padding: "0.38rem 0.45rem", textAlign: "right", borderBottom: "1px solid #e2e8f0" }}>dZ</th>
                    <th style={{ padding: "0.38rem 0.45rem", textAlign: "right", borderBottom: "1px solid #e2e8f0" }}>Residual 2D</th>
                    <th style={{ padding: "0.38rem 0.45rem", textAlign: "right", borderBottom: "1px solid #e2e8f0" }}>Residual 3D</th>
                    <th style={{ padding: "0.38rem 0.45rem", textAlign: "center", borderBottom: "1px solid #e2e8f0" }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {benchmarkRows.map((r, idx) => {
                    const isPass = r.statusResidual <= benchmarkTolerance;
                    return (
                      <tr key={`${r.id}-${idx}`} style={{ background: idx % 2 ? "#fcfdff" : "#ffffff" }}>
                        <td style={{ padding: "0.35rem 0.45rem", borderBottom: "1px solid #f1f5f9", fontWeight: 600 }}>{r.id}</td>
                        <td style={{ padding: "0.35rem 0.45rem", borderBottom: "1px solid #f1f5f9", textAlign: "right", fontFamily: "monospace" }}>{r.expectedX.toFixed(6)}</td>
                        <td style={{ padding: "0.35rem 0.45rem", borderBottom: "1px solid #f1f5f9", textAlign: "right", fontFamily: "monospace" }}>{r.expectedY.toFixed(6)}</td>
                        <td style={{ padding: "0.35rem 0.45rem", borderBottom: "1px solid #f1f5f9", textAlign: "right", fontFamily: "monospace" }}>{Number.isFinite(r.expectedZ) ? r.expectedZ.toFixed(4) : "-"}</td>
                        <td style={{ padding: "0.35rem 0.45rem", borderBottom: "1px solid #f1f5f9", textAlign: "right", fontFamily: "monospace" }}>{r.outputX.toFixed(6)}</td>
                        <td style={{ padding: "0.35rem 0.45rem", borderBottom: "1px solid #f1f5f9", textAlign: "right", fontFamily: "monospace" }}>{r.outputY.toFixed(6)}</td>
                        <td style={{ padding: "0.35rem 0.45rem", borderBottom: "1px solid #f1f5f9", textAlign: "right", fontFamily: "monospace" }}>{Number.isFinite(r.outputZ) ? r.outputZ.toFixed(4) : "-"}</td>
                        <td style={{ padding: "0.35rem 0.45rem", borderBottom: "1px solid #f1f5f9", textAlign: "right", fontFamily: "monospace", color: Math.abs(r.dx) > benchmarkTolerance ? "#b91c1c" : "#334155" }}>{r.dx.toFixed(6)}</td>
                        <td style={{ padding: "0.35rem 0.45rem", borderBottom: "1px solid #f1f5f9", textAlign: "right", fontFamily: "monospace", color: Math.abs(r.dy) > benchmarkTolerance ? "#b91c1c" : "#334155" }}>{r.dy.toFixed(6)}</td>
                        <td style={{ padding: "0.35rem 0.45rem", borderBottom: "1px solid #f1f5f9", textAlign: "right", fontFamily: "monospace", color: Number.isFinite(r.dz) && Math.abs(r.dz) > benchmarkTolerance ? "#b91c1c" : "#334155" }}>{Number.isFinite(r.dz) ? r.dz.toFixed(6) : "-"}</td>
                        <td style={{ padding: "0.35rem 0.45rem", borderBottom: "1px solid #f1f5f9", textAlign: "right", fontFamily: "monospace", color: "#334155" }}>{r.dist.toFixed(6)}</td>
                        <td style={{ padding: "0.35rem 0.45rem", borderBottom: "1px solid #f1f5f9", textAlign: "right", fontFamily: "monospace", fontWeight: 700, color: isPass ? "#15803d" : "#b91c1c" }}>{Number.isFinite(r.dist3d) ? r.dist3d.toFixed(6) : "-"}</td>
                        <td style={{ padding: "0.35rem 0.45rem", borderBottom: "1px solid #f1f5f9", textAlign: "center" }}>
                          <span style={{
                            display: "inline-block",
                            minWidth: "50px",
                            padding: "0.15rem 0.35rem",
                            borderRadius: "999px",
                            fontWeight: 700,
                            fontSize: "0.74rem",
                            background: isPass ? "#dcfce7" : "#fee2e2",
                            color: isPass ? "#166534" : "#991b1b"
                          }}>
                            {isPass ? "PASS" : "FAIL"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {showBulkResetConfirm && (
        <div style={{ marginTop: "0.65rem", padding: "0.65rem 0.75rem", border: "1px solid #fecaca", background: "#fff1f2", borderRadius: "8px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
          <span style={{ color: "#9f1239", fontSize: "0.88rem", fontWeight: 600 }}>
            Reset the current bulk workflow, benchmark results, and map output?
          </span>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <button
              onClick={() => setShowBulkResetConfirm(false)}
              style={{ padding: "0.35rem 0.7rem", border: "1px solid #cbd5e1", borderRadius: "6px", background: "#fff", color: "#334155", cursor: "pointer", fontWeight: 600 }}
            >
              Cancel
            </button>
            <button
              onClick={performResetAll}
              style={{ padding: "0.35rem 0.7rem", border: "none", borderRadius: "6px", background: "#dc2626", color: "#fff", cursor: "pointer", fontWeight: 600 }}
            >
              Reset Now
            </button>
          </div>
        </div>
      )}

      {bulkResults.length > 0 && (
        <div style={{ marginTop: "0.75rem" }}>
          {(() => {
            // Determine height types from results
            const sampleRow = bulkResults.find((r) => r.inputZType);
            const inputZType = sampleRow?.inputZType || "orthometric";
            const outputZType = sampleRow?.outputZType || "ellipsoidal";
            
            const inputHeightLabel = inputZType === "ellipsoidal" ? "h (ellipsoid)" : "H (orthometric)";
            const outputHeightLabel = outputZType === "ellipsoidal" ? "h (ellipsoid)" : "H (orthometric)";
            
            const labels = getCoordinateLabels(fromCrs, toCrs, inputZType, outputZType);
            const toIsGeoForTable = CRS_LIST.find((c) => c.code === toCrs)?.type === "geographic";
            
            return (
              <div>
                {/* Export and map actions */}
                <div style={{ marginBottom: "1rem", padding: "1rem", background: "#f0f9ff", borderRadius: "8px", border: "1px solid #bfdbfe" }}>
                  <div style={{ fontWeight: 700, marginBottom: "0.75rem", color: "var(--c-primary, #1d4ed8)", fontSize: "0.73rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    Export Conversion Results
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: "0.5rem" }}>
                    <button
                      onClick={handleExportCSV}
                      style={{
                        padding: "0.6rem 0.8rem",
                        background: "#10b981",
                        color: "#fff",
                        border: "none",
                        borderRadius: "6px",
                        cursor: "pointer",
                        fontWeight: 500,
                        fontSize: "0.85rem",
                        transition: "all 0.2s",
                      }}
                      onMouseOver={(e) => e.target.style.background = "#059669"}
                      onMouseOut={(e) => e.target.style.background = "#10b981"}
                    >
                      📄 CSV
                    </button>
                    <button
                      onClick={handleExportGeoJSON}
                      style={{
                        padding: "0.6rem 0.8rem",
                        background: "#3b82f6",
                        color: "#fff",
                        border: "none",
                        borderRadius: "6px",
                        cursor: "pointer",
                        fontWeight: 500,
                        fontSize: "0.85rem",
                        transition: "all 0.2s",
                      }}
                      onMouseOver={(e) => e.target.style.background = "#2563eb"}
                      onMouseOut={(e) => e.target.style.background = "#3b82f6"}
                    >
                      🗺️ GeoJSON
                    </button>
                    <button
                      onClick={handleExportKML}
                      style={{
                        padding: "0.6rem 0.8rem",
                        background: "#f59e0b",
                        color: "#fff",
                        border: "none",
                        borderRadius: "6px",
                        cursor: "pointer",
                        fontWeight: 500,
                        fontSize: "0.85rem",
                        transition: "all 0.2s",
                      }}
                      onMouseOver={(e) => e.target.style.background = "#d97706"}
                      onMouseOut={(e) => e.target.style.background = "#f59e0b"}
                    >
                      📍 KML
                    </button>
                    <button
                      onClick={handleExportGPX}
                      style={{
                        padding: "0.6rem 0.8rem",
                        background: "#8b5cf6",
                        color: "#fff",
                        border: "none",
                        borderRadius: "6px",
                        cursor: "pointer",
                        fontWeight: 500,
                        fontSize: "0.85rem",
                        transition: "all 0.2s",
                      }}
                      onMouseOver={(e) => e.target.style.background = "#7c3aed"}
                      onMouseOut={(e) => e.target.style.background = "#8b5cf6"}
                    >
                      🧭 GPX
                    </button>
                    <button
                      onClick={handleExportXLSX}
                      style={{
                        padding: "0.6rem 0.8rem",
                        background: "#06b6d4",
                        color: "#fff",
                        border: "none",
                        borderRadius: "6px",
                        cursor: "pointer",
                        fontWeight: 500,
                        fontSize: "0.85rem",
                        transition: "all 0.2s",
                      }}
                      onMouseOver={(e) => e.target.style.background = "#0891b2"}
                      onMouseOut={(e) => e.target.style.background = "#06b6d4"}
                    >
                      📊 Excel
                    </button>
                    <button
                      onClick={handleExportWKT}
                      style={{
                        padding: "0.6rem 0.8rem",
                        background: "#ec4899",
                        color: "#fff",
                        border: "none",
                        borderRadius: "6px",
                        cursor: "pointer",
                        fontWeight: 500,
                        fontSize: "0.85rem",
                        transition: "all 0.2s",
                      }}
                      onMouseOver={(e) => e.target.style.background = "#db2777"}
                      onMouseOut={(e) => e.target.style.background = "#ec4899"}
                    >
                      ✏️ WKT
                    </button>
                    <button
                      onClick={handleExportDXF}
                      style={{
                        padding: "0.6rem 0.8rem",
                        background: "#14b8a6",
                        color: "#fff",
                        border: "none",
                        borderRadius: "6px",
                        cursor: "pointer",
                        fontWeight: 500,
                        fontSize: "0.85rem",
                        transition: "all 0.2s",
                      }}
                      onMouseOver={(e) => e.target.style.background = "#0d9488"}
                      onMouseOut={(e) => e.target.style.background = "#14b8a6"}
                    >
                      📐 DXF
                    </button>
                    {/* Shapefile export disabled - library compatibility issues */}
                    <button
                      onClick={handleExportAll}
                      style={{
                        padding: "0.6rem 0.8rem",
                        background: "#6366f1",
                        color: "#fff",
                        border: "none",
                        borderRadius: "6px",
                        cursor: "pointer",
                        fontWeight: 500,
                        fontSize: "0.85rem",
                        transition: "all 0.2s",
                      }}
                      onMouseOver={(e) => e.target.style.background = "#4f46e5"}
                      onMouseOut={(e) => e.target.style.background = "#6366f1"}
                    >
                      📦 All (ZIP)
                    </button>
                    {benchmarkSummary && benchmarkRows.length > 0 && (
                      <button
                        onClick={handleExportBenchmarkReport}
                        style={{
                          padding: "0.6rem 0.8rem",
                          background: "#1d4ed8",
                          color: "#fff",
                          border: "none",
                          borderRadius: "6px",
                          cursor: "pointer",
                          fontWeight: 600,
                          fontSize: "0.85rem",
                          transition: "all 0.2s",
                        }}
                        onMouseOver={(e) => e.target.style.background = "#1e40af"}
                        onMouseOut={(e) => e.target.style.background = "#1d4ed8"}
                        title="Export detailed benchmark comparison report"
                      >
                        📑 Benchmark Report
                      </button>
                    )}
                  </div>
                  <div style={{ marginTop: "0.5rem", fontSize: "0.75rem", color: "#64748b" }}>
                    💡 <strong>Tip:</strong> Use "All (ZIP)" to export in all formats at once
                  </div>
                  <div style={{ marginTop: "0.35rem", fontSize: "0.78rem", color: "#0f172a" }}>
                    Note: KML/GPX are auto-converted to WGS84 (lon,lat) for Google Earth/GPX viewers. CSV/XLSX/GeoJSON/WKT stay in the selected target CRS. Heights are passed through unchanged.
                  </div>
                </div>

                {/* Transformation Accuracy/Uncertainty Panel */}
                {(() => {
                  const accuracyInfo = getTransformationAccuracy(fromCrs, toCrs);
                  return (
                    <div style={{ marginTop: "1rem", padding: "0.75rem", borderRadius: "8px", background: "#f0fdf4", border: "1px solid #86efac", color: "#166534" }}>
                      <div style={{ fontWeight: 700, marginBottom: "0.4rem", fontSize: "0.95rem" }}>
                        📏 Transformation Accuracy/Uncertainty
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "auto auto", gap: "1rem", fontSize: "0.9rem" }}>
                        <div>
                          <strong>Estimated Accuracy:</strong> <span style={{ color: "#15803d", fontWeight: 600 }}>±{accuracyInfo.accuracy} cm</span>
                        </div>
                        <div>
                          <strong>Confidence:</strong> <span style={{ color: "#15803d", fontWeight: 600 }}>{accuracyInfo.confidence}</span>
                        </div>
                      </div>
                      <div style={{ fontSize: "0.8rem", color: "#555", marginTop: "0.4rem" }}>
                        <em>
                          {accuracyInfo.accuracy === 0 
                            ? "Using the same CRS - no transformation error."
                            : accuracyInfo.accuracy <= 5
                            ? "Excellent accuracy suitable for most surveying and mapping applications."
                            : accuracyInfo.accuracy <= 15
                            ? "Good accuracy for general applications. Small position differences may occur at boundaries."
                            : "Fair accuracy for general-purpose applications. Verify results in critical areas."}
                        </em>
                      </div>
                    </div>
                  );
                })()}

                {/* Results table */}
                <div style={{ overflowX: "auto", marginTop: "1rem" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#f8fafc" }}>
                    <th style={{ textAlign: "left", padding: "0.4rem", borderBottom: "1px solid #e2e8f0" }}>Select</th>
                    <th style={{ textAlign: "left", padding: "0.4rem", borderBottom: "1px solid #e2e8f0" }}>#</th>
                    <th style={{ textAlign: "left", padding: "0.4rem", borderBottom: "1px solid #e2e8f0" }}>{labels.inputXLabel}</th>
                    <th style={{ textAlign: "left", padding: "0.4rem", borderBottom: "1px solid #e2e8f0" }}>{labels.inputYLabel}</th>
                    {parsedHasZ(bulkResults) && <th style={{ textAlign: "left", padding: "0.4rem", borderBottom: "1px solid #e2e8f0" }}>{inputHeightLabel}</th>}
                    {toIsGeoForTable && outputFormat === "BOTH" ? (
                      <>
                        <th style={{ textAlign: "left", padding: "0.4rem", borderBottom: "1px solid #e2e8f0" }}>{labels.outputXLabel} (DD)</th>
                        <th style={{ textAlign: "left", padding: "0.4rem", borderBottom: "1px solid #e2e8f0" }}>{labels.outputYLabel} (DD)</th>
                        <th style={{ textAlign: "left", padding: "0.4rem", borderBottom: "1px solid #e2e8f0" }}>{labels.outputXLabel} (DMS)</th>
                        <th style={{ textAlign: "left", padding: "0.4rem", borderBottom: "1px solid #e2e8f0" }}>{labels.outputYLabel} (DMS)</th>
                      </>
                    ) : (
                      <>
                        <th style={{ textAlign: "left", padding: "0.4rem", borderBottom: "1px solid #e2e8f0" }}>{labels.outputXLabel}</th>
                        <th style={{ textAlign: "left", padding: "0.4rem", borderBottom: "1px solid #e2e8f0" }}>{labels.outputYLabel}</th>
                      </>
                    )}
                    {parsedHasZ(bulkResults) && <th style={{ textAlign: "left", padding: "0.4rem", borderBottom: "1px solid #e2e8f0" }}>{outputHeightLabel}</th>}
                    {parsedHasN(bulkResults) && <th style={{ textAlign: "left", padding: "0.4rem", borderBottom: "1px solid #e2e8f0" }}>N (geoid ondulation)</th>}
                    {isUtmCode(toCrs) && <th style={{ textAlign: "left", padding: "0.4rem", borderBottom: "1px solid #e2e8f0" }}>Zone</th>}
                    {isCcCode(toCrs) && <th style={{ textAlign: "left", padding: "0.4rem", borderBottom: "1px solid #e2e8f0" }}>Zone</th>}
                    {(isGkCode(toCrs) || isSpainCode(toCrs) || isMgaCode(toCrs) || isJgdCode(toCrs) || isBngCode(toCrs) || isIgCode(toCrs) || isSaGaussCode(toCrs) || isEgyptCode(toCrs) || isMoroccoCode(toCrs) || isAlgeriaCode(toCrs) || isTunisiaCode(toCrs)) && <th style={{ textAlign: "left", padding: "0.4rem", borderBottom: "1px solid #e2e8f0" }}>Zone</th>}
                    {bulkResults.some((r) => r.outlierWarning) && <th style={{ textAlign: "left", padding: "0.4rem", borderBottom: "1px solid #e2e8f0" }}>Validation</th>}
                    <th style={{ textAlign: "left", padding: "0.4rem", borderBottom: "1px solid #e2e8f0" }}>Status</th>
                    <th style={{ textAlign: "left", padding: "0.4rem", borderBottom: "1px solid #e2e8f0" }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredBulkResults.map((row) => {
                    const outPrec = toCrs === "EPSG:4326" ? 8 : 4;
                    const ddX = Number.isFinite(row.outputXRaw)
                      ? fmtNum(row.outputXRaw, outPrec)
                      : (Number.isFinite(parseFloat(row.outputX)) ? fmtNum(parseFloat(row.outputX), outPrec) : row.outputX);
                    const ddY = Number.isFinite(row.outputYRaw)
                      ? fmtNum(row.outputYRaw, outPrec)
                      : (Number.isFinite(parseFloat(row.outputY)) ? fmtNum(parseFloat(row.outputY), outPrec) : row.outputY);
                    const dmsX = Number.isFinite(row.outputXRaw)
                      ? ddToDMS(row.outputXRaw, "lon")
                      : (row.outputXDms || ddToDMS(parseDMSToDD(row.outputX), "lon") || row.outputX);
                    const dmsY = Number.isFinite(row.outputYRaw)
                      ? ddToDMS(row.outputYRaw, "lat")
                      : (row.outputYDms || ddToDMS(parseDMSToDD(row.outputY), "lat") || row.outputY);
                    const hasError = String(row.outputX) === "ERROR";
                    const hasOutlier = Boolean(row.outlierWarning);
                    const hasWarning = Boolean(row.utmWarning || row.ccWarning || row.otherZoneWarning);
                    const status = hasError
                      ? { text: row.errorCategory ? `Error: ${row.errorCategory}` : "Error", bg: "#fee2e2", color: "#991b1b", border: "#fecaca" }
                      : hasOutlier
                      ? { text: "Outlier", bg: "#fee2e2", color: "#991b1b", border: "#fecaca" }
                      : hasWarning
                      ? { text: "Warning", bg: "#fef3c7", color: "#92400e", border: "#fde68a" }
                      : { text: "OK", bg: "#ecfdf5", color: "#166534", border: "#bbf7d0" };

                    return (
                      <tr key={row.id} style={{ background: row.outlierWarning ? "#fee2e2" : (row.utmWarning || row.ccWarning || row.otherZoneWarning ? "#fef3c7" : "transparent") }}>
                        <td style={{ padding: "0.35rem", borderBottom: "1px solid #e2e8f0" }}>
                          <input
                            type="checkbox"
                            checked={selectedBulkRows.includes(String(row.id))}
                            onChange={(e) => {
                              const key = String(row.id);
                              setSelectedBulkRows((prev) => e.target.checked ? Array.from(new Set([...prev, key])) : prev.filter((x) => x !== key));
                            }}
                          />
                        </td>
                        <td style={{ padding: "0.35rem", borderBottom: "1px solid #e2e8f0" }}>{row.id}</td>
                        <td style={{ padding: "0.35rem", borderBottom: "1px solid #e2e8f0" }}>
                          <input value={row.inputX ?? ""} onChange={(e) => updateBulkRowInput(row.id, "inputX", e.target.value)} style={{ width: "120px", padding: "0.25rem", border: "1px solid #cbd5e1", borderRadius: "4px" }} />
                        </td>
                        <td style={{ padding: "0.35rem", borderBottom: "1px solid #e2e8f0" }}>
                          <input value={row.inputY ?? ""} onChange={(e) => updateBulkRowInput(row.id, "inputY", e.target.value)} style={{ width: "120px", padding: "0.25rem", border: "1px solid #cbd5e1", borderRadius: "4px" }} />
                        </td>
                        {parsedHasZ(bulkResults) && <td style={{ padding: "0.35rem", borderBottom: "1px solid #e2e8f0" }}><input value={row.inputZ ?? ""} onChange={(e) => updateBulkRowInput(row.id, "inputZ", e.target.value)} style={{ width: "90px", padding: "0.25rem", border: "1px solid #cbd5e1", borderRadius: "4px" }} /></td>}
                        {toIsGeoForTable && outputFormat === "BOTH" ? (
                          <>
                            <td style={{ padding: "0.35rem", borderBottom: "1px solid #e2e8f0" }}>{ddX}</td>
                            <td style={{ padding: "0.35rem", borderBottom: "1px solid #e2e8f0" }}>{ddY}</td>
                            <td style={{ padding: "0.35rem", borderBottom: "1px solid #e2e8f0" }}>{dmsX}</td>
                            <td style={{ padding: "0.35rem", borderBottom: "1px solid #e2e8f0" }}>{dmsY}</td>
                          </>
                        ) : (
                          <>
                            <td style={{ padding: "0.35rem", borderBottom: "1px solid #e2e8f0" }}>{outputFormat === "DMS" && toIsGeoForTable ? dmsX : ddX}</td>
                            <td style={{ padding: "0.35rem", borderBottom: "1px solid #e2e8f0" }}>{outputFormat === "DMS" && toIsGeoForTable ? dmsY : ddY}</td>
                          </>
                        )}
                        {parsedHasZ(bulkResults) && <td style={{ padding: "0.35rem", borderBottom: "1px solid #e2e8f0" }}>{row.outputZ ?? ""}</td>}
                        {parsedHasN(bulkResults) && <td style={{ padding: "0.35rem", borderBottom: "1px solid #e2e8f0" }}>{row.N ?? ""}</td>}
                        {isUtmCode(toCrs) && <td style={{ padding: "0.35rem", borderBottom: "1px solid #e2e8f0", color: row.utmWarning ? "#b45309" : "#16a34a", fontWeight: row.utmWarning ? 600 : 400 }}>{row.utmWarning || "✓"}</td>}
                        {isCcCode(toCrs) && <td style={{ padding: "0.35rem", borderBottom: "1px solid #e2e8f0", color: row.ccWarning ? "#b45309" : "#16a34a", fontWeight: row.ccWarning ? 600 : 400 }}>{row.ccWarning || "✓"}</td>}
                        {(isGkCode(toCrs) || isSpainCode(toCrs) || isMgaCode(toCrs) || isJgdCode(toCrs) || isBngCode(toCrs) || isIgCode(toCrs) || isSaGaussCode(toCrs) || isEgyptCode(toCrs) || isMoroccoCode(toCrs) || isAlgeriaCode(toCrs) || isTunisiaCode(toCrs)) && <td style={{ padding: "0.35rem", borderBottom: "1px solid #e2e8f0", color: row.otherZoneWarning ? "#b45309" : "#16a34a", fontWeight: row.otherZoneWarning ? 600 : 400 }}>{row.otherZoneWarning || "✓"}</td>}
                        {bulkResults.some((r) => r.outlierWarning) && <td style={{ padding: "0.35rem", borderBottom: "1px solid #e2e8f0", color: row.outlierWarning ? "#b91c1c" : "#16a34a", fontWeight: row.outlierWarning ? 600 : 400 }}>{row.outlierWarning || "OK"}</td>}
                        <td style={{ padding: "0.35rem", borderBottom: "1px solid #e2e8f0" }}>
                          <span style={{ display: "inline-block", padding: "0.12rem 0.45rem", borderRadius: "999px", background: status.bg, color: status.color, border: `1px solid ${status.border}`, fontSize: "0.75rem", fontWeight: 700 }}>{status.text}</span>
                        </td>
                        <td style={{ padding: "0.35rem", borderBottom: "1px solid #e2e8f0" }}>
                          <button onClick={() => rerunBulkRow(row.id)} style={{ padding: "0.2rem 0.45rem", borderRadius: "4px", border: "1px solid #cbd5e1", background: "#fff", cursor: "pointer", fontWeight: 600, fontSize: "0.78rem" }}>Re-run</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      <div style={{ marginTop: "1rem" }}>
        <GeoidLoader onLoadComplete={handleGeoidLoadComplete} />
        <div style={{ fontSize: "0.85rem", color: "#475569" }}>
          Loaded grids: {loadedGeoidGrids.length === 0 ? "none" : loadedGeoidGrids.join(", ")}
        </div>
      </div>

      {/* ---- Embedded Map Disabled (use sidebar map) ---- */}
      {renderEmbeddedMap && (points3DData.length > 0 || show3DViewer) && (
        <div style={{ marginTop: "1.5rem", paddingTop: "1.5rem", borderTop: "2px solid #e2e8f0" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem" }}>
            <h2 style={{ fontSize: "1.2rem", fontWeight: 700, color: "#1e293b", margin: 0 }}>
              🌍 Map
            </h2>
            <button
              onClick={() => setShow3DViewer(!show3DViewer)}
              style={{
                padding: "0.6rem 1.2rem",
                background: show3DViewer ? "#ef4444" : "#3b82f6",
                color: "#fff",
                border: "none",
                borderRadius: "6px",
                cursor: "pointer",
                fontWeight: 600,
                fontSize: "0.95rem",
                transition: "all 0.3s ease",
              }}
            >
              {show3DViewer ? "Hide Map" : "Show Map"}
            </button>
          </div>

          {/* Information about the map visualization */}
          {show3DViewer && (
            <div style={{ fontSize: "0.85rem", color: "#475569", marginBottom: "1rem", padding: "0.75rem", background: "#f0f9ff", borderRadius: "6px", borderLeft: "4px solid #3b82f6" }}>
              <strong>Map Features:</strong>
              <ul style={{ margin: "0.5rem 0 0 1.25rem", paddingLeft: 0 }}>
                <li>🟢 <strong>Green markers:</strong> Geoid near ellipsoid (-2 to +2m)</li>
                <li>🔴 <strong>Red markers:</strong> Geoid above ellipsoid (&gt; +10m)</li>
                <li>🔵 <strong>Blue markers:</strong> Geoid below ellipsoid (&lt; -10m)</li>
                <li>📍 <strong>Click markers:</strong> See full point details with geoid undulation</li>
                <li>🗺️ <strong>Interactive map:</strong> Zoom, pan, and explore coordinates geographically</li>
              </ul>
            </div>
          )}

          {/* Render the map visualization component only when visible */}
          {show3DViewer && (
            <div data-map-section>
              <MapVisualization
                points={points3DData}
                isVisible={true}
                onPointSelect={handle3DPointSelect}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// Small helpers to check if bulk results contain Z or N columns
const parsedHasZ = (rows) => rows.some((r) => r.inputZ !== undefined || r.outputZ !== undefined);
const parsedHasN = (rows) => rows.some((r) => r.N !== undefined);

export default CoordinateConverter;
