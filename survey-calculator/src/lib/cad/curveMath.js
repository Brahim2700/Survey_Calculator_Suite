const EPS = 1e-9;

const toFinite = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const normalizeAngleRad = (angle) => {
  const twoPi = Math.PI * 2;
  let out = Number(angle) || 0;
  while (out < 0) out += twoPi;
  while (out >= twoPi) out -= twoPi;
  return out;
};

const asRadians = (angle) => {
  const n = Number(angle) || 0;
  return Math.abs(n) > (Math.PI * 2 + 1e-6) ? ((n * Math.PI) / 180) : n;
};

const shortestPositiveSweep = (start, end) => {
  let sweep = end - start;
  const twoPi = Math.PI * 2;
  while (sweep < 0) sweep += twoPi;
  while (sweep >= twoPi) sweep -= twoPi;
  return sweep;
};

export function bulgeToArc(start, end, bulge) {
  const x1 = toFinite(start?.x, NaN);
  const y1 = toFinite(start?.y, NaN);
  const x2 = toFinite(end?.x, NaN);
  const y2 = toFinite(end?.y, NaN);
  const b = Number(bulge);
  if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) return null;
  if (!Number.isFinite(b) || Math.abs(b) <= EPS) return null;

  const chordX = x2 - x1;
  const chordY = y2 - y1;
  const chord = Math.hypot(chordX, chordY);
  if (chord <= EPS) return null;

  const theta = 4 * Math.atan(b);
  const radius = chord / (2 * Math.sin(Math.abs(theta) / 2));
  if (!Number.isFinite(radius) || radius <= EPS) return null;

  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const ux = chordX / chord;
  const uy = chordY / chord;
  const nx = -uy;
  const ny = ux;

  const offset = radius * Math.cos(Math.abs(theta) / 2);
  const side = b > 0 ? 1 : -1;

  const cx = midX + (side * offset * nx);
  const cy = midY + (side * offset * ny);

  const startAngle = normalizeAngleRad(Math.atan2(y1 - cy, x1 - cx));
  const endAngle = normalizeAngleRad(Math.atan2(y2 - cy, x2 - cx));
  const counterClockwise = b > 0;

  return {
    kind: 'arc',
    start: { x: x1, y: y1, z: toFinite(start?.z, 0) },
    end: { x: x2, y: y2, z: toFinite(end?.z, 0) },
    center: { x: cx, y: cy, z: toFinite(start?.z ?? end?.z, 0) },
    radius,
    startAngle,
    endAngle,
    clockwise: !counterClockwise,
    bulge: b,
  };
}

export function tessellateArcSegment(arc, tolerance = 0.5, minSegments = 8, maxSegments = 720) {
  const center = arc?.center || {};
  const cx = toFinite(center.x, NaN);
  const cy = toFinite(center.y, NaN);
  const radius = toFinite(arc?.radius, NaN);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(radius) || radius <= EPS) return [];

  const clockwise = Boolean(arc?.clockwise);
  const rawStart = asRadians(toFinite(arc?.startAngle, 0));
  const rawEnd = asRadians(toFinite(arc?.endAngle, rawStart));
  const start = normalizeAngleRad(rawStart);
  const end = normalizeAngleRad(rawEnd);

  let sweep = shortestPositiveSweep(start, end);
  if (clockwise) {
    sweep = sweep > EPS ? (Math.PI * 2) - sweep : 0;
  }
  if (sweep <= EPS) {
    const point = { x: cx + radius * Math.cos(start), y: cy + radius * Math.sin(start), z: toFinite(center.z, 0) };
    return [point, point];
  }

  const tol = Math.max(1e-6, Number(tolerance) || 0.5);
  const delta = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - (tol / radius))));
  const safeDelta = Number.isFinite(delta) && delta > EPS ? delta : (Math.PI / 24);
  const segmentCount = Math.max(minSegments, Math.min(maxSegments, Math.ceil(sweep / safeDelta)));

  const out = [];
  for (let i = 0; i <= segmentCount; i += 1) {
    const t = i / segmentCount;
    const angle = clockwise ? (start - (sweep * t)) : (start + (sweep * t));
    out.push({
      x: cx + (radius * Math.cos(angle)),
      y: cy + (radius * Math.sin(angle)),
      z: toFinite(center.z, 0),
    });
  }
  return out;
}

