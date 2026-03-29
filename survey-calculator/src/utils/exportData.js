// src/utils/exportData.js
// Export utilities for converting and downloading data in multiple formats

import { utils, write } from 'xlsx';
import proj4 from 'proj4';
import { Buffer } from 'buffer';

// Polyfill Buffer for @mapbox/shp-write
if (typeof window !== 'undefined') {
  window.Buffer = window.Buffer || Buffer;
}

// Lazy import for shapefile writing
let shpWriteModule = null;
const _loadShpWrite = async () => {
  if (!shpWriteModule) {
    shpWriteModule = await import('@mapbox/shp-write');
  }
  return shpWriteModule;
};

const buildMetadataRows = (metadata = {}) => {
  const rows = [];
  const keys = [
    ['generatedAt', 'Generated At'],
    ['fromCrs', 'Source CRS'],
    ['toCrs', 'Target CRS'],
    ['geoidMode', 'Geoid Mode'],
    ['geoidName', 'Geoid Grid'],
    ['transformationAccuracyCm', 'Estimated Accuracy (cm)'],
    ['confidence', 'Confidence'],
    ['totalRows', 'Total Rows'],
    ['successRows', 'Success Rows'],
    ['errorRows', 'Error Rows'],
  ];
  keys.forEach(([key, label]) => {
    if (metadata[key] !== undefined && metadata[key] !== null && metadata[key] !== '') {
      rows.push([label, String(metadata[key])]);
    }
  });
  return rows;
};
/**
 * Export conversion results as CSV
 * @param {Array} results - Array of conversion result objects
 * @param {String} fromCrs - Source CRS code
 * @param {String} toCrs - Target CRS code
 * @param {Boolean} includeGeoid - Whether geoid data is included
 */
export const exportAsCSV = (results, fromCrs, toCrs, includeGeoid = false, metadata = null) => {
  if (!results || results.length === 0) return null;

  let csvContent = '';
  if (metadata) {
    buildMetadataRows(metadata).forEach(([k, v]) => {
      csvContent += `# ${k}: ${v}\n`;
    });
  }

  csvContent += 'id,inputX,inputY';
  if (results[0].inputZ !== undefined && results[0].inputZ !== null && results[0].inputZ !== '') {
    csvContent += ',inputZ';
  }
  csvContent += ',outputX,outputY';
  if (results[0].outputZ !== undefined && results[0].outputZ !== null && results[0].outputZ !== '') {
    csvContent += ',outputZ';
  }
  if (includeGeoid && results.some(r => r.N !== undefined && r.N !== null)) {
    csvContent += ',N';
  }
  csvContent += ',detectedFromCrs,fromCRS,toCRS\n';

  results.forEach(row => {
    const values = [
      row.id || '',
      row.inputX || '',
      row.inputY || '',
    ];
    if (results[0].inputZ !== undefined && results[0].inputZ !== null && results[0].inputZ !== '') {
      values.push(row.inputZ || '');
    }
    values.push(row.outputX || '', row.outputY || '');
    if (results[0].outputZ !== undefined && results[0].outputZ !== null && results[0].outputZ !== '') {
      values.push(row.outputZ || '');
    }
    if (includeGeoid && results.some(r => r.N !== undefined && r.N !== null)) {
      values.push(row.N || '');
    }
    values.push(row.detectedFromCrs || '', fromCrs, toCrs);
    csvContent += values.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',') + '\n';
  });

  return csvContent;
};

/**
 * Export conversion results as GeoJSON
 * @param {Array} results - Array of conversion result objects
 * @param {String} toCrs - Target CRS code
 * @param {Boolean} includeGeoid - Whether geoid data is included
 */
