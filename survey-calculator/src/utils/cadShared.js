import DxfParser from 'dxf-parser';
import { detectCRS, assessReferenceSystem } from './crsDetection.js';

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

  return null;
};

const normalizeCadLabelCandidate = (value) => String(value || '').trim();
const isCadPointNameProvided = (value) => normalizeCadLabelCandidate(value).length > 0;

const isLikelyPointIdentifier = (value) => {
  const text = normalizeCadLabelCandidate(value);
  if (!text) return false;
  if (text.length > 40) return false;
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

const collectTextLabels = (entities) => {
  const labels = [];

  const normalizeTextContent = (raw) => {
    const text = normalizeCadLabelCandidate(raw)
      .replace(/\\P/g, ' ')
      .replace(/\{\\[^}]*;/g, '')
      .replace(/[{}]/g, '')
      .trim();
    return text;
  };

  const addFromEntities = (entities) => {
    if (!Array.isArray(entities)) return;
    entities.forEach((ent) => {
      const type = String(ent?.type || '').toUpperCase();
      if (type !== 'TEXT' && type !== 'MTEXT' && type !== 'ATTRIB') return;

      const rawText = ent?.text ?? ent?.value ?? ent?.tag ?? '';
      const text = normalizeTextContent(rawText);
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
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
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
      transformed.vertices = (Array.isArray(entity?.vertices) ? entity.vertices : []).map((vertex) => applyCadTransform(vertex, transform));
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

  const visitEntities = (entities, transform, depth, ancestry = [], sourceBlock = null) => {
    if (!Array.isArray(entities)) return;
    diagnostics.resolution.nestedInsertDepthMax = Math.max(diagnostics.resolution.nestedInsertDepthMax, depth);

    entities.forEach((entity) => {
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
          return;
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
          return;
        }

        if (depth >= maxDepth) {
          diagnostics.resolution.transformWarnings.push(`Maximum CAD block nesting depth (${maxDepth}) reached at ${insertName}.`);
          return;
        }

        visitEntities(block?.entities, insertTransform, depth + 1, [...ancestry, insertName], insertName);
        return;
      }

      const transformed = transformCadEntity(entity, transform, { depth, sourceBlock });
      if (!transformed) {
        markSkipped(type);
        return;
      }
      flattened.push(transformed);
    });
  };

  visitEntities(dxfData?.entities, identityCadTransform(), 0, [], null);
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
  if (!entities.length || entities.length > 12) return false;
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
  let detectedFromCrs = detectCrsFromDxf(dxfData);
  const seenCoords = new Map();
  const expandedCad = expandCadEntities(dxfData, options);
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
  const diagnostics = {
    entityTypeCounts: countEntityTypes(dxfData),
    extraction: {
      explicitPointEntities: 0,
      insertPointSymbols: 0,
      inferredSymbolCenters: 0,
      fallbackVertices: 0,
      dedupMerged: 0,
      textLabelAssigned: 0,
    },
    references: expandedCad.diagnostics.references,
    resolution: expandedCad.diagnostics.resolution,
  };

  const addRow = (x, y, z, idHint, hasExplicitName = false, source = 'unknown') => {
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
      return;
    }

    const id = explicitName || String(idx);
    const row = {
      id,
      x,
      y,
      z: Number.isFinite(z) ? z : null,
      detectedFromCrs,
      hasExplicitName: Boolean(explicitName),
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
          addRow(ent.position?.x, ent.position?.y, z, null, false, 'point-entity');
          break;
        }
        case 'INSERT': {
          const nameLooksPointLike = /(?:^|[_\-\s])(pt|point|station|survey|node|borne|bench|cross)(?:$|[_\-\s])/i.test(String(ent.name || layer || ''));
          if ((nameLooksPointLike || ent.__blockPointLike) && ent.__blockResolved) {
            const iz = ent.position?.z ?? ent.z ?? ent.position?.[2];
            const pointName = ent.__pointName || extractInsertPointName(ent);
            addRow(ent.position?.x, ent.position?.y, iz, pointName, Boolean(pointName), 'insert-symbol');
          }
          break;
        }
        default:
          break;
      }
    });
  };

  visitEntities(expandedEntities);

  const inferredCenters = inferPointCentersFromSegments(segments, drawingDiagonal);
  inferredCenters.forEach((center) => {
    addRow(center.x, center.y, center.z, null, false, 'inferred-center');
  });

  if (!rows.length && !pointsOnly) {
    collectFallbackVertices(segments, (x, y, z, idHint) => addRow(x, y, z, idHint, false, 'fallback-vertex'));
  }

  diagnostics.extraction.textLabelAssigned = assignNearbyTextNames(rows, textLabels, drawingDiagonal);

  const coordinates = rows.map((row) => ({ x: row.x, y: row.y, z: row.z }));
  const metadata = { projection: detectedFromCrs || null };
  const crsSuggestions = detectCRS(coordinates, metadata);
  const referenceAssessment = assessReferenceSystem(coordinates, metadata, crsSuggestions);

  if (!detectedFromCrs && crsSuggestions.length > 0 && crsSuggestions[0].confidence > 0.7) {
    detectedFromCrs = crsSuggestions[0].code;
  }

  if (referenceAssessment.isLocal) {
    detectedFromCrs = 'LOCAL:ENGINEERING';
  }

  if (!detectedFromCrs) {
    detectedFromCrs = 'EPSG:4326';
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

export const collectCadGeometryFromDxf = (dxfData) => {
  const geometry = {
    lines: [],
    polylines: [],
  };
  const expandedEntities = expandCadEntities(dxfData).entities;

  const addLine = (start, end, layer, sourceType) => {
    if (!start || !end) return;
    const x1 = Number(start.x);
    const y1 = Number(start.y);
    const z1 = Number(start.z ?? 0);
    const x2 = Number(end.x);
    const y2 = Number(end.y);
    const z2 = Number(end.z ?? 0);
    if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) return;
    geometry.lines.push({
      layer: layer || 'LINE',
      sourceType: sourceType || 'LINE',
      start: [x1, y1, Number.isFinite(z1) ? z1 : 0],
      end: [x2, y2, Number.isFinite(z2) ? z2 : 0],
    });
  };

  const addPolyline = (vertices, layer, sourceType) => {
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
    geometry.polylines.push({
      layer: layer || sourceType || 'POLYLINE',
      sourceType: sourceType || 'POLYLINE',
      points: coords,
    });
  };

  const visitEntities = (entities) => {
    if (!Array.isArray(entities)) return;
    entities.forEach((ent) => {
      const layer = ent?.layer || ent?.type;
      switch (ent?.type) {
        case 'LINE':
          addLine(ent.start || ent?.vertices?.[0], ent.end || ent?.vertices?.[1], layer, 'LINE');
          break;
        case 'LWPOLYLINE':
        case 'POLYLINE':
          addPolyline(ent.vertices || [], layer, ent.type);
          break;
        default:
          break;
      }
    });
  };

  visitEntities(expandedEntities);

  return geometry;
};

export function parseDxfTextContent(text, options = {}) {
  const parser = new DxfParser();
  let dxf;
  try {
    dxf = parser.parseSync(text);
  } catch (err) {
    throw new Error(`Failed to parse DXF: ${err.message || err}`);
  }

  const pointResult = collectPointRowsFromDxf(dxf, options);
  const rows = pointResult.rows;
  const geometry = collectCadGeometryFromDxf(dxf);
  if (!rows.length) {
    const hint = options.pointsOnly
      ? 'No POINT entities found in DXF. Try unchecking "Points only" to extract vertices from lines/polylines.'
      : 'No point-like entities found in DXF';
    throw new Error(hint);
  }

  if (options.returnPayload) {
    return { rows, geometry, diagnostics: pointResult.diagnostics || null };
  }

  return rows;
}