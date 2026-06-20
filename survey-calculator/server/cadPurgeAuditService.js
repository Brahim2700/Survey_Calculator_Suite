import { resolveCadUploadToDxfText } from './cadService.js';

const PROTECTED_BLOCK_PREFIX = '*';
const PROTECTED_BLOCKS = new Set(['*MODEL_SPACE', '*PAPER_SPACE']);
const PROTECTED_LAYERS = new Set(['0', 'DEFPOINTS']);
const PROTECTED_LINETYPES = new Set(['BYLAYER', 'BYBLOCK', 'CONTINUOUS']);
const PROTECTED_TEXT_STYLES = new Set(['STANDARD']);
const PROTECTED_DIM_STYLES = new Set(['STANDARD']);
const PROTECTED_REGAPPS = new Set(['ACAD']);
const DEFAULT_OVERKILL_TOLERANCE = 1e-6;
const MAX_DUPLICATE_GROUPS_IN_REPORT = 500;

const XREF_MODE = {
  REPORT_ONLY: 'report-only',
  DETACH_UNREFERENCED: 'detach-unreferenced',
};

const OVERKILL_MODE = {
  REPORT_ONLY: 'report-only',
  DELETE_DUPLICATES: 'delete-duplicates',
};

const TEMPLATE_TRANSFER_MODE = {
  NONE: 'none',
  CLEAN_TEMPLATE_TRANSFER: 'clean-template-transfer',
};

function normalizeName(value) {
  return String(value || '').trim().toUpperCase();
}

function createNameRegistry() {
  return new Map();
}

function addDefinition(registry, value) {
  const raw = String(value || '').trim();
  const norm = normalizeName(raw);
  if (!norm) return;
  if (!registry.has(norm)) {
    registry.set(norm, raw);
  }
}

function markUsed(usedSet, value) {
  const norm = normalizeName(value);
  if (!norm) return;
  usedSet.add(norm);
}

function getRecordValue(record, code) {
  const hit = record.pairs.find((pair) => pair.code === code);
  return hit ? String(hit.value || '').trim() : '';
}

