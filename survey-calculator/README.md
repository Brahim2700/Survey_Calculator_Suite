# Survey Calculator

Client-side CRS conversion and visualization tool built with React + Vite. Supports geoid-based height conversions (h↔H), single and bulk transforms, and importing multiple geospatial formats.

## Quick Start

- Install: `npm install`
- Dev server: `npm run dev`
- Build: `npm run build`
- Preview: `npm run preview`

## Features

- Geoid height conversions in Auto mode (h↔H) with appropriate grid selection.
- Distinct input/output height types with clear labeling.
- Single and bulk conversion, including zone guidance for UTM.
- Flexible parsers for text/CSV with WKT, UTM, hemispheric DD.
- Import structured formats: GeoJSON, GPX, KML, XLSX, Shapefile ZIP.

## Supported Import Formats

- CSV/TXT: columns for `lon, lat, h` or `x, y, z`; supports tabs/commas/semicolons.
- WKT/EWKT: whole-line `POINT(lon lat h)` or with SRID.
- UTM: tokens with zone and hemisphere (e.g., `56S 321000 5678000`).
- Hemispheric DD: `S 33.8688, E 151.2093` style numbers.
- GeoJSON: Feature(s) with Point geometry; reads `coordinates` and optional `h` property.
- GPX: Waypoints (`wpt`) with lat/lon and `ele`.
- KML: Placemarks with Point coordinates and optional altitude.
- XLSX/XLS: sheet with columns like `id, lon, lat, h, SRID, WKT`.
- Shapefile ZIP: zipped .shp/.shx/.dbf (+ optional .prj); parsed to GeoJSON.

Accepted file types in the UI: `.csv,.txt,.geojson,.json,.gpx,.kml,.zip,.xlsx,.xls`.

## Sample Files

Download ready-made samples from `public/samples/`:

- `sample.csv`: lon/lat/h with WKT column.
- `sample.geojson`: Point features with `h` property.
- `sample.gpx`: Waypoints with elevation.
- `sample.kml`: Placemarks with Point coordinates.
- `sample.xlsx`: Spreadsheet with `lon, lat, h, WKT, SRID`.
- `sample_shapefile.zip`: Shapefile (Points) in WGS84 (`EPSG:4326`).

To regenerate XLSX and Shapefile samples: `npm run generate:samples`.

## Notes

- Geographic sources default to ellipsoidal height unless explicitly marked orthometric.
- Projected→Geographic outputs use ellipsoidal height; geoid conversions apply as needed.
