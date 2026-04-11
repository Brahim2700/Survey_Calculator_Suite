#!/usr/bin/env node
/**
 * generate-sample-dxf.mjs
 *
 * Generates a realistic georeferenced DXF urban plan in EPSG:2154 (Lambert-93)
 * representing a ~420×330m urban block near Saint-Denis, north of Paris, France.
 *
 * Layers  : LIMITE_ZONE · ROUTES · TROTTOIRS · BATIMENTS ·
 *           PARCELLES · ESPACES_VERTS · RESEAUX · POINTS_TOPO · ANNOTATIONS
 * Geometry: closed polylines (buildings, parcels, green spaces, zone boundary)
 *           open polylines   (roads, sidewalks, utility networks)
 *           POINT entities   (15 survey markers)
 *           TEXT  entities   (survey labels)
 *
 * Run  : node scripts/generate-sample-dxf.mjs
 * Output: public/samples/sample_urban_plan_l93.dxf
 */

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(__dirname, '../public/samples/sample_urban_plan_l93.dxf');

// ─── Handle counter ───────────────────────────────────────────────────────────
let _h = 0x50;
const nextH = () => (_h++).toString(16).toUpperCase();

// ─── Output buffer ────────────────────────────────────────────────────────────
const lines = [];

// Each pair of args becomes one group-code line + one value line
const emit = (...args) => {
  for (let i = 0; i < args.length; i += 2) {
    lines.push(String(args[i]));
    lines.push(String(args[i + 1]));
  }
};

// ─── Entity helpers ───────────────────────────────────────────────────────────

function lwpolyline(layer, vertices, closed = false) {
  emit(
    '  0', 'LWPOLYLINE',
    '  5', nextH(),
    '100', 'AcDbEntity',
    '  8', layer,
    '100', 'AcDbPolyline',
    ' 90', vertices.length,
    ' 70', closed ? 1 : 0,
    ' 43', '0.0'
  );
  for (const [x, y] of vertices) {
    emit(' 10', x.toFixed(3), ' 20', y.toFixed(3));
  }
}

function pointEnt(layer, x, y) {
  emit(
    '  0', 'POINT',
    '  5', nextH(),
    '100', 'AcDbEntity',
    '  8', layer,
    '100', 'AcDbPoint',
    ' 10', x.toFixed(3),
    ' 20', y.toFixed(3),
    ' 30', '0.000'
  );
}

function textEnt(layer, x, y, height, txt) {
  emit(
    '  0', 'TEXT',
    '  5', nextH(),
    '100', 'AcDbEntity',
    '  8', layer,
    '100', 'AcDbText',
    ' 10', x.toFixed(3),
    ' 20', y.toFixed(3),
    ' 30', '0.000',
    ' 40', height,
    '  1', txt,
    '100', 'AcDbText'
  );
}

// ─── Layer definitions ────────────────────────────────────────────────────────
const LAYERS = [
  { name: '0',             color: 7  }, // white / default
  { name: 'LIMITE_ZONE',   color: 6  }, // magenta  – overall boundary
  { name: 'ROUTES',        color: 1  }, // red       – road centre-lines
  { name: 'TROTTOIRS',     color: 8  }, // dark grey – sidewalks / kerbs
  { name: 'BATIMENTS',     color: 2  }, // yellow    – building footprints
  { name: 'PARCELLES',     color: 3  }, // green     – property lots
  { name: 'ESPACES_VERTS', color: 62 }, // olive     – parks / gardens
  { name: 'RESEAUX',       color: 4  }, // cyan      – utility networks
  { name: 'POINTS_TOPO',   color: 7  }, // white     – survey points
  { name: 'ANNOTATIONS',   color: 5  }, // blue      – point labels
];

// ─── HEADER ───────────────────────────────────────────────────────────────────
emit('999', '$EPSG=2154');
emit('999', 'Projection: Lambert-93 (RGF93/IGN69) – France metropolitaine');
emit('999', 'Zone: ~420 x 330 m – Secteur Saint-Denis, Ile-de-France');
emit('  0', 'SECTION');
emit('  2', 'HEADER');

