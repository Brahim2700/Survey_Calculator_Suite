import { collectCadGeometryFromDxf, parseDxfTextContent } from '../src/utils/cadShared.js';

const failures = [];

const assert = (condition, message) => {
  if (!condition) failures.push(message);
};

const buildMinimal3dFaceDxf = () => [
  '0', 'SECTION',
  '2', 'HEADER',
  '0', 'ENDSEC',
  '0', 'SECTION',
  '2', 'ENTITIES',
  '0', '3DFACE',
  '8', 'TIN_SURFACE',
  '10', '0',
  '20', '0',
  '30', '100',
  '11', '10',
  '21', '0',
  '31', '101',
  '12', '10',
  '22', '10',
  '32', '102',
  '13', '0',
  '23', '10',
  '33', '103',
  '0', 'ENDSEC',
  '0', 'EOF',
].join('\n');

const test3dFaceTriangulation = () => {
  const payload = parseDxfTextContent(buildMinimal3dFaceDxf(), { returnPayload: true });
  const surfaces = payload?.geometry?.surfaces || [];
  assert(surfaces.length === 1, `Expected 1 3DFACE surface, received ${surfaces.length}.`);
  const triangleCount = surfaces[0]?.triangles?.length || 0;
  assert(triangleCount === 2, `Expected 2 triangles from quad 3DFACE, received ${triangleCount}.`);
  const notifications = payload?.geometry?.validation?.notifications || [];
  assert(
    notifications.some((item) => item?.code === 'cad-surfaces-imported'),
    'Expected cad-surfaces-imported validation notification for 3DFACE payload.'
  );
};

const testPolyfaceLikeSurfaceExtraction = () => {
  const geometry = collectCadGeometryFromDxf({
    entities: [
      {
        type: 'POLYLINE',
        layer: 'TIN_POLYFACE',
        vertices: [
          { x: 0, y: 0, z: 5 },
          { x: 12, y: 0, z: 6 },
          { x: 12, y: 12, z: 7 },
          { x: 0, y: 12, z: 8 },
          { faceA: 1, faceB: 2, faceC: 3, faceD: 4 },
        ],
      },
    ],
    tables: {
      layer: {
        layers: {
          TIN_POLYFACE: { name: 'TIN_POLYFACE', visible: true },
        },
      },
    },
  });

  const surface = geometry?.surfaces?.[0] || null;
  assert(Boolean(surface), 'Expected polyface-like POLYLINE to produce one surface feature.');
  const triangleCount = surface?.triangles?.length || 0;
  assert(triangleCount === 2, `Expected 2 triangles from polyface quad, received ${triangleCount}.`);
};

const testMeshExtraction = () => {
  const geometry = collectCadGeometryFromDxf({
    entities: [
      {
        type: 'MESH',
        layer: 'TIN_MESH',
        vertices: [
          { x: 0, y: 0, z: 0 },
          { x: 5, y: 0, z: 1 },
          { x: 5, y: 5, z: 2 },
          { x: 0, y: 5, z: 1 },
        ],
        faces: [
          [0, 1, 2],
          [0, 2, 3],
        ],
      },
    ],
    tables: {
      layer: {
        layers: {
          TIN_MESH: { name: 'TIN_MESH', visible: true },
        },
      },
    },
  });

  const surfaces = geometry?.surfaces || [];
  assert(surfaces.length === 1, `Expected one MESH-derived surface, received ${surfaces.length}.`);
  const triangles = surfaces[0]?.triangles?.length || 0;
  assert(triangles === 2, `Expected 2 mesh triangles, received ${triangles}.`);
};

const run = () => {
  test3dFaceTriangulation();
  testPolyfaceLikeSurfaceExtraction();
  testMeshExtraction();

  if (failures.length > 0) {
    console.error('cad-surface-regression failed:');
    failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
    process.exit(1);
  }

  console.log('cad-surface-regression passed (3 tests).');
};

run();
