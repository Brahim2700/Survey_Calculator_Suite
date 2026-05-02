const DEFAULT_TOLERANCE = 1e-6;

export const HATCH_DIAGNOSTIC_CODES = {
  BOUNDARY_MISSING: 'HATCH_BOUNDARY_MISSING',
  OPEN_LOOP: 'HATCH_OPEN_LOOP',
  SELF_INTERSECTION: 'HATCH_SELF_INTERSECTION',
  EDGE_UNSUPPORTED: 'HATCH_EDGE_UNSUPPORTED',
  APPROXIMATED_EDGE: 'HATCH_APPROXIMATED_EDGE',
  ISLAND_INVALID: 'HATCH_ISLAND_INVALID',
  PATTERN_UNSUPPORTED: 'HATCH_PATTERN_UNSUPPORTED',
  RENDER_DEGRADED: 'HATCH_RENDER_DEGRADED',
};

const toNumber = (value, fallback = null) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const toPoint = (value) => {
  if (!value) return null;
  const x = toNumber(value.x ?? value[0]);
  const y = toNumber(value.y ?? value[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const bulge = toNumber(value.bulge, null);
  return bulge === null ? { x, y } : { x, y, bulge };
};

const pointsDistance = (a, b) => {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0));
};

const normalizeAngleRad = (valueDeg = 0) => (Number(valueDeg) * Math.PI) / 180;

const closePoints = (points, tolerance = DEFAULT_TOLERANCE) => {
  if (!Array.isArray(points) || points.length < 2) return points;
  const first = points[0];
  const last = points[points.length - 1];
  if (pointsDistance(first, last) <= tolerance) return points;
  return [...points, { ...first }];
};

const polygonArea = (points) => {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y - points[j].x * points[i].y;
  }
  return area / 2;
};

const sampleArcEdge = (edge, minSegments = 12) => {
  const center = toPoint(edge?.center || edge?.origin);
  const radius = toNumber(edge?.radius);
  const start = toNumber(edge?.startAngle, 0);
  const end = toNumber(edge?.endAngle, 0);
  if (!center || !Number.isFinite(radius) || radius <= 0) return [];

  const ccw = edge?.ccw !== false && edge?.isCounterClockwise !== false;
  let sweep = end - start;
  if (ccw && sweep < 0) sweep += 360;
  if (!ccw && sweep > 0) sweep -= 360;
  if (Math.abs(sweep) < 1e-9) sweep = ccw ? 360 : -360;
  const steps = Math.max(minSegments, Math.min(180, Math.ceil((Math.abs(sweep) / 360) * 96)));

  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const angle = normalizeAngleRad(start + sweep * t);
    points.push({
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle),
    });
  }
  return points;
};

const sampleEllipseEdge = (edge, minSegments = 20) => {
  const center = toPoint(edge?.center);
  const majorAxis = toPoint(edge?.majorAxis);
  const ratio = toNumber(edge?.ratio);
  const start = toNumber(edge?.startAngle, 0);
  const end = toNumber(edge?.endAngle, 360);
  if (!center || !majorAxis || !Number.isFinite(ratio) || ratio <= 0) return [];

  const majorLen = Math.hypot(majorAxis.x, majorAxis.y);
  if (majorLen <= 0) return [];
  const minorLen = majorLen * ratio;
  const axisRotation = Math.atan2(majorAxis.y, majorAxis.x);
  const ccw = edge?.ccw !== false && edge?.isCounterClockwise !== false;

  let sweep = end - start;
  if (ccw && sweep < 0) sweep += 360;
  if (!ccw && sweep > 0) sweep -= 360;
  if (Math.abs(sweep) < 1e-9) sweep = ccw ? 360 : -360;

  const steps = Math.max(minSegments, Math.min(220, Math.ceil((Math.abs(sweep) / 360) * 128)));
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const theta = normalizeAngleRad(start + sweep * t);
    const ex = majorLen * Math.cos(theta);
    const ey = minorLen * Math.sin(theta);
    const rx = ex * Math.cos(axisRotation) - ey * Math.sin(axisRotation);
    const ry = ex * Math.sin(axisRotation) + ey * Math.cos(axisRotation);
    points.push({ x: center.x + rx, y: center.y + ry });
  }
  return points;
};

