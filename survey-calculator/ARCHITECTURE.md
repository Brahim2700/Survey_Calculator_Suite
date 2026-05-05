# Survey Calculator Architecture

## Overview

Survey Calculator is a split-stack geospatial application:

- A browser-based frontend handles coordinate conversion, map rendering, geoid lookup, import/export workflows, and most interactive survey tools.
- An optional Node.js backend handles CAD uploads that require native DWG to DXF conversion before the frontend can inspect and visualize the geometry.
- In production, the frontend and CAD backend are deployed separately.

This repo does not include a server-side database. Most processing is stateless and in-memory. Small user preferences such as CRS favorites, recents, presets, and map basemap choices are stored in browser `localStorage`.

## High-Level Architecture

```text
Browser (React + Vite)
  |
  | 1. User imports coordinates / GIS files / CAD files
  v
Frontend processing layer
  - CRS detection
  - proj4 coordinate transforms
  - geoid lookup from static grid files
  - map visualization (Leaflet)
  - 3D visualization (Cesium / react-globe.gl / Three.js)
  - export/report generation
  |
  | 2a. DXF and standard GIS/text formats handled in browser
  |
  | 2b. DWG or large CAD files sent to CAD API
  v
CAD Backend (Express + Multer)
  - upload handling
  - chunked upload assembly
  - DWG -> DXF conversion via LibreDWG or custom converter command
  - CAD parsing + normalization
  |
  | 3. Parsed rows + geometry + warnings returned as JSON
  v
Browser UI
  - converter tables
  - map overlays
  - diagnostics / measurement / export panels
```

## Frontend Architecture

### Main role

The frontend is the primary application runtime. It owns the user interface, coordinate conversion logic, file import workflows, map rendering, and most feature logic.

### Frontend software used

- `React 19` for the single-page application UI
- `Vite 7` for development server, bundling, and frontend build
- `React DOM` for rendering
- `Leaflet` and `react-leaflet` for 2D map visualization
- `Cesium`, `react-globe.gl`, and `three` for 3D earth and scene visualization
- `proj4` for coordinate reference system transformations
- `geotiff` for geoid grid access and height-related raster reads
- `dxf-parser` for browser-side DXF parsing
- `xlsx`, `shpjs`, and `@mapbox/shp-write` for spreadsheet and shapefile import/export workflows
- `jsPDF`, `html2canvas`, and `jszip` for reporting, map export, and archive generation
- `mathjs` for calculation support
- `@vercel/analytics` for frontend analytics in hosted deployments

### Frontend structure

- `src/App.jsx` is the main composition root for the application UI.
- `src/Components/CoordinateConverter.jsx` drives conversion, import, and survey workflows.
- `src/Components/MapVisualization.jsx` renders map layers, points, CAD overlays, and measurement views.
- `src/utils/` contains the main reusable logic for calculations, CRS detection, CAD normalization, exports, and backend API calls.
- `public/` holds static assets such as geoid resources, backgrounds, and sample files.

### Frontend responsibilities

- Parse and validate coordinate inputs and common geospatial file types
- Detect likely CRS values from imported data
- Convert coordinates between source and target CRS with `proj4`
- Apply geoid-aware height handling when needed
- Render points, lines, labels, layers, and survey outputs on a 2D map
- Render 3D globe and surface visualizations for supported workflows
- Export processed results to multiple output formats
- Persist lightweight UI preferences in browser storage

## Backend Architecture

### Main role

The backend exists to support CAD workflows that cannot run reliably as a static frontend-only application, especially native DWG conversion.

### Backend software used

- `Node.js` as the backend runtime
- `Express 5` for HTTP API endpoints
- `cors` for origin control
- `multer` for multipart upload handling
- Native child-process execution through Node's `child_process`
- `LibreDWG` `dwg2dxf` as the preferred DWG converter

### Backend structure

- `server/index.js` exposes the CAD API endpoints
- `server/cadService.js` handles converter selection, temporary files, DWG to DXF conversion, and parsed CAD result normalization
- `src/utils/cadShared.js` is shared across frontend and backend for CAD parsing/normalization behavior

