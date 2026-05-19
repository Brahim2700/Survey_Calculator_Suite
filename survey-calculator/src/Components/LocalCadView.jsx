import React, { useMemo } from 'react';
import { tessellateArcSegment, tessellateCircle, tessellateEllipse, tessellateSpline } from '../lib/cad/curveMath.js';

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 640;
const PADDING = 24;

const isFinitePair = (x, y) => Number.isFinite(Number(x)) && Number.isFinite(Number(y));

const getBounds = (segments) => {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  segments.forEach((segment) => {
    segment.points.forEach(([x, y]) => {
      if (!isFinitePair(x, y)) return;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    });
  });

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null;
  }

  return { minX, minY, maxX, maxY, spanX: Math.max(1e-9, maxX - minX), spanY: Math.max(1e-9, maxY - minY) };
};

const transformPointFactory = (bounds) => {
  if (!bounds) return () => null;
  const sx = (VIEW_WIDTH - (PADDING * 2)) / bounds.spanX;
  const sy = (VIEW_HEIGHT - (PADDING * 2)) / bounds.spanY;
  const scale = Math.min(sx, sy);
  const usedW = bounds.spanX * scale;
  const usedH = bounds.spanY * scale;
  const offsetX = (VIEW_WIDTH - usedW) * 0.5;
  const offsetY = (VIEW_HEIGHT - usedH) * 0.5;

  return (xRaw, yRaw) => {
    const x = Number(xRaw);
    const y = Number(yRaw);
    if (!isFinitePair(x, y)) return null;
    const vx = offsetX + ((x - bounds.minX) * scale);
    const vy = VIEW_HEIGHT - (offsetY + ((y - bounds.minY) * scale));
    return [vx, vy];
  };
};

const toPolylinePath = (pts, transformPoint) => {
  const path = pts
    .map(([x, y]) => transformPoint(x, y))
    .filter(Boolean)
    .map(([vx, vy]) => `${vx.toFixed(2)},${vy.toFixed(2)}`)
    .join(' ');
  return path;
};

const LocalCadView = ({ cadGeometry }) => {
  const segments = useMemo(() => {
    const out = [];

    (Array.isArray(cadGeometry?.lines) ? cadGeometry.lines : []).forEach((line) => {
      const s = Array.isArray(line?.start) ? line.start : null;
      const e = Array.isArray(line?.end) ? line.end : null;
      if (!s || !e || !isFinitePair(s[0], s[1]) || !isFinitePair(e[0], e[1])) return;
      out.push({ color: line?.colorHex || '#2563eb', points: [[Number(s[0]), Number(s[1])], [Number(e[0]), Number(e[1])]] });
    });

    (Array.isArray(cadGeometry?.polylines) ? cadGeometry.polylines : []).forEach((poly) => {
      const pts = (Array.isArray(poly?.points) ? poly.points : [])
        .filter((pt) => Array.isArray(pt) && isFinitePair(pt[0], pt[1]))
        .map((pt) => [Number(pt[0]), Number(pt[1])]);
      if (pts.length < 2) return;
      out.push({ color: poly?.colorHex || '#1d4ed8', points: pts });
    });

    (Array.isArray(cadGeometry?.arcs) ? cadGeometry.arcs : []).forEach((arc) => {
      const center = Array.isArray(arc?.center) ? arc.center : null;
      const radius = Number(arc?.radius);
      if (!center || !isFinitePair(center[0], center[1]) || !Number.isFinite(radius) || radius <= 0) return;
      const pts = tessellateArcSegment({
        center: { x: Number(center[0]), y: Number(center[1]), z: Number(center[2] || 0) },
        radius,
        startAngle: Number(arc?.startAngle ?? 0),
        endAngle: Number(arc?.endAngle ?? 0),
        clockwise: Boolean(arc?.clockwise),
        sweepAngle: Number(arc?.sweepAngle),
      }, 0.5).map((p) => [p.x, p.y]);
      if (pts.length < 2) return;
      out.push({ color: arc?.colorHex || '#0f766e', points: pts });
    });

    (Array.isArray(cadGeometry?.circles) ? cadGeometry.circles : []).forEach((circle) => {
      const center = Array.isArray(circle?.center) ? circle.center : null;
      const radius = Number(circle?.radius);
      if (!center || !isFinitePair(center[0], center[1]) || !Number.isFinite(radius) || radius <= 0) return;
      const pts = tessellateCircle({ center: { x: Number(center[0]), y: Number(center[1]) }, radius }, 0.5).map((p) => [p.x, p.y]);
      if (pts.length < 3) return;
      out.push({ color: circle?.colorHex || '#7c3aed', points: pts });
    });

    (Array.isArray(cadGeometry?.ellipses) ? cadGeometry.ellipses : []).forEach((ellipse) => {
      const center = Array.isArray(ellipse?.center) ? ellipse.center : null;
      const axis = Array.isArray(ellipse?.majorAxis) ? ellipse.majorAxis : null;
      if (!center || !axis || !isFinitePair(center[0], center[1]) || !isFinitePair(axis[0], axis[1])) return;
      const pts = tessellateEllipse({
        center: { x: Number(center[0]), y: Number(center[1]) },
        majorAxis: { x: Number(axis[0]), y: Number(axis[1]) },
        ratio: Number(ellipse?.ratio || 1),
        startAngle: Number(ellipse?.startAngle || 0),
        endAngle: Number(ellipse?.endAngle || 0),
      }, 0.5).map((p) => [p.x, p.y]);
      if (pts.length < 3) return;
      out.push({ color: ellipse?.colorHex || '#dc2626', points: pts });
    });

    (Array.isArray(cadGeometry?.splines) ? cadGeometry.splines : []).forEach((spline) => {
      const pts = tessellateSpline({
        controlPoints: (Array.isArray(spline?.controlPoints) ? spline.controlPoints : []).map((p) => ({ x: Number(p?.[0]), y: Number(p?.[1]), z: Number(p?.[2] || 0) })),
      }, 0.5).map((p) => [p.x, p.y]);
      if (pts.length < 2) return;
      out.push({ color: spline?.colorHex || '#0891b2', points: pts });
    });

    return out;
  }, [cadGeometry]);

  const bounds = useMemo(() => getBounds(segments), [segments]);
  const transformPoint = useMemo(() => transformPointFactory(bounds), [bounds]);

  return (
    <div style={{ width: '100%', height: '100%', minHeight: '520px', border: '1px solid #dbe1ea', borderRadius: '12px', background: '#f8fafc', display: 'grid', gridTemplateRows: 'auto 1fr', overflow: 'hidden' }}>
      <div style={{ padding: '12px 14px', borderBottom: '1px solid #dbe1ea', background: '#fff7ed', color: '#9a3412', fontSize: '13px', fontWeight: 600 }}>
        This DWG appears to use local/project coordinates. Displaying in local CAD view until a valid CRS/georeferencing transform is confirmed.
      </div>
      <div style={{ padding: '10px', overflow: 'auto' }}>
        <svg viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} style={{ width: '100%', height: '100%', background: '#ffffff', borderRadius: '10px', border: '1px solid #e2e8f0' }}>
          <rect x='0' y='0' width={VIEW_WIDTH} height={VIEW_HEIGHT} fill='#ffffff' />
          {segments.map((segment, index) => {
            const path = toPolylinePath(segment.points, transformPoint);
            if (!path) return null;
            return <polyline key={index} points={path} fill='none' stroke={segment.color} strokeWidth='1.3' opacity='0.92' />;
          })}
        </svg>
      </div>
    </div>
  );
};

export default LocalCadView;
