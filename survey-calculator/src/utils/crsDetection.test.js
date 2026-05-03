import { describe, it, expect } from 'vitest';
import {
  detectCRS,
  assessReferenceSystem,
  shouldSwapCoordinateAxesForCrs,
  normalizeCoordinateAxesForCrs,
} from './crsDetection';

// ─── detectCRS ────────────────────────────────────────────────────────────────
describe('detectCRS', () => {
  it('returns empty array for empty input', () => {
    expect(detectCRS([])).toEqual([]);
    expect(detectCRS(null)).toEqual([]);
  });

  it('detects WGS84 geographic coordinates (lat/lon range)', () => {
    // Sydney area in geographic degrees
    const coords = [
      { x: 151.2, y: -33.8 },
      { x: 151.3, y: -33.9 },
    ];
    const results = detectCRS(coords);
    expect(results.length).toBeGreaterThan(0);
    const codes = results.map((r) => r.code);
    // Should suggest WGS84 or a geographic CRS
    const hasGeographic = codes.some((c) => c === 'EPSG:4326' || c?.includes('4326'));
    expect(hasGeographic).toBe(true);
  });

  it('prioritizes EPSG:4326 for swapped geographic coordinates with high longitudes', () => {
    // Swapped lon/lat style values (x=lat, y=lon), common in some CAD exports.
    const coords = [
      { x: -17.85, y: 133.42 },
      { x: -17.84, y: 133.43 },
      { x: -17.86, y: 133.44 },
    ];
    const results = detectCRS(coords);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].code).toBe('EPSG:4326');
    expect(Number(results[0].confidence)).toBeGreaterThanOrEqual(0.8);
  });

  it('avoids broad UTM trial suggestions when average values are outside UTM easting range', () => {
    const coords = [
      { x: 1734560, y: 7345678 },
      { x: 1739560, y: 7346178 },
    ];
    const results = detectCRS(coords);
    const hasUtmGuess = results.some((entry) => /^EPSG:32[67]\d{2}$/.test(String(entry.code || '')));
    expect(hasUtmGuess).toBe(false);
  });

  it('returns suggestions sorted by confidence descending', () => {
    const coords = [{ x: 148.0, y: -35.0 }, { x: 149.0, y: -36.0 }];
    const results = detectCRS(coords);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].confidence).toBeGreaterThanOrEqual(results[i].confidence);
    }
  });

  it('returns at most 8 suggestions', () => {
    const coords = [{ x: 148.0, y: -35.0 }];
    expect(detectCRS(coords).length).toBeLessThanOrEqual(8);
  });

  it('returns suggestions with required shape', () => {
    const coords = [{ x: 151.2, y: -33.8 }];
    const results = detectCRS(coords);
    results.forEach((r) => {
      expect(r).toHaveProperty('code');
      expect(r).toHaveProperty('confidence');
      expect(typeof r.confidence).toBe('number');
    });
  });

  it('detects French Lambert-93 from typical coordinate range', () => {
    // Lambert-93 (EPSG:2154) typical coords for Paris area
    const coords = [
      { x: 651000, y: 6862000 },
      { x: 652000, y: 6863000 },
    ];
    const results = detectCRS(coords);
    const codes = results.map((r) => r.code);
    expect(codes.some((c) => c === 'EPSG:2154')).toBe(true);
  });

  it('uses metadata EPSG hint when provided', () => {
    const coords = [{ x: 151.2, y: -33.8 }];
    const results = detectCRS(coords, { epsg: 4326 });
    expect(results[0].code).toBe('EPSG:4326');
    // Metadata hint gives a confidence boost — must be higher than the generic baseline
    expect(results[0].confidence).toBeGreaterThan(0.5);
  });
});

// ─── assessReferenceSystem ────────────────────────────────────────────────────
describe('assessReferenceSystem', () => {
  it('returns unknown status for empty coords', () => {
    const result = assessReferenceSystem([]);
    expect(result.status).toBe('unknown');
  });

  it('identifies geographic WGS84 as not local', () => {
    const coords = [{ x: 151.2, y: -33.8 }, { x: 150.0, y: -34.0 }];
    const result = assessReferenceSystem(coords);
    expect(result.isLocal).toBe(false);
  });

  it('flags small near-origin projected coords as local/unreferenced', () => {
    // Compact local grid near origin, no metadata
    const coords = [
      { x: 100, y: 200 },
      { x: 150, y: 250 },
      { x: 120, y: 220 },
    ];
    const result = assessReferenceSystem(coords, {});
    expect(['local-unreferenced', 'ambiguous']).toContain(result.status);
  });

  it('returns an object with required fields', () => {
    const coords = [{ x: 151.2, y: -33.8 }];
    const result = assessReferenceSystem(coords);
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('isLocal');
    expect(result).toHaveProperty('isAmbiguous');
    expect(result).toHaveProperty('confidence');
  });
});

// ─── shouldSwapCoordinateAxesForCrs ──────────────────────────────────────────
describe('shouldSwapCoordinateAxesForCrs', () => {
  it('returns a boolean', () => {
    const result = shouldSwapCoordinateAxesForCrs('EPSG:4326', 151.2, -33.8);
    expect(typeof result).toBe('boolean');
  });

  it('does not swap for WGS84 with standard lon/lat order', () => {
    // WGS84 with lon first, lat second — should not require swap
    expect(shouldSwapCoordinateAxesForCrs('EPSG:4326', 151.2, -33.8)).toBe(false);
  });
});

// ─── normalizeCoordinateAxesForCrs ────────────────────────────────────────────
describe('normalizeCoordinateAxesForCrs', () => {
  it('returns a two-element array [x, y]', () => {
    const result = normalizeCoordinateAxesForCrs('EPSG:4326', 151.2, -33.8);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it('preserves x/y when no swap needed', () => {
    const [x, y] = normalizeCoordinateAxesForCrs('EPSG:4326', 151.2, -33.8);
    expect(x).toBe(151.2);
    expect(y).toBe(-33.8);
  });
});
