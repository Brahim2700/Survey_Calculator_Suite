import { describe, expect, it } from 'vitest';
import {
  CAD_DIAGNOSTIC_CODES,
  collectCadXYBounds,
  decideCadRouting,
  isValidLatLng,
  shouldAbortWorldFit,
} from '../utils/cadCrsRouting.js';

describe('CAD CRS routing guards', () => {
  it('routes unknown/local CRS to local CAD view', () => {
    const decision = decideCadRouting({
      sourceCrs: 'LOCAL:ENGINEERING',
      sourceKnown: false,
      assessment: { status: 'local-unreferenced', isLocal: true, confidence: 0.2 },
      manualOverride: false,
    });

    expect(decision.mode).toBe('local');
    expect(decision.diagnosticCodes).toContain(CAD_DIAGNOSTIC_CODES.CRS_UNKNOWN_LOCAL_CAD);
    expect(decision.diagnosticCodes).toContain(CAD_DIAGNOSTIC_CODES.GEOMETRY_RENDERED_LOCAL_VIEW);
  });

  it('allows trusted georeferenced CRS for map overlay', () => {
    const decision = decideCadRouting({
      sourceCrs: 'EPSG:2154',
      sourceKnown: true,
      assessment: { status: 'referenced', isLocal: false, confidence: 0.91 },
      manualOverride: false,
    });

    expect(decision.mode).toBe('map');
  });

  it('rejects invalid geographic coordinates', () => {
    expect(isValidLatLng(48.85, 2.35)).toBe(true);
    expect(isValidLatLng(95, 2.35)).toBe(false);
    expect(isValidLatLng(48.85, 220)).toBe(false);
    expect(isValidLatLng(Number.NaN, 2.35)).toBe(false);
  });

  it('flags absurd world-scale fit extents', () => {
    expect(shouldAbortWorldFit({ latSpan: 5, lngSpan: 6, pointCount: 100 })).toBe(false);
    expect(shouldAbortWorldFit({ latSpan: 176, lngSpan: 20, pointCount: 200 })).toBe(true);
    expect(shouldAbortWorldFit({ latSpan: 90, lngSpan: 170, pointCount: 5 })).toBe(true);
  });

  it('computes CAD XY bounds and tracks absurd magnitudes', () => {
    const bounds = collectCadXYBounds({
      lines: [{ start: [0, 0], end: [10, 10] }],
      polylines: [{ points: [[20, 20], [30, 30]] }],
      arcs: [{ center: [1e9, 5] }],
    });

    expect(bounds.minX).toBe(0);
    expect(bounds.maxX).toBe(1e9);
    expect(bounds.absurdCount).toBeGreaterThan(0);
  });
});
