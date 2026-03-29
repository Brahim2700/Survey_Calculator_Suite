// src/utils/fileImport.js
// Lightweight file import helpers for GeoJSON, GPX, KML, Shapefile ZIP, and XLSX
// All parsers return an array of rows: { id, x, y, z, detectedFromCrs, crsSuggestions }
// - x,y in numeric lon/lat for geographic sources unless otherwise noted
// - z may be null
// - detectedFromCrs may be an EPSG string if the file carries CRS info
// - crsSuggestions is an array of detected CRS options with confidence scores

import DxfParser from 'dxf-parser';
import { detectCRS } from './crsDetection';

export async function parseGeoJSONFile(file) {
  const text = await file.text();
  const json = JSON.parse(text);
  const rows = [];
  let detectedFromCrs = null;
  let metadata = {};
  let isProjectedCRS = false;

  // Extract CRS metadata
  if (json.crs && json.crs.properties && json.crs.properties.name) {
    const name = json.crs.properties.name.toUpperCase();
    const m = name.match(/EPSG:(\d{4,5})/);
    if (m) {
      detectedFromCrs = `EPSG:${m[1]}`;
      metadata.crs = json.crs;
      
      // Check if this CRS is projected (not geographic)
      // Simple heuristic: if it's EPSG code, check if it's not a known geographic one
      const epsgCode = parseInt(m[1], 10);
      // Geographic codes are typically 4xxx (e.g., 4326, 4269, 4258)
      // Projected codes are typically 2xxx or 3xxx (e.g., 2154, 32633, etc.)
      isProjectedCRS = epsgCode < 4000 || epsgCode >= 5000;
    }
  }

  const feats = json.type === 'FeatureCollection' ? json.features : (json.type === 'Feature' ? [json] : []);
  let idx = 1;
  const coordinates = [];
  
  for (const f of feats) {
    if (!f || !f.geometry || f.geometry.type !== 'Point') continue;
    const coords = f.geometry.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    
    let x, y, z;
    
    if (isProjectedCRS) {
      // For projected CRS, coordinates are [easting, northing, height]
      x = Number(coords[0]);
      y = Number(coords[1]);
      z = coords.length > 2 ? Number(coords[2]) : (f.properties?.ele ?? null);
    } else {
      // For geographic CRS (or unspecified), GeoJSON standard is [lon, lat, height]
      x = Number(coords[0]);  // longitude
      y = Number(coords[1]);  // latitude
      z = coords.length > 2 ? Number(coords[2]) : (f.properties?.ele ?? null);
    }
    
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    coordinates.push({ x, y, z: Number.isFinite(z) ? z : null });
    rows.push({ id: f.properties?.name || idx++, x, y, z: Number.isFinite(z) ? z : null });
  }
  
  // Smart CRS detection
  console.log('[GeoJSON] Coordinates sample:', coordinates.slice(0, 2));
  console.log('[GeoJSON] Metadata:', metadata);
  console.log('[GeoJSON] Is Projected CRS:', isProjectedCRS);
  const crsSuggestions = detectCRS(coordinates, metadata);
  console.log('[GeoJSON] CRS Suggestions:', crsSuggestions);
  if (!detectedFromCrs && crsSuggestions.length > 0) {
    detectedFromCrs = crsSuggestions[0].code;
  }
  if (!detectedFromCrs) detectedFromCrs = 'EPSG:4326';
  
  // Add metadata to all rows
  rows.forEach(row => {
    row.detectedFromCrs = detectedFromCrs;
    row.crsSuggestions = crsSuggestions;
  });
  
  console.log('[GeoJSON] Final detected CRS:', detectedFromCrs, 'with', crsSuggestions.length, 'suggestions');
  
  return rows;
}

export async function parseGPXFile(file) {
  const text = await file.text();
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const wpts = Array.from(doc.getElementsByTagName('wpt'));
  const rows = [];
  const coordinates = [];
  let idx = 1;
  
  for (const w of wpts) {
    const lat = Number(w.getAttribute('lat'));
    const lon = Number(w.getAttribute('lon'));
    const eleNode = w.getElementsByTagName('ele')[0];
    const nameNode = w.getElementsByTagName('name')[0];
    const z = eleNode ? Number(eleNode.textContent) : null;
    const id = nameNode?.textContent || idx++;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    coordinates.push({ x: lon, y: lat, z: Number.isFinite(z) ? z : null });
    rows.push({ id, x: lon, y: lat, z: Number.isFinite(z) ? z : null });
  }
  
  // Smart CRS detection (GPX is always WGS84 but detect anyway for consistency)
  const crsSuggestions = detectCRS(coordinates, {});
  const detectedFromCrs = 'EPSG:4326'; // GPX standard
  
  rows.forEach(row => {
    row.detectedFromCrs = detectedFromCrs;
    row.crsSuggestions = crsSuggestions;
  });
  
  return rows;
}

