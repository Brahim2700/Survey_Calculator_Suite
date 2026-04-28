import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import DxfParser from 'dxf-parser';

const dxfPath = tmpdir() + '/oda-timing-423626393/Projet Niglo 3D.dxf';
const text = await readFile(dxfPath, 'utf8');
console.log('File size:', text.length, 'chars');

const MAX_DXF_ENTITY_GROUPS = 150000;
const DXF_SIZE_THRESHOLD_BYTES = 20 * 1024 * 1024;

function findDxfSectionBodyStart(t, name) {
  const upper = name.toUpperCase();
  const re = new RegExp(
    '\\r?\\n[ \\t]*0[ \\t]*\\r?\\n[ \\t]*SECTION[ \\t]*\\r?\\n[ \\t]*2[ \\t]*\\r?\\n[ \\t]*' +
    upper + '[ \\t]*\\r?\\n', 'i'
  );
  const m = re.exec(t);
  if (!m) return -1;
  return m.index + m[0].length;
}

const bodyStart = findDxfSectionBodyStart(text, 'ENTITIES');
console.log('bodyStart:', bodyStart);
console.log('text around bodyStart:', JSON.stringify(text.slice(bodyStart - 40, bodyStart + 40)));

const crlf = text.includes('\r\n');
const nl = crlf ? '\r\n' : '\n';
console.log('crlf:', crlf);

let pos = bodyStart;
let entityGroups = 0;
const textLen = text.length;
let truncatePos = -1;

while (pos < textLen) {
  const codeLineEnd = text.indexOf('\n', pos);
  if (codeLineEnd === -1) break;
  const codeLine = text.slice(pos, codeLineEnd).trim();

  const valStart = codeLineEnd + 1;
  const valLineEnd = text.indexOf('\n', valStart);
  const valLine = valLineEnd === -1
    ? text.slice(valStart).trim()
    : text.slice(valStart, valLineEnd).trim();

  if (codeLine === '0') {
    const kw = valLine.toUpperCase().replace(/\r$/, '');
    if (kw === 'ENDSEC') { console.log('Hit ENDSEC at entity', entityGroups); break; }
    if (kw === 'EOF') { console.log('Hit EOF at entity', entityGroups); break; }
    entityGroups++;
    if (entityGroups === 1) console.log('First entity type:', valLine, 'at pos:', pos);
    if (entityGroups > MAX_DXF_ENTITY_GROUPS) {
      truncatePos = pos;
      break;
    }
  }
  pos = valLineEnd === -1 ? textLen : valLineEnd + 1;
}

console.log('entityGroups counted:', entityGroups);
console.log('truncatePos:', truncatePos);

if (truncatePos >= 0) {
  const prefix = text.slice(0, truncatePos);
  const suffix = `  0${nl}ENDSEC${nl}  0${nl}EOF${nl}`;
  const result = prefix + suffix;
  console.log('prefix size:', prefix.length);
  console.log('result size:', result.length);
  // Show chars around the boundary
  console.log('CHARS before truncate (last 150):', JSON.stringify(prefix.slice(-150)));
  console.log('suffix repr:', JSON.stringify(suffix));
  console.log('RESULT END (last 150):', JSON.stringify(result.slice(-150)));

  const parser = new DxfParser();
  try {
    const dxf = parser.parseSync(result);
    console.log('PARSE SUCCESS! Entities:', dxf.entities ? dxf.entities.length : '?');
  } catch(e) {
    console.error('PARSE ERROR:', e.message);
  }
} else {
  console.log('Limit not hit — total entities:', entityGroups);
}
