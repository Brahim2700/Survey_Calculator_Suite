import path from 'node:path';

const PRESCAN_TEXT_SAMPLE_BYTES = Number(process.env.CAD_PRESCAN_SAMPLE_MB || 6) * 1024 * 1024;

const SIGNAL_WEIGHTS = {
  proxyEntityDetected: 25,
  advanced3dDetected: 20,
  highEntityCount: 15,
  modernVersionRisk: 10,
  coordinateAnomaly: 10,
  highInsertDensity: 10,
  malformedStructure: 10,
  hatchEntitiesDetected: 6,
  hatchPatternDetected: 6,
  hatchEdgePathDetected: 10,
  hatchNestedIslandDetected: 8,
  hatchAssociativeDetected: 5,
  hatchUnsupportedEdgeRisk: 12,
  hatchBoundaryMissingRisk: 12,
};

function toAsciiSnippet(buffer) {
  try {
    return Buffer.from(buffer).toString('latin1');
  } catch {
    return '';
  }
}

function getExtension(fileName = '') {
  return path.extname(fileName).toLowerCase();
}

function detectBinarySignature(buffer) {
  if (!buffer || buffer.length < 4) return 'unknown';
  const head = Buffer.from(buffer.subarray(0, Math.min(buffer.length, 8))).toString('ascii');
  if (/^AC10\d\d/i.test(head)) return 'dwg';
  return 'unknown';
}

