import DxfParser from 'dxf-parser';
import { detectCRS, assessReferenceSystem } from './crsDetection.js';

const CAD_TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });
const DEFAULT_TEXT_HEIGHT = 2.5;
const FALLBACK_TEXT_FONT = 'Segoe UI';
const CAD_SURFACE_TRIANGLE_WARN_THRESHOLD = 20000;
const CAD_UNIT_LABELS = {
  0: 'Unitless',
  1: 'Inches',
  2: 'Feet',
  3: 'Miles',
  4: 'Millimeters',
  5: 'Centimeters',
  6: 'Meters',
  7: 'Kilometers',
  8: 'Microinches',
  9: 'Mils',
  10: 'Yards',
  11: 'Angstroms',
  12: 'Nanometers',
  13: 'Microns',
  14: 'Decimeters',
  15: 'Decameters',
  16: 'Hectometers',
  17: 'Gigameters',
  18: 'Astronomical units',
  19: 'Light years',
  20: 'Parsecs',
};
const LAYER_STANDARDIZATION_RULES = [
  { category: 'ANNOTATION', standardName: 'ANNOTATION', pattern: /(ANNOT|TEXT|MTEXT|LABEL|NOTE|LEGEND|TITLE|TAG)/i },
  { category: 'CONTROL', standardName: 'CONTROL_POINTS', pattern: /(POINT|PTS|TOPO|SURVEY|STATION|BENCH|BORNE|NODE)/i },
  { category: 'BOUNDARY', standardName: 'BOUNDARY', pattern: /(BOUND|LIMIT|PARCEL|LOT|CADAST|ZONE)/i },
  { category: 'BUILDING', standardName: 'BUILDING', pattern: /(BATI|BUILD|HOUSE|WALL|STRUCT)/i },
  { category: 'TRANSPORT', standardName: 'TRANSPORT', pattern: /(ROAD|ROUTE|RUE|STREET|PATH|TROTTOIR|SIDEWALK|PARKING)/i },
  { category: 'UTILITY', standardName: 'UTILITY_NETWORK', pattern: /(RESEAU|NETWORK|SEWER|WATER|ELEC|POWER|GAS|FIBER|UTIL)/i },
  { category: 'TOPOGRAPHY', standardName: 'TOPOGRAPHY', pattern: /(TOPO|TERRAIN|CONTOUR|ALT|SPOT|LEVEL)/i },
  { category: 'REFERENCE', standardName: 'REFERENCE', pattern: /(XREF|EXTERNAL|REF|BACKGROUND|RASTER)/i },
];

const basenameFromPath = (value) => String(value || '').split(/[\\/]/).pop() || '';

const normalizeLayerToken = (value) => {
  const text = String(value || '0').trim();
  if (!text) return 'LAYER_0';
  const normalized = text
    .replace(/[|\\/]+/g, '_')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return normalized || 'LAYER_0';
};

const humanizeLayerName = (value) => String(value || '')
  .replace(/_/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const getLayerDescriptor = (layerName, layerRecord = null) => {
  const originalName = String(layerName || layerRecord?.name || '0').trim() || '0';
  const normalizedName = normalizeLayerToken(originalName);
  const rule = LAYER_STANDARDIZATION_RULES.find((candidate) => candidate.pattern.test(originalName) || candidate.pattern.test(normalizedName));
  const standardizedName = rule?.standardName || normalizedName;
  const category = rule?.category || 'OTHER';
  return {
    originalName,
    normalizedName,
    standardizedName,
    displayName: humanizeLayerName(standardizedName),
    category,
    renamed: standardizedName !== originalName && normalizedName !== originalName,
    visible: layerRecord?.visible !== false,
    frozen: Boolean(layerRecord?.frozen),
    colorIndex: Number.isFinite(Number(layerRecord?.colorIndex)) ? Number(layerRecord.colorIndex) : null,
    color: Number.isFinite(Number(layerRecord?.color)) ? Number(layerRecord.color) : null,
  };
};

// Standard AutoCAD Color Index (ACI) → CSS hex. Indices 0 and 256 mean BYBLOCK/BYLAYER
// (inherit); they return the fallback so the layer color is used instead. Index 7 is
// "white" in AutoCAD's dark-background world; we map it to near-black so it's readable
// on a white Leaflet map. Indices 250–255 are the standard grayscale ramp.
const ACI_HEX = [
  /* 0  byblock  */ null,
  /* 1  */ '#FF0000', /* 2  */ '#FFFF00', /* 3  */ '#00FF00', /* 4  */ '#00FFFF',
  /* 5  */ '#0000FF', /* 6  */ '#FF00FF', /* 7  */ '#1e293b', /* 8  */ '#808080',
  /* 9  */ '#C0C0C0',
  /* 10 */ '#FF0000', /* 11 */ '#FFAAAA', /* 12 */ '#BD0000', /* 13 */ '#BD7E7E',
  /* 14 */ '#810000', /* 15 */ '#815656', /* 16 */ '#680000', /* 17 */ '#684545',
  /* 18 */ '#4F0000', /* 19 */ '#4F3535',
  /* 20 */ '#FF3F00', /* 21 */ '#FFBFAA', /* 22 */ '#BD2E00', /* 23 */ '#BD8D7E',
  /* 24 */ '#811F00', /* 25 */ '#816056', /* 26 */ '#681900', /* 27 */ '#684D45',
  /* 28 */ '#4F1300', /* 29 */ '#4F3B35',
  /* 30 */ '#FF7F00', /* 31 */ '#FFD4AA', /* 32 */ '#BD5E00', /* 33 */ '#BD9D7E',
  /* 34 */ '#813F00', /* 35 */ '#816B56', /* 36 */ '#683300', /* 37 */ '#685645',
  /* 38 */ '#4F2700', /* 39 */ '#4F4235',
  /* 40 */ '#FFBF00', /* 41 */ '#FFEAAA', /* 42 */ '#BD8D00', /* 43 */ '#BDAD7E',
  /* 44 */ '#815F00', /* 45 */ '#817656', /* 46 */ '#684D00', /* 47 */ '#686045',
  /* 48 */ '#4F3B00', /* 49 */ '#4F4935',
  /* 50 */ '#FFFF00', /* 51 */ '#FFFFAA', /* 52 */ '#BDBD00', /* 53 */ '#BDBD7E',
  /* 54 */ '#818100', /* 55 */ '#818156', /* 56 */ '#686800', /* 57 */ '#686845',
  /* 58 */ '#4F4F00', /* 59 */ '#4F4F35',
  /* 60 */ '#BFFF00', /* 61 */ '#EAFFAA', /* 62 */ '#8DBD00', /* 63 */ '#ADBD7E',
  /* 64 */ '#5F8100', /* 65 */ '#768156', /* 66 */ '#4D6800', /* 67 */ '#606845',
  /* 68 */ '#3B4F00', /* 69 */ '#494F35',
  /* 70 */ '#7FFF00', /* 71 */ '#D4FFAA', /* 72 */ '#5EBD00', /* 73 */ '#9DBD7E',
  /* 74 */ '#3F8100', /* 75 */ '#6B8156', /* 76 */ '#336800', /* 77 */ '#566845',
  /* 78 */ '#274F00', /* 79 */ '#424F35',
  /* 80 */ '#3FFF00', /* 81 */ '#BFFFAA', /* 82 */ '#2EBD00', /* 83 */ '#8DBD7E',
  /* 84 */ '#1F8100', /* 85 */ '#608156', /* 86 */ '#196800', /* 87 */ '#4D6845',
  /* 88 */ '#134F00', /* 89 */ '#3B4F35',
  /* 90 */ '#00FF00', /* 91 */ '#AAFFAA', /* 92 */ '#00BD00', /* 93 */ '#7EBD7E',
  /* 94 */ '#008100', /* 95 */ '#568156', /* 96 */ '#006800', /* 97 */ '#456845',
  /* 98 */ '#004F00', /* 99 */ '#354F35',
  /* 100 */ '#00FF3F', /* 101 */ '#AAFFBF', /* 102 */ '#00BD2E', /* 103 */ '#7EBD8D',
  /* 104 */ '#00811F', /* 105 */ '#568160', /* 106 */ '#006819', /* 107 */ '#45684D',
  /* 108 */ '#004F13', /* 109 */ '#354F3B',
  /* 110 */ '#00FF7F', /* 111 */ '#AAFFD4', /* 112 */ '#00BD5E', /* 113 */ '#7EBD9D',
  /* 114 */ '#00813F', /* 115 */ '#56816B', /* 116 */ '#006833', /* 117 */ '#456856',
  /* 118 */ '#004F27', /* 119 */ '#354F42',
  /* 120 */ '#00FFBF', /* 121 */ '#AAFFEA', /* 122 */ '#00BD8D', /* 123 */ '#7EBDAD',
  /* 124 */ '#00815F', /* 125 */ '#568176', /* 126 */ '#00684D', /* 127 */ '#456860',
  /* 128 */ '#004F3B', /* 129 */ '#354F49',
  /* 130 */ '#00FFFF', /* 131 */ '#AAFFFF', /* 132 */ '#00BDBD', /* 133 */ '#7EBDBD',
  /* 134 */ '#008181', /* 135 */ '#568181', /* 136 */ '#006868', /* 137 */ '#456868',
  /* 138 */ '#004F4F', /* 139 */ '#354F4F',
  /* 140 */ '#00BFFF', /* 141 */ '#AAEAFF', /* 142 */ '#008DBD', /* 143 */ '#7EADBD',
  /* 144 */ '#005F81', /* 145 */ '#567681', /* 146 */ '#004D68', /* 147 */ '#456068',
  /* 148 */ '#003B4F', /* 149 */ '#35494F',
  /* 150 */ '#007FFF', /* 151 */ '#AAD4FF', /* 152 */ '#005EBD', /* 153 */ '#7E9DBD',
  /* 154 */ '#003F81', /* 155 */ '#566B81', /* 156 */ '#003368', /* 157 */ '#455668',
  /* 158 */ '#00274F', /* 159 */ '#35424F',
  /* 160 */ '#003FFF', /* 161 */ '#AABFFF', /* 162 */ '#002EBD', /* 163 */ '#7E8DBD',
  /* 164 */ '#001F81', /* 165 */ '#566081', /* 166 */ '#001968', /* 167 */ '#454D68',
  /* 168 */ '#00134F', /* 169 */ '#353B4F',
  /* 170 */ '#0000FF', /* 171 */ '#AAAAFF', /* 172 */ '#0000BD', /* 173 */ '#7E7EBD',
  /* 174 */ '#000081', /* 175 */ '#565681', /* 176 */ '#000068', /* 177 */ '#454568',
  /* 178 */ '#00004F', /* 179 */ '#35354F',
  /* 180 */ '#3F00FF', /* 181 */ '#BFAAFF', /* 182 */ '#2E00BD', /* 183 */ '#8D7EBD',
  /* 184 */ '#1F0081', /* 185 */ '#605681', /* 186 */ '#190068', /* 187 */ '#4D4568',
  /* 188 */ '#13004F', /* 189 */ '#3B354F',
  /* 190 */ '#7F00FF', /* 191 */ '#D4AAFF', /* 192 */ '#5E00BD', /* 193 */ '#9D7EBD',
  /* 194 */ '#3F0081', /* 195 */ '#6B5681', /* 196 */ '#330068', /* 197 */ '#564568',
  /* 198 */ '#27004F', /* 199 */ '#42354F',
  /* 200 */ '#BF00FF', /* 201 */ '#EAAAFF', /* 202 */ '#8D00BD', /* 203 */ '#AD7EBD',
  /* 204 */ '#5F0081', /* 205 */ '#765681', /* 206 */ '#4D0068', /* 207 */ '#604568',
  /* 208 */ '#3B004F', /* 209 */ '#49354F',
  /* 210 */ '#FF00FF', /* 211 */ '#FFAAFF', /* 212 */ '#BD00BD', /* 213 */ '#BD7EBD',
  /* 214 */ '#810081', /* 215 */ '#815681', /* 216 */ '#680068', /* 217 */ '#684568',
  /* 218 */ '#4F004F', /* 219 */ '#4F354F',
  /* 220 */ '#FF00BF', /* 221 */ '#FFAAEA', /* 222 */ '#BD008D', /* 223 */ '#BD7EAD',
  /* 224 */ '#81005F', /* 225 */ '#815676', /* 226 */ '#68004D', /* 227 */ '#684560',
  /* 228 */ '#4F003B', /* 229 */ '#4F3549',
  /* 230 */ '#FF007F', /* 231 */ '#FFAAD4', /* 232 */ '#BD005E', /* 233 */ '#BD7E9D',
  /* 234 */ '#81003F', /* 235 */ '#81566B', /* 236 */ '#680033', /* 237 */ '#684556',
  /* 238 */ '#4F0027', /* 239 */ '#4F3542',
  /* 240 */ '#FF003F', /* 241 */ '#FFAABF', /* 242 */ '#BD002E', /* 243 */ '#BD7E8D',
  /* 244 */ '#81001F', /* 245 */ '#815660', /* 246 */ '#680019', /* 247 */ '#68454D',
  /* 248 */ '#4F0013', /* 249 */ '#4F353B',
  /* 250 */ '#333333', /* 251 */ '#505050', /* 252 */ '#696969', /* 253 */ '#828282',
  /* 254 */ '#BEBEBE', /* 255 */ '#FFFFFF',
];

/**
 * Convert a DXF color value to a CSS hex string.
 * The value may be:
 *   - An ACI integer (1–255): looked up in the standard AutoCAD Color Index table.
 *   - A 24-bit true-colour integer (> 255): treated as 0xRRGGBB.
 *   - 0 / 256 / null / undefined: BYBLOCK or BYLAYER — returns `fallback`.
 *   - A string that already looks like '#rrggbb': returned as-is.
 */
const cadColorToHex = (value, fallback = '#94a3b8') => {
  if (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.trim())) return value.trim();
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric === 256) return fallback;
  // ACI range (1-255) — use the authoritative lookup table.
  if (numeric <= 255) return ACI_HEX[numeric] || fallback;
  // True-colour value stored as 0xRRGGBB integer (> 255).
  const hex = Math.round(numeric).toString(16).padStart(6, '0').slice(-6);
  return `#${hex}`;
};