export const exportAsGeoJSON = (results, toCrs, includeGeoid = false, metadata = null) => {
  if (!results || results.length === 0) return null;

  const features = results
    .filter(row => Number.isFinite(parseFloat(row.outputX)) && Number.isFinite(parseFloat(row.outputY)))
    .map(row => {
      const lon = parseFloat(row.outputX);
      const lat = parseFloat(row.outputY);
      const coordinates = row.outputZ !== undefined && row.outputZ !== null && row.outputZ !== ''
        ? [lon, lat, parseFloat(row.outputZ)]
        : [lon, lat];

      const properties = {
        id: row.id || '',
        inputX: row.inputX,
        inputY: row.inputY,
        outputX: row.outputX,
        outputY: row.outputY,
      };

      if (row.inputZ !== undefined && row.inputZ !== null && row.inputZ !== '') {
        properties.inputZ = row.inputZ;
      }
      if (row.outputZ !== undefined && row.outputZ !== null && row.outputZ !== '') {
        properties.outputZ = row.outputZ;
        properties.h = parseFloat(row.outputZ);
      }
      if (includeGeoid && row.N !== undefined && row.N !== null) {
        properties.N = row.N;
      }

      return {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates,
        },
        properties,
      };
    });

  return JSON.stringify({
    type: 'FeatureCollection',
    crs: {
      type: 'name',
      properties: { name: toCrs },
    },
    metadata: metadata || undefined,
    features,
  }, null, 2);
};

/**
 * Export conversion results as GeoJSON with WKT
 * @param {Array} results - Array of conversion result objects
 * @param {String} toCrs - Target CRS code
 */
export const exportAsGeoJSONWithWKT = (results, toCrs) => {
  if (!results || results.length === 0) return null;

  const features = results
    .filter(row => Number.isFinite(parseFloat(row.outputX)) && Number.isFinite(parseFloat(row.outputY)))
    .map(row => {
      const lon = parseFloat(row.outputX);
      const lat = parseFloat(row.outputY);
      const z = row.outputZ !== undefined && row.outputZ !== null && row.outputZ !== ''
        ? parseFloat(row.outputZ)
        : null;

      const wkt = z !== null
        ? `POINT Z (${lon} ${lat} ${z})`
        : `POINT (${lon} ${lat})`;

      return {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: z !== null ? [lon, lat, z] : [lon, lat],
        },
        properties: {
          id: row.id || '',
          wkt,
          CRS: toCrs,
        },
      };
    });

  return JSON.stringify({
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: toCrs } },
    features,
  }, null, 2);
};

/**
 * Export conversion results as KML
 * @param {Array} results - Array of conversion result objects
 * @param {String} toCrs - Target CRS code
 */