const sampleSplineEdge = (edge) => {
  const controlPoints = Array.isArray(edge?.controlPoints)
    ? edge.controlPoints.map((point) => toPoint(point)).filter(Boolean)
    : [];
  if (controlPoints.length < 2) return [];
  return controlPoints;
};

const edgeTypeName = (edge) => {
  const raw = String(edge?.type || '').toLowerCase();
  if (raw === 'line' || Number(edge?.type) === 1) return 'line';
  if (raw.includes('arc') || Number(edge?.type) === 2) return 'arc';
  if (raw.includes('ellipse') || Number(edge?.type) === 3) return 'ellipse';
  if (raw.includes('spline') || Number(edge?.type) === 4) return 'spline';
  return raw || 'unknown';
};

const hasSegmentIntersection = (a1, a2, b1, b2) => {
  const orientation = (p, q, r) => {
    const v = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
    if (Math.abs(v) < 1e-10) return 0;
    return v > 0 ? 1 : 2;
  };

  const onSegment = (p, q, r) => (
    q.x <= Math.max(p.x, r.x) + 1e-10
    && q.x + 1e-10 >= Math.min(p.x, r.x)
    && q.y <= Math.max(p.y, r.y) + 1e-10
    && q.y + 1e-10 >= Math.min(p.y, r.y)
  );

  const o1 = orientation(a1, a2, b1);
  const o2 = orientation(a1, a2, b2);
  const o3 = orientation(b1, b2, a1);
  const o4 = orientation(b1, b2, a2);

  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a1, b1, a2)) return true;
  if (o2 === 0 && onSegment(a1, b2, a2)) return true;
  if (o3 === 0 && onSegment(b1, a1, b2)) return true;
  if (o4 === 0 && onSegment(b1, a2, b2)) return true;
  return false;
};

const hasSelfIntersection = (points) => {
  if (!Array.isArray(points) || points.length < 4) return false;
  const max = points.length - 1;
  for (let i = 0; i < max; i += 1) {
    const a1 = points[i];
    const a2 = points[i + 1];
    for (let j = i + 1; j < max; j += 1) {
      if (Math.abs(i - j) <= 1) continue;
      if (i === 0 && j === max - 1) continue;
      const b1 = points[j];
      const b2 = points[j + 1];
      if (hasSegmentIntersection(a1, a2, b1, b2)) return true;
    }
  }
  return false;
};

const buildPolylineLoop = (rawLoop) => {
  const polylineVertices = Array.isArray(rawLoop?.vertices)
    ? rawLoop.vertices
    : (Array.isArray(rawLoop?.polyline?.vertices) ? rawLoop.polyline.vertices : []);

  const points = polylineVertices.map((point) => toPoint(point)).filter(Boolean);
  return {
    kind: 'polyline',
    closed: Boolean(rawLoop?.closed || rawLoop?.isClosed || rawLoop?.polyline?.isClosed),
    external: Boolean(rawLoop?.external || rawLoop?.isExternal || rawLoop?.outermost),
    outermost: Boolean(rawLoop?.outermost),
    points,
    edges: [],
  };
};

const buildEdgeLoop = (rawLoop) => {
  const edges = Array.isArray(rawLoop?.edges) ? rawLoop.edges : [];
  const normalizedEdges = edges.map((edge) => {
    const kind = edgeTypeName(edge);
    if (kind === 'line') {
      return {
        type: 'line',
        start: toPoint(edge?.start || { x: edge?.startX, y: edge?.startY }),
        end: toPoint(edge?.end || { x: edge?.endX, y: edge?.endY }),
      };
    }
    if (kind === 'arc') {
      return {
        type: 'arc',
        center: toPoint(edge?.center || edge?.origin),
        radius: toNumber(edge?.radius),
        startAngle: toNumber(edge?.startAngle, 0),
        endAngle: toNumber(edge?.endAngle, 0),
        ccw: edge?.ccw !== false && edge?.isCounterClockwise !== false,
      };
    }
    if (kind === 'ellipse') {
      return {
        type: 'ellipse',
        center: toPoint(edge?.center),
        majorAxis: toPoint(edge?.majorAxis),
        ratio: toNumber(edge?.ratio),
        startAngle: toNumber(edge?.startAngle, 0),
        endAngle: toNumber(edge?.endAngle, 360),
        ccw: edge?.ccw !== false && edge?.isCounterClockwise !== false,
      };
    }
    if (kind === 'spline') {
      return {
        type: 'spline',
        controlPoints: Array.isArray(edge?.controlPoints)
          ? edge.controlPoints.map((point) => toPoint(point)).filter(Boolean)
          : [],
        degree: toNumber(edge?.degree),
      };
    }
    return { type: 'unknown' };
  });

  return {
    kind: 'edge',
    closed: Boolean(rawLoop?.closed || rawLoop?.isClosed),
    external: Boolean(rawLoop?.external || rawLoop?.isExternal || rawLoop?.outermost),
    outermost: Boolean(rawLoop?.outermost),
    points: [],
    edges: normalizedEdges,
  };
};

