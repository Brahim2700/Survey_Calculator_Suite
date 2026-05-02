import { describe, expect, it } from 'vitest';
import { normalizeHatchEntity } from '../lib/cad/hatchModel.js';
import { buildRenderableHatch } from '../lib/render/hatchRenderer.js';

const square = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
  { x: 0, y: 0 },
];

describe('hatch normalization and rendering', () => {
  it('normalizes closed polyline hatch loops', () => {
    const hatch = normalizeHatchEntity({
      type: 'HATCH',
      handle: 'A1',
      layer: 'HATCHES',
      patternName: 'SOLID',
      boundaryPaths: [{ vertices: square, closed: true, external: true }],
    });

    expect(hatch.loops).toHaveLength(1);
    expect(hatch.loops[0].closed).toBe(true);
    expect(hatch.renderHints.degraded).toBe(false);
  });

  it('keeps nested island loops for hole rendering', () => {
    const hatch = normalizeHatchEntity({
      type: 'HATCH',
      patternName: 'SOLID',
      boundaryPaths: [
        { vertices: square, closed: true, external: true },
        {
          vertices: [
            { x: 3, y: 3 },
            { x: 7, y: 3 },
            { x: 7, y: 7 },
            { x: 3, y: 7 },
            { x: 3, y: 3 },
          ],
          closed: true,
          external: false,
        },
      ],
    });

    const renderable = buildRenderableHatch(hatch, { processingMode: 'full', zoom: 18 });
    expect(renderable.polygons.length).toBeGreaterThan(0);
    expect(renderable.polygons[0].holes.length).toBe(1);
  });

  it('supports line edge path hatch loops', () => {
    const hatch = normalizeHatchEntity({
      type: 'HATCH',
      patternName: 'ANSI31',
      loops: [{
        edges: [
          { type: 'line', start: { x: 0, y: 0 }, end: { x: 8, y: 0 } },
          { type: 'line', start: { x: 8, y: 0 }, end: { x: 8, y: 8 } },
          { type: 'line', start: { x: 8, y: 8 }, end: { x: 0, y: 8 } },
          { type: 'line', start: { x: 0, y: 8 }, end: { x: 0, y: 0 } },
        ],
        external: true,
      }],
    });

    expect(hatch.loops[0].closed).toBe(true);
    expect(hatch.loops[0].points.length).toBeGreaterThanOrEqual(4);
  });

  it('approximates arc edges in hatch loops', () => {
    const hatch = normalizeHatchEntity({
      type: 'HATCH',
      patternName: 'ANSI31',
      loops: [{
        edges: [
          { type: 'line', start: { x: 0, y: 0 }, end: { x: 4, y: 0 } },
          { type: 'arc', center: { x: 4, y: 4 }, radius: 4, startAngle: -90, endAngle: 0, ccw: true },
          { type: 'line', start: { x: 8, y: 4 }, end: { x: 0, y: 0 } },
        ],
        external: true,
      }],
    });

    const approxDiag = hatch.diagnostics.find((diag) => diag.code === 'HATCH_APPROXIMATED_EDGE');
    expect(approxDiag).toBeTruthy();
    expect(hatch.loops[0].points.length).toBeGreaterThan(4);
  });

  it('falls back safely for unsupported edge hatch data', () => {
    const hatch = normalizeHatchEntity({
      type: 'HATCH',
      patternName: 'ANSI31',
      loops: [{ edges: [{ type: 'unknown-custom-edge' }], external: true }],
    });

    const unsupported = hatch.diagnostics.find((diag) => diag.code === 'HATCH_EDGE_UNSUPPORTED');
    expect(unsupported).toBeTruthy();
    expect(hatch.renderHints.degraded).toBe(true);
  });

  it('recovers malformed open loops in preview mode with degraded warning', () => {
    const hatch = normalizeHatchEntity({
      type: 'HATCH',
      patternName: 'SOLID',
      boundaryPaths: [{
        vertices: [
          { x: 0, y: 0 },
          { x: 5, y: 0 },
          { x: 5, y: 5 },
          { x: 0.000005, y: 0.000005 },
        ],
        closed: false,
        external: true,
      }],
    }, { processingMode: 'preview', tolerance: 1e-6 });

    expect(hatch.loops[0].closed).toBe(true);
    const openDiag = hatch.diagnostics.find((diag) => diag.code === 'HATCH_OPEN_LOOP');
    expect(openDiag).toBeTruthy();
  });

  it('downgrades expensive pattern rendering in preview mode', () => {
    const hatch = normalizeHatchEntity({
      type: 'HATCH',
      patternName: 'ANSI31',
      boundaryPaths: [{ vertices: square, closed: true, external: true }],
    });

    const renderable = buildRenderableHatch(hatch, {
      processingMode: 'preview',
      zoom: 12,
      maxPatternSegments: 100,
      complexity: 600,
    });

    expect(renderable.renderAsSolid).toBe(true);
    expect(renderable.diagnostics.some((diag) => diag.code === 'HATCH_RENDER_DEGRADED')).toBe(true);
  });
});
