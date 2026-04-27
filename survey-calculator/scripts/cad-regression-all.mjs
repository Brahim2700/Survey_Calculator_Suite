/**
 * Master CAD regression test runner: validates parser across unit, fixture, and integration levels.
 */

import { execSync } from 'child_process';

const tests = [
  {
    name: 'Unit Surface Extraction',
    script: 'npm run test:cad:surfaces',
    description: '3DFACE/polyface/mesh/planesurface triangulation and metadata preservation.',
  },
  {
    name: 'Fixture Mixed Geometry',
    script: 'npm run test:cad:surfaces:fixture',
    description: 'Real-world DXF with lines, 3DFACE, PLANESURFACE, and 3DLINE entities.',
  },
  {
    name: 'CRS Detection (Regression)',
    script: 'npm run test:crs:regression',
    description: 'Ensure surface changes did not break CRS detection logic.',
  },
];

const run = () => {
  console.log('\n=== CAD Regression Test Suite ===\n');
  let passed = 0;
  let failed = 0;
  const results = [];

  for (const test of tests) {
    console.log(`[${tests.indexOf(test) + 1}/${tests.length}] Running: ${test.name}`);
    console.log(`    ${test.description}`);
    try {
      execSync(test.script, { stdio: 'pipe' });
      console.log(`    ✓ PASSED\n`);
      passed += 1;
      results.push({ name: test.name, status: 'PASSED' });
    } catch (err) {
      console.error(`    ✗ FAILED`);
      console.error(`    ${err.message}\n`);
      failed += 1;
      results.push({ name: test.name, status: 'FAILED' });
    }
  }

  console.log('=== Summary ===');
  console.log(`Passed: ${passed}/${tests.length}`);
  console.log(`Failed: ${failed}/${tests.length}`);
  results.forEach((r) => console.log(`  ${r.status}: ${r.name}`));
  console.log();

  process.exit(failed > 0 ? 1 : 0);
};

run();