const getCadUnitInfo = (header = {}) => {
  const unitCode = Number(header?.$INSUNITS);
  if (!Number.isFinite(unitCode)) {
    return { code: null, label: 'Unspecified' };
  }
  return {
    code: unitCode,
    label: CAD_UNIT_LABELS[unitCode] || `Code ${unitCode}`,
  };
};

const normalizeCadTextContent = (raw, repairStats = null) => {
  const original = String(raw ?? '');
  let text = original
    .replace(/\\P/g, ' ')
    .replace(/%%d/gi, ' deg')
    .replace(/%%p/gi, ' +/- ')
    .replace(/%%c/gi, ' dia ')
    .replace(/\\[A-Za-z][-0-9.,;]*/g, ' ')
    .replace(/\{\\[^}]*;/g, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (text !== original.trim() && repairStats) {
    repairStats.textSanitized = (repairStats.textSanitized || 0) + 1;
  }

  return text;
};

const getCadTextPosition = (entity, repairStats = null) => {
  const direct = entity?.position || entity?.startPoint || entity?.insertionPoint || entity?.alignPoint;
  const x = Number(direct?.x);
  const y = Number(direct?.y);
  const z = Number(direct?.z ?? entity?.z ?? 0);
  if (Number.isFinite(x) && Number.isFinite(y)) {
    return { x, y, z: Number.isFinite(z) ? z : 0 };
  }

  if (Array.isArray(entity?.vertices) && entity.vertices.length > 0) {
    const vertex = entity.vertices[0];
    if (repairStats) repairStats.textAnchorFallbacks = (repairStats.textAnchorFallbacks || 0) + 1;
    return toCadPoint(vertex);
  }

  return null;
};

const getStyleTable = (dxfData) => dxfData?.tables?.style?.styles || {};

const getCadTextStyle = (entity, styleTable = {}, repairStats = null) => {
  const styleName = String(
    entity?.styleName || entity?.style || entity?.textStyle || entity?.textStyleName || entity?.shapeName || 'STANDARD'
  ).trim() || 'STANDARD';
  const styleRecord = styleTable[styleName] || styleTable[styleName.toUpperCase()] || null;
  const fontFile = styleRecord?.fontFile || styleRecord?.bigFontFile || entity?.fontFile || null;
  const derivedFont = basenameFromPath(fontFile).replace(/\.[A-Za-z0-9]+$/, '') || null;
  const fontFamily = derivedFont || styleName || FALLBACK_TEXT_FONT;
  if (!styleRecord && repairStats) {
    repairStats.defaultTextStyle = (repairStats.defaultTextStyle || 0) + 1;
  }
  return {
    styleName,
    fontFile,
    fontFamily,
    widthFactor: Number.isFinite(Number(entity?.widthFactor ?? styleRecord?.widthFactor))
      ? Number(entity?.widthFactor ?? styleRecord?.widthFactor)
      : 1,
    obliqueAngle: Number.isFinite(Number(entity?.obliqueAngle ?? styleRecord?.obliqueAngle))
      ? Number(entity?.obliqueAngle ?? styleRecord?.obliqueAngle)
      : 0,
  };
};

const buildLayerSummary = (dxfData, entities, texts = []) => {
  const layerTable = dxfData?.tables?.layer?.layers || {};
  const summaryByStandard = new Map();

  const ensureLayer = (layerName, entityType = 'UNSPECIFIED') => {
    const layerRecord = layerTable[layerName] || layerTable[String(layerName || '').toUpperCase()] || null;
    const descriptor = getLayerDescriptor(layerName, layerRecord);
    const existing = summaryByStandard.get(descriptor.standardizedName) || {
      ...descriptor,
      originalNames: new Set(),
      entityTypes: {},
      entityCount: 0,
      textCount: 0,
      lineCount: 0,
      polylineCount: 0,
    };
    existing.originalNames.add(descriptor.originalName);
    existing.entityTypes[entityType] = (existing.entityTypes[entityType] || 0) + 1;
    existing.entityCount += 1;
    if (entityType === 'TEXT') existing.textCount += 1;
    if (entityType === 'LINE') existing.lineCount += 1;
    if (entityType === 'POLYLINE') existing.polylineCount += 1;
    summaryByStandard.set(descriptor.standardizedName, existing);
    return existing;
  };

  Object.keys(layerTable).forEach((layerName) => ensureLayer(layerName, 'DECLARED'));

  (Array.isArray(entities) ? entities : []).forEach((entity) => {
    const type = String(entity?.type || 'UNKNOWN').toUpperCase();
    const mappedType = type === 'LWPOLYLINE' || type === 'POLYLINE'
      ? 'POLYLINE'
      : (type === 'TEXT' || type === 'MTEXT' || type === 'ATTRIB' ? 'TEXT' : type);
    ensureLayer(entity?.layer || type, mappedType);
  });

  (Array.isArray(texts) ? texts : []).forEach((textEntity) => {
    ensureLayer(textEntity?.layerOriginal || textEntity?.layer || 'TEXT', 'TEXT');
  });

  const layers = [...summaryByStandard.values()]
    .map((entry) => ({
      ...entry,
      originalNames: [...entry.originalNames].sort(),
      displayName: humanizeLayerName(entry.standardizedName),
      colorHex: cadColorToHex(entry.color),
    }))
    .sort((a, b) => b.entityCount - a.entityCount || a.displayName.localeCompare(b.displayName));

  return {
    totalDeclaredLayers: Object.keys(layerTable).length,
    totalStandardizedLayers: layers.length,
    renamedLayers: layers.filter((layer) => layer.renamed).length,
    layers,
  };
};

const collectCadRawPoints = (rows, geometry) => {
  const points = [];

  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const x = Number(row?.x);
    const y = Number(row?.y);
    const z = Number(row?.z ?? 0);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      points.push({ x, y, z: Number.isFinite(z) ? z : 0 });
    }
  });

  (Array.isArray(geometry?.lines) ? geometry.lines : []).forEach((line) => {
    const start = Array.isArray(line?.start) ? line.start : [];
    const end = Array.isArray(line?.end) ? line.end : [];
    if (Number.isFinite(Number(start[0])) && Number.isFinite(Number(start[1]))) {
      points.push({ x: Number(start[0]), y: Number(start[1]), z: Number(start[2] ?? 0) });
    }
    if (Number.isFinite(Number(end[0])) && Number.isFinite(Number(end[1]))) {
      points.push({ x: Number(end[0]), y: Number(end[1]), z: Number(end[2] ?? 0) });
    }
  });

  (Array.isArray(geometry?.polylines) ? geometry.polylines : []).forEach((poly) => {
    (Array.isArray(poly?.points) ? poly.points : []).forEach((point) => {
      if (Number.isFinite(Number(point?.[0])) && Number.isFinite(Number(point?.[1]))) {
        points.push({ x: Number(point[0]), y: Number(point[1]), z: Number(point[2] ?? 0) });
      }
    });
  });

  (Array.isArray(geometry?.texts) ? geometry.texts : []).forEach((textEntity) => {
    const position = Array.isArray(textEntity?.position) ? textEntity.position : [];
    if (Number.isFinite(Number(position[0])) && Number.isFinite(Number(position[1]))) {
      points.push({ x: Number(position[0]), y: Number(position[1]), z: Number(position[2] ?? 0) });
    }
  });

  (Array.isArray(geometry?.surfaces) ? geometry.surfaces : []).forEach((surface) => {
    (Array.isArray(surface?.vertices) ? surface.vertices : []).forEach((vertex) => {
      if (Number.isFinite(Number(vertex?.[0])) && Number.isFinite(Number(vertex?.[1]))) {
        points.push({ x: Number(vertex[0]), y: Number(vertex[1]), z: Number(vertex[2] ?? 0) });
      }
    });
  });

  return points;
};

const buildCadValidationSummary = ({ rows, geometry, diagnostics, dxfData, headerCrsHint = null }) => {
  const unitInfo = getCadUnitInfo(dxfData?.header || {});
  const rawPoints = collectCadRawPoints(rows, geometry);
  const bounds = getBoundingBoxFromPoints(rawPoints);
  const referenceAssessment = diagnostics?.referenceAssessment || null;
  const detectedFromCrs = diagnostics?.detectedFromCrs || null;
  const notifications = [];
  const extremeCoordinateCount = rawPoints.filter((point) => Math.abs(point.x) > 1e8 || Math.abs(point.y) > 1e8).length;
  const originClusterCount = rawPoints.filter((point) => Math.abs(point.x) <= 1e-6 && Math.abs(point.y) <= 1e-6).length;
  const textCount = Array.isArray(geometry?.texts) ? geometry.texts.length : 0;
  const surfaceCount = Array.isArray(geometry?.surfaces) ? geometry.surfaces.length : 0;
  const triangleCount = (Array.isArray(geometry?.surfaces) ? geometry.surfaces : []).reduce(
    (sum, surface) => sum + (Array.isArray(surface?.triangles) ? surface.triangles.length : 0),
    0
  );

  if (!unitInfo.code || unitInfo.code === 0) {
    notifications.push({
      severity: 'warning',
      code: 'cad-units-missing',
      title: 'Units not declared',
      message: 'The drawing does not declare INSUNITS. Distance and extent checks use a best-effort fallback only.',
    });
  }

  if (referenceAssessment?.isLocal || detectedFromCrs === 'LOCAL:ENGINEERING') {
    notifications.push({
      severity: 'warning',
      code: 'cad-local-preview',
      title: 'Local preview only',
      message: 'This CAD file appears to use local engineering coordinates. The map preview is schematic until you assign a real CRS.',
      visualize: true,
    });
  } else if (referenceAssessment?.status === 'ambiguous') {
    notifications.push({
      severity: 'warning',
      code: 'cad-ambiguous-crs',
      title: 'CRS needs review',
      message: referenceAssessment?.reason || 'The imported coordinates are plausible, but the source CRS remains ambiguous.',
    });
  }

  if (extremeCoordinateCount > 0) {
    notifications.push({
      severity: 'error',
      code: 'cad-coordinate-anomaly',
      title: 'Coordinate anomaly detected',
      message: `${extremeCoordinateCount} CAD coordinate${extremeCoordinateCount === 1 ? '' : 's'} exceed the expected engineering/geospatial numeric range.`,
    });
  }

  if (originClusterCount > 0 && originClusterCount === rawPoints.length && rawPoints.length > 0) {
    notifications.push({
      severity: 'warning',
      code: 'cad-origin-cluster',
      title: 'All features are near origin',
      message: 'Most CAD entities are clustered around 0,0. Check whether the file lost its intended insertion base or georeferencing.',
    });
  }

  if (bounds && bounds.diagonal <= 0) {
    notifications.push({
      severity: 'warning',
      code: 'cad-flat-extent',
      title: 'Flat extent',
      message: 'The CAD extent collapsed to a single position. The file may contain only labels or damaged coordinates.',
    });
  }

  const unresolvedXrefs = diagnostics?.references?.unresolvedXrefs?.length || 0;
  if (unresolvedXrefs > 0) {
    notifications.push({
      severity: 'warning',
      code: 'cad-unresolved-xref',
      title: 'Unresolved external references',
      message: `${unresolvedXrefs} unresolved XREF reference${unresolvedXrefs === 1 ? '' : 's'} detected. The preview may be incomplete.`,
    });
  }

  const repairStats = diagnostics?.repairs || {};
  const repairCount = Object.values(repairStats).reduce((sum, value) => sum + (Number.isFinite(Number(value)) ? Number(value) : 0), 0);
  if (repairCount > 0) {
    notifications.push({
      severity: 'info',
      code: 'cad-auto-repair',
      title: 'Auto-repair applied',
      message: `The CAD import repaired ${repairCount} issue${repairCount === 1 ? '' : 's'} automatically, including text/style/layer normalization where needed.`,
    });
  }

  if (textCount > 0) {
    notifications.push({
      severity: 'info',
      code: 'cad-text-imported',
      title: 'CAD text imported',
      message: `${textCount} CAD text annotation${textCount === 1 ? '' : 's'} prepared for map display with style fallback support.`,
    });
  }

  if (surfaceCount > 0) {
    notifications.push({
      severity: 'info',
      code: 'cad-surfaces-imported',
      title: 'CAD terrain surfaces imported',
      message: `${surfaceCount} CAD surface object${surfaceCount === 1 ? '' : 's'} loaded with ${triangleCount} TIN triangle${triangleCount === 1 ? '' : 's'}.`,
    });
  }

  if (triangleCount >= CAD_SURFACE_TRIANGLE_WARN_THRESHOLD) {
    notifications.push({
      severity: 'warning',
      code: 'cad-surface-heavy',
      title: 'Heavy terrain mesh detected',
      message: `This drawing contains ${triangleCount} terrain triangles. Fill rendering may auto-throttle for interactive map performance.`,
    });
  }

  if (headerCrsHint?.suggestedCrs && !diagnostics?.detectedFromCrs) {
    notifications.push({
      severity: 'info',
      code: 'cad-header-crs-hint',
      title: `Header CRS suggestion: ${headerCrsHint.suggestedCrs}`,
      message: headerCrsHint.note || `DXF header analysis suggests ${headerCrsHint.suggestedCrs} (confidence: ${headerCrsHint.confidence}).`,
    });
  }

  return {
    units: unitInfo,
    bounds,
    extremeCoordinateCount,
    originClusterCount,
    headerCrsHint: headerCrsHint || null,
    notifications,
  };
};

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

  return null;
};

