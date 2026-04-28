/**
 * Test DXF section stripping for parse speedup.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseDxfTextContent } from '../src/utils/cadShared.js';

const DXF_PATH = path.join(os.tmpdir(), 'oda-timing-423626393', 'Projet Niglo 3D.dxf');

const hrt = () => Number(process.hrtime.bigint()) / 1e6;

/**
 * Strip a named SECTION from a DXF text. Each section is delimited by:
 *   (group 0 = SECTION) ... (group 2 = NAME) ... (group 0 = ENDSEC)
 */
function stripDxfSection(dxfText, sectionName) {
  // Split into lines and find section boundaries
  const lines = dxfText.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const code = lines[i].trim();
    const value = (lines[i + 1] || '').trim().toUpperCase();
    // Detect start of SECTION
    if (code === '0' && value === 'SECTION') {
      const nameCode = (lines[i + 2] || '').trim();
      const nameValue = (lines[i + 3] || '').trim().toUpperCase();
      if (nameCode === '2' && nameValue === sectionName.toUpperCase()) {
        // Skip until ENDSEC
        i += 4;
        while (i < lines.length) {
          const c = lines[i].trim();
          const v = (lines[i + 1] || '').trim().toUpperCase();
          if (c === '0' && v === 'ENDSEC') {
            i += 2; // skip past ENDSEC
            break;
          }
          i++;
        }
        continue;
      }
    }
    out.push(lines[i]);
    i++;
  }
  return out.join('\n');
}

async function main() {
  const text = await fs.readFile(DXF_PATH, 'utf8');
  console.log(`Original DXF: ${(text.length / 1024 / 1024).toFixed(1)} MB, ${text.split('\n').length} lines`);

  // Count section line ranges to understand which sections are heaviest
  const lines = text.split('\n');
  const sections = {};
  let currentSection = null;
  let sectionStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i].trim();
    const value = (lines[i + 1] || '').trim().toUpperCase();
    if (code === '0' && value === 'SECTION') {
      const nameCode = (lines[i + 2] || '').trim();
      const nameValue = (lines[i + 3] || '').trim().toUpperCase();
      if (nameCode === '2') {
        currentSection = nameValue;
        sectionStart = i;
      }
    } else if (code === '0' && value === 'ENDSEC' && currentSection) {
      sections[currentSection] = (sections[currentSection] || 0) + (i - sectionStart);
      currentSection = null;
    }
  }
  console.log('\nSection line counts:');
  Object.entries(sections).sort((a, b) => b[1] - a[1]).forEach(([name, count]) => {
    console.log(`  ${name.padEnd(15)} ${count.toLocaleString()} lines (${(count / lines.length * 100).toFixed(1)}%)`);
  });

  // Try stripping OBJECTS
  console.log('\n--- Stripping OBJECTS ---');
  let t = hrt();
  const noObjects = stripDxfSection(text, 'OBJECTS');
  console.log(`Strip time: ${(hrt() - t).toFixed(0)} ms, new size: ${(noObjects.length / 1024 / 1024).toFixed(1)} MB`);

  t = hrt();
  try {
    const r = parseDxfTextContent(noObjects, { returnPayload: true });
    console.log(`Parse time: ${(hrt() - t).toFixed(0)} ms`);
    console.log(`  rows: ${r.rows.length}, lines: ${r.geometry.lines.length}, polys: ${r.geometry.polylines.length}, surfaces: ${r.geometry.surfaces.length}`);
  } catch (e) {
    console.error('Parse error:', e.message);
  }

  // Try stripping OBJECTS + CLASSES
  console.log('\n--- Stripping OBJECTS + CLASSES ---');
  const noObjClass = stripDxfSection(noObjects, 'CLASSES');
  console.log(`New size: ${(noObjClass.length / 1024 / 1024).toFixed(1)} MB`);

  t = hrt();
  try {
    const r = parseDxfTextContent(noObjClass, { returnPayload: true });
    console.log(`Parse time: ${(hrt() - t).toFixed(0)} ms`);
    console.log(`  rows: ${r.rows.length}, lines: ${r.geometry.lines.length}, polys: ${r.geometry.polylines.length}, surfaces: ${r.geometry.surfaces.length}`);
  } catch (e) {
    console.error('Parse error:', e.message);
  }
}

main().catch(console.error);
