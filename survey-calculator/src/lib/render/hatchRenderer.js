import { resolvePatternDefinition, generatePatternSegments } from './patternLibrary.js';
import { buildHatchPolygons, computeHatchBounds, clipPatternSegmentsToPolygons } from './hatchGeometry.js';

const getMode = (value) => {
  const mode = String(value || 'full').toLowerCase();
  return mode === 'preview' || mode === 'recovery' ? mode : 'full';
};

export function shouldDegradeHatchRendering(hatch, context = {}) {
  const mode = getMode(context.processingMode || context.mode || hatch?.renderHints?.processingMode);
  const zoom = Number.isFinite(Number(context.zoom)) ? Number(context.zoom) : 18;
  const complexity = Number.isFinite(Number(context.complexity)) ? Number(context.complexity) : 0;
  const segmentBudget = Number.isFinite(Number(context.maxPatternSegments)) ? Number(context.maxPatternSegments) : 2000;

  if (mode === 'recovery') return true;
  if (mode === 'preview' && zoom < 15) return true;
  if (complexity > segmentBudget) return true;
  if (hatch?.renderHints?.hasUnsupportedEdges) return true;
  return false;
}

export function buildRenderableHatch(hatch, context = {}) {
  const polygons = buildHatchPolygons(hatch);
  const bounds = computeHatchBounds(hatch);
  const mode = getMode(context.processingMode || context.mode || hatch?.renderHints?.processingMode);
  const diagnostics = [];

  const pattern = resolvePatternDefinition(hatch);
  const forceSolidOnly = Boolean(context.solidOnly || hatch?.renderHints?.solidOnly);
  const degrade = shouldDegradeHatchRendering(hatch, {
    ...context,
    mode,
    complexity: context.complexity || (polygons.length * 240),
  });

  const renderAsSolid = forceSolidOnly || degrade || pattern.isSolid || !pattern.supported;

  if (degrade) {
    diagnostics.push({
      code: 'HATCH_RENDER_DEGRADED',
      severity: 'info',
      message: 'Pattern rendering downgraded to solid/degraded mode for performance or unsupported edges.',
    });
  }

  if (!pattern.supported) {
    diagnostics.push({
      code: 'HATCH_PATTERN_UNSUPPORTED',
      severity: 'info',
      message: `Pattern ${pattern.name || 'unknown'} is not fully supported and was approximated.`,
    });
  }

  let patternSegments = [];
  if (!renderAsSolid && bounds) {
    const rawSegments = generatePatternSegments(bounds, pattern.base, {
      maxSegments: Number.isFinite(Number(context.maxPatternSegments)) ? Number(context.maxPatternSegments) : 2000,
    });
    patternSegments = clipPatternSegmentsToPolygons(rawSegments, polygons);
  }

  return {
    polygons,
    patternSegments,
    renderAsSolid,
    mode,
    diagnostics,
    bounds,
  };
}