/**
 * Extracts and analyses the DXF header to produce a rich CRS hint.
 * Uses $INSUNITS, $MEASUREMENT, $EXTMIN/$EXTMAX to infer likely CRS.
 */
export const extractDxfHeaderCrsHint = (dxfData) => {
  const header = dxfData?.header || {};
  const unitInfo = getCadUnitInfo(header);

  // Header extent from $EXTMIN / $EXTMAX
  const extMin = header.$EXTMIN || null;
  const extMax = header.$EXTMAX || null;
  const minX = Number(extMin?.x ?? extMin?.[0] ?? NaN);
  const minY = Number(extMin?.y ?? extMin?.[1] ?? NaN);
  const maxX = Number(extMax?.x ?? extMax?.[0] ?? NaN);
  const maxY = Number(extMax?.y ?? extMax?.[1] ?? NaN);
  const hasExtent = Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY);
  const extent = hasExtent ? { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY } : null;

  // Explicit EPSG in header
  const explicitEpsg = header.$EPSG || header.$EPSGCODE || null;
  if (explicitEpsg) {
    return {
      suggestedCrs: `EPSG:${explicitEpsg}`,
      source: 'header-explicit',
      confidence: 'high',
      unitInfo,
      extent,
      note: `DXF header explicitly declares $EPSG = ${explicitEpsg}.`,
    };
  }

  let suggestedCrs = null;
  let source = null;
  let confidence = null;
  let note = null;

  if (hasExtent) {
    const isGeographic = minX >= -180 && maxX <= 180 && minY >= -90 && maxY <= 90;
    const isLambert93 = minX >= 90000 && maxX <= 1300000 && minY >= 5900000 && maxY <= 7250000;
    const isUtmLike = Math.abs(minX) < 1e6 && minY > 0 && maxY < 1e7 && (maxX - minX) < 1e6;
    const isRgf93Cc = minX >= 1000000 && maxX <= 1800000 && minY >= 1000000 && maxY <= 2800000;

    if (isGeographic) {
      suggestedCrs = 'EPSG:4326';
      source = 'header-extent';
      confidence = 'medium';
      note = `Extent (${minX.toFixed(2)}, ${minY.toFixed(2)}) → (${maxX.toFixed(2)}, ${maxY.toFixed(2)}) matches WGS84 geographic range.`;
    } else if (isLambert93) {
      suggestedCrs = 'EPSG:2154';
      source = 'header-extent';
      confidence = 'medium';
      note = `Extent matches French Lambert-93 (EPSG:2154) coordinate range.`;
    } else if (isRgf93Cc) {
      suggestedCrs = 'EPSG:3942'; // CC42 – a representative pick; actual zone needs more analysis
      source = 'header-extent';
      confidence = 'low';
      note = `Extent may match French RGF93/CC system. Confirm exact zone.`;
    } else if (isUtmLike) {
      // Estimate UTM zone from midpoint X (Easting ~166k–834k = zone width ~668k)
      const midLon = minX + (maxX - minX) / 2;
      const midNorthing = minY + (maxY - minY) / 2;
      const isNorth = midNorthing > 0;
      // UTM easting center is ~500000; guess zone from offset (very rough)
      const utmZoneGuess = Math.max(1, Math.min(60, Math.round((midLon - 166022) / 111319) + 1));
      suggestedCrs = `EPSG:${isNorth ? 326 : 327}${String(utmZoneGuess).padStart(2, '0')}`;
      source = 'header-extent';
      confidence = 'low';
      note = `Extent resembles UTM projected coordinates. Zone estimated as ${utmZoneGuess}${isNorth ? 'N' : 'S'} — verify before use.`;
    }
  }

  // Unit-based disambiguation
  if (unitInfo.code !== null && unitInfo.code !== 0) {
    const isMetric = [4, 5, 6, 7].includes(unitInfo.code); // mm, cm, m, km
    const isFeet = [1, 2].includes(unitInfo.code); // inches, feet
    if (suggestedCrs && isMetric) {
      note = (note || '') + ` Drawing unit: ${unitInfo.label} (metric — consistent with projected CRS).`;
    } else if (suggestedCrs && isFeet) {
      note = (note || '') + ` Drawing unit: ${unitInfo.label} (imperial — CRS suggestion may need review).`;
    }
  }

  return {
    suggestedCrs,
    source,
    confidence,
    unitInfo,
    extent,
    note,
  };
};

const normalizeCadLabelCandidate = (value) => String(value || '').trim();
const isCadPointNameProvided = (value) => normalizeCadLabelCandidate(value).length > 0;

const isLikelyPointIdentifier = (value) => {
  const text = normalizeCadLabelCandidate(value);
  if (!text) return false;
  if (text.length > 40) return false;
  if (/^[-+]?\d+(?:[.,]\d+)?$/.test(text)) return false;
  // Reject obvious file/path-like metadata labels.
  if (/\.(?:dxf|dwg|kml|kmz|csv|txt|geojson|gpx|json)\b/i.test(text)) return false;
  if (/[\\/]/.test(text)) return false;
  if (/:[^\s]/.test(text)) return false;
  // Most point labels include at least one digit or mixed token pattern.
  if (/[0-9]/.test(text)) return true;
  if (/^[A-Za-z]+[-_][A-Za-z0-9]+$/.test(text)) return true;
  return false;
};

const extractInsertPointName = (ent) => {
  const attrCandidates = [
    ...(Array.isArray(ent?.attribs) ? ent.attribs.map((attr) => attr?.text || attr?.value || attr?.tag) : []),
    ent?.text,
    isLikelyPointIdentifier(ent?.name) ? ent?.name : null,
  ];

  return attrCandidates.find(isCadPointNameProvided) || null;
};

const extractInsertPointElevation = (ent) => {
  const attrCandidates = [
    ...(Array.isArray(ent?.attribs) ? ent.attribs.map((attr) => attr?.text || attr?.value) : []),
    ent?.text,
  ];

  for (const candidate of attrCandidates) {
    const elevation = parseCadElevationText(candidate);
    if (Number.isFinite(elevation)) return elevation;
  }

  return null;
};

const collectTextLabels = (entities) => {
  const labels = [];

  const addFromEntities = (entities) => {
    if (!Array.isArray(entities)) return;
    entities.forEach((ent) => {
      const type = String(ent?.type || '').toUpperCase();
      if (type !== 'TEXT' && type !== 'MTEXT' && type !== 'ATTRIB') return;

      const rawText = ent?.text ?? ent?.value ?? ent?.tag ?? '';
      const text = normalizeCadTextContent(rawText);
      if (!isCadPointNameProvided(text)) return;

      const pos = ent?.position || ent?.startPoint || ent?.insertionPoint;
      const x = Number(pos?.x);
      const y = Number(pos?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;

      labels.push({
        text,
        x,
        y,
        layer: ent?.layer || null,
      });
    });
  };

  addFromEntities(entities);
  return labels;
};

const parseCadElevationText = (value) => {
  const text = normalizeCadLabelCandidate(value);
  if (!text) return null;
  const normalized = text
    .replace(',', '.')
    .replace(/[^0-9+\-.]/g, ' ')
    .trim();
  if (!normalized) return null;
  const token = normalized.split(/\s+/).find((part) => /^[-+]?\d+(?:\.\d+)?$/.test(part));
  if (!token) return null;
  const numeric = Number(token);
  if (!Number.isFinite(numeric)) return null;
  // Accept typical survey elevations while avoiding accidental huge IDs.
  if (numeric < -2000 || numeric > 15000) return null;
  return numeric;
};

const assignNearbyTextNames = (rows, labels, drawingDiagonal = 0) => {
  if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(labels) || labels.length === 0) return 0;

  const unnamedIndexes = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => !row?.hasExplicitName)
    .map(({ index }) => index);

  if (!unnamedIndexes.length) return 0;

  const tolerance = Math.max(2, Math.min(250, drawingDiagonal > 0 ? drawingDiagonal * 0.004 : 50));
  const usedRowIndexes = new Set();
  let assigned = 0;

  labels.forEach((label) => {
    if (!isLikelyPointIdentifier(label?.text)) return;

    const ranked = unnamedIndexes
      .filter((idx) => !usedRowIndexes.has(idx))
      .map((idx) => {
        const row = rows[idx];
        const dist = Math.hypot(row.x - label.x, row.y - label.y);
        return { idx, dist, sameLayer: String(row?.layer || '') === String(label?.layer || '') };
      })
      .sort((a, b) => a.dist - b.dist);

    if (!ranked.length) return;
    const best = ranked[0];
    const second = ranked[1] || null;
    const secondDist = second ? second.dist : Number.POSITIVE_INFINITY;
    const clearlyNearest = secondDist === Number.POSITIVE_INFINITY || best.dist <= secondDist * 0.55;
    const closeEnough = best.dist <= tolerance;

    if (!closeEnough || !clearlyNearest) return;

    rows[best.idx].id = label.text;
    rows[best.idx].hasExplicitName = true;
    usedRowIndexes.add(best.idx);
    assigned += 1;
  });

  return assigned;
};