export async function parseKMLFile(file) {
  const text = await file.text();
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const placemarks = Array.from(doc.getElementsByTagName('Placemark'));
  const rows = [];
  const coordinates = [];
  let idx = 1;
  
  for (const p of placemarks) {
    const name = p.getElementsByTagName('name')[0]?.textContent;
    const coordsNode = p.getElementsByTagName('coordinates')[0];
    if (!coordsNode) continue;
    const raw = coordsNode.textContent.trim();
    // KML coordinates are lon,lat[,alt] possibly multiple; take first
    const parts = raw.split(/\s+/)[0].split(',');
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    const z = parts[2] !== undefined ? Number(parts[2]) : null;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    coordinates.push({ x: lon, y: lat, z: Number.isFinite(z) ? z : null });
    rows.push({ id: name || idx++, x: lon, y: lat, z: Number.isFinite(z) ? z : null });
  }
  
  // Smart CRS detection (KML is always WGS84 but detect anyway for consistency)
  const crsSuggestions = detectCRS(coordinates, {});
  const detectedFromCrs = 'EPSG:4326'; // KML standard
  
  rows.forEach(row => {
    row.detectedFromCrs = detectedFromCrs;
    row.crsSuggestions = crsSuggestions;
  });
  
  return rows;
}

export async function parseXLSXFile(file) {
  const { read, utils } = await import('xlsx');
  const ab = await file.arrayBuffer();
  const wb = read(ab, { type: 'array' });
  const shName = wb.SheetNames[0];
  const sheet = wb.Sheets[shName];
  const rowsRaw = utils.sheet_to_json(sheet, { defval: null });
  const rows = [];
  const coordinates = [];
  let detectedFromCrs = null;
  let metadata = {};

  // Scan header-like keys for EPSG/SRID
  const keys = rowsRaw.length ? Object.keys(rowsRaw[0]).map((k) => String(k)) : [];
  for (const k of keys) {
    const m1 = k.toUpperCase().match(/EPSG:(\d{4,5})/);
    const m2 = k.toUpperCase().match(/SRID\s*=\s*(\d{4,5})/);
    if (m1) { detectedFromCrs = `EPSG:${m1[1]}`; metadata.crs = { code: detectedFromCrs }; break; }
    if (m2) { detectedFromCrs = `EPSG:${m2[1]}`; metadata.crs = { code: detectedFromCrs }; break; }
  }

  let idx = 1;
  for (const r of rowsRaw) {
    const get = (k) => r[k] ?? r[String(k)] ?? null;
    // Try common column names
    const lon = parseFloat(get('lon') ?? get('longitude') ?? get('x') ?? get('easting'));
    const lat = parseFloat(get('lat') ?? get('latitude') ?? get('y') ?? get('northing'));
    let z = parseFloat(get('h') ?? get('height') ?? get('elevation') ?? get('z'));
    const id = r['id'] ?? r['name'] ?? r['point'] ?? idx++;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (!Number.isFinite(z)) z = null;
    coordinates.push({ x: lon, y: lat, z });
    rows.push({ id, x: lon, y: lat, z });
  }
  
  // Smart CRS detection
  const crsSuggestions = detectCRS(coordinates, metadata);
  if (!detectedFromCrs && crsSuggestions.length > 0) {
    detectedFromCrs = crsSuggestions[0].code;
  }
  if (!detectedFromCrs) detectedFromCrs = 'EPSG:4326';
  
  rows.forEach(row => {
    row.detectedFromCrs = detectedFromCrs;
    row.crsSuggestions = crsSuggestions;
  });
  
  return rows;
}

export async function parseShapefileZip(file) {
  const shp = await import('shpjs');
  const ab = await file.arrayBuffer();
  const geojson = await shp.default(ab);
  // shpjs returns GeoJSON; reuse the GeoJSON parser
  const pseudoFile = new File([JSON.stringify(geojson)], file.name + '.json', { type: 'application/json' });
  return parseGeoJSONFile(pseudoFile);
}