function getRecordNumericValue(record, code, fallback = NaN) {
  const raw = getRecordValue(record, code);
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function buildRecordsFromDxfText(dxfText) {
  const lines = String(dxfText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const pairs = [];

  for (let i = 0; i < lines.length - 1; i += 2) {
    const code = Number.parseInt(String(lines[i] || '').trim(), 10);
    if (!Number.isInteger(code)) continue;
    pairs.push({ code, value: String(lines[i + 1] || '').trim() });
  }

  const records = [];
  let current = null;

  for (const pair of pairs) {
    if (pair.code === 0) {
      if (current && current.pairs.length > 0) {
        records.push(current);
      }
      current = {
        type: String(pair.value || '').trim().toUpperCase(),
        pairs: [pair],
      };
      continue;
    }

    if (!current) continue;
    current.pairs.push(pair);
  }

  if (current && current.pairs.length > 0) {
    records.push(current);
  }

  return records;
}

function isEntitySection(sectionName) {
  return sectionName === 'ENTITIES' || sectionName === 'BLOCKS';
}

function normalizeNumberForTolerance(value, tolerance) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const tol = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : DEFAULT_OVERKILL_TOLERANCE;
  return String(Math.round(n / tol));
}

function getRecordHandle(record) {
  return getRecordValue(record, 5) || null;
}

function makePointSignature(x, y, z, tolerance) {
  const qx = normalizeNumberForTolerance(x, tolerance);
  const qy = normalizeNumberForTolerance(y, tolerance);
  const qz = normalizeNumberForTolerance(z ?? 0, tolerance);
  if (!qx || !qy || !qz) return null;
  return `${qx},${qy},${qz}`;
}

function makeOverkillEntityDuplicateKey(record, tolerance = DEFAULT_OVERKILL_TOLERANCE) {
  const type = normalizeName(record?.type || '');
  const layer = normalizeName(getRecordValue(record, 8) || '0');

  if (type === 'LINE') {
    const p1 = makePointSignature(getRecordValue(record, 10), getRecordValue(record, 20), getRecordValue(record, 30) || 0, tolerance);
    const p2 = makePointSignature(getRecordValue(record, 11), getRecordValue(record, 21), getRecordValue(record, 31) || 0, tolerance);
    if (!p1 || !p2) return null;
    const ordered = p1 <= p2 ? `${p1}|${p2}` : `${p2}|${p1}`;
    return { entityType: 'LINE', key: `${layer}:${ordered}` };
  }

  if (type === 'POINT') {
    const p = makePointSignature(getRecordValue(record, 10), getRecordValue(record, 20), getRecordValue(record, 30) || 0, tolerance);
    if (!p) return null;
    return { entityType: 'POINT', key: `${layer}:${p}` };
  }

  if (type === 'CIRCLE') {
    const center = makePointSignature(getRecordValue(record, 10), getRecordValue(record, 20), getRecordValue(record, 30) || 0, tolerance);
    const radius = normalizeNumberForTolerance(getRecordValue(record, 40), tolerance);
    if (!center || !radius) return null;
    return { entityType: 'CIRCLE', key: `${layer}:${center}:R${radius}` };
  }

  if (type === 'ARC') {
    const center = makePointSignature(getRecordValue(record, 10), getRecordValue(record, 20), getRecordValue(record, 30) || 0, tolerance);
    const radius = normalizeNumberForTolerance(getRecordValue(record, 40), tolerance);
    const start = normalizeNumberForTolerance(getRecordValue(record, 50), tolerance);
    const end = normalizeNumberForTolerance(getRecordValue(record, 51), tolerance);
    if (!center || !radius || !start || !end) return null;
    return { entityType: 'ARC', key: `${layer}:${center}:R${radius}:A${start}-${end}` };
  }

  return null;
}

function buildOverkillDuplicateMap(records, { tolerance = DEFAULT_OVERKILL_TOLERANCE } = {}) {
  const bucketMap = new Map();
  let section = '';
  let currentBlock = null;

  records.forEach((record, recordIndex) => {
    const type = normalizeName(record?.type || '');

    if (type === 'SECTION') {
      section = normalizeName(getRecordValue(record, 2));
      currentBlock = null;
      return;
    }

    if (type === 'ENDSEC') {
      section = '';
      currentBlock = null;
      return;
    }

    if (!isEntitySection(section)) {
      return;
    }

    if (section === 'BLOCKS' && type === 'BLOCK') {
      currentBlock = normalizeName(getRecordValue(record, 2));
      return;
    }

    if (section === 'BLOCKS' && type === 'ENDBLK') {
      currentBlock = null;
      return;
    }

    const duplicateKey = makeOverkillEntityDuplicateKey(record, tolerance);
    if (!duplicateKey) return;

    const groupKey = `${duplicateKey.entityType}::${duplicateKey.key}`;
    if (!bucketMap.has(groupKey)) {
      bucketMap.set(groupKey, {
        entityType: duplicateKey.entityType,
        key: duplicateKey.key,
        occurrences: [],
      });
    }

    bucketMap.get(groupKey).occurrences.push({
      recordIndex,
      handle: getRecordHandle(record),
      layer: getRecordValue(record, 8) || '0',
      owner: section === 'BLOCKS' ? (currentBlock || 'BLOCKS') : 'MODEL_SPACE',
    });
  });

  const allGroups = [...bucketMap.values()].filter((group) => group.occurrences.length > 1);
  const duplicateGroups = allGroups.slice(0, MAX_DUPLICATE_GROUPS_IN_REPORT).map((group) => ({
    entityType: group.entityType,
    key: group.key,
    keep: group.occurrences[0],
    duplicates: group.occurrences.slice(1),
    occurrences: group.occurrences,
  }));

  const duplicateEntities = allGroups.reduce((sum, group) => sum + Math.max(0, group.occurrences.length - 1), 0);
  const duplicateByType = allGroups.reduce((acc, group) => {
    const count = Math.max(0, group.occurrences.length - 1);
    acc[group.entityType] = (acc[group.entityType] || 0) + count;
    return acc;
  }, {});

  return {
    tolerance,
    conservativeClasses: ['LINE', 'POINT', 'ARC', 'CIRCLE'],
    skippedRiskyClasses: ['SPLINE', 'HATCH(associative)', 'PROXYENTITY'],
    duplicateGroups,
    duplicateGroupCount: allGroups.length,
    duplicateEntities,
    duplicateByType,
    reportTruncated: allGroups.length > duplicateGroups.length,
  };
}

function classifyXrefResolution(flags) {
  const f = Number(flags);
  if (!Number.isFinite(f)) return 'unresolved';
  return (f & 32) === 32 ? 'resolved' : 'unresolved';
}

function toSortedOriginalNames(registry, setOfNormalizedNames) {
  const values = [];
  for (const norm of setOfNormalizedNames) {
    values.push(registry.get(norm) || norm);
  }
  return values.sort((a, b) => String(a).localeCompare(String(b)));
}

function normalizePurgeOptions(rawOptions = {}) {
  const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
  const xrefModeRaw = String(options?.xrefMode || options?.xrefs?.mode || XREF_MODE.REPORT_ONLY).trim().toLowerCase();
  const overkillModeRaw = String(options?.overkillMode || options?.overkill?.mode || OVERKILL_MODE.REPORT_ONLY).trim().toLowerCase();
  const toleranceRaw = Number(options?.overkillTolerance ?? options?.overkill?.tolerance ?? DEFAULT_OVERKILL_TOLERANCE);
  const templateTransferEnabled = Boolean(
    options?.templateTransfer === true
    || options?.templateTransfer?.enabled === true
    || String(options?.templateTransferMode || '').trim().toLowerCase() === TEMPLATE_TRANSFER_MODE.CLEAN_TEMPLATE_TRANSFER
  );

  const xrefMode = Object.values(XREF_MODE).includes(xrefModeRaw) ? xrefModeRaw : XREF_MODE.REPORT_ONLY;
  const overkillMode = Object.values(OVERKILL_MODE).includes(overkillModeRaw) ? overkillModeRaw : OVERKILL_MODE.REPORT_ONLY;
  const overkillTolerance = Number.isFinite(toleranceRaw) && toleranceRaw > 0 ? toleranceRaw : DEFAULT_OVERKILL_TOLERANCE;

  return {
    xrefMode,
    overkillMode,
    overkillTolerance,
    templateTransferMode: templateTransferEnabled ? TEMPLATE_TRANSFER_MODE.CLEAN_TEMPLATE_TRANSFER : TEMPLATE_TRANSFER_MODE.NONE,
  };
}

function normalizeTolerance(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_OVERKILL_TOLERANCE;
}

function quantizeNumber(value, tolerance) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const scale = 1 / normalizeTolerance(tolerance);
  return (Math.round(n * scale) / scale).toFixed(6);
}