const assignNearbyTextElevations = (rows, labels, drawingDiagonal = 0) => {
  if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(labels) || labels.length === 0) return 0;

  const tolerance = Math.max(2, Math.min(250, drawingDiagonal > 0 ? drawingDiagonal * 0.004 : 50));
  let assigned = 0;

  rows.forEach((row) => {
    const hasNumericZ = Number.isFinite(Number(row?.z));
    if (hasNumericZ && Number(row.z) !== 0) return;

    const candidate = labels
      .map((label) => {
        const value = parseCadElevationText(label?.text);
        if (!Number.isFinite(value)) return null;
        const dist = Math.hypot((Number(row?.x) || 0) - Number(label?.x), (Number(row?.y) || 0) - Number(label?.y));
        return {
          value,
          dist,
          sameLayer: String(row?.layer || '') === String(label?.layer || ''),
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (a.sameLayer !== b.sameLayer) return a.sameLayer ? -1 : 1;
        return a.dist - b.dist;
      })[0];

    if (!candidate || candidate.dist > tolerance) return;
    row.z = candidate.value;
    row.hasExplicitElevation = true;
    assigned += 1;
  });

  return assigned;
};

const distance2d = (a, b) => Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));

const getSegmentMidpoint = (segment) => ({
  x: (segment.start.x + segment.end.x) / 2,
  y: (segment.start.y + segment.end.y) / 2,
});

const getSegmentLength = (segment) => distance2d(segment.start, segment.end);

const getSegmentOrientationBucket = (segment) => {
  const dx = segment.end.x - segment.start.x;
  const dy = segment.end.y - segment.start.y;
  const angle = Math.atan2(dy, dx);
  const octant = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
  return octant;
};

const getBoundingBoxFromPoints = (points) => {
  const xs = points.map((p) => Number(p?.x)).filter(Number.isFinite);
  const ys = points.map((p) => Number(p?.y)).filter(Number.isFinite);
  if (!xs.length || !ys.length) return null;
  let minX = xs[0];
  let maxX = xs[0];
  for (const value of xs) {
    if (value < minX) minX = value;
    if (value > maxX) maxX = value;
  }
  let minY = ys[0];
  let maxY = ys[0];
  for (const value of ys) {
    if (value < minY) minY = value;
    if (value > maxY) maxY = value;
  }
  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    diagonal: Math.hypot(maxX - minX, maxY - minY),
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
  };
};

const identityCadTransform = () => ({
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  tx: 0,
  ty: 0,
  sz: 1,
  tz: 0,
});

const asFiniteNumber = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const toCadPoint = (value, fallbackZ = 0) => {
  if (Array.isArray(value)) {
    return {
      x: asFiniteNumber(value[0], 0),
      y: asFiniteNumber(value[1], 0),
      z: asFiniteNumber(value[2], fallbackZ),
    };
  }

  return {
    x: asFiniteNumber(value?.x, 0),
    y: asFiniteNumber(value?.y, 0),
    z: asFiniteNumber(value?.z, fallbackZ),
  };
};

const applyCadTransform = (point, transform) => {
  const local = toCadPoint(point);
  return {
    x: transform.a * local.x + transform.c * local.y + transform.tx,
    y: transform.b * local.x + transform.d * local.y + transform.ty,
    z: (transform.sz * local.z) + transform.tz,
  };
};

const composeCadTransforms = (parent, local) => ({
  a: parent.a * local.a + parent.c * local.b,
  b: parent.b * local.a + parent.d * local.b,
  c: parent.a * local.c + parent.c * local.d,
  d: parent.b * local.c + parent.d * local.d,
  tx: parent.a * local.tx + parent.c * local.ty + parent.tx,
  ty: parent.b * local.tx + parent.d * local.ty + parent.ty,
  sz: parent.sz * local.sz,
  tz: parent.sz * local.tz + parent.tz,
});

const createInsertTransform = (entity) => {
  const position = entity?.position || entity?.insertionPoint || {};
  const rotationDeg = asFiniteNumber(entity?.rotation ?? entity?.angle, 0);
  const rotationRad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rotationRad);
  const sin = Math.sin(rotationRad);
  const scaleX = asFiniteNumber(entity?.xScale ?? entity?.scaleX ?? entity?.scale?.x, 1);
  const scaleY = asFiniteNumber(entity?.yScale ?? entity?.scaleY ?? entity?.scale?.y, 1);
  const scaleZ = asFiniteNumber(entity?.zScale ?? entity?.scaleZ ?? entity?.scale?.z, 1);

  return {
    a: scaleX * cos,
    b: scaleX * sin,
    c: -scaleY * sin,
    d: scaleY * cos,
    tx: asFiniteNumber(position?.x, 0),
    ty: asFiniteNumber(position?.y, 0),
    sz: scaleZ,
    tz: asFiniteNumber(position?.z ?? entity?.z, 0),
  };
};

const isLikelyXrefReference = (name, block = null) => {
  const normalized = String(name || '').trim();
  if (!normalized) return false;
  if (/[|\\/]/.test(normalized)) return true;
  if (/\.dwg$/i.test(normalized)) return true;
  if (/^xref[_\-\s]?/i.test(normalized)) return true;
  if (block?.xrefPath || block?.path || block?.externalReference || block?.isXRef) return true;
  return false;
};

const pushUniqueReference = (target, item, key) => {
  if (target.some((existing) => existing.key === key)) return;
  target.push({ key, ...item });
};

const transformCadEntity = (entity, transform, metadata = {}) => {
  const type = String(entity?.type || '').toUpperCase();
  const transformed = {
    ...entity,
    layer: entity?.layer || metadata.layer || entity?.type,
    __depth: metadata.depth || 0,
    __sourceBlock: metadata.sourceBlock || null,
  };

  switch (type) {
    case 'POINT':
      transformed.position = applyCadTransform(entity?.position || entity, transform);
      transformed.z = transformed.position.z;
      return transformed;
    case 'LINE':
      transformed.start = applyCadTransform(entity?.start || entity?.vertices?.[0], transform);
      transformed.end = applyCadTransform(entity?.end || entity?.vertices?.[1], transform);
      return transformed;
    case 'LWPOLYLINE':
    case 'POLYLINE':
      transformed.vertices = (Array.isArray(entity?.vertices) ? entity.vertices : []).map((vertex) => {
        const projected = applyCadTransform(vertex, transform);
        return {
          ...vertex,
          ...projected,
          vertexIndices: Array.isArray(vertex?.vertexIndices) ? [...vertex.vertexIndices] : vertex?.vertexIndices,
          indices: Array.isArray(vertex?.indices) ? [...vertex.indices] : vertex?.indices,
          face: Array.isArray(vertex?.face) ? [...vertex.face] : vertex?.face,
        };
      });
      return transformed;
    case '3DFACE':
    case 'FACE3D': {
      const directVertices = Array.isArray(entity?.vertices) ? entity.vertices : [];
      const fallbackVertices = [entity?.firstCorner, entity?.secondCorner, entity?.thirdCorner, entity?.fourthCorner].filter(Boolean);
      const sourceVertices = directVertices.length > 0 ? directVertices : fallbackVertices;
      transformed.vertices = sourceVertices.map((vertex) => applyCadTransform(vertex, transform));
      return transformed;
    }
    case 'MESH':
      transformed.vertices = (Array.isArray(entity?.vertices) ? entity.vertices : []).map((vertex) => applyCadTransform(vertex, transform));
      transformed.faces = Array.isArray(entity?.faces) ? entity.faces : [];
      return transformed;
    case 'TEXT':
    case 'MTEXT':
    case 'ATTRIB': {
      const position = entity?.position || entity?.startPoint || entity?.insertionPoint;
      transformed.position = applyCadTransform(position, transform);
      transformed.startPoint = transformed.position;
      transformed.insertionPoint = transformed.position;
      return transformed;
    }
    default:
      return null;
  }
};

const expandCadEntities = (dxfData, options = {}) => {
  const blocks = dxfData?.blocks || {};
  const maxDepth = Number.isFinite(Number(options.maxDepth)) ? Number(options.maxDepth) : 10;
  const flattened = [];
  const diagnostics = {
    references: {
      unresolvedBlockRefs: [],
      unresolvedXrefs: [],
      cyclicBlockRefs: [],
    },
    resolution: {
      expandedInsertCount: 0,
      nestedInsertDepthMax: 0,
      expandedEntityCount: 0,
      skippedEntitiesByType: {},
      transformWarnings: [],
    },
  };

  const markSkipped = (type) => {
    const normalizedType = String(type || 'UNKNOWN').toUpperCase();
    diagnostics.resolution.skippedEntitiesByType[normalizedType] = (diagnostics.resolution.skippedEntitiesByType[normalizedType] || 0) + 1;
  };

  // Use iterative approach with work queue instead of recursion to avoid stack overflow on large files
  const workQueue = [
    {
      entities: dxfData?.entities || [],
      transform: identityCadTransform(),
      depth: 0,
      ancestry: [],
      sourceBlock: null,
    },
  ];

  while (workQueue.length > 0) {
    const work = workQueue.pop(); // pop() is O(1); shift() is O(n) for large queues
    const { entities, transform, depth, ancestry, sourceBlock } = work;

    if (!Array.isArray(entities)) continue;
    diagnostics.resolution.nestedInsertDepthMax = Math.max(diagnostics.resolution.nestedInsertDepthMax, depth);

    for (const entity of entities) {
      const type = String(entity?.type || 'UNKNOWN').toUpperCase();

      if (type === 'INSERT') {
        const insertName = String(entity?.name || '').trim();
        const block = insertName ? blocks[insertName] : null;
        const insertTransform = composeCadTransforms(transform, createInsertTransform(entity));
        const insertEntity = {
          ...entity,
          position: applyCadTransform(entity?.position || entity?.insertionPoint || {}, transform),
          layer: entity?.layer || entity?.type,
          __depth: depth,
          __sourceBlock: sourceBlock,
          __blockResolved: Boolean(block),
          __blockPointLike: Boolean(block) && isBlockPointLike(block),
          __pointName: extractInsertPointName(entity),
        };
        flattened.push(insertEntity);

        // AutoCAD survey point blocks often store the visible name/elevation as INSERT attributes.
        (Array.isArray(entity?.attribs) ? entity.attribs : []).forEach((attr, attrIndex) => {
          const attrEntity = {
            ...attr,
            type: 'ATTRIB',
            layer: attr?.layer || entity?.layer || insertEntity.layer,
            text: attr?.text ?? attr?.value ?? attr?.tag ?? '',
            value: attr?.value ?? attr?.text ?? attr?.tag ?? '',
            position: attr?.position || attr?.startPoint || attr?.insertionPoint || entity?.position || entity?.insertionPoint,
            __attrIndex: attrIndex,
          };
          const transformedAttr = transformCadEntity(attrEntity, insertTransform, { depth: depth + 1, sourceBlock: insertName || sourceBlock });
          if (transformedAttr) {
            flattened.push(transformedAttr);
          }
        });

        diagnostics.resolution.expandedInsertCount += 1;

        if (!block) {
          pushUniqueReference(diagnostics.references.unresolvedBlockRefs, {
            name: insertName || '(unnamed)',
            depth,
            layer: insertEntity.layer || null,
          }, `${insertName || '(unnamed)'}:${insertEntity.layer || ''}:${depth}`);
          if (isLikelyXrefReference(insertName)) {
            pushUniqueReference(diagnostics.references.unresolvedXrefs, {
              name: insertName || '(unnamed)',
              depth,
              layer: insertEntity.layer || null,
            }, `${insertName || '(unnamed)'}:${insertEntity.layer || ''}:${depth}`);
          }
          continue;
        }

        if ((!Array.isArray(block?.entities) || block.entities.length === 0) && isLikelyXrefReference(insertName, block)) {
          pushUniqueReference(diagnostics.references.unresolvedXrefs, {
            name: insertName || '(unnamed)',
            depth,
            layer: insertEntity.layer || null,
          }, `${insertName || '(unnamed)'}:${insertEntity.layer || ''}:empty:${depth}`);
        }

        if (ancestry.includes(insertName)) {
          pushUniqueReference(diagnostics.references.cyclicBlockRefs, {
            name: insertName,
            chain: [...ancestry, insertName],
          }, [...ancestry, insertName].join('>'));
          continue;
        }

        if (depth >= maxDepth) {
          diagnostics.resolution.transformWarnings.push(`Maximum CAD block nesting depth (${maxDepth}) reached at ${insertName}.`);
          continue;
        }

        // Queue block entities for processing instead of recursive call
        workQueue.push({
          entities: block?.entities || [],
          transform: insertTransform,
          depth: depth + 1,
          ancestry: [...ancestry, insertName],
          sourceBlock: insertName,
        });
        continue;
      }

      const transformed = transformCadEntity(entity, transform, { depth, sourceBlock });
      if (!transformed) {
        markSkipped(type);
        continue;
      }
      flattened.push(transformed);
    }
  }

  diagnostics.resolution.expandedEntityCount = flattened.length;
  return { entities: flattened, diagnostics };
};