// --------- CAD helpers (DXF/DWG) ---------
const detectCrsFromDxf = (dxfData) => {
  // Try to detect CRS from DXF header variables
  const header = dxfData?.header || {};
  
  // Check for custom CRS variables (some exporters add these)
  if (header.$EPSG || header.$EPSGCODE) {
    const code = header.$EPSG || header.$EPSGCODE;
    if (typeof code === 'number' || typeof code === 'string') {
      return `EPSG:${code}`;
    }
  }
  
  // Check layer names for CRS hints (e.g., layer named "UTM_32N" or "EPSG_2154")
  const layers = dxfData?.tables?.layer?.layers || {};
  for (const layerName of Object.keys(layers)) {
    const epsgMatch = layerName.match(/EPSG[_:]?(\d{4,5})/i);
    if (epsgMatch) return `EPSG:${epsgMatch[1]}`;
    
    const utmMatch = layerName.match(/UTM[_:]?(\d{1,2})([NS])/i);
    if (utmMatch) {
      const zone = utmMatch[1].padStart(2, '0');
      const hemi = utmMatch[2].toUpperCase();
      return hemi === 'N' ? `EPSG:326${zone}` : `EPSG:327${zone}`;
    }
  }
  
  // Check blocks for CRS info
  const blocks = dxfData?.blocks || {};
  for (const blockName of Object.keys(blocks)) {
    const epsgMatch = blockName.match(/EPSG[_:]?(\d{4,5})/i);
    if (epsgMatch) return `EPSG:${epsgMatch[1]}`;
  }
  
  // Default to WGS84 if no CRS detected
  return 'EPSG:4326';
};

const collectPointRowsFromDxf = (dxfData, options = {}) => {
  const rows = [];
  let idx = 1;
  const pointsOnly = options.pointsOnly || false;
  let detectedFromCrs = detectCrsFromDxf(dxfData);
  const seenCoords = new Map(); // Track coordinates to prefer non-zero Z values

  const addRow = (x, y, z, idHint) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const coordKey = `${x.toFixed(3)},${y.toFixed(3)}`;
    
    // If we've seen this coordinate before, prefer the one with non-zero Z
    if (seenCoords.has(coordKey)) {
      const existing = seenCoords.get(coordKey);
      if (existing.z === 0 && Number.isFinite(z) && z !== 0) {
        // Replace with non-zero Z
        existing.z = z;
      }
      return; // Don't add duplicate coordinates
    }
    
    const id = idHint || idx;
    const row = { id, x, y, z: Number.isFinite(z) ? z : null, detectedFromCrs };
    rows.push(row);
    seenCoords.set(coordKey, row);
    idx += 1;
  };

  const visitEntities = (entities) => {
    if (!entities || !Array.isArray(entities)) return;
    entities.forEach((ent) => {
      const layer = ent?.layer || ent?.type;
      switch (ent?.type) {
        case 'POINT': {
          // Extract Z coordinate
          const z = ent.position?.z ?? ent.z ?? ent.position?.[2] ?? ent.vertices?.[0]?.z;
          addRow(ent.position?.x, ent.position?.y, z, layer);
          break;
        }
        case 'LINE': {
          if (!pointsOnly) {
            const startZ = ent.start?.z ?? ent.startZ ?? ent.start?.[2];
            const endZ = ent.end?.z ?? ent.endZ ?? ent.end?.[2];
            addRow(ent.start?.x, ent.start?.y, startZ, `${layer || 'LINE'}-start`);
            addRow(ent.end?.x, ent.end?.y, endZ, `${layer || 'LINE'}-end`);
          }
          break;
        }
        case 'LWPOLYLINE':
        case 'POLYLINE': {
          if (!pointsOnly) {
            (ent.vertices || []).forEach((v, i) => {
              const vz = v?.z ?? v?.[2];
              addRow(v?.x, v?.y, vz, `${layer || ent.type}-${i + 1}`);
            });
          }
          break;
        }
        case 'VERTEX': {
          if (!pointsOnly) {
            const vz = ent.position?.z ?? ent.z ?? ent.position?.[2];
            addRow(ent.position?.x, ent.position?.y, vz, layer);
          }
          break;
        }
        case 'CIRCLE':
        case 'ARC': {
          if (!pointsOnly) {
            const cz = ent.center?.z ?? ent.centerZ ?? ent.center?.[2];
            addRow(ent.center?.x, ent.center?.y, cz, layer);
          }
          break;
        }
        case 'INSERT': {
          if (!pointsOnly) {
            const iz = ent.position?.z ?? ent.z ?? ent.position?.[2];
            addRow(ent.position?.x, ent.position?.y, iz, ent.name || layer || 'INSERT');
          }
          break;
        }
        default:
          break;
      }
    });
  };

  visitEntities(dxfData?.entities);
  const blocks = dxfData?.blocks || {};
  Object.values(blocks).forEach((b) => visitEntities(b?.entities));
  
  // Smart CRS detection
  const coordinates = rows.map(r => ({ x: r.x, y: r.y, z: r.z }));
  const metadata = { projection: detectedFromCrs !== 'EPSG:4326' ? detectedFromCrs : null };
  const crsSuggestions = detectCRS(coordinates, metadata);
  
  // Use smart detection if basic detection didn't find CRS
  if (detectedFromCrs === 'EPSG:4326' && crsSuggestions.length > 0 && crsSuggestions[0].confidence > 0.7) {
    detectedFromCrs = crsSuggestions[0].code;
  }
  
  // Add metadata to rows
  rows.forEach(row => {
    row.detectedFromCrs = detectedFromCrs;
    row.crsSuggestions = crsSuggestions;
  });
  
  return rows;
};