export const exportAsKML = (results, toCrs, metadata = null) => {

    // KML REQUIRES WGS84 (EPSG:4326) coordinates
    // Check if target CRS is WGS84, if not we need to convert
    const isWgs84 = toCrs === 'EPSG:4326' || toCrs === 'WGS84' || toCrs === 'urn:ogc:def:crs:OGC:1.3:CRS84';
  if (!results || results.length === 0) return null;

  const placemarks = results
    .filter(row => Number.isFinite(parseFloat(row.outputX)) && Number.isFinite(parseFloat(row.outputY)))
    .map((row, idx) => {
      const x = parseFloat(row.outputX);
      const y = parseFloat(row.outputY);
      let lon, lat;
      
      if (!isWgs84) {
        // Need to convert from target CRS to WGS84 for KML
        try {
          [lon, lat] = proj4(toCrs, 'EPSG:4326', [x, y]);
        } catch (err) {
          console.warn(`Failed to convert ${toCrs} to WGS84 for KML export:`, err.message);
          // Fallback: assume coordinates are already geographic
          lon = x;
          lat = y;
        }
      } else {
        // Converter outputs geographic coordinates as X=lon, Y=lat.
        lon = x;
        lat = y;
      }
      
      const z = row.outputZ !== undefined && row.outputZ !== null && row.outputZ !== ''
        ? `<altitude>${parseFloat(row.outputZ)}</altitude>`
        : '';

      const description = `
        Input: (${row.inputX}, ${row.inputY})
        Output: (${row.outputX}, ${row.outputY})
        CRS: ${toCrs}
        ${row.outputZ ? `Height: ${row.outputZ}` : ''}
        ${row.N ? `Geoid: ${row.N}` : ''}
      `.trim();

      return `
    <Placemark>
      <name>${row.id || `Point ${idx + 1}`}</name>
      <description>${description}</description>
      <Point>
        <coordinates>${lon},${lat}${z ? `,${parseFloat(row.outputZ)}` : ''}</coordinates>
      </Point>
    </Placemark>`;
    }).join('\n');

  const metadataDescription = metadata
    ? buildMetadataRows(metadata).map(([k, v]) => `${k}: ${v}`).join(' | ')
    : 'Coordinate conversion results from Survey Calculator Suite';

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Converted Coordinates</name>
    <description>${metadataDescription}</description>
    <Style id="point">
      <IconStyle>
        <Icon>
          <href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href>
        </Icon>
      </IconStyle>
    </Style>
${placemarks}
  </Document>
</kml>`;
};

/**
 * Export conversion results as GPX
@@ * @param {String} toCrs - Target CRS code
 * @param {Array} results - Array of conversion result objects
 */
export const exportAsGPX = (results, toCrs, metadata = null) => {

    // GPX REQUIRES WGS84 (EPSG:4326) coordinates
    const isWgs84 = toCrs === 'EPSG:4326' || toCrs === 'WGS84' || toCrs === 'urn:ogc:def:crs:OGC:1.3:CRS84';
  if (!results || results.length === 0) return null;

  const waypoints = results
    .filter(row => Number.isFinite(parseFloat(row.outputX)) && Number.isFinite(parseFloat(row.outputY)))
    .map((row, idx) => {
      const x = parseFloat(row.outputX);
      const y = parseFloat(row.outputY);
      let lon, lat;
      
      if (!isWgs84) {
        // Need to convert from target CRS to WGS84 for GPX
        try {
          [lon, lat] = proj4(toCrs, 'EPSG:4326', [x, y]);
        } catch (err) {
          console.warn(`Failed to convert ${toCrs} to WGS84 for GPX export:`, err.message);
          lon = x;
          lat = y;
        }
      } else {
        // Converter outputs geographic coordinates as X=lon, Y=lat.
        lon = x;
        lat = y;
      }
      
      const ele = row.outputZ !== undefined && row.outputZ !== null && row.outputZ !== ''
        ? `<ele>${parseFloat(row.outputZ)}</ele>`
        : '';

      return `
  <wpt lat="${lat}" lon="${lon}">
    <name>${row.id || `Point ${idx + 1}`}</name>
    ${ele}
  </wpt>`;
    }).join('\n');

  const metadataDesc = metadata
    ? buildMetadataRows(metadata).map(([k, v]) => `${k}: ${v}`).join(' | ')
    : 'Coordinate conversion results';

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Survey Calculator Suite"
     xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <desc>${metadataDesc}</desc>
  </metadata>
${waypoints}
</gpx>`;
};

/**
 * Export conversion results as XLSX
 * @param {Array} results - Array of conversion result objects
 * @param {String} fromCrs - Source CRS code
 * @param {String} toCrs - Target CRS code
 * @param {Boolean} includeGeoid - Whether geoid data is included
 */
export const exportAsXLSX = (results, fromCrs, toCrs, includeGeoid = false, metadata = null) => {
  if (!results || results.length === 0) return null;

  const data = results.map(row => {
    const record = {
      id: row.id || '',
      inputX: row.inputX,
      inputY: row.inputY,
      outputX: row.outputX,
      outputY: row.outputY,
      fromCRS: fromCrs,
      toCRS: toCrs,
    };

    if (row.inputZ !== undefined && row.inputZ !== null && row.inputZ !== '') {
      record.inputZ = row.inputZ;
    }
    if (row.outputZ !== undefined && row.outputZ !== null && row.outputZ !== '') {
      record.outputZ = row.outputZ;
    }
    if (includeGeoid && row.N !== undefined && row.N !== null) {
      record.N = row.N;
    }

    return record;
  });

  const worksheet = utils.json_to_sheet(data);
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, worksheet, 'Conversions');

  // Add metadata sheet
  const metadataRows = [
    { key: 'Source CRS', value: fromCrs },
    { key: 'Target CRS', value: toCrs },
    { key: 'Total Points', value: results.length },
    { key: 'Export Date', value: new Date().toISOString() },
  ];
  if (metadata) {
    buildMetadataRows(metadata).forEach(([k, v]) => {
      metadataRows.push({ key: k, value: v });
    });
  }
  const metadataSheet = utils.json_to_sheet(metadataRows);
  utils.book_append_sheet(workbook, metadataSheet, 'Metadata');

  return workbook;
};