const getEntitySegments = (entities, source = 'top-level') => {
  const segments = [];
  if (!Array.isArray(entities)) return segments;

  entities.forEach((ent, entityIndex) => {
    const layer = ent?.layer || ent?.type || source;
    if (ent?.type === 'LINE') {
      const lineStart = ent?.start || ent?.vertices?.[0];
      const lineEnd = ent?.end || ent?.vertices?.[1];
      if (Number.isFinite(Number(lineStart?.x)) && Number.isFinite(Number(lineStart?.y)) && Number.isFinite(Number(lineEnd?.x)) && Number.isFinite(Number(lineEnd?.y))) {
        segments.push({
          id: `${source}:${layer}:${entityIndex}:line`,
          layer,
          type: 'LINE',
          start: { x: Number(lineStart.x), y: Number(lineStart.y), z: Number(lineStart.z ?? 0) },
          end: { x: Number(lineEnd.x), y: Number(lineEnd.y), z: Number(lineEnd.z ?? 0) },
        });
      }
      return;
    }

    if (ent?.type === 'LWPOLYLINE' || ent?.type === 'POLYLINE') {
      const vertices = Array.isArray(ent?.vertices) ? ent.vertices : [];
      for (let i = 0; i < vertices.length - 1; i += 1) {
        const start = vertices[i];
        const end = vertices[i + 1];
        if (!Number.isFinite(Number(start?.x)) || !Number.isFinite(Number(start?.y)) || !Number.isFinite(Number(end?.x)) || !Number.isFinite(Number(end?.y))) continue;
        segments.push({
          id: `${source}:${layer}:${entityIndex}:seg:${i}`,
          layer,
          type: ent.type,
          start: { x: Number(start.x), y: Number(start.y), z: Number(start.z ?? 0) },
          end: { x: Number(end.x), y: Number(end.y), z: Number(end.z ?? 0) },
        });
      }
    }
  });

  return segments;
};

const toIndexFromFaceToken = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return null;
  return Math.abs(Math.trunc(n)) - 1;
};

const normalizeTriangleIndexes = (indexes, vertexCount) => {
  const unique = [];
  indexes.forEach((indexValue) => {
    const index = Number(indexValue);
    if (!Number.isInteger(index) || index < 0 || index >= vertexCount) return;
    if (unique.includes(index)) return;
    unique.push(index);
  });
  if (unique.length < 3) return [];
  const triangles = [];
  for (let i = 1; i < unique.length - 1; i += 1) {
    triangles.push([unique[0], unique[i], unique[i + 1]]);
  }
  return triangles;
};

const buildSurfaceFeature = ({ vertices, triangles, layer, layerTable = {}, sourceType = 'SURFACE' }) => {
  const safeVertices = (Array.isArray(vertices) ? vertices : [])
    .map((vertex) => {
      const x = Number(vertex?.x ?? vertex?.[0]);
      const y = Number(vertex?.y ?? vertex?.[1]);
      const z = Number(vertex?.z ?? vertex?.[2] ?? 0);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return [x, y, Number.isFinite(z) ? z : 0];
    })
    .filter(Boolean);

  if (safeVertices.length < 3) return null;

  const safeTriangles = (Array.isArray(triangles) ? triangles : [])
    .filter((tri) => Array.isArray(tri) && tri.length === 3)
    .map((tri) => tri.map((v) => Number(v)))
    .filter((tri) => tri.every((v) => Number.isInteger(v) && v >= 0 && v < safeVertices.length));

  if (!safeTriangles.length) return null;

  const descriptor = getLayerDescriptor(layer || sourceType || 'SURFACE', layerTable[layer || sourceType || 'SURFACE']);
  const elevations = safeVertices.map((vertex) => Number(vertex[2])).filter(Number.isFinite);
  let minZ = null;
  let maxZ = null;
  if (elevations.length) {
    minZ = elevations[0];
    maxZ = elevations[0];
    for (const value of elevations) {
      if (value < minZ) minZ = value;
      if (value > maxZ) maxZ = value;
    }
  }

  return {
    layer: descriptor.displayName,
    layerOriginal: descriptor.originalName,
    layerNormalized: descriptor.normalizedName,
    layerStandardized: descriptor.standardizedName,
    layerCategory: descriptor.category,
    sourceType,
    vertices: safeVertices,
    triangles: safeTriangles,
    triangleCount: safeTriangles.length,
    vertexCount: safeVertices.length,
    minZ,
    maxZ,
  };
};

const extract3dFaceSurface = (entity, layerTable = {}) => {
  const vertices = Array.isArray(entity?.vertices)
    ? entity.vertices
    : [entity?.firstCorner, entity?.secondCorner, entity?.thirdCorner, entity?.fourthCorner].filter(Boolean);
  if (!Array.isArray(vertices) || vertices.length < 3) return null;

  const validCount = Math.min(vertices.length, 4);
  const triangles = validCount === 3
    ? [[0, 1, 2]]
    : normalizeTriangleIndexes([0, 1, 2, 3], validCount);

  return buildSurfaceFeature({
    vertices: vertices.slice(0, validCount),
    triangles,
    layer: entity?.layer,
    layerTable,
    sourceType: String(entity?.type || '3DFACE').toUpperCase(),
  });
};

const extractMeshSurface = (entity, layerTable = {}) => {
  const vertices = Array.isArray(entity?.vertices) ? entity.vertices : [];
  if (vertices.length < 3) return null;

  const faceRecords = Array.isArray(entity?.faces) ? entity.faces : [];
  const triangles = [];
  faceRecords.forEach((face) => {
    const faceIndexes = Array.isArray(face)
      ? face
      : (Array.isArray(face?.vertexIndices) ? face.vertexIndices : (Array.isArray(face?.indices) ? face.indices : []));
    triangles.push(...normalizeTriangleIndexes(faceIndexes.map((idx) => Number(idx)), vertices.length));
  });

  return buildSurfaceFeature({
    vertices,
    triangles,
    layer: entity?.layer,
    layerTable,
    sourceType: 'MESH',
  });
};

const extractPolyfaceSurface = (entity, layerTable = {}) => {
  if (String(entity?.type || '').toUpperCase() !== 'POLYLINE') return null;
  const vertices = Array.isArray(entity?.vertices) ? entity.vertices : [];
  if (vertices.length < 4) return null;

  const faceLikeRecords = vertices.filter((vertex) => {
    if (!vertex || typeof vertex !== 'object') return false;
    if (Array.isArray(vertex?.vertexIndices) || Array.isArray(vertex?.indices) || Array.isArray(vertex?.face)) return true;
    return ['faceA', 'faceB', 'faceC', 'faceD', 'vtx0', 'vtx1', 'vtx2', 'vtx3'].some((key) => Number.isFinite(Number(vertex?.[key])));
  });
  if (!faceLikeRecords.length) return null;

  const coordVertices = vertices.filter((vertex) => Number.isFinite(Number(vertex?.x)) && Number.isFinite(Number(vertex?.y)));
  if (coordVertices.length < 3) return null;

  const triangles = [];
  faceLikeRecords.forEach((face) => {
    const indexTokens = [];
    if (Array.isArray(face?.vertexIndices)) indexTokens.push(...face.vertexIndices);
    if (Array.isArray(face?.indices)) indexTokens.push(...face.indices);
    if (Array.isArray(face?.face)) indexTokens.push(...face.face);
    ['faceA', 'faceB', 'faceC', 'faceD', 'vtx0', 'vtx1', 'vtx2', 'vtx3'].forEach((key) => {
      if (Number.isFinite(Number(face?.[key]))) indexTokens.push(face[key]);
    });
    const normalized = indexTokens
      .map(toIndexFromFaceToken)
      .filter((idx) => Number.isInteger(idx));
    triangles.push(...normalizeTriangleIndexes(normalized, coordVertices.length));
  });

  return buildSurfaceFeature({
    vertices: coordVertices,
    triangles,
    layer: entity?.layer,
    layerTable,
    sourceType: 'POLYFACE_MESH',
  });
};

const extractPlaneSurface = (entity, layerTable = {}) => {
  if (String(entity?.type || '').toUpperCase() !== 'PLANESURFACE') return null;

  // PLANESURFACE can have vertices directly or via boundaries
  let vertices = [];
  
  // Try to extract vertices from the entity's surface points
  if (Array.isArray(entity?.controlPointArray)) {
    vertices = entity.controlPointArray.filter(Boolean);
  } else if (Array.isArray(entity?.vertices)) {
    vertices = entity.vertices.filter(Boolean);
  } else if (Array.isArray(entity?.points)) {
    vertices = entity.points.filter(Boolean);
  }

  // If still no vertices, try boundary extraction
  if (vertices.length < 3 && Array.isArray(entity?.boundaryPaths)) {
    entity.boundaryPaths.forEach((path) => {
      if (Array.isArray(path?.vertices)) {
        vertices.push(...path.vertices.filter(Boolean));
      }
    });
  }

  // Dedup and validate
  const uniqueVertices = [];
  const vertexKey = new Set();
  vertices.forEach((v) => {
    const x = Number(v?.x ?? v?.[0]);
    const y = Number(v?.y ?? v?.[1]);
    const z = Number(v?.z ?? v?.[2] ?? 0);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const key = `${x.toFixed(6)},${y.toFixed(6)}`;
    if (vertexKey.has(key)) return;
    vertexKey.add(key);
    uniqueVertices.push([x, y, Number.isFinite(z) ? z : 0]);
  });

  if (uniqueVertices.length < 3) return null;

  // For planar surface, triangulate via fan triangulation from first vertex
  const triangles = [];
  if (uniqueVertices.length === 3) {
    triangles.push([0, 1, 2]);
  } else if (uniqueVertices.length === 4) {
    triangles.push([0, 1, 2], [0, 2, 3]);
  } else {
    // Fan triangulation: from vertex 0 to each edge
    for (let i = 1; i < uniqueVertices.length - 1; i += 1) {
      triangles.push([0, i, i + 1]);
    }
  }

  return buildSurfaceFeature({
    vertices: uniqueVertices,
    triangles,
    layer: entity?.layer,
    layerTable,
    sourceType: 'PLANESURFACE',
  });
};

const _extract3dLineSurface = (entity) => {
  if (String(entity?.type || '').toUpperCase() !== '3DLINE') return null;
  
  // 3DLINE is typically a wireframe; we extract it as polyline geometry, not surface
  // Return null here; it will be handled by addPolyline in visitEntities
  return null;
};

const getLengthQuantile = (values, q) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q)));
  return sorted[index];
};

const clusterCandidates = (candidates, tolerance) => {
  const clusters = [];
  candidates.forEach((candidate) => {
    const hit = clusters.find((cluster) => distance2d(cluster.center, candidate.point) <= tolerance);
    if (!hit) {
      clusters.push({ center: { ...candidate.point }, items: [candidate] });
      return;
    }

    hit.items.push(candidate);
    const factor = hit.items.length;
    hit.center = {
      x: ((hit.center.x * (factor - 1)) + candidate.point.x) / factor,
      y: ((hit.center.y * (factor - 1)) + candidate.point.y) / factor,
    };
  });
  return clusters;
};

const getClusterDirectionStats = (center, segments, tolerance) => {
  const octants = new Set();

  const addDirection = (point) => {
    const angle = Math.atan2(point.y - center.y, point.x - center.x);
    const octant = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
    octants.add(octant);
  };

  segments.forEach((segment) => {
    const midpoint = getSegmentMidpoint(segment);
    const nearStart = distance2d(segment.start, center) <= tolerance;
    const nearEnd = distance2d(segment.end, center) <= tolerance;
    const nearMid = distance2d(midpoint, center) <= tolerance;

    if (nearStart) addDirection(segment.end);
    if (nearEnd) addDirection(segment.start);
    if (nearMid) {
      addDirection(segment.start);
      addDirection(segment.end);
    }
  });

  const oppositePairs = new Set();
  octants.forEach((octant) => {
    const opposite = (octant + 4) % 8;
    if (octants.has(opposite)) {
      oppositePairs.add(`${Math.min(octant, opposite)}-${Math.max(octant, opposite)}`);
    }
  });

  return { octants, oppositePairs };
};