export async function parseDXFFile(file, options = {}) {
  const text = await file.text();
  const parser = new DxfParser();
  let dxf;
  try {
    dxf = parser.parseSync(text);
  } catch (err) {
    throw new Error(`Failed to parse DXF: ${err.message || err}`);
  }
  const rows = collectPointRowsFromDxf(dxf, options);
  if (!rows.length) {
    const hint = options.pointsOnly ? 'No POINT entities found in DXF. Try unchecking "Points only" to extract vertices from lines/polylines.' : 'No point-like entities found in DXF';
    throw new Error(hint);
  }
  return rows;
}

export async function parseDWGFile(file, options = {}) {
  const buffer = await file.arrayBuffer();

  // Try to parse DWG content as DXF text if it is a text-based export
  try {
    const text = new TextDecoder().decode(buffer);
    const parser = new DxfParser();
    const dxf = parser.parseSync(text);
    const rows = collectPointRowsFromDxf(dxf, options);
    if (rows.length) return rows;
  } catch {
    // Continue to friendly error below
  }

  throw new Error('DWG parsing failed. Please export/save the drawing as DXF (ASCII) and try again.');
}

// --------- Text helpers (CSV/WKT/UTM) ---------
export function tryParseWKT(line) {
  const ewktMatch = line.match(/SRID\s*=\s*(\d{4,5})\s*;\s*POINT\s*\(([^)]+)\)/i);
  const wktMatch = line.match(/POINT\s*\(([^)]+)\)/i);
  if (ewktMatch) {
    const srid = ewktMatch[1];
    const coords = ewktMatch[2].split(/[\s,]+/).filter(Boolean);
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    const z = coords[2] !== undefined ? Number(coords[2]) : null;
    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      return { x: lon, y: lat, z: Number.isFinite(z) ? z : null, detectedFromCrs: `EPSG:${srid}` };
    }
  }
  if (wktMatch) {
    const coords = wktMatch[1].split(/[\s,]+/).filter(Boolean);
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    const z = coords[2] !== undefined ? Number(coords[2]) : null;
    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      return { x: lon, y: lat, z: Number.isFinite(z) ? z : null, detectedFromCrs: 'EPSG:4326' };
    }
  }
  return null;
}

export function tryParseUTM(tokens) {
  // Accept: "55S 334368.6336 6250948.3454 [H]" or "32756 X Y [H]"
  const tokenStr = tokens[0]?.toUpperCase();
  let zone = null;
  let hemi = null;
  let idx = 0;

  const zh = tokenStr.match(/^(\d{1,2})([NS])$/);
  if (zh) {
    zone = parseInt(zh[1], 10);
    hemi = zh[2];
    idx = 1;
  } else {
    const em = tokenStr.match(/^EPSG:(326|327)(\d{2})$/);
    const nm = tokenStr.match(/^(326|327)(\d{2})$/);
    if (em || nm) {
      zone = parseInt((em || nm)[2], 10);
      hemi = ((em || nm)[1] === '326') ? 'N' : 'S';
      idx = 1;
    }
  }
  if (zone && (tokens.length - idx) >= 2) {
    const x = parseFloat(tokens[idx]);
    const y = parseFloat(tokens[idx + 1]);
    const z = tokens[idx + 2] !== undefined ? parseFloat(tokens[idx + 2]) : null;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const fromCrs = `${hemi === 'N' ? 'EPSG:326' : 'EPSG:327'}${String(zone).padStart(2, '0')}`;
      return { x, y, z: Number.isFinite(z) ? z : null, detectedFromCrs: fromCrs };
    }
  }
  return null;
}

export function parseHemisphericNumber(tok) {
  // Accept 48.8566N or 2.3522E
  const m = String(tok).toUpperCase().match(/^\s*([+-]?\d+(?:\.\d+)?)\s*([NSEW])\s*$/);
  if (!m) return null;
  const val = parseFloat(m[1]);
  const dir = m[2];
  const signed = (dir === 'S' || dir === 'W') ? -Math.abs(val) : Math.abs(val);
  return signed;
}
