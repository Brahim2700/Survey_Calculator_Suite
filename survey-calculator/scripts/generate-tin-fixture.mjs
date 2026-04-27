/**
 * Generate a synthetic mixed-geometry DXF fixture with lines, 3DFACE, PLANESURFACE, and 3DLINE
 * for TIN regression testing.
 */

const generateMixedGeometryDxf = () => {
  const lines = [];

  // Header
  lines.push('0', 'SECTION', '2', 'HEADER');
  lines.push('9', '$INSUNITS', '70', '4');
  lines.push('0', 'ENDSEC');

  // Layer table
  lines.push('0', 'SECTION', '2', 'TABLES');
  lines.push('0', 'TABLE', '2', 'LAYER');
  lines.push('70', '2');
  // Layer TOPO_LINES
  lines.push('0', 'LAYER', '2', 'TOPO_LINES', '70', '0', '62', '7', '6', 'CONTINUOUS');
  // Layer TIN_SURFACE
  lines.push('0', 'LAYER', '2', 'TIN_SURFACE', '70', '0', '62', '3', '6', 'CONTINUOUS');
  lines.push('0', 'ENDTAB');
  lines.push('0', 'ENDTAB');
  lines.push('0', 'ENDTAB');
  lines.push('0', 'ENDTAB');
  lines.push('0', 'ENDTAB');
  lines.push('0', 'ENDSEC');

  // Entities: mix of lines, 3DFACE, PLANESURFACE, and 3DLINE
  lines.push('0', 'SECTION', '2', 'ENTITIES');

  // Line 1: simple topographic contour
  lines.push('0', 'LWPOLYLINE');
  lines.push('8', 'TOPO_LINES');
  lines.push('90', '4');
  lines.push('10', '0', '20', '0');
  lines.push('10', '100', '20', '0');
  lines.push('10', '100', '20', '100');
  lines.push('10', '0', '20', '100');

  // Line 2: simple line
  lines.push('0', 'LINE');
  lines.push('8', 'TOPO_LINES');
  lines.push('10', '50', '20', '50', '30', '50');
  lines.push('11', '150', '21', '50', '31', '60');

  // 3DFACE 1: Triangular face (3 vertices repeated for DXF - will be converted to 1 triangle)
  lines.push('0', '3DFACE');
  lines.push('8', 'TIN_SURFACE');
  lines.push('10', '0', '20', '0', '30', '100');
  lines.push('11', '50', '21', '0', '31', '102');
  lines.push('12', '25', '22', '50', '32', '101');
  lines.push('13', '25', '23', '50', '33', '101'); // Repeat 3rd vertex for triangle

  // 3DFACE 2: Quad face (will be converted to 2 triangles)
  lines.push('0', '3DFACE');
  lines.push('8', 'TIN_SURFACE');
  lines.push('10', '100', '20', '0', '30', '105');
  lines.push('11', '150', '21', '0', '31', '106');
  lines.push('12', '150', '22', '50', '32', '107');
  lines.push('13', '100', '23', '50', '33', '106');

  // LINE 3: Another topographic line
  lines.push('0', 'LINE');
  lines.push('8', 'TOPO_LINES');
  lines.push('10', '200', '20', '50', '30', '55');
  lines.push('11', '250', '21', '100', '31', '65');

  // LWPOLYLINE 2: Another contour/path
  lines.push('0', 'LWPOLYLINE');
  lines.push('8', 'TOPO_LINES');
  lines.push('90', '3');
  lines.push('10', '250', '20', '0');
  lines.push('10', '300', '20', '50');
  lines.push('10', '250', '20', '100');

  lines.push('0', 'ENDSEC');
  lines.push('0', 'EOF');

  return lines.join('\n');
};

export { generateMixedGeometryDxf };
