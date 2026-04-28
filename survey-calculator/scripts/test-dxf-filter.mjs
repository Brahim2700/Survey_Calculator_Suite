/**
 * Test DXF entity type pre-filtering to reduce parse time.
 * Only keeps entity types our renderer actually uses.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseDxfTextContent } from '../src/utils/cadShared.js';

const DXF_PATH = path.join(os.tmpdir(), 'oda-timing-423626393', 'Projet Niglo 3D.dxf');

const hrt = () => Number(process.hrtime.bigint()) / 1e6;

// Entity types our geometry pipeline actually processes
const KEEP_TYPES = new Set([
  'POINT', 'INSERT', 'ATTRIB', 'ATTDEF', 'SEQEND', 'VERTEX',
  'LINE', 'LWPOLYLINE', 'POLYLINE',
  '3DFACE', 'FACE3D', 'MESH', 'PLANESURFACE',
  'TEXT', 'MTEXT', 'DIMENSION',
  'HATCH', '3DLINE',
  // Block section markers — always keep
  'BLOCK', 'ENDBLK',
]);

/**
 * Pre-filter DXF text to keep only KEEP_TYPES entities in ENTITIES and BLOCKS sections.
 * Other sections (HEADER, CLASSES, TABLES, OBJECTS) are passed through unchanged.
 * VERTEX/SEQEND are always kept after a POLYLINE to preserve sequence integrity.
 */
function preFilterDxfEntities(dxfText, keepTypes = KEEP_TYPES) {
  const lines = dxfText.split('\n');
  const out = [];
  let i = 0;
  let inFilterableSection = false; // true when inside ENTITIES or BLOCKS
  let skipCurrentEntity = false;
  let inPolylineSequence = false; // keep VERTEX+SEQEND after POLYLINE

  while (i < lines.length) {
    const codeLine = lines[i];
    const code = codeLine.trim();

    if (code === '0') {
      // Next line is the entity/section value
      const valueLine = lines[i + 1] || '';
      const value = valueLine.trim().toUpperCase();

      if (value === 'SECTION') {
        // Start of a section — look at section name (2 lines ahead)
        const nameCode = (lines[i + 2] || '').trim();
        const nameValue = (lines[i + 3] || '').trim().toUpperCase();
        inFilterableSection = nameCode === '2' && (nameValue === 'ENTITIES' || nameValue === 'BLOCKS');
        skipCurrentEntity = false;
        inPolylineSequence = false;
        out.push(codeLine, valueLine);
        i += 2;
        continue;
      }

      if (value === 'ENDSEC') {
        inFilterableSection = false;
        skipCurrentEntity = false;
        inPolylineSequence = false;
        out.push(codeLine, valueLine);
        i += 2;
        continue;
      }

      if (inFilterableSection) {
        // Entity boundary: decide keep or skip
        const keep = keepTypes.has(value) || inPolylineSequence;
        skipCurrentEntity = !keep;

        // Track POLYLINE sequences (VERTEX+SEQEND must follow)
        if (value === 'POLYLINE') {
          inPolylineSequence = true;
        } else if (value === 'SEQEND') {
          inPolylineSequence = false;
        } else if (inPolylineSequence && value !== 'VERTEX') {
          // Any other entity type ends the polyline sequence
          inPolylineSequence = false;
        }
      }
    }

    if (!skipCurrentEntity) {
      out.push(codeLine);
    }
    i++;
  }

  return out.join('\n');
}

async function main() {
  const text = await fs.readFile(DXF_PATH, 'utf8');
  console.log(`Original DXF: ${(text.length / 1024 / 1024).toFixed(1)} MB, ${text.split('\n').length.toLocaleString()} lines`);

  console.log('\n--- Pre-filtering to keep only renderable entity types ---');
  let t = hrt();
  const filtered = preFilterDxfEntities(text);
  const filterTime = (hrt() - t).toFixed(0);
  console.log(`Filter time: ${filterTime} ms`);
  console.log(`Filtered size: ${(filtered.length / 1024 / 1024).toFixed(1)} MB`);
  console.log(`Reduction: ${((1 - filtered.length / text.length) * 100).toFixed(1)}%`);

  t = hrt();
  try {
    const r = parseDxfTextContent(filtered, { returnPayload: true });
    const parseTime = (hrt() - t).toFixed(0);
    console.log(`Parse time: ${parseTime} ms`);
    console.log(`  rows: ${r.rows.length}, lines: ${r.geometry.lines.length}, polys: ${r.geometry.polylines.length}, surfaces: ${r.geometry.surfaces.length}`);
    console.log(`Total (filter+parse): ${Number(filterTime) + Number(parseTime)} ms`);
  } catch (e) {
    console.error('Parse error:', e.message);
  }
}

main().catch(console.error);
