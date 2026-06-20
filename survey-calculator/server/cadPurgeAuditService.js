import { resolveCadUploadToDxfText } from './cadService.js';

const PROTECTED_BLOCK_PREFIX = '*';
const PROTECTED_BLOCKS = new Set(['*MODEL_SPACE', '*PAPER_SPACE']);
const PROTECTED_LAYERS = new Set(['0', 'DEFPOINTS']);
const PROTECTED_LINETYPES = new Set(['BYLAYER', 'BYBLOCK', 'CONTINUOUS']);
const PROTECTED_TEXT_STYLES = new Set(['STANDARD']);
const PROTECTED_DIM_STYLES = new Set(['STANDARD']);
const PROTECTED_REGAPPS = new Set(['ACAD']);

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

function makeLineDuplicateKey(record) {
  const layer = normalizeName(getRecordValue(record, 8) || '0');
  const x1 = Number(getRecordValue(record, 10));
  const y1 = Number(getRecordValue(record, 20));
  const z1 = Number(getRecordValue(record, 30) || 0);
  const x2 = Number(getRecordValue(record, 11));
  const y2 = Number(getRecordValue(record, 21));
  const z2 = Number(getRecordValue(record, 31) || 0);

  if (![x1, y1, z1, x2, y2, z2].every(Number.isFinite)) {
    return null;
  }

  const a = `${x1.toFixed(6)},${y1.toFixed(6)},${z1.toFixed(6)}`;
  const b = `${x2.toFixed(6)},${y2.toFixed(6)},${z2.toFixed(6)}`;
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

export function analyzeDxfTextForPurgeAudit(dxfText, { fileName = '' } = {}) {
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

  const duplicateLineGroups = [...lineDuplicateCounts.values()].filter((count) => count > 1);
  const duplicateLineEntityCount = duplicateLineGroups.reduce((sum, count) => sum + (count - 1), 0);

  const totalCandidateCount = Object.values(unused).reduce((sum, list) => sum + list.length, 0);

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
    },
    candidates: unused,
    safety: {
      geometryProtected: true,
      notes: [
        'This endpoint is audit-only and does not modify source files.',
        'Candidate lists are conservative and based on detected references in the current drawing.',
        'MLeader style candidate detection is only enabled when no MLEADER entities are present.',
      ],
    },
  };
}

export async function runCadPurgeAudit({ buffer, originalName }) {
  const resolution = await resolveCadUploadToDxfText({ buffer, originalName });
  const audit = analyzeDxfTextForPurgeAudit(resolution.dxfText, { fileName: originalName });

  return {
    ...audit,
    sourceFormat: resolution.sourceFormat,
    conversion: {
      converterModeUsed: resolution.converterModeUsed || null,
      converterAttemptedModes: Array.isArray(resolution.converterAttemptedModes) ? resolution.converterAttemptedModes : [],
      notes: Array.isArray(resolution.notes) ? resolution.notes : [],
    },
  };
}