/**
 * Export conversion results as WKT (one point per line)
 * @param {Array} results - Array of conversion result objects
 */
export const exportAsWKT = (results, metadata = null) => {
  if (!results || results.length === 0) return null;

  const wktBody = results
    .filter(row => Number.isFinite(parseFloat(row.outputX)) && Number.isFinite(parseFloat(row.outputY)))
    .map((row, idx) => {
      const lon = parseFloat(row.outputX);
      const lat = parseFloat(row.outputY);
      const z = row.outputZ !== undefined && row.outputZ !== null && row.outputZ !== ''
        ? parseFloat(row.outputZ)
        : null;

      if (z !== null) {
        return `${row.id || idx + 1}: POINT Z (${lon} ${lat} ${z})`;
      }
      return `${row.id || idx + 1}: POINT (${lon} ${lat})`;
    })
    .join('\n');

  if (!metadata) return wktBody;
  const metadataHeader = buildMetadataRows(metadata)
    .map(([k, v]) => `# ${k}: ${v}`)
    .join('\n');
  return `${metadataHeader}\n${wktBody}`;
};

/**
 * Export conversion results as UTM/Zone format (if applicable)
 * @param {Array} results - Array of conversion result objects
 * @param {String} toCrs - Target CRS code
 */
export const exportAsUTMFormat = (results, toCrs) => {
  if (!results || results.length === 0) return null;

  // Try to extract UTM zone from EPSG code
  const m = /^EPSG:(326|327)(\d{2})$/.exec(toCrs);
  if (!m) return null;

  const hemi = m[1] === '326' ? 'N' : 'S';
  const zone = parseInt(m[2], 10);

  return results
    .map((row, idx) => {
      const x = row.outputX || '';
      const y = row.outputY || '';
      const z = row.outputZ ? ` ${row.outputZ}` : '';
      return `${row.id || idx + 1}: ${zone}${hemi} ${x} ${y}${z}`;
    })
    .join('\n');
};

/**
 * Export conversion results as DXF
 * @param {Array} results - Array of conversion result objects
 * @param {String} toCrs - Target CRS code
 */