function makeLineDuplicateKey(record, tolerance = DEFAULT_OVERKILL_TOLERANCE) {
  const layer = normalizeName(getRecordValue(record, 8) || '0');
  const x1 = quantizeNumber(getRecordValue(record, 10), tolerance);
  const y1 = quantizeNumber(getRecordValue(record, 20), tolerance);
  const z1 = quantizeNumber(getRecordValue(record, 30) || 0, tolerance);
  const x2 = quantizeNumber(getRecordValue(record, 11), tolerance);
  const y2 = quantizeNumber(getRecordValue(record, 21), tolerance);
  const z2 = quantizeNumber(getRecordValue(record, 31) || 0, tolerance);

  if (![x1, y1, z1, x2, y2, z2].every((v) => typeof v === 'string')) {
    return null;
  }

  const a = `${x1},${y1},${z1}`;
  const b = `${x2},${y2},${z2}`;
  const ordered = a <= b ? `${a}|${b}` : `${b}|${a}`;
  return `${layer}:${ordered}`;
}

function isXrefBlock({ name, flags, path }) {
  const norm = normalizeName(name);
  const hasPath = Boolean(String(path || '').trim());
  const hasXrefFlag = Number.isFinite(flags) && ((flags & 4) === 4 || (flags & 8) === 8 || (flags & 16) === 16);
  const looksLikeXref = /\|/.test(norm) || /\.DWG$/i.test(norm) || /^XREF[_\-\s]?/i.test(norm);
  return hasPath || hasXrefFlag || looksLikeXref;
}

function computeReachableBlocks(topLevelRefs, blockGraph) {
  const visited = new Set();
  const queue = [...topLevelRefs];

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || visited.has(next)) continue;
    visited.add(next);

    const deps = blockGraph.get(next);
    if (!deps || deps.size === 0) continue;
    for (const dep of deps) {
      if (!visited.has(dep)) queue.push(dep);
    }
  }

  return visited;
}

function buildUnusedList(registry, usedSet, protectedSet = new Set(), customFilter = null) {
  const values = [];

  for (const [norm, original] of registry.entries()) {
    if (protectedSet.has(norm)) continue;
    if (usedSet.has(norm)) continue;
    if (typeof customFilter === 'function' && !customFilter(norm, original)) continue;
    values.push(original);
  }

  values.sort((a, b) => a.localeCompare(b));
  return values;
}

function buildRemovalSetsFromAudit(audit) {
  const candidates = audit?.candidates || {};
  const normalizeList = (key) => new Set(
    (Array.isArray(candidates?.[key]) ? candidates[key] : [])
      .map((name) => normalizeName(name))
      .filter(Boolean)
  );

  return {
    layers: normalizeList('layers'),
    linetypes: normalizeList('linetypes'),
    textStyles: normalizeList('textStyles'),
    dimensionStyles: normalizeList('dimensionStyles'),
    regapps: normalizeList('regapps'),
    blocks: normalizeList('blocks'),
    xrefs: normalizeList('xrefs'),
    mleaderStyles: normalizeList('mleaderStyles'),
  };
}

function emptyRemovedNames() {
  return {
    layers: new Set(),
    linetypes: new Set(),
    textStyles: new Set(),
    dimensionStyles: new Set(),
    regapps: new Set(),
    blocks: new Set(),
    xrefs: new Set(),
    mleaderStyles: new Set(),
  };
}

function serializeRecordsToDxfText(records) {
  const lines = [];

  for (const record of records) {
    const pairs = Array.isArray(record?.pairs) ? record.pairs : [];
    for (const pair of pairs) {
      if (Number(pair.code) === 999) continue;
      lines.push(String(pair.code ?? '0'));
      lines.push(String(pair.value ?? ''));
    }
  }

  const eofIdx = records.findIndex((record) => record?.type === 'EOF');
  if (eofIdx < 0) {
    lines.push('0', 'EOF');
  }

  return `${lines.join('\n')}\n`;
}