export function approximateEdgeLoop(loop, tolerance = DEFAULT_TOLERANCE) {
  const points = [];
  const warnings = [];
  const unsupported = [];

  if (!Array.isArray(loop?.edges) || loop.edges.length === 0) {
    return { points: [], warnings: ['Edge path contains no edges.'], unsupported: ['empty-edge-loop'] };
  }

  for (const edge of loop.edges) {
    const type = String(edge?.type || '').toLowerCase();
    if (type === 'line') {
      const start = toPoint(edge?.start);
      const end = toPoint(edge?.end);
      if (!start || !end) {
        unsupported.push('line');
        continue;
      }
      if (points.length === 0 || pointsDistance(points[points.length - 1], start) > tolerance) {
        points.push(start);
      }
      points.push(end);
      continue;
    }

    if (type === 'arc') {
      const sampled = sampleArcEdge(edge);
      if (sampled.length < 2) {
        unsupported.push('arc');
        continue;
      }
      if (points.length > 0 && pointsDistance(points[points.length - 1], sampled[0]) <= tolerance) sampled.shift();
      points.push(...sampled);
      warnings.push('Arc edge approximated as polyline segments.');
      continue;
    }

    if (type === 'ellipse') {
      const sampled = sampleEllipseEdge(edge);
      if (sampled.length < 2) {
        unsupported.push('ellipse');
        continue;
      }
      if (points.length > 0 && pointsDistance(points[points.length - 1], sampled[0]) <= tolerance) sampled.shift();
      points.push(...sampled);
      warnings.push('Ellipse edge approximated as polyline segments.');
      continue;
    }

    if (type === 'spline') {
      const sampled = sampleSplineEdge(edge);
      if (sampled.length < 2) {
        unsupported.push('spline');
        continue;
      }
      if (points.length > 0 && pointsDistance(points[points.length - 1], sampled[0]) <= tolerance) sampled.shift();
      points.push(...sampled);
      warnings.push('Spline edge approximated from control points.');
      continue;
    }

    unsupported.push(type || 'unknown');
  }

  return {
    points,
    warnings,
    unsupported,
  };
}

export function isLoopClosed(loop, tolerance = DEFAULT_TOLERANCE) {
  const points = Array.isArray(loop?.points) ? loop.points : [];
  if (points.length < 3) return false;
  return pointsDistance(points[0], points[points.length - 1]) <= tolerance;
}