export const exportAsDXF = (results, metadata = null) => {
  if (!results || results.length === 0) return null;

  const filtered = results.filter(
    (row) => Number.isFinite(parseFloat(row.outputX)) && Number.isFinite(parseFloat(row.outputY))
  );

  const lines = [];

  // HEADER section (DXF R12 / AC1009 for widest compatibility)
  lines.push(
    '0',
    'SECTION',
    '2',
    'HEADER',
    '9',
    '$ACADVER',
    '1',
    'AC1009',
    '0',
    'ENDSEC'
  );

  if (metadata && metadata.fromCrs && metadata.toCrs) {
    lines.splice(10, 0,
      '9', '$EXTMIN',
      '1', `From ${metadata.fromCrs} To ${metadata.toCrs}`
    );
  }

  // TABLES section with only LTYPE and LAYER (R12 minimal)
  lines.push('0', 'SECTION', '2', 'TABLES');

  // LTYPE table with CONTINUOUS definition
  lines.push(
    '0', 'TABLE',
    '2', 'LTYPE',
    '70', '1',
    '0', 'LTYPE',
    '2', 'CONTINUOUS',
    '70', '0',
    '3', 'Solid line',
    '72', '65',
    '73', '0',
    '40', '0.0',
    '0', 'ENDTAB'
  );

  // LAYER table with default layer 0 and POINTS layer
  lines.push(
    '0', 'TABLE',
    '2', 'LAYER',
    '70', '2',
    '0', 'LAYER',
    '2', '0',
    '70', '0',
    '62', '7',
    '6', 'CONTINUOUS',
    '0', 'LAYER',
    '2', 'POINTS',
    '70', '0',
    '62', '7',
    '6', 'CONTINUOUS',
    '0', 'ENDTAB'
  );

  lines.push('0', 'ENDSEC');

  // BLOCKS section with required *MODEL_SPACE and *PAPER_SPACE definitions
  console.log('DXF Export: Adding BLOCKS section with MODEL_SPACE and PAPER_SPACE');
  lines.push('0', 'SECTION', '2', 'BLOCKS');

  // *MODEL_SPACE block
  lines.push(
    '0', 'BLOCK',
    '8', '0',
    '2', '*MODEL_SPACE',
    '70', '0',
    '10', '0', '20', '0', '30', '0',
    '3', '*MODEL_SPACE'
  );
  lines.push('0', 'ENDBLK', '8', '0');

  // *PAPER_SPACE block
  lines.push(
    '0', 'BLOCK',
    '8', '0',
    '2', '*PAPER_SPACE',
    '70', '0',
    '10', '0', '20', '0', '30', '0',
    '3', '*PAPER_SPACE'
  );
  lines.push('0', 'ENDBLK', '8', '0');

  lines.push('0', 'ENDSEC');

  // ENTITIES section with POINT entities on POINTS layer
  lines.push('0', 'SECTION', '2', 'ENTITIES');

  filtered.forEach((row) => {
    const x = parseFloat(row.outputX);
    const y = parseFloat(row.outputY);
    const z =
      row.outputZ !== undefined && row.outputZ !== null && row.outputZ !== ''
        ? parseFloat(row.outputZ)
        : 0;

    lines.push(
      '0',
      'POINT',
      '8',
      'POINTS',
      '62',
      '7',
      '10',
      `${x}`,
      '20',
      `${y}`,
      '30',
      `${z}`
    );
  });

  lines.push('0', 'ENDSEC', '0', 'EOF');

  // AutoCAD expects CRLF line endings
  console.log('Total DXF lines:', lines.length);
  console.log('First 100 lines:', lines.slice(0, 100));
  return lines.join('\r\n');
};

/**
 * Export conversion results as DWG (text-based ASCII DXF format)
 * Note: True binary DWG requires specialized libraries; this exports as DXF with .dwg extension
 * @param {Array} results - Array of conversion result objects
 */
export const exportAsDWG = (results) => {
  // DWG binary format is proprietary - export as DXF instead
  return exportAsDXF(results);
};

export const exportErrorsAsCSV = (results, metadata = null) => {
  if (!results || results.length === 0) return null;
  const failed = results.filter((r) => String(r.outputX) === 'ERROR' || r.errorCategory || r.errorMessage);
  if (failed.length === 0) return null;

  let csv = '';
  if (metadata) {
    buildMetadataRows(metadata).forEach(([k, v]) => {
      csv += `# ${k}: ${v}\n`;
    });
  }
  csv += 'id,inputX,inputY,inputZ,errorCategory,errorMessage\n';
  failed.forEach((r) => {
    const row = [
      r.id || '',
      r.inputX || '',
      r.inputY || '',
      r.inputZ || '',
      r.errorCategory || 'conversion',
      r.errorMessage || (String(r.outputY || 'Unknown error')),
    ];
    csv += row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',') + '\n';
  });
  return csv;
};

/**
 * Download data as file
 * @param {String|Workbook} data - Data to download (string or Excel workbook object)
 * @param {String} filename - Name of the file to save
 * @param {String} format - File format (csv, json, kml, gpx, txt, xlsx, dxf, dwg)
 */
