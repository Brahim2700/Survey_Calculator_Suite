/**
 * Inspect ODA DXF output for the 8MB file to find EOF format issues.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ODA = 'C:\\Program Files\\ODA\\ODAFileConverter 27.1.0\\ODAFileConverter.exe';
const inp = path.resolve(__dirname, '../public/samples');
const out = path.join(tmpdir(), 'oda-test-out-' + Date.now());

await fs.mkdir(out, { recursive: true });
console.log('Converting...');
try {
  execSync(`"${ODA}" "${inp}" "${out}" ACAD2018 DXF 0 0 "RD561-dessin_fondsPlan.dwg"`, { timeout: 90000, stdio: 'pipe' });
} catch (err) {
  console.warn('ODA exit non-zero:', err.message?.slice(0, 100));
}

const files = await fs.readdir(out);
console.log('Output files:', files);

const dxf = files.find((f) => f.toLowerCase().endsWith('.dxf'));
if (!dxf) {
  console.error('No DXF file produced!');
  process.exit(1);
}

const content = await fs.readFile(path.join(out, dxf), 'utf8');
console.log('DXF size:', content.length, 'chars,', (content.length / 1024 / 1024).toFixed(1), 'MB');

// Find ALL occurrences of "EOF" keyword as a value
let pos = 0;
let eofCount = 0;
while (true) {
  const idx = content.indexOf('EOF', pos);
  if (idx === -1) break;
  eofCount++;
  console.log(`EOF occurrence #${eofCount} at index ${idx} of ${content.length}:`);
  console.log('  Context:', JSON.stringify(content.slice(Math.max(0, idx - 30), idx + 30)));
  pos = idx + 1;
  if (eofCount >= 5) break;
}

console.log('\nLAST 300 CHARS:', JSON.stringify(content.slice(-300)));