const inferPointCentersFromSegments = (segments, drawingDiagonal = 0) => {
  if (!segments.length) return [];

  const lengths = segments.map(getSegmentLength).filter((len) => Number.isFinite(len) && len > 0);
  if (!lengths.length) return [];

  const q25 = getLengthQuantile(lengths, 0.25);
  const q50 = getLengthQuantile(lengths, 0.5);
  const floorFromDrawing = drawingDiagonal > 0 ? drawingDiagonal * 0.0002 : 0.0001;
  const ceilingFromDrawing = drawingDiagonal > 0 ? drawingDiagonal * 0.03 : Math.max(q50 * 1.5, q25 * 2.5, 1);
  const smallLengthThreshold = Math.max(floorFromDrawing, Math.min(Math.max(q25 * 2.5, q50 * 0.35, floorFromDrawing), ceilingFromDrawing));
  const candidateSegments = segments.filter((segment) => getSegmentLength(segment) <= smallLengthThreshold);
  if (!candidateSegments.length) return [];

  const tolerance = Math.max(smallLengthThreshold * 0.2, drawingDiagonal * 0.0001, 0.0001);
  const endpointClusters = clusterCandidates(
    candidateSegments.flatMap((segment) => ([
      { point: segment.start, segmentId: segment.id, anchorType: 'endpoint' },
      { point: segment.end, segmentId: segment.id, anchorType: 'endpoint' },
    ])),
    tolerance
  );
  const midpointClusters = clusterCandidates(
    candidateSegments.map((segment) => ({ point: getSegmentMidpoint(segment), segmentId: segment.id, anchorType: 'midpoint' })),
    tolerance
  );

  const centers = [];

  endpointClusters.forEach((cluster) => {
    const supportedSegments = candidateSegments.filter((segment) => (
      distance2d(segment.start, cluster.center) <= tolerance || distance2d(segment.end, cluster.center) <= tolerance
    ));
    if (supportedSegments.length < 3) return;

    const orientationBuckets = new Set(supportedSegments.map(getSegmentOrientationBucket));
    const { octants } = getClusterDirectionStats(cluster.center, supportedSegments, tolerance);
    if (orientationBuckets.size < 2 && octants.size < 3) return;

    centers.push({
      x: cluster.center.x,
      y: cluster.center.y,
      z: supportedSegments[0]?.start?.z ?? 0,
      segmentIds: supportedSegments.map((segment) => segment.id),
      inferred: true,
    });
  });

  midpointClusters.forEach((cluster) => {
    const supportedSegments = candidateSegments.filter((segment) => distance2d(getSegmentMidpoint(segment), cluster.center) <= tolerance);
    if (supportedSegments.length < 2) return;

    const { octants, oppositePairs } = getClusterDirectionStats(cluster.center, supportedSegments, tolerance);
    if (oppositePairs.size < 2 && octants.size < 4) return;

    centers.push({
      x: cluster.center.x,
      y: cluster.center.y,
      z: supportedSegments[0]?.start?.z ?? 0,
      segmentIds: supportedSegments.map((segment) => segment.id),
      inferred: true,
    });
  });

  return centers.filter((center, index, arr) => arr.findIndex((other) => distance2d(other, center) <= tolerance) === index);
};

const isBlockPointLike = (block, drawingDiagonal = 0) => {
  const entities = Array.isArray(block?.entities) ? block.entities : [];
  // Raised from 12 to 50: many survey point symbols (AutoCAD standard and
  // national variants) use detailed geometry — cross+circle, triangle, etc. —
  // that exceeds the old limit and was silently rejected.
  if (!entities.length || entities.length > 50) return false;
  if (entities.some((entity) => entity?.type === 'POINT')) return true;

  const segments = getEntitySegments(entities, `block:${block?.name || 'unnamed'}`);
  if (!segments.length) return false;

  const points = segments.flatMap((segment) => [segment.start, segment.end]);
  const bbox = getBoundingBoxFromPoints(points);
  if (!bbox) return false;

  if (drawingDiagonal > 0 && bbox.diagonal > drawingDiagonal * 0.03) return false;

  return inferPointCentersFromSegments(segments, Math.max(bbox.diagonal, drawingDiagonal * 0.01)).length > 0;
};

const collectFallbackVertices = (segments, addRow) => {
  segments.forEach((segment, index) => {
    addRow(segment.start.x, segment.start.y, segment.start.z, `${segment.layer || segment.type}-start-${index + 1}`);
    addRow(segment.end.x, segment.end.y, segment.end.z, `${segment.layer || segment.type}-end-${index + 1}`);
  });
};

const countEntityTypes = (dxfData) => {
  const counts = {};
  const addEntities = (entities) => {
    if (!Array.isArray(entities)) return;
    entities.forEach((ent) => {
      const type = String(ent?.type || 'UNKNOWN').toUpperCase();
      counts[type] = (counts[type] || 0) + 1;
    });
  };

  addEntities(dxfData?.entities);
  Object.values(dxfData?.blocks || {}).forEach((block) => addEntities(block?.entities));
  return counts;
};

export const collectPointRowsFromDxf = (dxfData, options = {}) => {
  const rows = [];
  let idx = 1;
  const pointsOnly = options.pointsOnly || false;
  const strictExistingPointsOnly = options.strictExistingPointsOnly === true;
  let detectedFromCrs = detectCrsFromDxf(dxfData);
  const seenCoords = new Map();
  // Reuse pre-computed expanded entities if provided to avoid double processing
  const expandedCad = options.expandedCad || expandCadEntities(dxfData, options);
  const expandedEntities = expandedCad.entities;
  const segments = getEntitySegments(expandedEntities);
  const drawingPoints = [
    ...segments.flatMap((segment) => [segment.start, segment.end]),
    ...expandedEntities
      .map((ent) => ent?.position || ent?.startPoint || ent?.insertionPoint)
      .filter((pos) => Number.isFinite(Number(pos?.x)) && Number.isFinite(Number(pos?.y)))
      .map((pos) => ({ x: Number(pos.x), y: Number(pos.y) })),
  ];
  const drawingBounds = getBoundingBoxFromPoints(drawingPoints);
  const drawingDiagonal = drawingBounds?.diagonal || 0;
  const textLabels = collectTextLabels(expandedEntities);
  const repairs = {
    textSanitized: 0,
    textAnchorFallbacks: 0,
    defaultTextStyle: 0,
    defaultTextHeight: 0,
    normalizedLayerName: 0,
  };
  const diagnostics = {
    entityTypeCounts: countEntityTypes(dxfData),
    extraction: {
      explicitPointEntities: 0,
      insertPointSymbols: 0,
      inferredSymbolCenters: 0,
      fallbackVertices: 0,
      dedupMerged: 0,
      textLabelAssigned: 0,
      textElevationAssigned: 0,
    },
    references: expandedCad.diagnostics.references,
    resolution: expandedCad.diagnostics.resolution,
    repairs,
  };

  const addRow = (x, y, z, idHint, hasExplicitName = false, source = 'unknown', layer = null, blockAttributes = null) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const coordKey = `${x.toFixed(3)},${y.toFixed(3)}`;
    const normalizedHint = normalizeCadLabelCandidate(idHint);
    const explicitName = hasExplicitName && isCadPointNameProvided(normalizedHint) ? normalizedHint : null;

    if (seenCoords.has(coordKey)) {
      const existing = seenCoords.get(coordKey);
      diagnostics.extraction.dedupMerged += 1;
      if (existing.z === 0 && Number.isFinite(z) && z !== 0) {
        existing.z = z;
      }
      if (!existing.hasExplicitName && explicitName) {
        existing.id = explicitName;
        existing.hasExplicitName = true;
      }
      if (blockAttributes && !existing.blockAttributes) {
        existing.blockAttributes = blockAttributes;
      }
      return;
    }

    const id = explicitName || String(idx);
    const row = {
      id,
      x,
      y,
      z: Number.isFinite(z) ? z : null,
      layer,
      detectedFromCrs,
      hasExplicitName: Boolean(explicitName),
      blockAttributes: blockAttributes || null,
    };
    rows.push(row);
    seenCoords.set(coordKey, row);
    idx += 1;

    if (source === 'point-entity') diagnostics.extraction.explicitPointEntities += 1;
    if (source === 'insert-symbol') diagnostics.extraction.insertPointSymbols += 1;
    if (source === 'inferred-center') diagnostics.extraction.inferredSymbolCenters += 1;
    if (source === 'fallback-vertex') diagnostics.extraction.fallbackVertices += 1;
  };

  const visitEntities = (entities) => {
    if (!entities || !Array.isArray(entities)) return;
    entities.forEach((ent) => {
      const layer = ent?.layer || ent?.type;
      switch (ent?.type) {
        case 'POINT': {
          const z = ent.position?.z ?? ent.z ?? ent.position?.[2] ?? ent.vertices?.[0]?.z;
          addRow(ent.position?.x, ent.position?.y, z, null, false, 'point-entity', layer || null);
          break;
        }
        case 'INSERT': {
          const nameLooksPointLike = /(?:^|[_\-\s])(pt|point|station|survey|node|borne|bench|cross)(?:$|[_\-\s])/i.test(String(ent.name || layer || ''));
          // Any INSERT that carries ATTRIB children is almost certainly an annotated survey
          // station block (AutoCAD survey practice: point blocks carry name/elevation ATTRIBs).
          // Accept these regardless of block name, so French survey files (blocks like
          // NPI, TER, BM, A15, CIBLE, GP3D, etc.) are not silently discarded.
          const hasAttribs = Array.isArray(ent.attribs) && ent.attribs.length > 0;
          if ((nameLooksPointLike || ent.__blockPointLike || hasAttribs) && ent.__blockResolved) {
            const fallbackElevation = extractInsertPointElevation(ent);
            const iz = ent.position?.z ?? ent.z ?? ent.position?.[2] ?? fallbackElevation;
            const pointName = ent.__pointName || extractInsertPointName(ent);
            // Collect all ATTRIB TAG=VALUE pairs as structured metadata
            const attribMap = {};
            (Array.isArray(ent.attribs) ? ent.attribs : []).forEach((attr) => {
              const tag = String(attr?.tag || '').trim().toUpperCase();
              const val = String(attr?.text ?? attr?.value ?? '').trim();
              if (tag && val) attribMap[tag] = val;
            });
            const blockAttributes = Object.keys(attribMap).length > 0 ? { blockName: ent.name || null, attributes: attribMap } : null;
            addRow(ent.position?.x, ent.position?.y, iz, pointName, Boolean(pointName), 'insert-symbol', layer || null, blockAttributes);
          }
          break;
        }
        default:
          break;
      }
    });
  };

  visitEntities(expandedEntities);

  if (!strictExistingPointsOnly) {
    const inferredCenters = inferPointCentersFromSegments(segments, drawingDiagonal);
    inferredCenters.forEach((center) => {
      addRow(center.x, center.y, center.z, null, false, 'inferred-center', null);
    });
  }

  // When no recognized point entities were found at all, fall back to line/polyline
  // endpoints so the drawing is at least visualized. This handles survey files where
  // point markers are non-standard INSERT blocks or the file contains only traverse
  // lines with no explicit POINT entities.
  // pointsOnly=true is the only case where we should NOT add inferred vertices.
  if (!rows.length && !pointsOnly) {
    collectFallbackVertices(segments, (x, y, z, idHint) => addRow(x, y, z, idHint, false, 'fallback-vertex', null));
  }

  diagnostics.extraction.textLabelAssigned = assignNearbyTextNames(rows, textLabels, drawingDiagonal);
  diagnostics.extraction.textElevationAssigned = assignNearbyTextElevations(rows, textLabels, drawingDiagonal);

  const coordinates = rows.map((row) => ({ x: row.x, y: row.y, z: row.z }));
  const bounds = getBoundingBoxFromPoints(coordinates);
  const metadata = { projection: detectedFromCrs || null };
  const crsSuggestions = detectCRS(coordinates, metadata);
  const referenceAssessment = assessReferenceSystem(coordinates, metadata, crsSuggestions);

  const isProjectedLike = (bbox) => {
    if (!bbox) return false;
    const xProjected = Math.abs(bbox.minX) > 180 || Math.abs(bbox.maxX) > 180;
    const yProjected = Math.abs(bbox.minY) > 90 || Math.abs(bbox.maxY) > 90;
    return xProjected || yProjected;
  };

  const isFrenchCcCode = (code) => /^EPSG:39(4[2-9]|50)$/.test(String(code || ''));

  const pickAutoDetectedCrs = (suggestions) => {
    if (!Array.isArray(suggestions) || suggestions.length === 0) return null;
    const top = suggestions[0];
    const second = suggestions[1] || null;
    const topConfidence = Number(top?.confidence || 0);
    const confidenceGap = topConfidence - Number(second?.confidence || 0);

    if (topConfidence < 0.8) return null;

    if (isFrenchCcCode(top?.code)) {
      const strongNonCcAlternative = suggestions.some((candidate) => (
        candidate?.code
        && !isFrenchCcCode(candidate.code)
        && Number(candidate.confidence || 0) >= (topConfidence - 0.06)
      ));
      if (strongNonCcAlternative) return null;
    }

    if (topConfidence >= 0.88) return top.code;
    if (topConfidence >= 0.84 && confidenceGap >= 0.08) return top.code;
    return null;
  };

  if (!detectedFromCrs) {
    detectedFromCrs = pickAutoDetectedCrs(crsSuggestions);
  }

  // Preserve any explicit or confidently detected CRS. Only fall back to LOCAL
  // when we still do not have a referenced CRS candidate.
  if (referenceAssessment.isLocal && !detectedFromCrs) {
    detectedFromCrs = 'LOCAL:ENGINEERING';
  }

  if (!detectedFromCrs) {
    detectedFromCrs = isProjectedLike(bounds) ? 'LOCAL:ENGINEERING' : 'EPSG:4326';
  }

  rows.forEach((row) => {
    row.detectedFromCrs = detectedFromCrs;
    row.crsSuggestions = crsSuggestions;
    row.crsAssessment = referenceAssessment;
  });

  diagnostics.referenceAssessment = referenceAssessment;
  diagnostics.detectedFromCrs = detectedFromCrs;

  return { rows, diagnostics };
};

