import { describe, it, expect } from 'vitest';
import {
  formatDMS,
  calculateSlopeDistance,
  calculateHorizontalDistance,
  calculateVerticalAngle,
  calculateGridDistance,
  calculateUTMScaleFactor,
  getUTMZone,
  getUTMCentralMeridian,
  calculateElevationFactor,
  calculateGroundDistance,
  calculateGeodesicDistance,
} from './calculations';

// ─── formatDMS ───────────────────────────────────────────────────────────────
describe('formatDMS', () => {
  it('formats integer degrees correctly', () => {
    expect(formatDMS(45)).toBe("45° 0' 0.00\"");
  });

  it('formats 90 degrees', () => {
    expect(formatDMS(90)).toBe("90° 0' 0.00\"");
  });

  it('formats a negative value using its absolute value', () => {
    const result = formatDMS(-33.8688);
    expect(result).toMatch(/^33°/);
  });

  it('formats a value with minutes and seconds', () => {
    // 1.5° = 1° 30' 0.00"
    expect(formatDMS(1.5)).toBe("1° 30' 0.00\"");
  });
});

// ─── calculateSlopeDistance ───────────────────────────────────────────────────
describe('calculateSlopeDistance', () => {
  it('calculates 3D Pythagorean distance', () => {
    const d = calculateSlopeDistance(
      { x: 0, y: 0, z: 0 },
      { x: 3, y: 4, z: 0 },
    );
    expect(d).toBeCloseTo(5, 6);
  });

  it('includes vertical component', () => {
    // 3-4-5 in XY plane, +0 Z → 5; add Z=12 → 13
    const d = calculateSlopeDistance(
      { x: 0, y: 0, z: 0 },
      { x: 3, y: 4, z: 12 },
    );
    expect(d).toBeCloseTo(13, 6);
  });

  it('returns 0 for identical points', () => {
    expect(calculateSlopeDistance({ x: 5, y: 5, z: 5 }, { x: 5, y: 5, z: 5 })).toBe(0);
  });
});

// ─── calculateHorizontalDistance ─────────────────────────────────────────────
describe('calculateHorizontalDistance', () => {
  it('ignores Z axis', () => {
    const d = calculateHorizontalDistance({ x: 0, y: 0, z: 100 }, { x: 3, y: 4, z: 9999 });
    expect(d).toBeCloseTo(5, 6);
  });

  it('works with easting/northing aliases', () => {
    const d = calculateHorizontalDistance(
      { e: 0, n: 0 },
      { e: 6, n: 8 },
    );
    expect(d).toBeCloseTo(10, 6);
  });
});

// ─── calculateVerticalAngle ───────────────────────────────────────────────────
describe('calculateVerticalAngle', () => {
  it('returns 0 for zero slope distance', () => {
    expect(calculateVerticalAngle(0, 0)).toBe(0);
  });

  it('returns 0° when slope equals horizontal (level)', () => {
    expect(calculateVerticalAngle(10, 10)).toBeCloseTo(0, 4);
  });

  it('returns 90° when horizontal distance is 0 (vertical)', () => {
    expect(calculateVerticalAngle(10, 0)).toBeCloseTo(90, 4);
  });
});

// ─── getUTMZone ───────────────────────────────────────────────────────────────
describe('getUTMZone', () => {
  it('returns zone 1 for longitude -179', () => {
    expect(getUTMZone(-179)).toBe(1);
  });

  it('returns zone 31 for London (~0°)', () => {
    expect(getUTMZone(0)).toBe(31);
  });

  it('returns zone 56 for Sydney (~151°)', () => {
    // Sydney CBD is at ~151.2°E → floor((151+180)/6)+1 = floor(55.17)+1 = 56
    expect(getUTMZone(151)).toBe(56);
  });

  it('returns zone 60 for longitude 179', () => {
    expect(getUTMZone(179)).toBe(60);
  });
});

// ─── getUTMCentralMeridian ────────────────────────────────────────────────────
describe('getUTMCentralMeridian', () => {
  it('returns -177 for zone 1', () => {
    expect(getUTMCentralMeridian(1)).toBe(-177);
  });

  it('returns 3 for zone 31', () => {
    expect(getUTMCentralMeridian(31)).toBe(3);
  });

  it('returns 177 for zone 60', () => {
    expect(getUTMCentralMeridian(60)).toBe(177);
  });
});

// ─── calculateElevationFactor ─────────────────────────────────────────────────
describe('calculateElevationFactor', () => {
  it('returns 1 at sea level', () => {
    expect(calculateElevationFactor(0)).toBeCloseTo(1, 9);
  });

  it('returns slightly > 1 for positive elevation', () => {
    expect(calculateElevationFactor(1000)).toBeGreaterThan(1);
  });

  it('is proportional to elevation over radius', () => {
    const R = 6378137;
    expect(calculateElevationFactor(R)).toBeCloseTo(2, 5);
  });
});

// ─── calculateGroundDistance ──────────────────────────────────────────────────
describe('calculateGroundDistance', () => {
  it('returns grid distance when both factors are 1', () => {
    expect(calculateGroundDistance(100, 1, 1)).toBe(100);
  });

  it('scales by both factors', () => {
    expect(calculateGroundDistance(100, 0.9996, 1.0001)).toBeCloseTo(99.97, 1);
  });
});

// ─── calculateGeodesicDistance ───────────────────────────────────────────────
describe('calculateGeodesicDistance', () => {
  it('returns ~0 for identical points', () => {
    const r = calculateGeodesicDistance(48.8566, 2.3522, 48.8566, 2.3522);
    expect(r.distance).toBeCloseTo(0, 1);
  });

  it('calculates Paris→London within ±5 km of known value (~344 km)', () => {
    // Paris: 48.8566, 2.3522 | London: 51.5074, -0.1278 → ~343.9 km
    const r = calculateGeodesicDistance(48.8566, 2.3522, 51.5074, -0.1278);
    expect(r.distance).toBeGreaterThan(340000);
    expect(r.distance).toBeLessThan(348000);
  });

  it('calculates Sydney→Auckland within ±5 km (~2155 km)', () => {
    // Sydney: -33.8688, 151.2093 | Auckland: -36.8485, 174.7633
    const r = calculateGeodesicDistance(-33.8688, 151.2093, -36.8485, 174.7633);
    expect(r.distance).toBeGreaterThan(2150000);
    expect(r.distance).toBeLessThan(2165000);
  });

  it('returns forwardAzimuth in [0, 360)', () => {
    const r = calculateGeodesicDistance(48.8566, 2.3522, 51.5074, -0.1278);
    expect(r.forwardAzimuth).toBeGreaterThanOrEqual(0);
    expect(r.forwardAzimuth).toBeLessThan(360);
  });
});