export const downloadFile = (data, filename, format = 'csv') => {
  if (!data) return;

  try {
    if (format === 'xlsx' && data && data.SheetNames) {
      // Generate XLSX binary and download as blob
      const wbout = write(data, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([wbout], { type: getContentType('xlsx') });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } else if (data instanceof Blob) {
      // Already a Blob (e.g., shapefile zip)
      const url = URL.createObjectURL(data);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } else {
      // It's a string
      const blob = new Blob([data], { type: getContentType(format) });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }
  } catch (error) {
    console.error('Download failed:', error);
    throw error;
  }
};

/**
 * Get MIME type for format
 */
const getContentType = (format) => {
  const types = {
    csv: 'text/csv;charset=utf-8;',
    txt: 'text/plain;charset=utf-8;',
    json: 'application/json;charset=utf-8;',
    geojson: 'application/geo+json;charset=utf-8;',
    kml: 'application/vnd.google-earth.kml+xml;charset=utf-8;',
    gpx: 'application/gpx+xml;charset=utf-8;',
    wkt: 'text/plain;charset=utf-8;',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    dxf: 'application/dxf;charset=utf-8;',
    dwg: 'application/acad;charset=utf-8;',
    zip: 'application/zip',
  };
  return types[format] || 'text/plain;charset=utf-8;';
};


/**
 * Export conversion results as individual Shapefile components (.shp, .shx, .dbf, .prj)
 * NOTE: Disabled - @mapbox/shp-write library has compatibility issues in browser environment
 * @returns {Promise<null>} - Shapefile export not supported
 */
export const exportAsShapefile = async () => {
  console.warn('Shapefile export is not currently supported due to library compatibility issues');
  return null;
};

/**
 * Export with all formats at once as a ZIP archive
 * @param {Array} results - Array of conversion result objects
 * @param {String} fromCrs - Source CRS code
 * @param {String} toCrs - Target CRS code
 * @param {Boolean} includeGeoid - Whether geoid data is included
 */
export const exportAllFormats = async (results, fromCrs, toCrs, includeGeoid = false, metadata = null) => {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();

  // Add CSV
  const csv = exportAsCSV(results, fromCrs, toCrs, includeGeoid, metadata);
  if (csv) zip.file('coordinates.csv', csv);

  // Add GeoJSON
  const geojson = exportAsGeoJSON(results, toCrs, includeGeoid, metadata);
  if (geojson) zip.file('coordinates.geojson', geojson);

  // Add KML
  const kml = exportAsKML(results, toCrs, metadata);
  if (kml) zip.file('coordinates.kml', kml);

  // Add GPX
  const gpx = exportAsGPX(results, toCrs, metadata);
  if (gpx) zip.file('coordinates.gpx', gpx);

  // Add WKT
  const wkt = exportAsWKT(results, metadata);
  if (wkt) zip.file('coordinates.wkt', wkt);

  // Add DXF
  const dxf = exportAsDXF(results, metadata);
  if (dxf) zip.file('coordinates.dxf', dxf);

  // Add XLSX
  const xlsxWorkbook = exportAsXLSX(results, fromCrs, toCrs, includeGeoid, metadata);
  if (xlsxWorkbook) {
    const xlsxBinary = write(xlsxWorkbook, { bookType: 'xlsx', type: 'array' });
    zip.file('coordinates.xlsx', xlsxBinary);
  }

  // Add Shapefile (skip - individual downloads in separate handler)
  try {
    const shpData = await exportAsShapefile(results, toCrs);
    if (shpData?.files) {
      // Add individual shapefile components to the zip
      Object.entries(shpData.files).forEach(([filename, fileData]) => {
        if (fileData instanceof Uint8Array || fileData instanceof ArrayBuffer) {
          zip.file(`shapefile/${filename}`, fileData);
        } else if (typeof fileData === 'string') {
          zip.file(`shapefile/${filename}`, fileData);
        }
      });
    }
  } catch (err) {
    console.warn('Shapefile export skipped:', err);
  }

  // Generate and download
  const content = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(content);
  const link = document.createElement('a');
  link.href = url;
  link.download = `coordinates_${new Date().toISOString().split('T')[0]}.zip`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};