export const collectCadGeometryFromDxf = (dxfData, expandedCad = null) => {
  const DIMENSION_TYPE_LABELS = ['Linear', 'Aligned', 'Angular (3pt)', 'Diameter', 'Radius', 'Angular (2L)', 'Ordinate'];

  // Hard limits — stop collecting each type once reached to avoid huge payloads.
  // Entities are sampled by stride so coverage spans the full dataset rather than
  // only the first N items in DXF order.
  const MAX_LINES = 30_000;
  const MAX_POLYLINES = 15_000;
  const MAX_SURFACES = 40_000;
  const MAX_TEXTS = 8_000;
  const MAX_DIMENSIONS = 5_000;

  const geometry = {
    lines: [],
    polylines: [],
    texts: [],
    dimensions: [],
    hatches: [],
    surfaces: [],
  };
  // Reuse pre-computed expanded entities to avoid double processing on large files
  const expandedEntities = expandedCad?.entities || expandCadEntities(dxfData).entities;
  const layerTable = dxfData?.tables?.layer?.layers || {};
  const styleTable = getStyleTable(dxfData);
  const repairStats = {
    textSanitized: 0,
    textAnchorFallbacks: 0,
    defaultTextStyle: 0,
    defaultTextHeight: 0,
    normalizedLayerName: 0,
  };

  const addLine = (start, end, layer, sourceType, entityColor) => {
    if (geometry.lines.length >= MAX_LINES) return;
    if (!start || !end) return;
    const x1 = Number(start.x);
    const y1 = Number(start.y);
    const z1 = Number(start.z ?? 0);
    const x2 = Number(end.x);
    const y2 = Number(end.y);
    const z2 = Number(end.z ?? 0);
    if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) return;
    const descriptor = getLayerDescriptor(layer || 'LINE', layerTable[layer || 'LINE']);
    if (descriptor.renamed) repairStats.normalizedLayerName += 1;
    // Resolve colour: entity-level overrides layer-level (CAD "colour by entity" > "colour by layer")
    const layerColorHex = cadColorToHex(descriptor.color);
    const colorHex = cadColorToHex(entityColor, layerColorHex);
    geometry.lines.push({
      layer: descriptor.displayName,
      layerOriginal: descriptor.originalName,
      layerNormalized: descriptor.normalizedName,
      layerStandardized: descriptor.standardizedName,
      layerCategory: descriptor.category,
      sourceType: sourceType || 'LINE',
      colorHex,
      start: [x1, y1, Number.isFinite(z1) ? z1 : 0],
      end: [x2, y2, Number.isFinite(z2) ? z2 : 0],
    });
  };

  const addPolyline = (vertices, layer, sourceType, entityColor) => {
    if (geometry.polylines.length >= MAX_POLYLINES) return;
    if (!Array.isArray(vertices) || vertices.length < 2) return;
    const coords = vertices
      .map((v) => {
        const x = Number(v?.x);
        const y = Number(v?.y);
        const z = Number(v?.z ?? 0);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return [x, y, Number.isFinite(z) ? z : 0];
      })
      .filter(Boolean);

    if (coords.length < 2) return;

    // Decimate dense polylines to avoid huge payloads (keep first+last vertex always)
    const MAX_POLY_VERTICES = 500;
    if (coords.length > MAX_POLY_VERTICES) {
      const step = Math.ceil(coords.length / MAX_POLY_VERTICES);
      const decimated = [coords[0]];
      for (let i = step; i < coords.length - 1; i += step) decimated.push(coords[i]);
      decimated.push(coords[coords.length - 1]);
      coords.length = 0;
      decimated.forEach((c) => coords.push(c));
    }

    const descriptor = getLayerDescriptor(layer || sourceType || 'POLYLINE', layerTable[layer || sourceType || 'POLYLINE']);
    if (descriptor.renamed) repairStats.normalizedLayerName += 1;
    const layerColorHex = cadColorToHex(descriptor.color);
    const colorHex = cadColorToHex(entityColor, layerColorHex);
    geometry.polylines.push({
      layer: descriptor.displayName,
      layerOriginal: descriptor.originalName,
      layerNormalized: descriptor.normalizedName,
      layerStandardized: descriptor.standardizedName,
      layerCategory: descriptor.category,
      sourceType: sourceType || 'POLYLINE',
      colorHex,
      points: coords,
    });
  };

  const addText = (entity) => {
    if (geometry.texts.length >= MAX_TEXTS) return;
    const type = String(entity?.type || '').toUpperCase();
    if (!['TEXT', 'MTEXT', 'ATTRIB'].includes(type)) return;

    const position = getCadTextPosition(entity, repairStats);
    if (!position) return;

    const descriptor = getLayerDescriptor(entity?.layer || 'TEXT', layerTable[entity?.layer || 'TEXT']);
    if (descriptor.renamed) repairStats.normalizedLayerName += 1;
    const style = getCadTextStyle(entity, styleTable, repairStats);
    const content = normalizeCadTextContent(entity?.text ?? entity?.value ?? entity?.tag ?? '', repairStats);
    if (!content) return;

    let textHeight = Number(entity?.textHeight ?? entity?.height ?? entity?.nominalTextHeight ?? 0);
    if (!Number.isFinite(textHeight) || textHeight <= 0) {
      textHeight = DEFAULT_TEXT_HEIGHT;
      repairStats.defaultTextHeight += 1;
    }

    geometry.texts.push({
      layer: descriptor.displayName,
      layerOriginal: descriptor.originalName,
      layerNormalized: descriptor.normalizedName,
      layerStandardized: descriptor.standardizedName,
      layerCategory: descriptor.category,
      sourceType: type,
      position: [position.x, position.y, position.z],
      text: content,
      rawText: String(entity?.text ?? entity?.value ?? entity?.tag ?? ''),
      textHeight,
      rotation: Number.isFinite(Number(entity?.rotation ?? entity?.angle)) ? Number(entity?.rotation ?? entity?.angle) : 0,
      styleName: style.styleName,
      fontFamily: style.fontFamily || FALLBACK_TEXT_FONT,
      fontFile: style.fontFile || null,
      widthFactor: style.widthFactor,
      obliqueAngle: style.obliqueAngle,
      colorHex: cadColorToHex(entity?.color, cadColorToHex(descriptor.color)),
    });
  };

  const addDimension = (entity) => {
    if (geometry.dimensions.length >= MAX_DIMENSIONS) return;
    const layer = entity?.layer || 'DIM';
    const descriptor = getLayerDescriptor(layer, layerTable[layer]);
    const typeCode = Number(entity?.dimensionType ?? 0) & 0x0F;
    const typeLabel = DIMENSION_TYPE_LABELS[typeCode] || `Type ${typeCode}`;
    const rawText = entity?.text ?? entity?.dimensionText ?? '';
    const measurement = Number.isFinite(Number(entity?.actualMeasurement)) ? Number(entity.actualMeasurement) : null;
    const displayText = rawText || (measurement !== null ? String(measurement.toFixed(3)) : '');
    const midPoint = entity?.midPoint || entity?.textMidpoint || entity?.insertionPoint;
    const defPoint = entity?.definitionPoint;
    const p1x = Number(entity?.x1 ?? entity?.xLinePoint1?.x ?? NaN);
    const p1y = Number(entity?.y1 ?? entity?.xLinePoint1?.y ?? NaN);
    const p2x = Number(entity?.x2 ?? entity?.xLinePoint2?.x ?? NaN);
    const p2y = Number(entity?.y2 ?? entity?.xLinePoint2?.y ?? NaN);

    const dimRecord = {
      layer: descriptor.displayName,
      layerOriginal: descriptor.originalName,
      layerNormalized: descriptor.normalizedName,
      layerStandardized: descriptor.standardizedName,
      sourceType: 'DIMENSION',
      typeCode,
      typeLabel,
      text: displayText,
      measurement,
      defPoint: defPoint ? [Number(defPoint.x), Number(defPoint.y), Number(defPoint.z ?? 0)] : null,
      midPoint: midPoint ? [Number(midPoint.x), Number(midPoint.y), Number(midPoint.z ?? 0)] : null,
      p1: Number.isFinite(p1x) && Number.isFinite(p1y) ? [p1x, p1y] : null,
      p2: Number.isFinite(p2x) && Number.isFinite(p2y) ? [p2x, p2y] : null,
    };
    geometry.dimensions.push(dimRecord);

    // Add dimension text as a map annotation
    if (displayText && midPoint) {
      const mx = Number(midPoint.x);
      const my = Number(midPoint.y);
      const mz = Number(midPoint.z ?? 0);
      if (Number.isFinite(mx) && Number.isFinite(my)) {
        geometry.texts.push({
          layer: descriptor.displayName,
          layerOriginal: descriptor.originalName,
          layerNormalized: descriptor.normalizedName,
          layerStandardized: descriptor.standardizedName,
          layerCategory: descriptor.category,
          sourceType: 'DIMENSION',
          position: [mx, my, Number.isFinite(mz) ? mz : 0],
          text: displayText,
          rawText,
          textHeight: DEFAULT_TEXT_HEIGHT,
          rotation: Number.isFinite(Number(entity?.angle)) ? Number(entity.angle) : 0,
          styleName: 'STANDARD',
          fontFamily: FALLBACK_TEXT_FONT,
          fontFile: null,
          widthFactor: 1,
          obliqueAngle: 0,
          colorHex: cadColorToHex(entity?.color, descriptor.colorHex || '#94a3b8'),
        });
      }
    }

    // Add extension lines as geometry lines
    if (defPoint && Number.isFinite(p1x) && Number.isFinite(p1y)) {
      addLine({ x: p1x, y: p1y, z: 0 }, { x: Number(defPoint.x), y: Number(defPoint.y), z: Number(defPoint.z ?? 0) }, layer, 'DIMENSION', entity?.color);
    }
    if (defPoint && Number.isFinite(p2x) && Number.isFinite(p2y)) {
      addLine({ x: p2x, y: p2y, z: 0 }, { x: Number(defPoint.x), y: Number(defPoint.y), z: Number(defPoint.z ?? 0) }, layer, 'DIMENSION', entity?.color);
    }
  };

  // Shoelace formula for polygon area from a flat [x,y] vertices array
  const shoelaceArea = (vertices) => {
    let area = 0;
    const n = vertices.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area += vertices[i][0] * vertices[j][1];
      area -= vertices[j][0] * vertices[i][1];
    }
    return Math.abs(area) / 2;
  };

  const addHatch = (entity) => {
    const layer = entity?.layer || 'HATCH';
    const descriptor = getLayerDescriptor(layer, layerTable[layer]);
    const patternName = String(entity?.pattern || entity?.patternName || '').trim() || 'HATCH';
    const isSolid = Boolean(entity?.solidFill || patternName === 'SOLID');

    // Extract boundary paths - dxf-parser provides boundaryPaths array
    const boundaryPaths = Array.isArray(entity?.boundaryPaths) ? entity.boundaryPaths : [];
    const hatchPolygons = [];

    boundaryPaths.forEach((path) => {
      // Polyline-type boundary
      if (Array.isArray(path?.vertices) && path.vertices.length >= 3) {
        const verts = path.vertices
          .map((v) => {
            const x = Number(v?.x ?? v?.[0] ?? NaN);
            const y = Number(v?.y ?? v?.[1] ?? NaN);
            return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
          })
          .filter(Boolean);
        if (verts.length >= 3) {
          hatchPolygons.push(verts);
          // Also add as a polyline for map display
          addPolyline(
            [...verts.map(([x, y]) => ({ x, y, z: 0 })), { x: verts[0][0], y: verts[0][1], z: 0 }],
            layer, 'HATCH', entity?.color
          );
        }
      }
      // Edge-type boundary — collect LINE edges
      if (Array.isArray(path?.edges)) {
        const verts = [];
        path.edges.forEach((edge) => {
          const edgeType = String(edge?.type || '').toUpperCase();
          if (edgeType === 'LINE' && edge?.start) {
            const x = Number(edge.start?.x ?? NaN);
            const y = Number(edge.start?.y ?? NaN);
            if (Number.isFinite(x) && Number.isFinite(y)) verts.push([x, y]);
          }
        });
        if (verts.length >= 3) hatchPolygons.push(verts);
      }
    });

    if (hatchPolygons.length === 0) return;

    // Compute total area (outer boundary only — first polygon)
    const outerVerts = hatchPolygons[0];
    const area = shoelaceArea(outerVerts);
    const centroid = outerVerts.length > 0
      ? [
        outerVerts.reduce((s, v) => s + v[0], 0) / outerVerts.length,
        outerVerts.reduce((s, v) => s + v[1], 0) / outerVerts.length,
      ]
      : null;

    geometry.hatches.push({
      layer: descriptor.displayName,
      layerOriginal: descriptor.originalName,
      layerNormalized: descriptor.normalizedName,
      layerStandardized: descriptor.standardizedName,
      sourceType: 'HATCH',
      patternName,
      isSolid,
      area,
      centroid,
      boundaryCount: hatchPolygons.length,
      colorHex: cadColorToHex(entity?.color, descriptor.colorHex || '#94a3b8'),
    });
  };

  const addSurface = (entity) => {
    if (geometry.surfaces.length >= MAX_SURFACES) return;
    const type = String(entity?.type || '').toUpperCase();
    let surface = null;
    if (type === '3DFACE' || type === 'FACE3D') {
      surface = extract3dFaceSurface(entity, layerTable);
    } else if (type === 'MESH') {
      surface = extractMeshSurface(entity, layerTable);
    } else if (type === 'POLYLINE') {
      surface = extractPolyfaceSurface(entity, layerTable);
    } else if (type === 'PLANESURFACE') {
      surface = extractPlaneSurface(entity, layerTable);
    }
    if (!surface) return;
    if (surface.layerNormalized !== (entity?.layer || '').toUpperCase()) {
      repairStats.normalizedLayerName += 1;
    }
    geometry.surfaces.push(surface);
  };

  const visitEntities = (entities) => {
    if (!Array.isArray(entities)) return;
    entities.forEach((ent) => {
      const layer = ent?.layer || ent?.type;
      switch (ent?.type) {
        case 'LINE':
          addLine(ent.start || ent?.vertices?.[0], ent.end || ent?.vertices?.[1], layer, 'LINE', ent.color);
          break;
        case 'LWPOLYLINE':
        case 'POLYLINE':
          addPolyline(ent.vertices || [], layer, ent.type, ent.color);
          if (String(ent?.type || '').toUpperCase() === 'POLYLINE') {
            addSurface(ent);
          }
          break;
        case 'TEXT':
        case 'MTEXT':
        case 'ATTRIB':
          addText(ent);
          break;
        case 'DIMENSION':
          addDimension(ent);
          break;
        case 'HATCH':
          addHatch(ent);
          break;
        case '3DFACE':
        case 'FACE3D':
        case 'MESH':
          addSurface(ent);
          break;
        case 'PLANESURFACE':
          addSurface(ent);
          break;
        case '3DLINE':
          // 3DLINE is wireframe entity; render as polyline
          addPolyline(ent.vertices || [], layer, '3DLINE', ent.color);
          break;
        default:
          break;
      }
    });
  };

  visitEntities(expandedEntities);

  geometry.layerSummary = buildLayerSummary(dxfData, expandedEntities, geometry.texts);
  geometry.repairs = repairStats;

  return geometry;
};