emit('  9', '$ACADVER',    '  1', 'AC1015');
emit('  9', '$DWGCODEPAGE','  3', 'ANSI_1252');

emit('  9', '$INSBASE');
emit(' 10', '0.0', ' 20', '0.0', ' 30', '0.0');

emit('  9', '$EXTMIN');
emit(' 10', '654985.0', ' 20', '6861985.0', ' 30', '0.0');

emit('  9', '$EXTMAX');
emit(' 10', '655435.0', ' 20', '6862335.0', ' 30', '0.0');

emit('  9', '$LIMMIN');
emit(' 10', '654985.0', ' 20', '6861985.0');

emit('  9', '$LIMMAX');
emit(' 10', '655435.0', ' 20', '6862335.0');

emit('  9', '$INSUNITS',   ' 70', '6');  // 6 = metres
emit('  9', '$MEASUREMENT',' 70', '1');  // 1 = metric

emit('  9', '$PROJECTNAME', '  1', 'Plan_Masse_Saint_Denis_EPSG2154');
emit('  9', '$LASTSAVEDBY', '  1', 'SurveyCalculatorSuite-v1');

emit('  0', 'ENDSEC');

// ─── TABLES ───────────────────────────────────────────────────────────────────
emit('  0', 'SECTION');
emit('  2', 'TABLES');

// LTYPE table (just CONTINUOUS)
emit(
  '  0', 'TABLE',
  '  2', 'LTYPE',
  '  5', '1',
  '100', 'AcDbSymbolTable',
  ' 70', '1'
);
emit(
  '  0', 'LTYPE',
  '  5', '2',
  '100', 'AcDbSymbolTableRecord',
  '100', 'AcDbLinetypeTableRecord',
  '  2', 'CONTINUOUS',
  ' 70', '0',
  '  3', 'Solid line',
  ' 72', '65',
  ' 73', '0',
  ' 40', '0.0'
);
emit('  0', 'ENDTAB');

// LAYER table
emit(
  '  0', 'TABLE',
  '  2', 'LAYER',
  '  5', '3',
  '100', 'AcDbSymbolTable',
  ' 70', String(LAYERS.length)
);
let lh = 4;
for (const L of LAYERS) {
  emit(
    '  0', 'LAYER',
    '  5', (lh++).toString(16).toUpperCase(),
    '100', 'AcDbSymbolTableRecord',
    '100', 'AcDbLayerTableRecord',
    '  2', L.name,
    ' 70', '0',
    ' 62', L.color,
    '  6', 'CONTINUOUS'
  );
}
emit('  0', 'ENDTAB');
emit('  0', 'ENDSEC');

// ─── ENTITIES ─────────────────────────────────────────────────────────────────
emit('  0', 'SECTION');
emit('  2', 'ENTITIES');

// ── Zone boundary (closed) ────────────────────────────────────────────────────
lwpolyline('LIMITE_ZONE', [
  [654995, 6861995],
  [655425, 6861995],
  [655425, 6862325],
  [654995, 6862325],
], true);

// ── Roads (open) ──────────────────────────────────────────────────────────────

// Route Nationale D7 – E-W main road with subtle natural curve
lwpolyline('ROUTES', [
  [654990, 6862148],
  [655050, 6862150],
  [655100, 6862150],
  [655200, 6862150],
  [655310, 6862148],
  [655380, 6862146],
  [655430, 6862144],
]);

// Rue de la République – N-S main road
lwpolyline('ROUTES', [
  [655198, 6861990],
  [655200, 6862060],
  [655200, 6862080],
  [655200, 6862150],
  [655202, 6862240],
  [655201, 6862290],
  [655200, 6862330],
]);

// Chemin du Parc – diagonal NW approach road
lwpolyline('ROUTES', [
  [654990, 6862268],
  [655055, 6862225],
  [655120, 6862192],
  [655165, 6862170],
  [655200, 6862150],
]);

