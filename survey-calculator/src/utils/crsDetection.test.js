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
    expect(results[0].code).toBe('EPSG:4326');
  });

  it('keeps projected UTM candidates ahead of EPSG:4326 for UTM-metric coordinates', () => {
    // Typical UTM zone 31N metric coordinates (meters)
    const coords = [
      { x: 500000, y: 4649776 },
      { x: 500120, y: 4649901 },
      { x: 499880, y: 4649651 },
    ];

    const results = detectCRS(coords);
    expect(results.length).toBeGreaterThan(0);
    const topCode = String(results[0].code || '');
    expect(/^EPSG:(326|327)\d{2}$/.test(topCode) || /^EPSG:258(2\d|3[0-2])$/.test(topCode)).toBe(true);

    const wgs84 = results.find((entry) => entry.code === 'EPSG:4326');
    if (wgs84) {
      expect(Number(wgs84.confidence || 0)).toBeLessThan(Number(results[0].confidence || 1));
    }
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

  it('keeps CC46 above Monte Mario zone 1 for CC46-like coordinates', () => {
    // Typical RGF93 / CC46 magnitudes (France)
    const coords = [
      { x: 1702000, y: 5203000 },
      { x: 1702600, y: 5203600 },
      { x: 1701800, y: 5202800 },
    ];

    const results = detectCRS(coords);
    expect(results.length).toBeGreaterThan(0);

    const cc46 = results.find((r) => r.code === 'EPSG:3946');
    const italy1 = results.find((r) => r.code === 'EPSG:3003');

    expect(cc46).toBeTruthy();
    if (italy1 && cc46) {
      expect(Number(cc46.confidence || 0)).toBeGreaterThan(Number(italy1.confidence || 0));
    }
    expect(results[0].code).not.toBe('EPSG:3003');
  });

  it('downranks Monte Mario when French CC and Monte Mario overlap are both plausible', () => {
    // This pattern can match both EPSG:3003 and French CC families by extents only.
    // Guard should avoid legacy Monte Mario winning by default.
    const coords = [
      { x: 1702000, y: 5203000 },
      { x: 1702600, y: 5203600 },
      { x: 1701800, y: 5202800 },
    ];

    const results = detectCRS(coords);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].code).not.toBe('EPSG:3003');

    const bestFrenchCc = results.find((r) => /^EPSG:39(4[2-9]|50)$/.test(String(r.code || '')));
    const monteMario = results.find((r) => r.code === 'EPSG:3003');
    expect(bestFrenchCc).toBeTruthy();
    if (bestFrenchCc && monteMario) {
      expect(Number(bestFrenchCc.confidence || 0)).toBeGreaterThan(Number(monteMario.confidence || 0));
    }
  });

  it('keeps Monte Mario zone 1 first for Italy-like projected data', () => {
    const coords = [
      { x: 1532400, y: 5041900 },
      { x: 1533100, y: 5042600 },
      { x: 1531800, y: 5041300 },
    ];

    const results = detectCRS(coords);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].code).toBe('EPSG:3003');
  });

  it('keeps old French Lambert III and IV candidates in top suggestions', () => {
    const lambertIII = [
      { x: 586474.96, y: 168623.33 },
      { x: 588089.63, y: 169711.61 },
      { x: 584861.43, y: 167261.00 },
    ];
    const lambertIV = [
      { x: 601099.88, y: 127941.20 },
      { x: 602783.12, y: 129061.14 },
      { x: 599419.06, y: 126541.62 },
    ];

    const lambertIIIResults = detectCRS(lambertIII).slice(0, 5).map((entry) => entry.code);
    const lambertIVResults = detectCRS(lambertIV).slice(0, 5).map((entry) => entry.code);

    expect(lambertIIIResults).toContain('EPSG:27563');
    expect(lambertIVResults).toContain('EPSG:27564');
  });

  it('keeps ETRS89 / LAEA Europe below French national candidates for France-like projected data', () => {
    const coords = [
      { x: 1702000, y: 5203000 },
      { x: 1702600, y: 5203600 },
      { x: 1701800, y: 5202800 },
    ];

    const results = detectCRS(coords);
    const laea = results.find((r) => r.code === 'EPSG:3035');
    const bestFrench = results.find((r) => /^EPSG:(2154|39(4[2-9]|50))$/.test(String(r.code || '')));

    expect(bestFrench).toBeTruthy();
    if (laea && bestFrench) {
      expect(Number(bestFrench.confidence || 0)).toBeGreaterThan(Number(laea.confidence || 0));
    }
    expect(results[0].code).not.toBe('EPSG:3035');
  });

  it('uses CC zone token from file name metadata to prioritize French CC45', () => {
    const coords = [
      { x: 1702000, y: 5203000 },
      { x: 1702600, y: 5203600 },
      { x: 1701800, y: 5202800 },
    ];

    const results = detectCRS(coords, { fileName: 'FDP-plan de RSD IND D MOTER-CC45.dwg' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].code).toBe('EPSG:3945');
  });

  it('ranks CC46 first for the reported France sample point instead of Italy/WebMercator', () => {
    // Reported real-world point from a French CC46 DWG upload.
    const coords = [{ x: 1840998, y: 5164960 }];

    const results = detectCRS(coords, { fileName: 'PMP 1910-461 TER IND-A Parking Boutan.dwg' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].code).toBe('EPSG:3946');

    const italy1 = results.find((r) => r.code === 'EPSG:3003');
    const webMercator = results.find((r) => r.code === 'EPSG:3857');
    const cc46 = results.find((r) => r.code === 'EPSG:3946');
    expect(cc46).toBeTruthy();

    if (italy1 && cc46) {
      expect(Number(cc46.confidence || 0)).toBeGreaterThan(Number(italy1.confidence || 0));
    }
    if (webMercator && cc46) {
      expect(Number(cc46.confidence || 0)).toBeGreaterThan(Number(webMercator.confidence || 0));
    }
  });

  it('ranks CC47 first for the reported point instead of Lambert-93', () => {
    const coords = [{ x: 1420065, y: 6219491 }];

    const results = detectCRS(coords, { fileName: 'VezinsCesbronBlaiteauPTF.dwg' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].code).toBe('EPSG:3947');

    const lambert93 = results.find((r) => r.code === 'EPSG:2154');
    const cc47 = results.find((r) => r.code === 'EPSG:3947');
    expect(cc47).toBeTruthy();
    if (lambert93 && cc47) {
      expect(Number(cc47.confidence || 0)).toBeGreaterThan(Number(lambert93.confidence || 0));
    }
  });

  it('does not treat plain file names as authoritative CRS metadata', () => {
    const coords = [
      { x: 1702000, y: 5203000 },
      { x: 1702600, y: 5203600 },
      { x: 1701800, y: 5202800 },
    ];

    const withPlainName = detectCRS(coords, { fileName: 'Fini-BassinBR10.dwg' });
    const withoutName = detectCRS(coords, {});

    expect(withPlainName.length).toBeGreaterThan(0);
    expect(withoutName.length).toBeGreaterThan(0);

    // Plain names should not disable France/overlap disambiguation.
    expect(withPlainName[0].code).toBe(withoutName[0].code);
    expect(withPlainName[0].code).not.toBe('EPSG:3003');
  });

  it('does not lock inferred italy area from a single overlap candidate', () => {
    const coords = [
      { x: 1702000, y: 5203000 },
      { x: 1702600, y: 5203600 },
      { x: 1701800, y: 5202800 },
    ];

    const results = detectCRS(coords, {});
    const monteMario = results.find((r) => r.code === 'EPSG:3003');
    if (monteMario) {
      expect(String(monteMario.reason || '')).not.toContain('outside inferred italy area');
      expect(String(monteMario.reason || '')).not.toContain('country mismatch with inferred italy');
    }
  });

  it('detects Belgian Lambert 72 from typical projected range', () => {
    // Belgian Lambert 72 (EPSG:31370) style coordinates near Brussels
    const coords = [
      { x: 148700, y: 171000 },
      { x: 149100, y: 171300 },
      { x: 148200, y: 170600 },
    ];
    const results = detectCRS(coords);
    const codes = results.map((r) => r.code);
    expect(codes.some((c) => c === 'EPSG:31370')).toBe(true);
  });

  it('detects Belgian Lambert 2008 from typical projected range', () => {
    const coords = [
      { x: 648700, y: 671000 },
      { x: 649200, y: 671300 },
      { x: 648100, y: 670700 },
    ];
    const results = detectCRS(coords);
    const codes = results.map((r) => r.code);
    expect(codes.some((c) => c === 'EPSG:3812')).toBe(true);
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
