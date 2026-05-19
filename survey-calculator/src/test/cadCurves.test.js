import { describe, expect, it } from 'vitest';
import { collectCadGeometryFromDxf } from '../utils/cadShared.js';

const makeDxfData = (entities) => ({
  entities,
  tables: {
    layer: {
      layers: {
        ROAD: { name: 'ROAD', color: 7 },
      },
    },
    style: { styles: {} },
  },
});

const makeExpandedCad = (entities, processingMode = 'full', skippedEntitiesByType = {}) => ({
  entities,
  processingMode,
  diagnostics: {
    resolution: {
      skippedEntitiesByType,
    },
  },
});

describe('CAD curve extraction', () => {
  it('preserves roundabout LWPOLYLINE bulge segments as arc segments', () => {
    const entities = [
      {
        type: 'LWPOLYLINE',
        layer: 'ROAD',
        closed: true,
        vertices: [
          { x: 0, y: 10, bulge: 0.41421356237 },
          { x: 10, y: 0, bulge: 0.41421356237 },
          { x: 0, y: -10, bulge: 0.41421356237 },
          { x: -10, y: 0, bulge: 0.41421356237 },
        ],
      },
    ];

    const geometry = collectCadGeometryFromDxf(makeDxfData(entities), makeExpandedCad(entities));

    expect(geometry.polylines.length).toBe(1);
    expect(geometry.curveSummary.polylineBulgeSegments).toBe(4);
    expect(geometry.polylines[0].segments.every((segment) => segment.kind === 'arc')).toBe(true);
  });

  it('preserves explicit ARC and CIRCLE entities', () => {
    const entities = [
      { type: 'ARC', layer: 'ROAD', center: { x: 100, y: 200 }, radius: 25, startAngle: 0, endAngle: 90 },
      { type: 'CIRCLE', layer: 'ROAD', center: { x: 150, y: 250 }, radius: 12 },
    ];

    const geometry = collectCadGeometryFromDxf(makeDxfData(entities), makeExpandedCad(entities));

    expect(geometry.arcs.length).toBe(1);
    expect(geometry.circles.length).toBe(1);
    expect(geometry.arcs[0].radius).toBe(25);
    expect(geometry.circles[0].radius).toBe(12);
  });

  it('preserves ELLIPSE and SPLINE entities and marks preview approximation diagnostics', () => {
    const entities = [
      {
        type: 'ELLIPSE',
        layer: 'ROAD',
        center: { x: 0, y: 0 },
        majorAxis: { x: 20, y: 0 },
        ratio: 0.5,
      },
      {
        type: 'SPLINE',
        layer: 'ROAD',
        controlPoints: [
          { x: 0, y: 0 },
          { x: 10, y: 20 },
          { x: 20, y: 0 },
        ],
        degreeOfSplineCurve: 3,
      },
    ];

    const geometry = collectCadGeometryFromDxf(makeDxfData(entities), makeExpandedCad(entities, 'preview'));

    expect(geometry.ellipses.length).toBe(1);
    expect(geometry.splines.length).toBe(1);
    expect(geometry.curveDiagnostics.some((diag) => diag.code === 'CURVE_ELLIPSE_APPROXIMATED')).toBe(true);
    expect(geometry.curveDiagnostics.some((diag) => diag.code === 'CURVE_SPLINE_APPROXIMATED')).toBe(true);
  });

  it('emits proxy/alignment diagnostics when skipped custom entities are detected', () => {
    const entities = [
      { type: 'LINE', layer: 'ROAD', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
    ];

    const geometry = collectCadGeometryFromDxf(
      makeDxfData(entities),
      makeExpandedCad(entities, 'full', { ACDBPROXYENTITY: 2, AECC_ALIGNMENT: 1 })
    );

    expect(geometry.curveDiagnostics.some((diag) => diag.code === 'CURVE_PROXY_UNSUPPORTED')).toBe(true);
    expect(geometry.curveDiagnostics.some((diag) => diag.code === 'CURVE_ALIGNMENT_PROXY_DETECTED')).toBe(true);
  });

  it('keeps mixed tangent+arc polyline segments', () => {
    const entities = [
      {
        type: 'LWPOLYLINE',
        layer: 'ROAD',
        closed: false,
        vertices: [
          { x: 0, y: 0, bulge: 0 },
          { x: 20, y: 0, bulge: 0.6 },
          { x: 35, y: 10, bulge: 0 },
          { x: 45, y: 10, bulge: 0 },
        ],
      },
    ];

    const geometry = collectCadGeometryFromDxf(makeDxfData(entities), makeExpandedCad(entities));
    const segments = geometry.polylines[0].segments;

    expect(segments.some((segment) => segment.kind === 'line')).toBe(true);
    expect(segments.some((segment) => segment.kind === 'arc')).toBe(true);
  });

  it('flips bulge direction when a block insert mirrors the source polyline', () => {
    const dxfData = makeDxfData([
      {
        type: 'INSERT',
        name: 'ROUNDABOUT_ARC',
        layer: 'ROAD',
        position: { x: 0, y: 0 },
        xScale: -1,
        yScale: 1,
      },
    ]);

    dxfData.blocks = {
      ROUNDABOUT_ARC: {
        name: 'ROUNDABOUT_ARC',
        entities: [
          {
            type: 'LWPOLYLINE',
            layer: 'ROAD',
            vertices: [
              { x: 1, y: 0, bulge: 0.41421356237 },
              { x: 0, y: 1 },
            ],
          },
        ],
      },
    };

    const geometry = collectCadGeometryFromDxf(dxfData);
    const segment = geometry.polylines[0].segments[0];

    expect(segment.kind).toBe('arc');
    expect(segment.clockwise).toBe(true);
    expect(segment.center[0]).toBeCloseTo(0, 9);
    expect(segment.center[1]).toBeCloseTo(0, 9);
    expect(segment.sweepAngle).toBeCloseTo(-(Math.PI / 2), 9);
  });

  it('downgrades bulge arcs under non-uniform insert scaling instead of fabricating a circular arc', () => {
    const dxfData = makeDxfData([
      {
        type: 'INSERT',
        name: 'SCALED_ARC',
        layer: 'ROAD',
        position: { x: 0, y: 0 },
        xScale: 2,
        yScale: 1,
      },
    ]);

    dxfData.blocks = {
      SCALED_ARC: {
        name: 'SCALED_ARC',
        entities: [
          {
            type: 'LWPOLYLINE',
            layer: 'ROAD',
            vertices: [
              { x: 1, y: 0, bulge: 0.41421356237 },
              { x: 0, y: 1 },
            ],
          },
        ],
      },
    };

    const geometry = collectCadGeometryFromDxf(dxfData);
    const segment = geometry.polylines[0].segments[0];

    expect(segment.kind).toBe('line');
    expect(geometry.curveDiagnostics.some((diag) => diag.code === 'CURVE_BULGE_IGNORED')).toBe(true);
  });
});