// Rue Commerciale – E-W south branch off N-S road
lwpolyline('ROUTES', [
  [655200, 6862068],
  [655280, 6862065],
  [655355, 6862060],
  [655430, 6862055],
]);

// Impasse des Lilas – dead-end cul-de-sac (NE residential)
lwpolyline('ROUTES', [
  [655305, 6862240],
  [655352, 6862252],
  [655410, 6862250],
  [655422, 6862250],
]);

// ── Sidewalks / kerbs (open) ──────────────────────────────────────────────────

// North kerb of Route D7
lwpolyline('TROTTOIRS', [
  [654990, 6862160],
  [655100, 6862162],
  [655200, 6862162],
  [655310, 6862160],
  [655430, 6862156],
]);

// South kerb of Route D7
lwpolyline('TROTTOIRS', [
  [654990, 6862136],
  [655100, 6862138],
  [655200, 6862138],
  [655310, 6862136],
  [655430, 6862132],
]);

// West kerb of N-S road
lwpolyline('TROTTOIRS', [
  [655186, 6861990],
  [655188, 6862060],
  [655188, 6862150],
  [655190, 6862250],
  [655190, 6862330],
]);

// East kerb of N-S road
lwpolyline('TROTTOIRS', [
  [655210, 6861990],
  [655212, 6862060],
  [655212, 6862150],
  [655214, 6862250],
  [655212, 6862330],
]);

// ── Buildings – closed polylines ──────────────────────────────────────────────

// NW quadrant – residential zone
// Immeuble A  (apartment block, 80×60 m)
lwpolyline('BATIMENTS', [
  [655010, 6862165], [655090, 6862165],
  [655090, 6862225], [655010, 6862225],
], true);

// Immeuble B  (apartment block, 60×50 m)
lwpolyline('BATIMENTS', [
  [655105, 6862175], [655165, 6862175],
  [655165, 6862225], [655105, 6862225],
], true);

// Maison 1  (detached house, 33×23 m)
lwpolyline('BATIMENTS', [
  [655015, 6862240], [655048, 6862240],
  [655048, 6862263], [655015, 6862263],
], true);

// Maison 2  (detached house, 35×24 m)
lwpolyline('BATIMENTS', [
  [655063, 6862252], [655098, 6862252],
  [655098, 6862276], [655063, 6862276],
], true);

// Maison 3  (detached house, 39×26 m)
lwpolyline('BATIMENTS', [
  [655113, 6862242], [655152, 6862242],
  [655152, 6862268], [655113, 6862268],
], true);

// École primaire  (school, 75×35 m)
lwpolyline('BATIMENTS', [
  [655015, 6862282], [655090, 6862282],
  [655090, 6862317], [655015, 6862317],
], true);

// SW quadrant – commercial / industrial zone
// Entrepôt logistique  (warehouse, 110×65 m)
lwpolyline('BATIMENTS', [
  [655010, 6862010], [655120, 6862010],
  [655120, 6862075], [655010, 6862075],
], true);

// Commerce A  (retail unit, 50×38 m)
lwpolyline('BATIMENTS', [
  [655010, 6862090], [655060, 6862090],
  [655060, 6862128], [655010, 6862128],
], true);

// Commerce B  (retail unit, 58×38 m)
lwpolyline('BATIMENTS', [
  [655072, 6862090], [655130, 6862090],
  [655130, 6862128], [655072, 6862128],
], true);

// Parking couvert  (covered car park, 55×25 m)
lwpolyline('BATIMENTS', [
  [655135, 6862010], [655190, 6862010],
  [655190, 6862035], [655135, 6862035],
], true);

// NE quadrant – mixed residential
// Pavillon 1  (L-shaped villa, 6 vertices)
lwpolyline('BATIMENTS', [
  [655215, 6862165], [655292, 6862165],
  [655292, 6862205], [655262, 6862205],
  [655262, 6862232], [655215, 6862232],
], true);

