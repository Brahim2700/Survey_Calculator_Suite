import DxfParser from 'dxf-parser';
import { detectCRS } from './crsDetection.js';

const CAD_TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

export function decodeCadHeader(data, byteLength = 64) {
  const view = data instanceof Uint8Array ? data.subarray(0, byteLength) : new Uint8Array(data).subarray(0, byteLength);
  return CAD_TEXT_DECODER.decode(view).replace(/\0/g, '');
}

export function isLikelyNativeDwgData(data) {
  const signature = decodeCadHeader(data, 6).slice(0, 6);
  return /^AC10\d{2}$/i.test(signature);
}

export function isLikelyDxfText(text) {
  const normalized = String(text || '').trimStart();
  return normalized.startsWith('0\nSECTION')
    || normalized.startsWith('0\r\nSECTION')
    || normalized.includes('\nSECTION\n')
    || normalized.includes('\r\nSECTION\r\n');
}

export function isLikelyDxfData(data, byteLength = 512) {
  return isLikelyDxfText(decodeCadHeader(data, byteLength));
}

const detectCrsFromDxf = (dxfData) => {
  const header = dxfData?.header || {};

  if (header.$EPSG || header.$EPSGCODE) {
    const code = header.$EPSG || header.$EPSGCODE;
    if (typeof code === 'number' || typeof code === 'string') {
      return `EPSG:${code}`;
    }
  }

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

  const blocks = dxfData?.blocks || {};
  for (const blockName of Object.keys(blocks)) {
    const epsgMatch = blockName.match(/EPSG[_:]?(\d{4,5})/i);
    if (epsgMatch) return `EPSG:${epsgMatch[1]}`;
  }

  return 'EPSG:4326';
};

export const collectPointRowsFromDxf = (dxfData, options = {}) => {
  const rows = [];
  let idx = 1;
  const pointsOnly = options.pointsOnly || false;
  let detectedFromCrs = detectCrsFromDxf(dxfData);
  const seenCoords = new Map();

  const addRow = (x, y, z, idHint) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const coordKey = `${x.toFixed(3)},${y.toFixed(3)}`;

    if (seenCoords.has(coordKey)) {
      const existing = seenCoords.get(coordKey);
      if (existing.z === 0 && Number.isFinite(z) && z !== 0) {
        existing.z = z;
      }
      return;
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
  Object.values(dxfData?.blocks || {}).forEach((block) => visitEntities(block?.entities));

  const coordinates = rows.map((row) => ({ x: row.x, y: row.y, z: row.z }));
  const metadata = { projection: detectedFromCrs !== 'EPSG:4326' ? detectedFromCrs : null };
  const crsSuggestions = detectCRS(coordinates, metadata);

  if (detectedFromCrs === 'EPSG:4326' && crsSuggestions.length > 0 && crsSuggestions[0].confidence > 0.7) {
    detectedFromCrs = crsSuggestions[0].code;
  }

  rows.forEach((row) => {
    row.detectedFromCrs = detectedFromCrs;
    row.crsSuggestions = crsSuggestions;
  });

  return rows;
};

export function parseDxfTextContent(text, options = {}) {
  const parser = new DxfParser();
  let dxf;
  try {
    dxf = parser.parseSync(text);
  } catch (err) {
    throw new Error(`Failed to parse DXF: ${err.message || err}`);
  }

  const rows = collectPointRowsFromDxf(dxf, options);
  if (!rows.length) {
    const hint = options.pointsOnly
      ? 'No POINT entities found in DXF. Try unchecking "Points only" to extract vertices from lines/polylines.'
      : 'No point-like entities found in DXF';
    throw new Error(hint);
  }

  return rows;
}