export function tessellateCircle(circle, tolerance = 0.5) {
  const center = circle?.center || {};
  const radius = toFinite(circle?.radius, NaN);
  if (!Number.isFinite(radius) || radius <= EPS) return [];
  return tessellateArcSegment({
    center,
    radius,
    startAngle: 0,
    endAngle: 0,
    clockwise: false,
  }, tolerance, 24);
}

export function tessellateEllipse(ellipse, tolerance = 0.5, maxSegments = 720) {
  const center = ellipse?.center || {};
  const majorAxis = ellipse?.majorAxis || {};
  const cx = toFinite(center.x, NaN);
  const cy = toFinite(center.y, NaN);
  const ax = toFinite(majorAxis.x, NaN);
  const ay = toFinite(majorAxis.y, NaN);
  const ratio = toFinite(ellipse?.ratio, NaN);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(ax) || !Number.isFinite(ay)) return [];
  if (!Number.isFinite(ratio) || ratio <= EPS) return [];

  const majorRadius = Math.hypot(ax, ay);
  if (!Number.isFinite(majorRadius) || majorRadius <= EPS) return [];
  const minorRadius = majorRadius * ratio;
  const rotation = Math.atan2(ay, ax);

  const start = normalizeAngleRad(asRadians(toFinite(ellipse?.startAngle, 0)));
  const endRaw = ellipse?.endAngle;
  const end = endRaw === undefined || endRaw === null
    ? start
    : normalizeAngleRad(asRadians(toFinite(endRaw, start)));
  const sweep = shortestPositiveSweep(start, end) || (Math.PI * 2);

  const maxRadius = Math.max(majorRadius, minorRadius);
  const tol = Math.max(1e-6, Number(tolerance) || 0.5);
  const delta = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - (tol / maxRadius))));
  const safeDelta = Number.isFinite(delta) && delta > EPS ? delta : (Math.PI / 24);
  const segmentCount = Math.max(16, Math.min(maxSegments, Math.ceil(sweep / safeDelta)));

  const out = [];
  for (let i = 0; i <= segmentCount; i += 1) {
    const t = i / segmentCount;
    const theta = start + (sweep * t);
    const ex = majorRadius * Math.cos(theta);
    const ey = minorRadius * Math.sin(theta);
    const x = cx + (ex * Math.cos(rotation)) - (ey * Math.sin(rotation));
    const y = cy + (ex * Math.sin(rotation)) + (ey * Math.cos(rotation));
    out.push({ x, y, z: toFinite(center.z, 0) });
  }

  return out;
}

export function tessellateSpline(spline, tolerance = 0.5) {
  const cps = Array.isArray(spline?.controlPoints) ? spline.controlPoints : [];
  const points = cps
    .map((p) => ({ x: toFinite(p?.x, NaN), y: toFinite(p?.y, NaN), z: toFinite(p?.z, 0) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

  if (points.length < 2) return [];
  if (points.length === 2) {
    return [
      { x: points[0].x, y: points[0].y, z: points[0].z },
      { x: points[1].x, y: points[1].y, z: points[1].z },
    ];
  }

  let maxLeg = 0;
  for (let i = 1; i < points.length; i += 1) {
    const leg = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    if (leg > maxLeg) maxLeg = leg;
  }
  const tol = Math.max(0.05, Number(tolerance) || 0.5);
  const stepsPerSpan = Math.max(6, Math.min(80, Math.ceil(Math.max(1, maxLeg / tol) * 0.33)));

  const out = [];
  const get = (i) => points[Math.max(0, Math.min(points.length - 1, i))];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    const p3 = get(i + 2);

    for (let s = 0; s <= stepsPerSpan; s += 1) {
      if (i > 0 && s === 0) continue;
      const t = s / stepsPerSpan;
      const t2 = t * t;
      const t3 = t2 * t;
      const x = 0.5 * (
        (2 * p1.x)
        + (-p0.x + p2.x) * t
        + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2
        + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
      );
      const y = 0.5 * (
        (2 * p1.y)
        + (-p0.y + p2.y) * t
        + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2
        + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
      );
      out.push({ x, y, z: p1.z });
    }
  }

  return out;
}
