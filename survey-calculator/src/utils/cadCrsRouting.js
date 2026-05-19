export const CAD_DIAGNOSTIC_CODES = {
  CRS_UNKNOWN_LOCAL_CAD: 'CRS_UNKNOWN_LOCAL_CAD',
  CRS_DOUBLE_REPROJECTION: 'CRS_DOUBLE_REPROJECTION',
  CRS_INVALID_LATLON_ASSUMPTION: 'CRS_INVALID_LATLON_ASSUMPTION',
  EXTENT_OUTLIER_DETECTED: 'EXTENT_OUTLIER_DETECTED',
  MAP_FIT_ABORTED_INVALID_BOUNDS: 'MAP_FIT_ABORTED_INVALID_BOUNDS',
  GEOMETRY_RENDERED_LOCAL_VIEW: 'GEOMETRY_RENDERED_LOCAL_VIEW',
};

const LOW_CONFIDENCE_THRESHOLD = 0.75;
const ABSURD_MAGNITUDE = 1e8;

const pushPair = (pairs, xRaw, yRaw) => {
  const x = Number(xRaw);
  const y = Number(yRaw);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  pairs.push([x, y]);
};

export const collectCadXYBounds = (geometry) => {
  const pairs = [];
  const lines = Array.isArray(geometry?.lines) ? geometry.lines : [];
  const polylines = Array.isArray(geometry?.polylines) ? geometry.polylines : [];
  const arcs = Array.isArray(geometry?.arcs) ? geometry.arcs : [];
  const circles = Array.isArray(geometry?.circles) ? geometry.circles : [];
  const ellipses = Array.isArray(geometry?.ellipses) ? geometry.ellipses : [];
  const splines = Array.isArray(geometry?.splines) ? geometry.splines : [];
  const texts = Array.isArray(geometry?.texts) ? geometry.texts : [];
  const hatches = Array.isArray(geometry?.hatches) ? geometry.hatches : [];
  const surfaces = Array.isArray(geometry?.surfaces) ? geometry.surfaces : [];

  lines.forEach((line) => {
    pushPair(pairs, line?.start?.[0], line?.start?.[1]);
    pushPair(pairs, line?.end?.[0], line?.end?.[1]);
  });
  polylines.forEach((poly) => {
    (Array.isArray(poly?.points) ? poly.points : []).forEach((pt) => pushPair(pairs, pt?.[0], pt?.[1]));
  });
  arcs.forEach((arc) => pushPair(pairs, arc?.center?.[0], arc?.center?.[1]));
  circles.forEach((circle) => pushPair(pairs, circle?.center?.[0], circle?.center?.[1]));
  ellipses.forEach((ellipse) => {
    pushPair(pairs, ellipse?.center?.[0], ellipse?.center?.[1]);
    pushPair(
      pairs,
      Number(ellipse?.center?.[0]) + Number(ellipse?.majorAxis?.[0] || 0),
      Number(ellipse?.center?.[1]) + Number(ellipse?.majorAxis?.[1] || 0)
    );
  });
  splines.forEach((spline) => {
    (Array.isArray(spline?.controlPoints) ? spline.controlPoints : []).forEach((pt) => pushPair(pairs, pt?.[0], pt?.[1]));
  });
  texts.forEach((text) => pushPair(pairs, text?.position?.[0], text?.position?.[1]));
  hatches.forEach((hatch) => {
    (Array.isArray(hatch?.polygons) ? hatch.polygons : []).forEach((polygon) => {
      (Array.isArray(polygon) ? polygon : []).forEach((pt) => pushPair(pairs, pt?.[0], pt?.[1]));
    });
  });
  surfaces.forEach((surface) => {
    (Array.isArray(surface?.vertices) ? surface.vertices : []).forEach((pt) => pushPair(pairs, pt?.[0], pt?.[1]));
  });

  if (!pairs.length) return null;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let absurdCount = 0;

  pairs.forEach(([x, y]) => {
    if (Math.abs(x) > ABSURD_MAGNITUDE || Math.abs(y) > ABSURD_MAGNITUDE) absurdCount += 1;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  });

  return {
    pointCount: pairs.length,
    minX,
    minY,
    maxX,
    maxY,
    spanX: maxX - minX,
    spanY: maxY - minY,
    absurdCount,
  };
};

export const isValidLatLng = (latRaw, lngRaw) => {
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  return true;
};

export const decideCadRouting = ({
  sourceCrs,
  sourceKnown,
  assessment,
  manualOverride = false,
}) => {
  if (manualOverride && sourceKnown) {
    return { mode: 'map', reason: 'manual-override', confidenceLow: false, diagnosticCodes: [] };
  }

  if (!sourceCrs || sourceCrs === 'LOCAL:ENGINEERING' || !sourceKnown) {
    return {
      mode: 'local',
      reason: 'unknown-or-local-crs',
      confidenceLow: true,
      diagnosticCodes: [
        CAD_DIAGNOSTIC_CODES.CRS_UNKNOWN_LOCAL_CAD,
        CAD_DIAGNOSTIC_CODES.GEOMETRY_RENDERED_LOCAL_VIEW,
      ],
    };
  }

  if (assessment?.isLocal || assessment?.status === 'local-unreferenced') {
    return {
      mode: 'local',
      reason: 'local-engineering-assessment',
      confidenceLow: true,
      diagnosticCodes: [
        CAD_DIAGNOSTIC_CODES.CRS_UNKNOWN_LOCAL_CAD,
        CAD_DIAGNOSTIC_CODES.GEOMETRY_RENDERED_LOCAL_VIEW,
      ],
    };
  }

  if (assessment?.isAmbiguous || assessment?.status === 'ambiguous') {
    return {
      mode: 'local',
      reason: 'ambiguous-crs-assessment',
      confidenceLow: true,
      diagnosticCodes: [
        CAD_DIAGNOSTIC_CODES.CRS_UNKNOWN_LOCAL_CAD,
        CAD_DIAGNOSTIC_CODES.GEOMETRY_RENDERED_LOCAL_VIEW,
      ],
    };
  }

  if (Number(assessment?.confidence) > 0 && Number(assessment?.confidence) < LOW_CONFIDENCE_THRESHOLD) {
    return {
      mode: 'local',
      reason: 'low-confidence-crs-assessment',
      confidenceLow: true,
      diagnosticCodes: [
        CAD_DIAGNOSTIC_CODES.CRS_UNKNOWN_LOCAL_CAD,
        CAD_DIAGNOSTIC_CODES.GEOMETRY_RENDERED_LOCAL_VIEW,
      ],
    };
  }

  return { mode: 'map', reason: 'trusted-crs', confidenceLow: false, diagnosticCodes: [] };
};

export const shouldAbortWorldFit = ({ latSpan, lngSpan, pointCount = 0 }) => {
  const lat = Number(latSpan);
  const lng = Number(lngSpan);
  const points = Number(pointCount) || 0;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return true;
  if (lat <= 0 || lng <= 0) return true;
  if (lat > 170 || lng > 350) return true;
  if ((lat > 80 || lng > 160) && points < 20) return true;
  return false;
};