function applySafePurgeToDxfText(dxfText, audit) {
  const records = buildRecordsFromDxfText(dxfText);
  const options = normalizePurgeOptions(audit?.optionsApplied || {});
  const removalSets = buildRemovalSetsFromAudit(audit);
  const removedNames = emptyRemovedNames();
  const kept = [];
  const xrefAll = new Set((audit?.xrefPolicy?.all || []).map((name) => normalizeName(name)).filter(Boolean));
  const xrefDetachEligible = new Set((audit?.xrefPolicy?.detachEligible || []).map((name) => normalizeName(name)).filter(Boolean));
  const liveDependencies = {
    layers: new Set((audit?.liveDependencies?.layers || []).map((name) => normalizeName(name)).filter(Boolean)),
    linetypes: new Set((audit?.liveDependencies?.linetypes || []).map((name) => normalizeName(name)).filter(Boolean)),
    textStyles: new Set((audit?.liveDependencies?.textStyles || []).map((name) => normalizeName(name)).filter(Boolean)),
    dimensionStyles: new Set((audit?.liveDependencies?.dimensionStyles || []).map((name) => normalizeName(name)).filter(Boolean)),
    regapps: new Set((audit?.liveDependencies?.regapps || []).map((name) => normalizeName(name)).filter(Boolean)),
    blocks: new Set((audit?.liveDependencies?.blocks || []).map((name) => normalizeName(name)).filter(Boolean)),
    xrefs: new Set((audit?.liveDependencies?.xrefs || []).map((name) => normalizeName(name)).filter(Boolean)),
    mleaderStyles: new Set((audit?.liveDependencies?.mleaderStyles || []).map((name) => normalizeName(name)).filter(Boolean)),
  };

  if (options.xrefMode !== XREF_MODE.DETACH_UNREFERENCED) {
    removalSets.xrefs.clear();
  } else {
    for (const norm of [...removalSets.xrefs]) {
      if (!xrefDetachEligible.has(norm)) {
        removalSets.xrefs.delete(norm);
      }
    }
  }

  if (options.templateTransferMode === TEMPLATE_TRANSFER_MODE.CLEAN_TEMPLATE_TRANSFER && options.xrefMode === XREF_MODE.REPORT_ONLY) {
    for (const xrefName of xrefAll) {
      liveDependencies.xrefs.add(xrefName);
      liveDependencies.blocks.add(xrefName);
    }
  }

  const duplicateEntityIndexesToRemove = new Set();
  if (options.overkillMode === OVERKILL_MODE.DELETE_DUPLICATES) {
    const groups = Array.isArray(audit?.overkill?.duplicateMap?.duplicateGroups)
      ? audit.overkill.duplicateMap.duplicateGroups
      : [];

    for (const group of groups) {
      const duplicates = Array.isArray(group?.duplicates) ? group.duplicates : [];
      for (const occurrence of duplicates) {
        const idx = Number(occurrence?.recordIndex);
        if (Number.isInteger(idx) && idx >= 0) {
          duplicateEntityIndexesToRemove.add(idx);
        }
      }
    }
  }

  const removedOverkillByType = {};
  let removedOverkillTotal = 0;

  let section = '';
  let table = '';
  let skippingBlock = false;
  let skippingSection = '';
  let skippedThumbnailSection = false;
  let recordIndex = -1;

  const shouldKeepTableDefinitionInTransfer = (tableName, record, recordType) => {
    if (options.templateTransferMode !== TEMPLATE_TRANSFER_MODE.CLEAN_TEMPLATE_TRANSFER) return true;
    if (recordType !== tableName) return true;

    const name = getRecordValue(record, 2);
    const norm = normalizeName(name);
    if (!norm) return true;

    if (tableName === 'LAYER') return liveDependencies.layers.has(norm);
    if (tableName === 'LTYPE') return liveDependencies.linetypes.has(norm);
    if (tableName === 'STYLE') return liveDependencies.textStyles.has(norm);
    if (tableName === 'DIMSTYLE') return liveDependencies.dimensionStyles.has(norm);
    if (tableName === 'APPID') return liveDependencies.regapps.has(norm);
    if (tableName === 'BLOCK_RECORD') {
      if (xrefAll.has(norm)) return liveDependencies.xrefs.has(norm);
      return liveDependencies.blocks.has(norm);
    }
    return true;
  };

  for (const record of records) {
    recordIndex += 1;
    const type = record.type;

    if (skippingSection) {
      if (type === 'ENDSEC') {
        skippingSection = '';
      }
      continue;
    }

    if (type === 'SECTION') {
      section = normalizeName(getRecordValue(record, 2));
      if (section === 'THUMBNAILIMAGE') {
        skippingSection = section;
        skippedThumbnailSection = true;
        table = '';
        continue;
      }
      table = '';
      if (!skippingBlock) kept.push(record);
      continue;
    }

    if (type === 'ENDSEC') {
      section = '';
      table = '';
      if (!skippingBlock) kept.push(record);
      continue;
    }

    if (section === 'TABLES') {
      if (type === 'TABLE') {
        table = normalizeName(getRecordValue(record, 2));
        kept.push(record);
        continue;
      }
      if (type === 'ENDTAB') {
        table = '';
        kept.push(record);
        continue;
      }

      if (table === 'LAYER' && type === 'LAYER') {
        const name = getRecordValue(record, 2);
        const norm = normalizeName(name);
        const removeByTransfer = !shouldKeepTableDefinitionInTransfer('LAYER', record, type);
        if (removalSets.layers.has(norm) || removeByTransfer) {
          removedNames.layers.add(name);
          continue;
        }
      }

      if (table === 'LTYPE' && type === 'LTYPE') {
        const name = getRecordValue(record, 2);
        const norm = normalizeName(name);
        const removeByTransfer = !shouldKeepTableDefinitionInTransfer('LTYPE', record, type);
        if (removalSets.linetypes.has(norm) || removeByTransfer) {
          removedNames.linetypes.add(name);
          continue;
        }
      }

      if (table === 'STYLE' && type === 'STYLE') {
        const name = getRecordValue(record, 2);
        const norm = normalizeName(name);
        const removeByTransfer = !shouldKeepTableDefinitionInTransfer('STYLE', record, type);
        if (removalSets.textStyles.has(norm) || removeByTransfer) {
          removedNames.textStyles.add(name);
          continue;
        }
      }

      if (table === 'DIMSTYLE' && type === 'DIMSTYLE') {
        const name = getRecordValue(record, 2);
        const norm = normalizeName(name);
        const removeByTransfer = !shouldKeepTableDefinitionInTransfer('DIMSTYLE', record, type);
        if (removalSets.dimensionStyles.has(norm) || removeByTransfer) {
          removedNames.dimensionStyles.add(name);
          continue;
        }
      }

      if (table === 'APPID' && type === 'APPID') {
        const name = getRecordValue(record, 2);
        const norm = normalizeName(name);
        const removeByTransfer = !shouldKeepTableDefinitionInTransfer('APPID', record, type);
        if (removalSets.regapps.has(norm) || removeByTransfer) {
          removedNames.regapps.add(name);
          continue;
        }
      }

      if (table === 'BLOCK_RECORD' && type === 'BLOCK_RECORD') {
        const name = getRecordValue(record, 2);
        const norm = normalizeName(name);
        const removeByTransfer = !shouldKeepTableDefinitionInTransfer('BLOCK_RECORD', record, type);
        if (removalSets.blocks.has(norm) || (removeByTransfer && !xrefAll.has(norm))) {
          removedNames.blocks.add(name);
          continue;
        }
        if (removalSets.xrefs.has(norm) || (removeByTransfer && xrefAll.has(norm))) {
          removedNames.xrefs.add(name);
          continue;
        }
      }

      kept.push(record);
      continue;
    }

    if (section === 'BLOCKS') {
      if (!skippingBlock && type === 'BLOCK') {
        const name = getRecordValue(record, 2);
        const norm = normalizeName(name);
        const removeByTransfer = options.templateTransferMode === TEMPLATE_TRANSFER_MODE.CLEAN_TEMPLATE_TRANSFER
          ? (xrefAll.has(norm) ? !liveDependencies.xrefs.has(norm) : !liveDependencies.blocks.has(norm))
          : false;

        if (removalSets.blocks.has(norm) || removalSets.xrefs.has(norm) || removeByTransfer) {
          skippingBlock = true;
          if (removalSets.xrefs.has(norm) || (removeByTransfer && xrefAll.has(norm))) removedNames.xrefs.add(name);
          else removedNames.blocks.add(name);
          continue;
        }
      }

      if (skippingBlock) {
        if (type === 'ENDBLK') {
          skippingBlock = false;
        }
        continue;
      }
    }

    if (isEntitySection(section) && duplicateEntityIndexesToRemove.has(recordIndex)) {
      const entityType = normalizeName(type || 'UNKNOWN') || 'UNKNOWN';
      removedOverkillByType[entityType] = (removedOverkillByType[entityType] || 0) + 1;
      removedOverkillTotal += 1;
      continue;
    }

    if (section === 'OBJECTS' && type === 'MLEADERSTYLE') {
      const name = getRecordValue(record, 3) || getRecordValue(record, 2) || getRecordValue(record, 300);
      const norm = normalizeName(name);
      const removeByTransfer = options.templateTransferMode === TEMPLATE_TRANSFER_MODE.CLEAN_TEMPLATE_TRANSFER
        ? !liveDependencies.mleaderStyles.has(norm)
        : false;
      if (removalSets.mleaderStyles.has(norm) || removeByTransfer) {
        removedNames.mleaderStyles.add(name);
        continue;
      }
    }

    kept.push(record);
  }

  const removed = Object.fromEntries(
    Object.entries(removedNames).map(([key, set]) => [key, [...set].sort((a, b) => String(a).localeCompare(String(b)))])
  );

  const removedCounts = Object.fromEntries(
    Object.entries(removed).map(([key, list]) => [key, Array.isArray(list) ? list.length : 0])
  );

  const removedTotal = Object.values(removedCounts).reduce((sum, value) => sum + Number(value || 0), 0);
  const cleanedDxfText = serializeRecordsToDxfText(kept);

  return {
    cleanedDxfText,
    removed,
    removedCounts,
    removedTotal,
    overkill: {
      removedDuplicatesTotal: removedOverkillTotal,
      removedDuplicatesByType: removedOverkillByType,
      mode: options.overkillMode,
    },
    compaction: {
      removedThumbnailSection: skippedThumbnailSection,
      commentPairsStripped: true,
    },
    transfer: {
      mode: options.templateTransferMode,
    },
    xrefs: {
      mode: options.xrefMode,
      detachedUnreferencedCount: removedCounts.xrefs,
    },
  };
}

