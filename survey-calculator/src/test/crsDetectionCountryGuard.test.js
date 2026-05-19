import { describe, expect, it } from 'vitest';
import { detectCRS } from '../utils/crsDetection.js';

describe('CRS country disambiguation guard', () => {
  it('keeps French CC candidates ahead of Monte Mario on overlapping projected ranges', () => {
    const coordinates = [
      { x: 1682400, y: 4691200 },
      { x: 1682650, y: 4691450 },
      { x: 1682900, y: 4691100 },
      { x: 1682100, y: 4690850 },
      { x: 1682750, y: 4691650 },
      { x: 1682450, y: 4690900 },
    ];

    const suggestions = detectCRS(coordinates, {});
    const firstItalianIndex = suggestions.findIndex((s) => s.code === 'EPSG:3003' || s.code === 'EPSG:3004');
    const firstFrenchIndex = suggestions.findIndex((s) => /^(EPSG:(394[2-9]|3950|2154|98\d\d|2756[1-4]|27572))$/.test(String(s?.code || '')));

    expect(firstFrenchIndex).toBeGreaterThanOrEqual(0);
    if (firstItalianIndex >= 0) {
      expect(firstFrenchIndex).toBeLessThan(firstItalianIndex);
    }
  });
});