// Pavillon 2  (villa, 77×50 m)
lwpolyline('BATIMENTS', [
  [655308, 6862180], [655385, 6862180],
  [655385, 6862230], [655308, 6862230],
], true);

// Garage collectif  (collective garage block, 43×27 m)
lwpolyline('BATIMENTS', [
  [655215, 6862257], [655258, 6862257],
  [655258, 6862284], [655215, 6862284],
], true);

// Résidence C  (apartment, T-shaped, 8 vertices)
lwpolyline('BATIMENTS', [
  [655310, 6862248], [655385, 6862248],
  [655385, 6862265], [655358, 6862265],
  [655358, 6862300], [655336, 6862300],
  [655336, 6862265], [655310, 6862265],
], true);

// SE quadrant – industrial
// Bâtiment industriel principal  (L-shaped, 6 vertices)
lwpolyline('BATIMENTS', [
  [655215, 6862008], [655390, 6862008],
  [655390, 6862058], [655312, 6862058],
  [655312, 6862098], [655215, 6862098],
], true);

// Atelier annexe  (workshop, 45×35 m)
lwpolyline('BATIMENTS', [
  [655330, 6862070], [655375, 6862070],
  [655375, 6862105], [655330, 6862105],
], true);

// Maison gardien  (caretaker house, 43×23 m)
lwpolyline('BATIMENTS', [
  [655215, 6862115], [655258, 6862115],
  [655258, 6862138], [655215, 6862138],
], true);

// ── Property parcels (closed) ─────────────────────────────────────────────────

// Parcelle 001  – NW residential lot
lwpolyline('PARCELLES', [
  [655002, 6862155], [655193, 6862155],
  [655193, 6862323], [655002, 6862323],
], true);

// Parcelle 002  – SW commercial lot
lwpolyline('PARCELLES', [
  [655002, 6861998], [655193, 6861998],
  [655193, 6862145], [655002, 6862145],
], true);

// Parcelle 003  – NE lot west side
lwpolyline('PARCELLES', [
  [655205, 6862155], [655305, 6862155],
  [655305, 6862323], [655205, 6862323],
], true);

// Parcelle 004  – NE lot east side (park + residences)
lwpolyline('PARCELLES', [
  [655305, 6862155], [655423, 6862155],
  [655423, 6862323], [655305, 6862323],
], true);

// Parcelle 005  – SE industrial lot
lwpolyline('PARCELLES', [
  [655205, 6861998], [655423, 6861998],
  [655423, 6862145], [655205, 6862145],
], true);

// ── Green spaces (closed, irregular polygons) ─────────────────────────────────

// Parc municipal  (park, irregular hexagon, NE corner)
lwpolyline('ESPACES_VERTS', [
  [655222, 6862248],
  [655298, 6862242],
  [655375, 6862260],
  [655418, 6862295],
  [655402, 6862320],
  [655222, 6862318],
], true);

// Jardin partagé  (community garden, irregular pentagon, SW)
lwpolyline('ESPACES_VERTS', [
  [655135, 6862082],
  [655183, 6862082],
  [655188, 6862106],
  [655183, 6862133],
  [655135, 6862133],
  [655130, 6862106],
], true);

// Square résidentiel  (residential square, NW)
lwpolyline('ESPACES_VERTS', [
  [655100, 6862245],
  [655182, 6862245],
  [655182, 6862320],
  [655100, 6862320],
], true);

// Bande verte  (green buffer strip along zone south edge)
lwpolyline('ESPACES_VERTS', [
  [654998, 6861998],
  [655425, 6861998],
  [655425, 6862005],
  [654998, 6862005],
], true);

// ── Utility networks (open) ───────────────────────────────────────────────────

// Réseau AEP  (potable water main, follows Route D7)
lwpolyline('RESEAUX', [
  [654990, 6862153],
  [655100, 6862153],
  [655200, 6862153],
  [655310, 6862153],
  [655430, 6862153],
]);

