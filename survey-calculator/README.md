# Survey Calculator

Client-side CRS conversion and visualization tool built with React + Vite. Supports geoid-based height conversions (h↔H), single and bulk transforms, and importing multiple geospatial formats.

The repo now also includes an optional CAD backend service for native DWG parsing. The frontend stays in this app; DWG conversion happens server-side.

Architecture and stack details: see [ARCHITECTURE.md](ARCHITECTURE.md).

## Quick Start

- Install: `npm install`
- Dev server: `npm run dev`
- CAD backend: `npm run dev:server`
- Full stack dev: `npm run dev:full`
- Build: `npm run build`
- Preview: `npm run preview`

## Features

- Geoid height conversions in Auto mode (h↔H) with appropriate grid selection.
- Distinct input/output height types with clear labeling.
- Single and bulk conversion, including zone guidance for UTM.
- Flexible parsers for text/CSV with WKT, UTM, hemispheric DD.
- Import structured formats: GeoJSON, GPX, KML, XLSX, Shapefile ZIP.
- DXF parsing in-browser, plus native DWG parsing through the optional backend service.

## CAD Handling Behavior

- CAD imports (DXF/DWG) now run in automatic permissive expert mode by default.
- The previous strict/permissive selector has been removed to keep the workflow simpler.
- If CRS looks local/unreferenced or ambiguous, the app shows a notice but does not block preview/conversion.

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
- DXF: parsed locally in the browser.
- DWG: uploaded to the backend service, converted to DXF, then normalized for conversion/inspection.

Accepted file types in the UI: `.csv,.txt,.geojson,.json,.gpx,.kml,.zip,.xlsx,.xls,.dxf,.dwg`.

## DWG Backend Setup

The DWG backend is included under `server/` and exposes `/api/cad/health` and `/api/cad/parse`.

Hosted production uses LibreDWG (`dwg2dxf`) by default through `Dockerfile.cad-api`, which is the intended Railway deployment path. End users of the hosted app do not need ODA or any local CAD software installed.

For local Windows development only, the backend can still auto-detect a standard ODA File Converter install such as `C:\Program Files\ODA\ODAFileConverter 27.1.0\ODAFileConverter.exe`.

For native DWG support outside the Railway Docker image, configure one of these on the machine running `npm run dev:server`:

- `DWG2DXF_PATH`: optional path override for LibreDWG `dwg2dxf`.
- `ODA_FILE_CONVERTER_PATH`: optional path to ODA File Converter executable for local fallback use.
- `DWG_CONVERTER_COMMAND`: custom command template for another converter. Supported placeholders: `{inputPath}`, `{inputDir}`, `{inputFileName}`, `{outputDir}`, `{outputDxfPath}`, `{outputBaseName}`.

Quick Windows install:

- `winget install --id ODA.ODAFileConverter -e --accept-package-agreements --accept-source-agreements`

Optional backend environment variables:

- `CAD_API_PORT`: backend port, defaults to `4000`.
- `CAD_MAX_UPLOAD_MB`: upload limit in MB, defaults to `100`.
- `DWG_CONVERTER_TIMEOUT_MS`: converter timeout, defaults to `120000`.
- `ODA_OUTPUT_VERSION`: output target for ODA conversion, defaults to `ACAD2018`.

Frontend development proxy:

- Vite proxies `/api/cad` to `http://localhost:4000` by default.
- Override it with `VITE_CAD_BACKEND_PROXY_TARGET` if your backend runs elsewhere.

## Production Deployment

For production, deploy the frontend and CAD backend separately.

- Frontend: deploy this Vite app to Vercel.
- CAD backend: deploy `server/` on infrastructure that supports native binaries and child processes.

Important:

- Do not rely on a local machine path like `C:\Program Files\...` for production.
- Vercel should call a hosted CAD API using `VITE_CAD_API_BASE_URL`, for example `https://cad-api.yourdomain.com/api/cad`.
- The hosted CAD backend on Railway should use the included Docker image, which already installs LibreDWG (`dwg2dxf`).
- ODA is optional and only relevant for local Windows development or a custom non-Docker server environment.

Files added for this flow:

- `Dockerfile.cad-api`
- `.env.cad-api.example`
- `.env.vercel.example`
- `CAD_BACKEND_DEPLOYMENT.md`

Recommended production shape:

- Vercel for the frontend UI.
- A dedicated CAD service on a VM, container host, or managed backend platform for DWG/DXF processing.
- Optional object storage and job queue for large CAD files.

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

## Project Goals (Planned, Not Implemented Yet)

- Survey Adjustment Engine: add least-squares network adjustment and traverse closure analysis.
- Quality outputs for adjustment workflows: residuals, closure error, RMSE, and confidence reporting.
- Control Point Manager: store, lock, and reuse known control points by project with quality class and epoch.
- Coordinate Epoch and Velocity Support: time-dependent coordinate handling for GNSS datasets.
- Baseline and Loop QA: automatic traverse loop and baseline tolerance checks.
- Cadastral Parcel Tools: parcel closure checks, area/frontage metrics, and legal-style reporting.
- Stakeout Mode: field deltas for design points and lines (direction, distance, cut/fill).
- Profile and Cross-Section Generator: longitudinal profiles and cross-sections from measured lines.
- CRS Batch Recommendation Engine: suggest best working CRS per imported layer/region.
- Datum Shift Audit: expose transformation path, grids used, and uncertainty metadata.
- Project Version Snapshots: project checkpoints with side-by-side change comparison.
