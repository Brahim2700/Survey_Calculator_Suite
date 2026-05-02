const DEG_TO_RAD = Math.PI / 180;

const makeLinePattern = (angleDeg = 45, spacing = 10) => ({
  kind: 'line',
  angleDeg,
  spacing,
});

const makeCrossPattern = (angleDeg = 45, spacing = 10) => ({
  kind: 'cross',
  angleDeg,
  spacing,
});

export function resolvePatternDefinition(hatch) {
  const patternName = String(hatch?.patternName || '').trim().toUpperCase();
  const scale = Number.isFinite(Number(hatch?.patternScale)) ? Math.max(0.05, Number(hatch.patternScale)) : 1;
  const angle = Number.isFinite(Number(hatch?.patternAngle)) ? Number(hatch.patternAngle) : 0;

  if (!patternName || patternName === 'SOLID') {
    return {
      supported: true,
      isSolid: true,
      name: patternName || 'SOLID',
      base: makeLinePattern(angle, 10 * scale),
    };
  }

  if (patternName === 'ANSI31' || patternName === 'LINE') {
    return {
      supported: true,
      isSolid: false,
      name: patternName,
      base: makeLinePattern(angle || 45, 12 * scale),
    };
  }

  if (patternName === 'ANSI32' || patternName === 'ANSI33' || patternName === 'CROSS') {
    return {
      supported: true,
      isSolid: false,
      name: patternName,
      base: makeCrossPattern(angle || 45, 12 * scale),
    };
  }

  return {
    supported: false,
    isSolid: false,
    name: patternName,
    base: makeLinePattern(angle || 45, 14 * scale),
  };
}

export function generatePatternSegments(bounds, pattern, options = {}) {
  if (!bounds || !pattern) return [];
  const maxSegments = Number.isFinite(Number(options.maxSegments)) ? Number(options.maxSegments) : 2500;
  const spacing = Math.max(0.5, Number(pattern.spacing || 10));
  const angle = Number(pattern.angleDeg || 0) * DEG_TO_RAD;
  const direction = { x: Math.cos(angle), y: Math.sin(angle) };
  const normal = { x: -direction.y, y: direction.x };

  const corners = [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY },
  ];

  let minProj = Number.POSITIVE_INFINITY;
  let maxProj = Number.NEGATIVE_INFINITY;
  corners.forEach((corner) => {
    const p = corner.x * normal.x + corner.y * normal.y;
    if (p < minProj) minProj = p;
    if (p > maxProj) maxProj = p;
  });

  const diagonal = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  const halfLen = diagonal * 0.65 + spacing * 2;

  const segments = [];
  for (let proj = minProj - spacing; proj <= maxProj + spacing; proj += spacing) {
    if (segments.length >= maxSegments) break;
    const origin = { x: normal.x * proj, y: normal.y * proj };
    segments.push([
      { x: origin.x - direction.x * halfLen, y: origin.y - direction.y * halfLen },
      { x: origin.x + direction.x * halfLen, y: origin.y + direction.y * halfLen },
    ]);
  }

  if (pattern.kind === 'cross') {
    const second = generatePatternSegments(bounds, {
      ...pattern,
      kind: 'line',
      angleDeg: (Number(pattern.angleDeg || 0) + 90) % 360,
    }, {
      ...options,
      maxSegments: Math.max(0, maxSegments - segments.length),
    });
    return [...segments, ...second].slice(0, maxSegments);
  }

  return segments;
}