### Backend API surface

- `GET /api/cad/health` returns backend and converter availability status
- `POST /api/cad/parse` handles direct CAD upload and parsing
- `POST /api/cad/upload/chunk` accepts chunked uploads for large CAD files
- `POST /api/cad/upload/complete` assembles uploaded chunks and runs parsing

### Backend responsibilities

- Accept uploaded DWG and DXF files
- Assemble chunked uploads for large files
- Convert DWG files into DXF using an available converter
- Sanitize and parse CAD content
- Return normalized rows, geometry, warnings, and inspection metadata to the frontend

## System and Deployment Architecture

### Development system

The app can run in two modes locally:

- Frontend only: `npm run dev`
- Full stack: `npm run dev:full`

Local development software:

- `Node.js` and `npm`
- Vite dev server for the frontend
- Express server on port `4000` by default for the CAD API
- Vite proxy from `/api/cad` to the local backend

### Production system

The intended production setup is split deployment:

- Frontend hosted as a static Vite build on `Vercel`
- CAD backend hosted separately on a container-capable service such as `Railway`

Production system software:

- `Vercel` for frontend hosting
- `Railway` or another container host for the CAD API
- `Docker` for packaging the backend runtime
- `Dockerfile.cad-api` to build the backend image with LibreDWG installed

### Container/runtime details

- Backend container base image: `node:20-bookworm-slim`
- Native packages are installed during image build so `dwg2dxf` is available at runtime
- `railway.json` configures health checks for `/api/cad/health`
- `vercel.json` configures the frontend build and static caching headers

## Request and Data Flow

### Standard coordinate and GIS workflow

1. The user imports text, CSV, GeoJSON, GPX, KML, XLSX, Shapefile ZIP, or DXF.
2. The frontend parses the file in the browser.
3. CRS detection and coordinate transformations run in the frontend.
4. Results are rendered on the map and made available for export.

### CAD DWG workflow

1. The user imports a DWG file.
2. The frontend uploads the file to the CAD backend.
3. Large files switch to chunked upload mode automatically.
4. The backend runs a lightweight CAD-aware pre-scan and computes risk score, recommended mode, and recommended engine.
5. The backend applies authoritative mode routing (full/preview/recovery) and conversion preference.
6. The backend converts DWG to DXF using the routed engine path.
7. The backend parses and normalizes the CAD result.
8. JSON rows, geometry, and pre-scan/inspection telemetry are returned to the frontend.
9. The frontend renders results and surfaces pre-scan confidence and recovery guidance.

## Practical Summary

- Frontend: React + Vite geospatial SPA
- Backend: Express CAD processing API on Node.js
- Mapping: Leaflet for 2D, Cesium/Three-based tooling for 3D
- Geospatial engine: proj4 + geotiff + custom survey utilities
- CAD conversion system: LibreDWG in Docker (or a custom converter command when explicitly configured)
- Hosting system: Vercel for UI, Railway or equivalent for native CAD backend
- Persistence model: mostly stateless, with browser localStorage for user preferences

## Enhancements In Progress (May 2026)

- Worker-first chunk planning is now used in the frontend CAD upload path to keep large-file preflight and chunk plan generation off the main UI thread.
- Stream-based preflight now reads an initial signature in the Worker using `File.stream()` for lightweight staged diagnostics before upload.
- Backend chunk completion now assembles chunk files through Node streams (`pipeline`) instead of buffering all parts in memory first.
- CAD engine routing now attempts multiple converters in order (LibreDWG first, then custom when available) and records fallback details in inspection metadata.
- Staged processing hints (`full`, `preview`, `recovery`) are now propagated from frontend upload flow to backend inspection results.
- Added server-side CAD pre-scan service with weighted risk scoring and recommended mode/engine outputs.
- Added `POST /api/cad/prescan` endpoint for lightweight CAD-aware inspection without full conversion.
- Upload/parse routes now merge client hint mode with server pre-scan mode and use server result as authoritative routing.
