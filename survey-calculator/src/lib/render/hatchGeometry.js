import { computeLoopBounds } from '../cad/hatchModel.js';

const pointInRing = (point, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];

    const intersects = ((yi > point.y) !== (yj > point.y))
      && (point.x < ((xj - xi) * (point.y - yi)) / ((yj - yi) || 1e-12) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
};

export function toRingPoints(loop) {
  const points = Array.isArray(loop?.points) ? loop.points : [];
  if (points.length < 4) return [];
  return points.map((point) => [point.x, point.y]);
}

export function buildHatchPolygons(hatch) {
  const loops = Array.isArray(hatch?.loops) ? hatch.loops : [];
  const closedLoops = loops.filter((loop) => loop?.closed && Array.isArray(loop?.points) && loop.points.length >= 4);
  if (closedLoops.length === 0) return [];

  const outerLoops = closedLoops.filter((loop) => loop.external || loop.outermost);
  const innerLoops = closedLoops.filter((loop) => !loop.external && !loop.outermost);

  const outers = outerLoops.length > 0 ? outerLoops : [closedLoops[0]];
  return outers.map((outer) => {
    const outerRing = toRingPoints(outer);
    const holes = innerLoops
      .filter((hole) => {
        const holeBounds = computeLoopBounds(hole);
        if (!holeBounds) return false;
        const samplePoint = { x: holeBounds.minX + holeBounds.width * 0.5, y: holeBounds.minY + holeBounds.height * 0.5 };
        return pointInRing(samplePoint, outerRing);
      })
      .map((hole) => toRingPoints(hole))
      .filter((ring) => ring.length >= 4);

    return {
      outer: outerRing,
      holes,
    };
  }).filter((poly) => poly.outer.length >= 4);
}

export function computeHatchBounds(hatch) {
  const loops = Array.isArray(hatch?.loops) ? hatch.loops : [];
  let bounds = null;
  loops.forEach((loop) => {
    const b = computeLoopBounds(loop);
    if (!b) return;
    if (!bounds) {
      bounds = { ...b };
      return;
    }
    bounds.minX = Math.min(bounds.minX, b.minX);
    bounds.minY = Math.min(bounds.minY, b.minY);
    bounds.maxX = Math.max(bounds.maxX, b.maxX);
    bounds.maxY = Math.max(bounds.maxY, b.maxY);
    bounds.width = bounds.maxX - bounds.minX;
    bounds.height = bounds.maxY - bounds.minY;
  });
  return bounds;
}

export function clipPatternSegmentsToPolygons(segments, polygons) {
  if (!Array.isArray(segments) || !Array.isArray(polygons)) return [];
  const clipped = [];
  segments.forEach((segment) => {
    const mid = {
      x: (segment[0].x + segment[1].x) / 2,
      y: (segment[0].y + segment[1].y) / 2,
    };

    const inside = polygons.some((poly) => {
      if (!Array.isArray(poly?.outer) || poly.outer.length < 4) return false;
      if (!pointInRing(mid, poly.outer)) return false;
      if (!Array.isArray(poly?.holes)) return true;
      return !poly.holes.some((hole) => pointInRing(mid, hole));
    });

    if (inside) {
      clipped.push([
        [segment[0].x, segment[0].y],
        [segment[1].x, segment[1].y],
      ]);
    }
  });
  return clipped;
}