function safeCountRegex(text, regex) {
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function parseDxfVersion(text) {
  const versionMatch = text.match(/\$ACADVER[\s\S]{0,80}?\b(AC10\d\d|AC1\d\d\d)\b/i);
  return versionMatch ? versionMatch[1].toUpperCase() : null;
}

function parseDwgVersionFromHeader(buffer) {
  if (!buffer || buffer.length < 6) return null;
  const head = Buffer.from(buffer.subarray(0, 6)).toString('ascii').toUpperCase();
  return /^AC10\d\d$/.test(head) ? head : null;
}

function sampleCoordinates(text, limit = 5000) {
  const nums = [];
  const re = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let m;
  while ((m = re.exec(text)) !== null && nums.length < limit) {
    const value = Number(m[0]);
    if (Number.isFinite(value)) nums.push(value);
  }
  return nums;
}

function isModernVersionRisk(versionCode) {
  if (!versionCode) return false;
  // AC1024+ roughly maps to modern AutoCAD generations where proxy-heavy files are common.
  const numeric = Number(versionCode.replace(/^AC/i, ''));
  return Number.isFinite(numeric) && numeric >= 1024;
}

function buildRecommendedMode(score) {
  if (score >= 50) return 'recovery';
  if (score >= 25) return 'preview';
  return 'full';
}

function buildConfidence(score, signalCount, formatHint) {
  if (formatHint === 'dwg' && score < 25) {
    return {
      level: 'low',
      reason: 'DWG pre-scan found limited visible risk markers; proxy/custom entities may still appear later.',
    };
  }
  if (score >= 50 || signalCount >= 4) {
    return {
      level: 'high',
      reason: 'Multiple high-risk CAD signals detected during server pre-scan.',
    };
  }
  if (score >= 25 || signalCount >= 2) {
    return {
      level: 'medium',
      reason: 'Moderate CAD complexity indicators detected during server pre-scan.',
    };
  }
  return {
    level: 'medium',
    reason: 'Low-risk pre-scan result with no major CAD complexity signals.',
  };
}

function collectPrescanSignals({ text, fileSizeBytes, versionCode }) {
  const normalized = String(text || '').toUpperCase();
  const signals = [];

  const proxyCount = safeCountRegex(normalized, /PROXY_ENTITY|ACDBPROXYENTITY|ACAD_PROXY|PROXYOBJECT/g);
  if (proxyCount > 0) {
    signals.push({
      code: 'proxy-entity-detected',
      weight: SIGNAL_WEIGHTS.proxyEntityDetected,
      detail: `Detected ${proxyCount} proxy-related marker(s).`,
    });
  }

  const advanced3dCount = safeCountRegex(normalized, /3DSOLID|SURFACE|ACIS|BODY|REGION|SUBD|MESH|POLYFACE/g);
  if (advanced3dCount > 0) {
    signals.push({
      code: 'advanced-3d-marker',
      weight: SIGNAL_WEIGHTS.advanced3dDetected,
      detail: `Detected ${advanced3dCount} advanced 3D/surface marker(s).`,
    });
  }

  const insertCount = safeCountRegex(normalized, /\bINSERT\b/g);
  if (insertCount >= 800) {
    signals.push({
      code: 'high-insert-density',
      weight: SIGNAL_WEIGHTS.highInsertDensity,
      detail: `Detected dense INSERT usage (${insertCount}).`,
    });
  }

  const approximateEntityCount = safeCountRegex(normalized, /\bLINE\b|\bLWPOLYLINE\b|\bPOLYLINE\b|\bPOINT\b|\bCIRCLE\b|\bARC\b|\bINSERT\b/g);
  if (approximateEntityCount >= 5000 || fileSizeBytes >= 60 * 1024 * 1024) {
    signals.push({
      code: 'high-entity-count',
      weight: SIGNAL_WEIGHTS.highEntityCount,
      detail: `Approximate entity marker count ${approximateEntityCount}; file size ${(fileSizeBytes / (1024 * 1024)).toFixed(1)} MB.`,
    });
  }

  if (isModernVersionRisk(versionCode)) {
    signals.push({
      code: 'modern-version-risk',
      weight: SIGNAL_WEIGHTS.modernVersionRisk,
      detail: `Detected version ${versionCode}, often associated with advanced/proxy content.`,
    });
  }

  const coords = sampleCoordinates(normalized);
  const hasCoordinateAnomaly = coords.some((value) => Math.abs(value) > 1e9);
  if (hasCoordinateAnomaly) {
    signals.push({
      code: 'coordinate-anomaly',
      weight: SIGNAL_WEIGHTS.coordinateAnomaly,
      detail: 'Detected extreme coordinate magnitude (>|1e9|) in sampled values.',
    });
  }

  const eofCount = safeCountRegex(normalized, /\bEOF\b/g);
  if (eofCount === 0 && normalized.includes('SECTION')) {
    signals.push({
      code: 'malformed-structure',
      weight: SIGNAL_WEIGHTS.malformedStructure,
      detail: 'Section markers detected but EOF marker missing in sampled text.',
    });
  }

  const hatchEntityCount = safeCountRegex(normalized, /\bHATCH\b/g);
  if (hatchEntityCount > 0) {
    signals.push({
      code: 'has-hatch-entities',
      weight: SIGNAL_WEIGHTS.hatchEntitiesDetected,
      detail: `Detected ${hatchEntityCount} hatch marker(s).`,
    });
  }

  const hatchPatternCount = safeCountRegex(normalized, /\bANSI31\b|\bANSI32\b|\bANSI33\b|\bCROSS\b|\bAR-\w+\b/g);
  if (hatchPatternCount > 0) {
    signals.push({
      code: 'has-pattern-hatches',
      weight: SIGNAL_WEIGHTS.hatchPatternDetected,
      detail: `Detected ${hatchPatternCount} pattern hatch marker(s).`,
    });
  }

  const hatchEdgePathCount = safeCountRegex(normalized, /\bEDGEPATH\b|\bSPLINEEDGE\b|\bELLIPSEEDGE\b|\bARCEDGE\b/g);
  if (hatchEdgePathCount > 0) {
    signals.push({
      code: 'has-edge-path-hatches',
      weight: SIGNAL_WEIGHTS.hatchEdgePathDetected,
      detail: `Detected ${hatchEdgePathCount} edge-path hatch marker(s).`,
    });
  }

  const nestedIslandCount = safeCountRegex(normalized, /\bISLAND\b|\bOUTERMOST\b|\bEXTERNAL\b/g);
  if (nestedIslandCount > 0) {
    signals.push({
      code: 'has-nested-hatch-islands',
      weight: SIGNAL_WEIGHTS.hatchNestedIslandDetected,
      detail: `Detected ${nestedIslandCount} hatch island marker(s).`,
    });
  }

  const associativeCount = safeCountRegex(normalized, /\bASSOCIATIVE\b|\bASSOC\b/g);
  if (associativeCount > 0 && hatchEntityCount > 0) {
    signals.push({
      code: 'has-associative-hatches',
      weight: SIGNAL_WEIGHTS.hatchAssociativeDetected,
      detail: `Detected ${associativeCount} associative hatch marker(s).`,
    });
  }

  const unsupportedEdgeRiskCount = safeCountRegex(normalized, /\bSPLINEEDGE\b|\bELLIPSEEDGE\b/g);
  if (unsupportedEdgeRiskCount > 0) {
    signals.push({
      code: 'has-unsupported-hatch-edges',
      weight: SIGNAL_WEIGHTS.hatchUnsupportedEdgeRisk,
      detail: `Detected ${unsupportedEdgeRiskCount} hatch edge marker(s) likely requiring approximation.`,
    });
  }

  const boundaryPathCount = safeCountRegex(normalized, /\bBOUNDARYPATH\b|\bLWPOLYLINE\b|\bEDGEPATH\b/g);
  if (hatchEntityCount > 0 && boundaryPathCount === 0) {
    signals.push({
      code: 'hatch-boundary-missing',
      weight: SIGNAL_WEIGHTS.hatchBoundaryMissingRisk,
      detail: 'Detected hatch records with weak/possibly missing boundary markers in sampled text.',
    });
  }

  return {
    signals,
    approximateEntityCount,
    insertCount,
  };
}

function buildRecommendedEngine() {
  // ODA route is intentionally removed from runtime selection; always target LibreDWG.
  return 'libredwg';
}

export function prescanCadBuffer({ buffer, originalName, fileSizeBytes = 0 }) {
  const ext = getExtension(originalName);
  const sample = buffer.subarray(0, Math.min(buffer.length, PRESCAN_TEXT_SAMPLE_BYTES));
  const text = toAsciiSnippet(sample);
  const signatureHint = detectBinarySignature(sample);
  const formatHint = signatureHint !== 'unknown'
    ? signatureHint
    : (ext === '.dxf' ? 'dxf' : ext === '.dwg' ? 'dwg' : 'unknown');
  const dxfVersion = formatHint === 'dxf' ? parseDxfVersion(text) : null;
  const dwgVersion = formatHint === 'dwg' ? parseDwgVersionFromHeader(sample) : null;
  const versionCode = dxfVersion || dwgVersion;

  const { signals, approximateEntityCount, insertCount } = collectPrescanSignals({
    text,
    fileSizeBytes,
    versionCode,
  });

  const riskScore = signals.reduce((sum, signal) => sum + Number(signal.weight || 0), 0);
  const recommendedMode = buildRecommendedMode(riskScore);
  const recommendedEngine = buildRecommendedEngine(recommendedMode, signals);
  const confidence = buildConfidence(riskScore, signals.length, formatHint);

  const warnings = [];
  if (recommendedMode !== 'full') {
    warnings.push(`Server pre-scan recommends ${recommendedMode} mode for this CAD file.`);
  }
  return {
    riskScore,
    recommendedMode,
    recommendedEngine,
    confidenceLevel: confidence.level,
    confidenceReason: confidence.reason,
    signals,
    warnings,
    stats: {
      fileSizeBytes,
      sampleBytes: sample.length,
      formatHint,
      versionCode,
      approximateEntityCount,
      insertCount,
    },
  };
}