export function computeLoopBounds(loop) {
  const points = Array.isArray(loop?.points) ? loop.points : [];
  if (points.length === 0) return null;
  let minX = points[0].x;
  let maxX = points[0].x;
  let minY = points[0].y;
  let maxY = points[0].y;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function classifyHatchLoops(loops) {
  const normalizedLoops = Array.isArray(loops) ? loops.map((loop) => ({ ...loop })) : [];
  if (normalizedLoops.length === 0) return [];

  const hasTaggedExternal = normalizedLoops.some((loop) => loop.external || loop.outermost);
  if (!hasTaggedExternal) {
    let maxAreaIndex = -1;
    let maxArea = -1;
    normalizedLoops.forEach((loop, index) => {
      const area = Math.abs(polygonArea(Array.isArray(loop?.points) ? loop.points : []));
      if (area > maxArea) {
        maxArea = area;
        maxAreaIndex = index;
      }
    });
    if (maxAreaIndex >= 0) {
      normalizedLoops[maxAreaIndex].external = true;
      normalizedLoops[maxAreaIndex].outermost = true;
    }
  }

  return normalizedLoops.map((loop) => {
    if (loop.external || loop.outermost) return loop;
    return { ...loop, external: false, outermost: false };
  });
}

export function normalizeHatchEntity(raw, context = {}) {
  const tolerance = Number.isFinite(Number(context?.tolerance)) ? Number(context.tolerance) : DEFAULT_TOLERANCE;
  const mode = String(context?.processingMode || 'full').toLowerCase();
  const fallbackMode = mode === 'preview' || mode === 'recovery' ? mode : 'full';

  const hatchId = String(raw?.id || raw?.handle || raw?.uuid || raw?.name || `hatch-${Math.random().toString(36).slice(2, 10)}`);
  const warnings = [];
  const diagnostics = [];

  const sourceLoops = Array.isArray(raw?.boundaryPaths)
    ? raw.boundaryPaths
    : (Array.isArray(raw?.paths)
      ? raw.paths
      : (Array.isArray(raw?.loops)
        ? raw.loops
        : (Array.isArray(raw?.boundaries) ? raw.boundaries : [])));

  if (sourceLoops.length === 0) {
    warnings.push('Hatch has no extractable boundary loops.');
    diagnostics.push({
      code: HATCH_DIAGNOSTIC_CODES.BOUNDARY_MISSING,
      severity: 'warning',
      confidence: 'high',
      fallbackUsed: true,
      recommendation: 'Keep diagnostics-visible fallback only; source hatch boundary is missing.',
    });
  }

  const loops = [];

  sourceLoops.forEach((rawLoop) => {
    let loop = Array.isArray(rawLoop?.edges) && rawLoop.edges.length > 0
      ? buildEdgeLoop(rawLoop)
      : buildPolylineLoop(rawLoop);

    if (loop.kind === 'edge') {
      const approximation = approximateEdgeLoop(loop, tolerance);
      loop.points = approximation.points;
      if (approximation.warnings.length > 0) {
        warnings.push(...approximation.warnings);
        diagnostics.push({
          code: HATCH_DIAGNOSTIC_CODES.APPROXIMATED_EDGE,
          severity: 'info',
          confidence: 'medium',
          fallbackUsed: false,
          recommendation: 'Edge path was approximated for browser rendering.',
        });
      }
      if (approximation.unsupported.length > 0) {
        warnings.push(`Unsupported hatch edge types: ${approximation.unsupported.join(', ')}`);
        diagnostics.push({
          code: HATCH_DIAGNOSTIC_CODES.EDGE_UNSUPPORTED,
          severity: 'warning',
          confidence: 'high',
          fallbackUsed: true,
          recommendation: 'Use degraded hatch preview or source CAD viewer for full fidelity.',
        });
      }
    }

    loop.points = Array.isArray(loop.points) ? loop.points.filter(Boolean) : [];
    loop.closed = loop.closed || isLoopClosed(loop, tolerance);

    if (!loop.closed && loop.points.length >= 3) {
      const first = loop.points[0];
      const last = loop.points[loop.points.length - 1];
      const nearClosed = pointsDistance(first, last) <= tolerance * 10;
      if (nearClosed && fallbackMode !== 'full') {
        loop.points = closePoints(loop.points, tolerance * 10);
        loop.closed = true;
        warnings.push('Loop was nearly closed and auto-closed in degraded mode.');
        diagnostics.push({
          code: HATCH_DIAGNOSTIC_CODES.OPEN_LOOP,
          severity: 'warning',
          confidence: 'medium',
          fallbackUsed: true,
          recommendation: 'Review source boundary closure; rendered using approximated closure.',
        });
      }
    }

    if (!loop.closed) {
      diagnostics.push({
        code: HATCH_DIAGNOSTIC_CODES.OPEN_LOOP,
        severity: 'warning',
        confidence: 'high',
        fallbackUsed: true,
        recommendation: 'Open hatch loops are not rendered as accurate hatches.',
      });
    }

    if (loop.closed && hasSelfIntersection(loop.points)) {
      diagnostics.push({
        code: HATCH_DIAGNOSTIC_CODES.SELF_INTERSECTION,
        severity: 'warning',
        confidence: 'medium',
        fallbackUsed: true,
        recommendation: 'Self-intersecting loops were downgraded for safe preview rendering.',
      });
    }

    loops.push(loop);
  });

  const classifiedLoops = classifyHatchLoops(loops);
  const closedLoops = classifiedLoops.filter((loop) => loop.closed && Array.isArray(loop.points) && loop.points.length >= 4);

  if (closedLoops.length === 0) {
    diagnostics.push({
      code: HATCH_DIAGNOSTIC_CODES.RENDER_DEGRADED,
      severity: 'warning',
      confidence: 'high',
      fallbackUsed: true,
      recommendation: 'No valid closed loops available; using degraded diagnostics-only representation.',
    });
  }

  const normalized = {
    id: hatchId,
    handle: raw?.handle || null,
    layer: raw?.layer || null,
    color: raw?.color ?? null,
    trueColor: raw?.trueColor ?? null,
    transparency: toNumber(raw?.transparency),
    elevation: toNumber(raw?.elevation),
    extrusion: raw?.extrusion && Number.isFinite(Number(raw?.extrusion?.x))
      ? {
          x: toNumber(raw.extrusion.x, 0),
          y: toNumber(raw.extrusion.y, 0),
          z: toNumber(raw.extrusion.z, 1),
        }
      : null,
    associative: Boolean(raw?.associative || raw?.isAssociative),
    style: toNumber(raw?.style),
    patternType: raw?.solidFill || String(raw?.patternName || raw?.pattern || '').toUpperCase() === 'SOLID'
      ? 'solid'
      : (String(raw?.gradient || '').trim() ? 'gradient' : (raw?.pattern || raw?.patternName ? 'pattern' : 'unknown')),
    patternName: String(raw?.patternName || raw?.pattern || '').trim() || null,
    patternAngle: toNumber(raw?.patternAngle ?? raw?.angle, 0),
    patternScale: toNumber(raw?.patternScale ?? raw?.scale, 1),
    patternDouble: Boolean(raw?.patternDouble),
    loops: classifiedLoops,
    bounds: closedLoops.length > 0
      ? closedLoops.reduce((acc, loop) => {
          const b = computeLoopBounds(loop);
          if (!b) return acc;
          if (!acc) return { ...b };
          return {
            minX: Math.min(acc.minX, b.minX),
            minY: Math.min(acc.minY, b.minY),
            maxX: Math.max(acc.maxX, b.maxX),
            maxY: Math.max(acc.maxY, b.maxY),
            width: Math.max(acc.maxX, b.maxX) - Math.min(acc.minX, b.minX),
            height: Math.max(acc.maxY, b.maxY) - Math.min(acc.minY, b.minY),
          };
        }, null)
      : null,
    sourceEngine: context?.sourceEngine || 'custom',
    warnings: [...new Set(warnings)],
    diagnostics,
    renderHints: {
      hasUnsupportedEdges: diagnostics.some((entry) => entry.code === HATCH_DIAGNOSTIC_CODES.EDGE_UNSUPPORTED),
      approximated: diagnostics.some((entry) => entry.code === HATCH_DIAGNOSTIC_CODES.APPROXIMATED_EDGE),
      degraded: diagnostics.some((entry) => entry.fallbackUsed),
      solidOnly: fallbackMode !== 'full',
    },
    raw: context?.preserveRaw ? raw : undefined,
  };

  if (normalized.patternType === 'pattern') {
    const pname = String(normalized.patternName || '').toUpperCase();
    const supportedPattern = pname === '' || pname === 'ANSI31' || pname === 'ANSI32' || pname === 'ANSI33' || pname === 'LINE' || pname === 'CROSS';
    if (!supportedPattern) {
      normalized.diagnostics.push({
        code: HATCH_DIAGNOSTIC_CODES.PATTERN_UNSUPPORTED,
        severity: 'info',
        confidence: 'medium',
        fallbackUsed: true,
        recommendation: 'Pattern fallback to simplified line/cross preview was used.',
      });
      normalized.renderHints.degraded = true;
    }
  }

  return normalized;
}

export function normalizeHatchesCollection(rawEntities = [], context = {}) {
  const hatches = [];
  const diagnostics = [];

  (Array.isArray(rawEntities) ? rawEntities : []).forEach((entity) => {
    const type = String(entity?.type || '').toUpperCase();
    if (type !== 'HATCH') return;
    const hatch = normalizeHatchEntity(entity, context);
    hatches.push(hatch);
    (Array.isArray(hatch?.diagnostics) ? hatch.diagnostics : []).forEach((diag) => {
      diagnostics.push({
        hatchId: hatch.id,
        handle: hatch.handle || null,
        ...diag,
      });
    });
  });

  return { hatches, diagnostics };
}