export function analyzeDxfTextForPurgeAudit(dxfText, { fileName = '', options = {} } = {}) {
  const normalizedOptions = normalizePurgeOptions(options);
  const records = buildRecordsFromDxfText(dxfText);
  if (!records.length) {
    throw new Error('Unable to analyze DXF for purge audit: no readable records found.');
  }

  const definitions = {
    blocks: createNameRegistry(),
    layers: createNameRegistry(),
    linetypes: createNameRegistry(),
    textStyles: createNameRegistry(),
    dimensionStyles: createNameRegistry(),
    regapps: createNameRegistry(),
    mleaderStyles: createNameRegistry(),
  };

  const usage = {
    blocks: new Set(),
    layers: new Set(),
    linetypes: new Set(),
    textStyles: new Set(),
    dimensionStyles: new Set(),
    regapps: new Set(),
    mleaderStyles: new Set(),
  };

  const blockGraph = new Map();
  const topLevelBlockRefs = new Set();
  const xrefBlocks = new Map();
  const blockInsertCounts = new Map();
  const lineDuplicateCounts = new Map();

  let section = '';
  let table = '';
  let currentBlock = null;
  let mleaderEntityCount = 0;

  const ensureBlockGraphNode = (name) => {
    const norm = normalizeName(name);
    if (!norm) return null;
    if (!blockGraph.has(norm)) {
      blockGraph.set(norm, new Set());
    }
    return norm;
  };

  for (const record of records) {
    const type = record.type;

    if (type === 'SECTION') {
      section = normalizeName(getRecordValue(record, 2));
      table = '';
      currentBlock = null;
      continue;
    }

    if (type === 'ENDSEC') {
      section = '';
      table = '';
      currentBlock = null;
      continue;
    }

    if (section === 'TABLES') {
      if (type === 'TABLE') {
        table = normalizeName(getRecordValue(record, 2));
        continue;
      }

      if (type === 'ENDTAB') {
        table = '';
        continue;
      }

      if (table === 'LAYER' && type === 'LAYER') addDefinition(definitions.layers, getRecordValue(record, 2));
      if (table === 'LTYPE' && type === 'LTYPE') addDefinition(definitions.linetypes, getRecordValue(record, 2));
      if (table === 'STYLE' && type === 'STYLE') addDefinition(definitions.textStyles, getRecordValue(record, 2));
      if (table === 'DIMSTYLE' && type === 'DIMSTYLE') addDefinition(definitions.dimensionStyles, getRecordValue(record, 2));
      if (table === 'APPID' && type === 'APPID') addDefinition(definitions.regapps, getRecordValue(record, 2));
      if (table === 'BLOCK_RECORD' && type === 'BLOCK_RECORD') addDefinition(definitions.blocks, getRecordValue(record, 2));
      continue;
    }

    if (section === 'BLOCKS') {
      if (type === 'BLOCK') {
        const blockName = getRecordValue(record, 2);
        addDefinition(definitions.blocks, blockName);
        currentBlock = normalizeName(blockName);
        ensureBlockGraphNode(currentBlock);

        const flags = getRecordNumericValue(record, 70, NaN);
        const xrefPath = getRecordValue(record, 1);
        if (isXrefBlock({ name: blockName, flags, path: xrefPath })) {
          xrefBlocks.set(normalizeName(blockName), {
            name: blockName,
            flags: Number.isFinite(flags) ? flags : null,
            path: xrefPath || null,
          });
        }
        continue;
      }

      if (type === 'ENDBLK') {
        currentBlock = null;
        continue;
      }
    }

    const xdataAppNames = record.pairs.filter((pair) => pair.code === 1001).map((pair) => pair.value);
    xdataAppNames.forEach((appName) => markUsed(usage.regapps, appName));

    if (section === 'OBJECTS' && type === 'MLEADERSTYLE') {
      const styleName = getRecordValue(record, 3) || getRecordValue(record, 2) || getRecordValue(record, 300);
      addDefinition(definitions.mleaderStyles, styleName);
      continue;
    }

    if (!isEntitySection(section)) {
      continue;
    }

    markUsed(usage.layers, getRecordValue(record, 8) || '0');

    const linetypeName = getRecordValue(record, 6);
    if (linetypeName) markUsed(usage.linetypes, linetypeName);

    const textStyleName = getRecordValue(record, 7);
    if (textStyleName) markUsed(usage.textStyles, textStyleName);

    if (type === 'DIMENSION') {
      const dimStyle = getRecordValue(record, 3);
      if (dimStyle) markUsed(usage.dimensionStyles, dimStyle);
    }

    if (type === 'MLEADER') {
      mleaderEntityCount += 1;
      const mleaderStyleName = getRecordValue(record, 3);
      if (mleaderStyleName) markUsed(usage.mleaderStyles, mleaderStyleName);
    }

    if (type === 'INSERT' || type === 'MINSERT') {
      const targetBlockName = getRecordValue(record, 2);
      if (targetBlockName) {
        const targetNorm = normalizeName(targetBlockName);
        markUsed(usage.blocks, targetNorm);
        blockInsertCounts.set(targetNorm, (blockInsertCounts.get(targetNorm) || 0) + 1);

        if (currentBlock) {
          const owner = ensureBlockGraphNode(currentBlock);
          if (owner) blockGraph.get(owner).add(targetNorm);
        } else {
          topLevelBlockRefs.add(targetNorm);
        }
      }
    }

    if (type === 'LINE') {
      const lineKey = makeLineDuplicateKey(record);
      if (lineKey) {
        lineDuplicateCounts.set(lineKey, (lineDuplicateCounts.get(lineKey) || 0) + 1);
      }
    }
  }

  const reachableBlocks = computeReachableBlocks(topLevelBlockRefs, blockGraph);
  for (const blockName of reachableBlocks) {
    usage.blocks.add(blockName);
  }

  const protectedBlocks = new Set(PROTECTED_BLOCKS);
  for (const name of definitions.blocks.keys()) {
    if (name.startsWith(PROTECTED_BLOCK_PREFIX)) {
      protectedBlocks.add(name);
    }
  }

  const xrefNames = new Set(xrefBlocks.keys());
  const xrefResolved = [];
  const xrefUnresolved = [];
  const xrefDetachEligible = [];
  const xrefBindRequired = [];
  const xrefReferenceMap = [];

  for (const [xrefNorm, info] of xrefBlocks.entries()) {
    const originalName = definitions.blocks.get(xrefNorm) || info?.name || xrefNorm;
    const refCount = Number(blockInsertCounts.get(xrefNorm) || 0);
    const resolution = classifyXrefResolution(info?.flags);

    xrefReferenceMap.push({
      name: originalName,
      normalizedName: xrefNorm,
      references: refCount,
      resolution,
      flags: Number.isFinite(Number(info?.flags)) ? Number(info.flags) : null,
      path: info?.path || null,
    });

    if (resolution === 'resolved') xrefResolved.push(originalName);
    else xrefUnresolved.push(originalName);

    if (refCount === 0) xrefDetachEligible.push(originalName);
    else xrefBindRequired.push(originalName);
  }

  xrefReferenceMap.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  xrefResolved.sort((a, b) => String(a).localeCompare(String(b)));
  xrefUnresolved.sort((a, b) => String(a).localeCompare(String(b)));
  xrefDetachEligible.sort((a, b) => String(a).localeCompare(String(b)));
  xrefBindRequired.sort((a, b) => String(a).localeCompare(String(b)));

  const unused = {
    layers: buildUnusedList(definitions.layers, usage.layers, PROTECTED_LAYERS),
    linetypes: buildUnusedList(definitions.linetypes, usage.linetypes, PROTECTED_LINETYPES),
    textStyles: buildUnusedList(definitions.textStyles, usage.textStyles, PROTECTED_TEXT_STYLES),
    dimensionStyles: buildUnusedList(definitions.dimensionStyles, usage.dimensionStyles, PROTECTED_DIM_STYLES),
    regapps: buildUnusedList(definitions.regapps, usage.regapps, PROTECTED_REGAPPS),
    blocks: buildUnusedList(definitions.blocks, usage.blocks, protectedBlocks, (norm) => !xrefNames.has(norm)),
    xrefs: buildUnusedList(definitions.blocks, usage.blocks, protectedBlocks, (norm) => xrefNames.has(norm)),
    mleaderStyles: [],
  };

  if (definitions.mleaderStyles.size > 0 && mleaderEntityCount === 0) {
    unused.mleaderStyles = buildUnusedList(definitions.mleaderStyles, usage.mleaderStyles, new Set());
  }

  const overkillDuplicateMap = buildOverkillDuplicateMap(records, { tolerance: normalizedOptions.overkillTolerance });

  const duplicateLineGroups = [...lineDuplicateCounts.values()].filter((count) => count > 1);
  const duplicateLineEntityCount = duplicateLineGroups.reduce((sum, count) => sum + (count - 1), 0);

  const totalCandidateCount = Object.values(unused).reduce((sum, list) => sum + list.length, 0);

  const liveBlocks = new Set([...usage.blocks, ...protectedBlocks]);
  const liveXrefs = new Set([...xrefNames].filter((xrefName) => {
    const count = Number(blockInsertCounts.get(xrefName) || 0);
    if (normalizedOptions.xrefMode === XREF_MODE.DETACH_UNREFERENCED) {
      return count > 0;
    }
    return true;
  }));
  for (const xref of liveXrefs) {
    liveBlocks.add(xref);
  }

  const liveDependencies = {
    layers: toSortedOriginalNames(definitions.layers, new Set([...usage.layers, ...PROTECTED_LAYERS])),
    linetypes: toSortedOriginalNames(definitions.linetypes, new Set([...usage.linetypes, ...PROTECTED_LINETYPES])),
    textStyles: toSortedOriginalNames(definitions.textStyles, new Set([...usage.textStyles, ...PROTECTED_TEXT_STYLES])),
    dimensionStyles: toSortedOriginalNames(definitions.dimensionStyles, new Set([...usage.dimensionStyles, ...PROTECTED_DIM_STYLES])),
    regapps: toSortedOriginalNames(definitions.regapps, new Set([...usage.regapps, ...PROTECTED_REGAPPS])),
    blocks: toSortedOriginalNames(definitions.blocks, liveBlocks),
    xrefs: toSortedOriginalNames(definitions.blocks, liveXrefs),
    mleaderStyles: toSortedOriginalNames(definitions.mleaderStyles, usage.mleaderStyles),
  };

  return {
    mode: 'audit-only',
    fileName: String(fileName || ''),
    safe: true,
    willModifyDrawing: false,
    willRemoveGeometry: false,
    summary: {
      totalDefinitions: {
        layers: definitions.layers.size,
        linetypes: definitions.linetypes.size,
        textStyles: definitions.textStyles.size,
        dimensionStyles: definitions.dimensionStyles.size,
        regapps: definitions.regapps.size,
        blocks: definitions.blocks.size,
        xrefs: xrefBlocks.size,
        mleaderStyles: definitions.mleaderStyles.size,
      },
      totalCandidates: totalCandidateCount,
      candidateCounts: {
        layers: unused.layers.length,
        linetypes: unused.linetypes.length,
        textStyles: unused.textStyles.length,
        dimensionStyles: unused.dimensionStyles.length,
        regapps: unused.regapps.length,
        blocks: unused.blocks.length,
        xrefs: unused.xrefs.length,
        mleaderStyles: unused.mleaderStyles.length,
      },
      overkillPotential: {
        duplicateLineGroups: duplicateLineGroups.length,
        duplicateLineEntities: duplicateLineEntityCount,
      },
      xrefPolicy: {
        total: xrefBlocks.size,
        resolved: xrefResolved.length,
        unresolved: xrefUnresolved.length,
        detachEligible: xrefDetachEligible.length,
        bindRequired: xrefBindRequired.length,
      },
    },
    candidates: unused,
    xrefPolicy: {
      mode: normalizedOptions.xrefMode,
      all: toSortedOriginalNames(definitions.blocks, xrefNames),
      resolved: xrefResolved,
      unresolved: xrefUnresolved,
      detachEligible: xrefDetachEligible,
      bindRequired: xrefBindRequired,
      references: xrefReferenceMap,
      policyNotes: [
        'Default policy is report-only for XREF blocks.',
        'Only unreferenced XREFs are eligible for detach when detach-unreferenced mode is enabled.',
        'Referenced XREFs are never silently removed; use explicit bind workflow or keep as-is.',
      ],
    },
    overkill: {
      mode: normalizedOptions.overkillMode,
      tolerance: normalizedOptions.overkillTolerance,
      duplicateMap: overkillDuplicateMap,
    },
    templateTransfer: {
      mode: normalizedOptions.templateTransferMode,
      enabled: normalizedOptions.templateTransferMode === TEMPLATE_TRANSFER_MODE.CLEAN_TEMPLATE_TRANSFER,
      notes: [
        'Clean-template transfer copies live entities and required dependencies into a fresh output stream.',
        'Only in-use layers/styles and referenced block definitions are preserved.',
      ],
    },
    liveDependencies,
    optionsApplied: normalizedOptions,
    safety: {
      geometryProtected: true,
      notes: [
        'This endpoint is audit-only and does not modify source files.',
        'Candidate lists are conservative and based on detected references in the current drawing.',
        'MLeader style candidate detection is only enabled when no MLEADER entities are present.',
        'XREF default action is report-only.',
        'Overkill map includes only conservative classes (LINE, POINT, ARC, CIRCLE) with tolerance matching.',
      ],
    },
  };
}