// Réseau EU  (foul sewage, N-S axis)
lwpolyline('RESEAUX', [
  [655195, 6861990],
  [655195, 6862060],
  [655195, 6862150],
  [655195, 6862260],
  [655195, 6862330],
]);

// Réseau BT  (low-voltage power, follows Chemin du Parc then N)
lwpolyline('RESEAUX', [
  [654990, 6862274],
  [655058, 6862228],
  [655142, 6862186],
  [655200, 6862150],
  [655200, 6862230],
  [655200, 6862320],
]);

// Réseau Télécoms  (fibre optic, E-W south then branch N)
lwpolyline('RESEAUX', [
  [654990, 6862143],
  [655200, 6862143],
  [655200, 6862060],
  [655310, 6862060],
  [655430, 6862048],
]);

// ── Survey points (POINT + TEXT label) ───────────────────────────────────────
const SURVEY = [
  // Corner markers (zone boundary)
  ['PT001', 654995, 6861995, 'Borne zone SW – alt.28.5m'],
  ['PT002', 655425, 6861995, 'Borne zone SE – alt.27.8m'],
  ['PT003', 655425, 6862325, 'Borne zone NE – alt.30.1m'],
  ['PT004', 654995, 6862325, 'Borne zone NW – alt.29.6m'],
  // Road junctions
  ['PT005', 655200, 6862150, 'Carrefour D7/Rep – alt.28.9m'],
  ['PT006', 655200, 6862068, 'Jonction commerciale – alt.28.5m'],
  // Building reference points
  ['PT007', 655010, 6862165, 'Angle Immeuble A – alt.28.7m'],
  ['PT008', 655215, 6862008, 'Angle Batiment Ind. – alt.27.9m'],
  ['PT009', 655010, 6862010, 'Angle Entrepot SW – alt.28.0m'],
  ['PT010', 655385, 6862180, 'Angle Pavillon 2 – alt.29.5m'],
  // Interior topo
  ['PT011', 655090, 6862225, 'Topo Imm B – alt.29.0m'],
  ['PT012', 655308, 6862230, 'Topo Pavillon 1 – alt.29.8m'],
  ['PT013', 655050, 6862042, 'Centre Entrepot – alt.28.2m'],
  ['PT014', 655312, 6862058, 'Equerre Ind. – alt.28.1m'],
  ['PT015', 655200, 6862268, 'Acc. Parc – alt.30.3m'],
];

for (const [name, x, y, desc] of SURVEY) {
  pointEnt('POINTS_TOPO', x, y);
  // Short label just above the point (offset 2 m N, 2 m E)
  textEnt('ANNOTATIONS', x + 2, y + 2, 4, name);
  // Full description offset further up (for apps that read TEXT content)
  textEnt('ANNOTATIONS', x + 2, y + 8, 2, desc);
}

// ─── Close ENTITIES ───────────────────────────────────────────────────────────
emit('  0', 'ENDSEC');
emit('  0', 'EOF');

// ─── Write output ─────────────────────────────────────────────────────────────
const content = lines.join('\r\n') + '\r\n';
writeFileSync(OUTPUT, content, 'utf-8');

const entityCount = _h - 0x50;
const polylineCount = lines.filter((l, i) => i % 2 === 1 && l === 'LWPOLYLINE').length;
const pointCount    = lines.filter((l, i) => i % 2 === 1 && l === 'POINT').length;
const textCount     = lines.filter((l, i) => i % 2 === 1 && l === 'TEXT').length;

console.log('DXF plan generated successfully');
console.log(`  Output : ${OUTPUT}`);
console.log(`  Lines  : ${lines.length}`);
console.log(`  Entities:`);
console.log(`    LWPOLYLINEs : ${polylineCount}  (open + closed)`);
console.log(`    POINTs      : ${pointCount}`);
console.log(`    TEXTs       : ${textCount}`);
console.log(`  Layers : ${LAYERS.map(l => l.name).join(' · ')}`);