/**
 * Pre-process a large DXF text string to reduce parse time by capping the number
 * of entity groups in the ENTITIES section.
 *
 * The DXF parser (dxf-parser) is strictly line-based and O(n) in line count.
 * Very large files (>20 MB DXF text) can take 20+ seconds in parseSync().
 * This function truncates the heavy ENTITIES section at a safe entity-group
 * boundary so parse time scales with the limited entity count instead.
 *
 * DXF format is strictly alternating pairs: (code-line, value-line).
 * We read pairs to stay aligned and never mis-interpret a value as a code.
 */
// Cap at 40k entity groups — matches MAX_SURFACES limit and keeps parse time reasonable.
// For the Projet Niglo 3D test file (93MB DXF, 186k total groups), this truncates
// the ENTITIES body from 76MB to ~16MB, cutting total file to ~33MB and parse time
// from 24s to ~8s.  Geometry post-parse limits ensure we never render more than
// the per-type caps anyway (40k surfaces, 30k lines, etc.).
const MAX_DXF_ENTITY_GROUPS = 40_000;
const DXF_SIZE_THRESHOLD_BYTES = 20 * 1024 * 1024; // only pre-process if DXF > 20 MB

/**
 * Locate the start of a named DXF section in raw text (offset of the leading newline
 * before "  0\r\nSECTION\r\n  2\r\nNAME").  Returns -1 if not found.
 */
function findDxfSectionBodyStart(text, sectionName) {
  const upper = sectionName.toUpperCase();
  // Match: newline + 0 + newline + SECTION + newline + 2 + newline + NAME + newline
  const re = new RegExp(
    '\\r?\\n[ \\t]*0[ \\t]*\\r?\\n[ \\t]*SECTION[ \\t]*\\r?\\n[ \\t]*2[ \\t]*\\r?\\n[ \\t]*' +
    upper +
    '[ \\t]*\\r?\\n',
    'i'
  );
  const m = re.exec(text);
  if (!m) return -1;
  return m.index + m[0].length; // offset right after the ENTITIES\r\n header
}

/**
 * Pre-process a large DXF text string to reduce parseSync() time.
 *
 * Strategy: locate the ENTITIES section body, count entity groups (group-code 0
 * pairs) one at a time. Once we hit MAX_DXF_ENTITY_GROUPS, find the next clean
 * entity boundary and inject "  0\r\nENDSEC\r\n  0\r\nEOF\r\n" there.
 * Everything before the ENTITIES section is copied verbatim (raw string slice —
 * no line splitting, no \r\n mangling).
 */
function limitDxfTextSize(dxfText) {
  if (typeof dxfText !== 'string' || dxfText.length < DXF_SIZE_THRESHOLD_BYTES) {
    return dxfText;
  }

  const bodyStart = findDxfSectionBodyStart(dxfText, 'ENTITIES');
  if (bodyStart === -1) return dxfText;

  // Determine the line-ending style so injected lines match the rest of the file.
  const crlf = dxfText.includes('\r\n');
  const nl = crlf ? '\r\n' : '\n';

  // Walk the ENTITIES body reading strict DXF pairs (code-line + value-line).
  // Advancing ONE line at a time is wrong — a value line whose content is "0"
  // (e.g. lineweight=0 for code 370, transparency=0 for code 440) would be
  // mis-counted as an entity-start group code.  We must advance TWO lines per
  // iteration to stay aligned with the alternating code/value structure.
  let pos = bodyStart;
  let entityGroups = 0;
  const textLen = dxfText.length;

  while (pos < textLen) {
    // --- Read the CODE line ---
    const codeLineEnd = dxfText.indexOf('\n', pos);
    if (codeLineEnd === -1) break;
    const codeLine = dxfText.slice(pos, codeLineEnd).trim();

    // --- Read the VALUE line ---
    const valStart = codeLineEnd + 1;
    const valLineEnd = dxfText.indexOf('\n', valStart);
    const valLine = valLineEnd === -1
      ? dxfText.slice(valStart).trim()
      : dxfText.slice(valStart, valLineEnd).trim();

    if (codeLine === '0') {
      const kw = valLine.toUpperCase().replace(/\r$/, '');
      if (kw === 'ENDSEC') break; // reached end of ENTITIES naturally
      if (kw === 'EOF') break;

      entityGroups++;
      if (entityGroups > MAX_DXF_ENTITY_GROUPS) {
        // pos is the start of the (MAX_DXF_ENTITY_GROUPS+1)-th entity's code line.
        // The previous entity is complete — inject ENDSEC + EOF right here.
        const prefix = dxfText.slice(0, pos);
        const suffix = `  0${nl}ENDSEC${nl}  0${nl}EOF${nl}`;
        return prefix + suffix;
      }
    }

    // Advance by TWO lines (code line + value line) to stay pair-aligned.
    pos = (valLineEnd === -1 ? textLen : valLineEnd + 1);
  }

  // Fell through without hitting the limit — return as-is
  return dxfText;
}

export function parseDxfTextContent(text, options = {}) {
  const parser = new DxfParser();
  let dxf;
  try {
    // parseSync blocks the main thread. For very large DXF strings yield first so
    // the browser can flush any pending renders / progress updates before we block.
    if (typeof text === 'string' && text.length > 2 * 1024 * 1024) {
      // Non-blocking delay (best-effort — parseSync itself is still synchronous).
      // At least allows the loading spinner to paint before we freeze.
      void new Promise((r) => setTimeout(r, 0));
    }
    // Pre-process very large DXF files: limit entity count so parseSync stays fast.
    const processedText = limitDxfTextSize(text);
    dxf = parser.parseSync(processedText);
  } catch (err) {
    throw new Error(`Failed to parse DXF: ${err.message || err}`);
  }

  // Compute expanded entities once to avoid double processing on large files
  // that can cause stack overflow with deeply nested blocks or many entities
  let expandedCad;
  try {
    expandedCad = expandCadEntities(dxf, options);
  } catch (err) {
    if (String(err?.message || err).includes('stack') || String(err?.message || err).includes('recursion')) {
      throw new Error(`DXF file too complex to parse: ${err.message || 'Block nesting or entity count too high. Try splitting the file.'}`);
    }
    throw err;
  }

  const pointResult = collectPointRowsFromDxf(dxf, { ...options, expandedCad });
  const rows = pointResult.rows;

  // In points-only mode skip heavy geometry extraction for faster large-file previews.
  const geometry = options.pointsOnly
    ? {
      lines: [],
      polylines: [],
      texts: [],
      dimensions: [],
      hatches: [],
      surfaces: [],
      layerSummary: null,
      repairs: {},
    }
    : collectCadGeometryFromDxf(dxf, expandedCad);

  const headerCrsHint = extractDxfHeaderCrsHint(dxf);
  const validation = buildCadValidationSummary({
    rows,
    geometry,
    diagnostics: pointResult.diagnostics,
    dxfData: dxf,
    headerCrsHint,
  });
  const diagnostics = {
    ...pointResult.diagnostics,
    repairs: {
      ...(pointResult.diagnostics?.repairs || {}),
      ...(geometry.repairs || {}),
    },
    layerSummary: geometry.layerSummary || null,
    headerCrsHint,
    validation,
  };

  geometry.validation = validation;
  geometry.notifications = validation.notifications;
  geometry.headerCrsHint = headerCrsHint;

  const hasRenderableCad = rows.length > 0
    || (!options.pointsOnly && (
      geometry.lines.length > 0
      || geometry.polylines.length > 0
      || geometry.texts.length > 0
      || geometry.surfaces.length > 0
      || (Array.isArray(geometry.dimensions) && geometry.dimensions.length > 0)
    ));

  if (!hasRenderableCad) {
    const hint = options.pointsOnly
      ? 'No POINT entities found in DXF. Try unchecking "Points only" to extract vertices from lines/polylines.'
      : 'No point-like entities found in DXF';
    throw new Error(hint);
  }

  if (options.returnPayload) {
    return { rows, geometry, diagnostics: diagnostics || null };
  }

  return rows;
}