export async function runCadPurgeAudit({ buffer, originalName, options = {} }) {
  const normalizedOptions = normalizePurgeOptions(options);
  const resolution = await resolveCadUploadToDxfText({ buffer, originalName });
  const audit = analyzeDxfTextForPurgeAudit(resolution.dxfText, { fileName: originalName, options: normalizedOptions });

  return {
    ...audit,
    sourceFormat: resolution.sourceFormat,
    conversion: {
      converterModeUsed: resolution.converterModeUsed || null,
      converterAttemptedModes: Array.isArray(resolution.converterAttemptedModes) ? resolution.converterAttemptedModes : [],
      notes: Array.isArray(resolution.notes) ? resolution.notes : [],
    },
    optionsApplied: normalizedOptions,
  };
}

export async function runCadPurgeApply({ buffer, originalName, options = {} }) {
  const normalizedOptions = normalizePurgeOptions(options);
  const resolution = await resolveCadUploadToDxfText({ buffer, originalName });
  const auditBefore = analyzeDxfTextForPurgeAudit(resolution.dxfText, { fileName: originalName, options: normalizedOptions });
  const applyResult = applySafePurgeToDxfText(resolution.dxfText, auditBefore);
  const auditAfter = analyzeDxfTextForPurgeAudit(applyResult.cleanedDxfText, { fileName: originalName, options: normalizedOptions });
  const cleanedFileName = `${String(originalName || 'drawing').replace(/\.[^.]+$/, '') || 'drawing'}-safepurge.dxf`;
  const sizeBeforeBytes = Buffer.byteLength(String(resolution.dxfText || ''), 'utf8');
  const sizeAfterBytes = Buffer.byteLength(String(applyResult.cleanedDxfText || ''), 'utf8');
  const sizeDeltaBytes = sizeAfterBytes - sizeBeforeBytes;
  const sizeDeltaPercent = sizeBeforeBytes > 0
    ? Number(((sizeDeltaBytes / sizeBeforeBytes) * 100).toFixed(2))
    : null;

  return {
    mode: 'apply-safe',
    fileName: String(originalName || ''),
    cleanedFileName,
    safe: true,
    willModifyDrawing: true,
    willRemoveGeometry: false,
    summary: {
      removedTotal: applyResult.removedTotal,
      removedCounts: applyResult.removedCounts,
      sizeBeforeBytes,
      sizeAfterBytes,
      sizeDeltaBytes,
      sizeDeltaPercent,
      compaction: applyResult.compaction,
      overkill: applyResult.overkill,
      xrefs: applyResult.xrefs,
      transfer: applyResult.transfer,
      candidateCountsBefore: auditBefore?.summary?.candidateCounts || null,
      candidateCountsAfter: auditAfter?.summary?.candidateCounts || null,
    },
    removed: applyResult.removed,
    safety: {
      geometryProtected: true,
      notes: [
        'SafePurge Apply removes only definitions proven unreferenced by audit analysis.',
        'Model space and paper space block records are protected and never removed.',
        'Referenced blocks (directly or through block trees) are not removed.',
        'Protected defaults/system objects are retained.',
        'Referenced XREFs are kept unless an explicit bind workflow is requested externally.',
      ],
    },
    sourceFormat: resolution.sourceFormat,
    conversion: {
      converterModeUsed: resolution.converterModeUsed || null,
      converterAttemptedModes: Array.isArray(resolution.converterAttemptedModes) ? resolution.converterAttemptedModes : [],
      notes: Array.isArray(resolution.notes) ? resolution.notes : [],
    },
    optionsApplied: normalizedOptions,
    auditBefore,
    auditAfter,
    cleanedDxfText: applyResult.cleanedDxfText,
  };
}
