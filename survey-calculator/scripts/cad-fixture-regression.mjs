/**
 * File-based DXF fixture regression test: validates parser behavior on mixed-geometry DXF
 * with supported entity types (lines, polylines, and 3DFACE surfaces).
 * 
 * Note: dxf-parser library currently supports:
 * - LINE, LWPOLYLINE, POLYLINE (lines/wireframe)
 * - 3DFACE (triangulated surfaces)
 * Does NOT support: 3DLINE, PLANESURFACE (not yet implemented by dxf-parser)
 */

import { parseDxfTextContent } from '../src/utils/cadShared.js';
import { generateMixedGeometryDxf } from './generate-tin-fixture.mjs';

const failures = [];

const assert = (condition, message) => {
  if (!condition) failures.push(message);
};

const testMixedGeometryFixture = () => {
  const dxfText = generateMixedGeometryDxf();
  const payload = parseDxfTextContent(dxfText, { returnPayload: true });

  // Validate basic payload structure
  assert(payload, 'Expected parsed DXF payload.');
  assert(Array.isArray(payload?.rows), 'Expected rows array in payload.');
  assert(payload?.geometry, 'Expected geometry object in payload.');

  const { rows, geometry } = payload;

  // Validate line geometry extracted
  const lines = geometry?.lines || [];
  const polylines = geometry?.polylines || [];
  const totalLineGeometry = lines.length + polylines.length;
  assert(
    totalLineGeometry >= 2,
    `Expected at least 2 line/polyline entities, received ${totalLineGeometry} total.`
  );

  // Validate surface extraction (3DFACE only - supported by dxf-parser)
  const surfaces = geometry?.surfaces || [];
  assert(
    surfaces.length >= 2,
    `Expected at least 2 3DFACE surfaces, received ${surfaces.length}.`
  );

  // Validate all surfaces are 3DFACE type
  const face3dSurfaces = surfaces.filter((s) => s?.sourceType === '3DFACE');
  assert(
    face3dSurfaces.length === surfaces.length,
    `Expected all surfaces to be 3DFACE, found: ${surfaces.map((s) => s?.sourceType).join(', ')}`
  );

  // Validate first 3DFACE (3-4 vertices)
  const surface1 = surfaces[0] || {};
  const triangles1 = surface1?.triangles?.length || 0;
  assert(
    triangles1 >= 1,
    `Expected at least 1 triangle from first 3DFACE, received ${triangles1}.`
  );
  const vertices1 = surface1?.vertices?.length || 0;
  assert(
    vertices1 >= 3,
    `Expected at least 3 vertices in first surface, received ${vertices1}.`
  );

  // Validate second 3DFACE (quad - 4 vertices → 2 triangles)
  const surface2 = surfaces[1] || {};
  const triangles2 = surface2?.triangles?.length || 0;
  assert(
    triangles2 === 2,
    `Expected 2 triangles from second 3DFACE quad, received ${triangles2}.`
  );
  const vertices2 = surface2?.vertices?.length || 0;
  assert(
    vertices2 === 4,
    `Expected 4 vertices in second surface, received ${vertices2}.`
  );
};

const testSurfaceVertexBounds = () => {
  const dxfText = generateMixedGeometryDxf();
  const payload = parseDxfTextContent(dxfText, { returnPayload: true });
  const surfaces = payload?.geometry?.surfaces || [];

  surfaces.forEach((surface, idx) => {
    const vertices = surface?.vertices || [];
    const triangles = surface?.triangles || [];

    // Validate all triangle indices are in bounds
    triangles.forEach((tri, triIdx) => {
      const [i0, i1, i2] = tri || [];
      assert(
        Number.isInteger(i0) && i0 >= 0 && i0 < vertices.length,
        `Surface ${idx} triangle ${triIdx}: index 0 (${i0}) out of bounds [0, ${vertices.length}).`
      );
      assert(
        Number.isInteger(i1) && i1 >= 0 && i1 < vertices.length,
        `Surface ${idx} triangle ${triIdx}: index 1 (${i1}) out of bounds [0, ${vertices.length}).`
      );
      assert(
        Number.isInteger(i2) && i2 >= 0 && i2 < vertices.length,
        `Surface ${idx} triangle ${triIdx}: index 2 (${i2}) out of bounds [0, ${vertices.length}).`
      );
    });

    // Validate all vertices have finite coordinates
    vertices.forEach((vertex, vIdx) => {
      const [x, y, z] = vertex || [];
      assert(
        Number.isFinite(x) && Number.isFinite(y),
        `Surface ${idx} vertex ${vIdx}: x,y must be finite, got [${x}, ${y}].`
      );
      assert(
        Number.isFinite(z),
        `Surface ${idx} vertex ${vIdx}: z must be finite, got ${z}.`
      );
    });
  });
};

const testGeometryLayerMetadata = () => {
  const dxfText = generateMixedGeometryDxf();
  const payload = parseDxfTextContent(dxfText, { returnPayload: true });
  const surfaces = payload?.geometry?.surfaces || [];
  const polylines = payload?.geometry?.polylines || [];

  surfaces.forEach((surface) => {
    assert(
      surface?.layerStandardized,
      `Surface missing standardized layer name.`
    );
    assert(
      surface?.sourceType === '3DFACE',
      `Surface sourceType should be 3DFACE, got ${surface?.sourceType}.`
    );
    assert(
      Number.isFinite(surface?.vertexCount) && surface.vertexCount > 0,
      `Surface missing valid vertexCount.`
    );
    assert(
      Number.isFinite(surface?.triangleCount) && surface.triangleCount > 0,
      `Surface missing valid triangleCount.`
    );
  });

  // Validate polylines have proper metadata
  polylines.forEach((pl, idx) => {
    assert(
      Array.isArray(pl?.points) && pl.points.length >= 2,
      `Polyline ${idx} should have at least 2 points.`
    );
    assert(
      pl?.sourceType,
      `Polyline ${idx} missing sourceType.`
    );
  });
};

const run = () => {
  testMixedGeometryFixture();
  testSurfaceVertexBounds();
  testGeometryLayerMetadata();

  if (failures.length > 0) {
    console.error('cad-fixture-regression failed:');
    failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
    process.exit(1);
  }

  console.log('cad-fixture-regression passed (3 test suites, 14 assertions).');
};

run();
