// src/App.jsx
import { useEffect, useMemo, useState } from "react";
import { Analytics } from "@vercel/analytics/react";
import CoordinateConverter from "./Components/CoordinateConverter";
import MapVisualization from "./Components/MapVisualization";
import PointSearchFilter from "./Components/PointSearchFilter";
import PerformanceDiagnostics from "./Components/PerformanceDiagnostics";
import MultiPointMeasurements from "./Components/MultiPointMeasurements";
import ElevationProfile from "./Components/ElevationProfile";
import BatchOperations from "./Components/BatchOperations";
import proj4 from "proj4";
import { calculateAllDistances, calculateGeodesicDistance, getUTMZone } from "./utils/calculations";
import { on } from "./utils/eventBus";
import { exportMapAsPdf, exportMapAsPng } from "./utils/mapExport";
import "./App.css";

const PDF_MARGIN_MM = 8;
const EXPORT_PANEL_WIDTH_PX = 350;
const EXPORT_MIN_HEIGHT_PX = 980;
const PDF_PAGE_SIZES_MM = {
  a4: { w: 210, h: 297 },
  a3: { w: 297, h: 420 },
};
const STANDARD_PRINT_SCALES = [
  100, 200, 250, 500, 750, 1000, 1250, 1500, 2000, 2500, 3000,
  4000, 5000, 7500, 10000, 12500, 15000, 20000, 25000, 50000,
];
const EMPTY_CAD_GEOMETRY = {
  lines: [],
  polylines: [],
  texts: [],
  layerSummary: null,
  validation: null,
  notifications: [],
  repairs: null,
  localPreview: false,
};

const pickNiceScale = (requiredDenominator) => {
  if (!Number.isFinite(requiredDenominator) || requiredDenominator <= 0) return null;
  const rounded = Math.ceil(requiredDenominator);
  const fromList = STANDARD_PRINT_SCALES.find((value) => value >= rounded);
  if (fromList) return fromList;
  return Math.ceil(rounded / 5000) * 5000;
};

function App() {
  const [converterPoints, setConverterPoints] = useState([]);
  const [cadGeometry, setCadGeometry] = useState(EMPTY_CAD_GEOMETRY);
  const [measureMode, setMeasureMode] = useState(false);
  const [measurePoints, setMeasurePoints] = useState([]);
  const [distanceDisplayUnit, setDistanceDisplayUnit] = useState("m"); // m | km
  const [angleDisplayUnit, setAngleDisplayUnit] = useState("deg"); // deg | gon
  const [converterSessionKey, setConverterSessionKey] = useState(0);
  const [mapExportRoot, setMapExportRoot] = useState(null);
  const [mapInstance, setMapInstance] = useState(null);
  const [mapMetrics, setMapMetrics] = useState(null);
  const [isExportingMap, setIsExportingMap] = useState(false);
  const [showExportPanel, setShowExportPanel] = useState(false);
  const [mapFocusMode, setMapFocusMode] = useState(false);
  const [exportSettings, setExportSettings] = useState({
    projectName: "Survey Plan",
    surveyor: "",
    scale: "",
    notes: "",
    pdfPageSize: "a4",
    pdfOrientation: "landscape",
  });
  
  // New features state
  const [filteredPoints, setFilteredPoints] = useState(null);
  const [showSearchPanel, setShowSearchPanel] = useState(true);
  const [showDiagnosticsPanel, setShowDiagnosticsPanel] = useState(false);
  const [showMeasurementsPanel, setShowMeasurementsPanel] = useState(true);
  const [showElevationProfilePanel, setShowElevationProfilePanel] = useState(true);
  const [showBatchOpsPanel, setShowBatchOpsPanel] = useState(true);

  const resetAppWorkspace = ({ remountConverter = false } = {}) => {
    setConverterPoints([]);
    setCadGeometry(EMPTY_CAD_GEOMETRY);
    setMeasureMode(false);
    setMeasurePoints([]);
    setDistanceDisplayUnit("m");
    setAngleDisplayUnit("deg");
    if (remountConverter) {
      setConverterSessionKey((prev) => prev + 1);
    }
  };

  // Points from Coordinate Converter
  useEffect(() => {
    const off = on("converter:pointsForMap", ({ points }) => {
      if (Array.isArray(points)) {
        setConverterPoints(points.map((p) => ({ ...p, sourceType: "converted" })));
      }
    });
    return () => off && off();
  }, []);

  useEffect(() => {
    const off = on("converter:cadGeometryForMap", ({ geometry }) => {
      if (geometry && (Array.isArray(geometry.lines) || Array.isArray(geometry.polylines) || Array.isArray(geometry.texts))) {
        setCadGeometry({
          lines: Array.isArray(geometry.lines) ? geometry.lines : [],
          polylines: Array.isArray(geometry.polylines) ? geometry.polylines : [],
          texts: Array.isArray(geometry.texts) ? geometry.texts : [],
          layerSummary: geometry.layerSummary || null,
          validation: geometry.validation || null,
          notifications: Array.isArray(geometry.notifications) ? geometry.notifications : [],
          repairs: geometry.repairs || null,
          localPreview: Boolean(geometry.localPreview),
        });
        return;
      }
      setCadGeometry(EMPTY_CAD_GEOMETRY);
    });
    return () => off && off();
  }, []);

  useEffect(() => {
    const off = on("converter:resetAll", () => {
      resetAppWorkspace();
    });
    return () => off && off();
  }, []);

  // Simple UX: while measure mode is ON, click converted markers to choose P1 and P2.
  const handleMapPointSelect = (point) => {
    if (!measureMode) return;
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return;

    const selected = {
      id: point.id,
      lat: point.lat,
      lng: point.lng,
      height: Number.isFinite(Number(point.height)) ? Number(point.height) : 0,
      label: point.label || (point.id !== undefined ? String(point.id) : "Point"),
        source: point.sourceType || "point",
        sourceLabel: point.label || (point.id !== undefined ? String(point.id) : "Point"),
    };

    setMeasurePoints((prev) => {
      if (prev.length === 0) {
        return [{ id: 1, ...selected }];
      }
      if (prev.length === 1) {
        const sameAsFirst =
          Math.abs(prev[0].lat - selected.lat) < 1e-10 &&
          Math.abs(prev[0].lng - selected.lng) < 1e-10;
        if (sameAsFirst) return prev;
        return [prev[0], { id: 2, ...selected }];
      }
      // If two points already selected, start a new measurement with this point.
      return [{ id: 1, ...selected }];
    });
  };

  // Compute full surveying metrics for each measured leg
  const measureLegs = measurePoints.length >= 2
    ? measurePoints.slice(1).map((pt, i) => {
        const prev = measurePoints[i];
        const avgLon = (prev.lng + pt.lng) / 2;
        const avgLat = (prev.lat + pt.lat) / 2;
        const zone = getUTMZone(avgLon);
        const utmCode = `EPSG:${avgLat >= 0 ? 326 : 327}${String(zone).padStart(2, "0")}`;

        let p1 = { lat: prev.lat, lon: prev.lng, elev: 0, e: 0, n: 0 };
        let p2 = { lat: pt.lat, lon: pt.lng, elev: 0, e: 0, n: 0 };

        try {
          const [e1, n1] = proj4("EPSG:4326", utmCode, [prev.lng, prev.lat]);
          const [e2, n2] = proj4("EPSG:4326", utmCode, [pt.lng, pt.lat]);
          p1 = { ...p1, e: e1, n: n1 };
          p2 = { ...p2, e: e2, n: n2 };
        } catch (err) {
          // Fallback keeps geodesic valid even if projected transform fails.
          console.warn("UTM projection failed for measure leg:", err);
        }

        const metrics = calculateAllDistances(p1, p2, "UTM", zone);
        const g = calculateGeodesicDistance(prev.lat, prev.lng, pt.lat, pt.lng);

        return {
          from: prev.id,
          to: pt.id,
          slopeDistance: metrics.slopeDistance,
          horizontalDistance: metrics.horizontalDistance,
          gridDistance: metrics.gridDistance,
          groundDistance: metrics.groundDistance,
          geodesicDistance: g?.distance || metrics.geodesicDistance || 0,
          azimuth: g?.forwardAzimuth || 0,
          scaleFactor: metrics.scaleFactor,
          elevationFactor: metrics.elevationFactor,
          combinedFactor: metrics.combinedFactor,
          utmZone: zone,
        };
      })
    : [];
  const totalGroundDistance = measureLegs.reduce((s, l) => s + l.groundDistance, 0);
  const totalGeodesicDistance = measureLegs.reduce((s, l) => s + l.geodesicDistance, 0);

  const formatDistance = (meters) => {
    if (distanceDisplayUnit === "km") {
      return `${(meters / 1000).toFixed(6)} km`;
    }
    return `${meters.toFixed(2)} m`;
  };

  const formatAngle = (degrees) => {
    if (angleDisplayUnit === "gon") {
      return `${((degrees * 10) / 9).toFixed(4)} gon`;
    }
    return `${degrees.toFixed(2)}°`;
  };

  const allPoints = [...converterPoints];

  const suggestedPrintScale = useMemo(() => {
    if (!mapMetrics) return null;

    const extentWm = Number(mapMetrics.extentWidthMeters);
    const extentHm = Number(mapMetrics.extentHeightMeters);
    const mapWpx = Number(mapMetrics.mapWidthPx);
    const mapHpx = Number(mapMetrics.mapHeightPx);
    if (!Number.isFinite(extentWm) || !Number.isFinite(extentHm) || extentWm <= 0 || extentHm <= 0) return null;
    if (!Number.isFinite(mapWpx) || !Number.isFinite(mapHpx) || mapWpx <= 0 || mapHpx <= 0) return null;

    const pageBase = PDF_PAGE_SIZES_MM[exportSettings.pdfPageSize] || PDF_PAGE_SIZES_MM.a4;
    const orientation = exportSettings.pdfOrientation === "portrait" ? "portrait" : "landscape";
    const pageW = orientation === "landscape" ? pageBase.h : pageBase.w;
    const pageH = orientation === "landscape" ? pageBase.w : pageBase.h;
    const drawableW = pageW - PDF_MARGIN_MM * 2;
    const drawableH = pageH - PDF_MARGIN_MM * 2;

    const composedWpx = mapWpx + EXPORT_PANEL_WIDTH_PX;
    const composedHpx = Math.max(mapHpx, EXPORT_MIN_HEIGHT_PX);
    const fitFactor = Math.min(drawableW / composedWpx, drawableH / composedHpx);
    if (!Number.isFinite(fitFactor) || fitFactor <= 0) return null;

    const mapWmmOnPage = mapWpx * fitFactor;
    const mapHmmOnPage = mapHpx * fitFactor;
    if (mapWmmOnPage <= 0 || mapHmmOnPage <= 0) return null;

    const scaleFromWidth = extentWm / (mapWmmOnPage / 1000);
    const scaleFromHeight = extentHm / (mapHmmOnPage / 1000);
    const required = Math.max(scaleFromWidth, scaleFromHeight);

    return pickNiceScale(required);
  }, [mapMetrics, exportSettings.pdfPageSize, exportSettings.pdfOrientation]);

  const getExportDetails = () => {
    const nowIso = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    const surveyorText = exportSettings.surveyor.trim();
    const scaleText = exportSettings.scale.trim();
    const notesText = exportSettings.notes.trim();

    return {
      stamp: nowIso,
      details: [
        { label: "Project", value: exportSettings.projectName.trim() || "Survey Plan" },
        { label: "Surveyor", value: surveyorText || "-" },
        { label: "Scale", value: scaleText || "Not specified" },
        { label: "Notes", value: notesText || "-" },
        { label: "Converted points", value: converterPoints.length },
        { label: "CAD lines", value: cadGeometry.lines.length },
        { label: "CAD polylines", value: cadGeometry.polylines.length },
        { label: "CAD texts", value: cadGeometry.texts.length },
        { label: "Measure mode", value: measureMode ? "ON" : "OFF" },
        { label: "Measure points", value: measurePoints.length },
        { label: "Total ground dist", value: `${totalGroundDistance.toFixed(3)} m` },
        { label: "Total geodesic", value: `${totalGeodesicDistance.toFixed(3)} m` },
      ],
    };
  };

  const handleMapExport = async (format) => {
    if (!mapExportRoot) {
      alert("Map is not ready yet. Please try again in a second.");
      return;
    }

    try {
      setIsExportingMap(true);
      const info = getExportDetails();
      const selectedScale = exportSettings.scale.trim();
      const fallbackScale = suggestedPrintScale ? `1:${suggestedPrintScale.toLocaleString()}` : "";
      const exportInfo = {
        title: exportSettings.projectName.trim() || "Survey Plan",
        subtitle: exportSettings.surveyor.trim()
          ? `Surveyor: ${exportSettings.surveyor.trim()}`
          : "SurveyCalc Geomatics Suite",
        details: info.details,
        mapScaleLabel: selectedScale || fallbackScale,
      };

      if (format === "png") {
        await exportMapAsPng(mapExportRoot, exportInfo, `survey-plan-${info.stamp}.png`, mapInstance);
      } else {
        await exportMapAsPdf(
          mapExportRoot,
          exportInfo,
          `survey-plan-${info.stamp}.pdf`,
          {
            format: exportSettings.pdfPageSize,
            orientation: exportSettings.pdfOrientation,
          },
          mapInstance
        );
      }
      setShowExportPanel(false);
    } catch (err) {
      console.error("Map export failed:", err);
      alert(`Map export failed: ${err.message || "Unknown error"}`);
    } finally {
      setIsExportingMap(false);
    }
  };

  const updateExportSetting = (key, value) => {
    setExportSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleBatchOperation = (operationData) => {
    const { operation, points, offset } = operationData;

    if (operation === 'delete') {
      // Remove deleted points from converter points
      const deletedIds = new Set(points.map((p) => p.id));
      setConverterPoints((prev) => prev.filter((p) => !deletedIds.has(p.id)));
      setFilteredPoints(null);
    } else if (operation === 'elevationOffset') {
      // Apply elevation offset to points
      const modifiedPoints = points.map((p) => ({
        ...p,
        height: (Number(p?.height) || 0) + offset,
      }));
      const modifiedIds = new Set(modifiedPoints.map((p) => p.id));

      setConverterPoints((prev) =>
        prev.map((p) =>
          modifiedIds.has(p.id) ? modifiedPoints.find((mp) => mp.id === p.id) : p
        )
      );
      setFilteredPoints(null);
    }
  };

  return (
    <div className="app-shell">
      {/* ── Header ── */}
      <header className="app-header">
        <p className="app-kicker">Professional Geomatics Platform</p>
        <h1 className="app-title">
          Survey<span className="app-title-accent">Calc</span> Geomatics Suite
        </h1>
        <p className="app-subtitle">Coordinate Conversion, Benchmarking, and Survey Computation Workspace</p>
      </header>

      {/* ── Two-column layout ── */}
      <div className={`app-columns${mapFocusMode ? " map-focus" : ""}`}>

        {/* Left column: tools */}
        <div className="app-col-left">
          <CoordinateConverter key={converterSessionKey} />

          {/* Feature panels with tab-like navigation */}
          <div style={{ display: 'grid', gap: '10px', marginTop: '12px' }}>
            {/* Feature tabs */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(5, 1fr)',
                gap: '6px',
              }}
            >
              <button
                onClick={() => setShowSearchPanel(!showSearchPanel)}
                title="Search and filter points"
                style={{
                  border: '1px solid rgba(148,163,184,0.55)',
                  background: showSearchPanel ? 'rgba(59,130,246,0.75)' : 'rgba(15,23,42,0.65)',
                  color: '#e2e8f0',
                  borderRadius: '6px',
                  fontSize: '9px',
                  padding: '6px 4px',
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                🔍 Search
              </button>
              <button
                onClick={() => setShowDiagnosticsPanel(!showDiagnosticsPanel)}
                title="Performance diagnostics"
                style={{
                  border: '1px solid rgba(148,163,184,0.55)',
                  background: showDiagnosticsPanel ? 'rgba(59,130,246,0.75)' : 'rgba(15,23,42,0.65)',
                  color: '#e2e8f0',
                  borderRadius: '6px',
                  fontSize: '9px',
                  padding: '6px 4px',
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                📊 Perf
              </button>
              <button
                onClick={() => setShowMeasurementsPanel(!showMeasurementsPanel)}
                title="Multi-point measurements"
                style={{
                  border: '1px solid rgba(148,163,184,0.55)',
                  background: showMeasurementsPanel ? 'rgba(59,130,246,0.75)' : 'rgba(15,23,42,0.65)',
                  color: '#e2e8f0',
                  borderRadius: '6px',
                  fontSize: '9px',
                  padding: '6px 4px',
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                📏 Measure
              </button>
              <button
                onClick={() => setShowElevationProfilePanel(!showElevationProfilePanel)}
                title="Elevation profile"
                style={{
                  border: '1px solid rgba(148,163,184,0.55)',
                  background: showElevationProfilePanel ? 'rgba(59,130,246,0.75)' : 'rgba(15,23,42,0.65)',
                  color: '#e2e8f0',
                  borderRadius: '6px',
                  fontSize: '9px',
                  padding: '6px 4px',
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                📈 Profile
              </button>
              <button
                onClick={() => setShowBatchOpsPanel(!showBatchOpsPanel)}
                title="Batch operations"
                style={{
                  border: '1px solid rgba(148,163,184,0.55)',
                  background: showBatchOpsPanel ? 'rgba(59,130,246,0.75)' : 'rgba(15,23,42,0.65)',
                  color: '#e2e8f0',
                  borderRadius: '6px',
                  fontSize: '9px',
                  padding: '6px 4px',
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                ⚙️ Batch
              </button>
            </div>

            {/* Feature panels */}
            {showSearchPanel && (
              <PointSearchFilter
                points={converterPoints}
                onFilter={(filtered) => setFilteredPoints(filtered)}
                onClearFilter={() => setFilteredPoints(null)}
              />
            )}

            {showDiagnosticsPanel && (
              <PerformanceDiagnostics
                points={converterPoints}
                cadGeometry={cadGeometry}
                mapMetrics={mapMetrics}
              />
            )}

            {showMeasurementsPanel && (
              <MultiPointMeasurements
                measurePoints={measurePoints}
                onClearMeasurements={() => setMeasurePoints([])}
              />
            )}

            {showElevationProfilePanel && <ElevationProfile measurePoints={measurePoints} />}

            {showBatchOpsPanel && (
              <BatchOperations
                points={converterPoints}
                filteredPoints={filteredPoints}
                onBatchOperation={handleBatchOperation}
              />
            )}
          </div>
        </div>

        {/* Right column: sticky map + measure panel */}
        <div className="app-col-right">
          <div className="map-card">

            {/* Map toolbar */}
            <div className="map-toolbar">
              <span className="map-toolbar-title">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display:"inline-block", verticalAlign:"middle", marginRight:"0.35rem", opacity:0.8 }}>
                  <polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/>
                  <line x1="9" y1="3" x2="9" y2="18"/>
                  <line x1="15" y1="6" x2="15" y2="21"/>
                </svg>
                Interactive Map
              </span>
              <div className="map-toolbar-actions">
                <button
                  className="btn btn-ghost"
                  onClick={() => resetAppWorkspace({ remountConverter: true })}
                  title="Reset the app for a new conversion session"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.708"/><path d="M3 3v6h6"/></svg>
                  New Operation
                </button>
                {measurePoints.length > 0 && (
                  <button
                    className="btn btn-danger"
                    onClick={() => setMeasurePoints([])}
                    title="Clear measure points"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
                    Clear
                  </button>
                )}
                <button
                  className={`btn btn-measure${measureMode ? " active" : ""}`}
                  onClick={() => setMeasureMode(m => !m)}
                  title={measureMode ? "Stop measuring" : "Click converted points to measure"}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 6H3"/><path d="M21 12H3"/><path d="M21 18H3"/></svg>
                  {measureMode ? "Measuring…" : "Measure"}
                </button>
                <button
                  className={`btn btn-ghost${mapFocusMode ? " btn-mapfocus-active" : ""}`}
                  onClick={() => setMapFocusMode((v) => !v)}
                  title={mapFocusMode ? "Restore balanced layout" : "Expand map workspace"}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
                  {mapFocusMode ? "Balanced View" : "Map Focus"}
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => setShowExportPanel((v) => !v)}
                  title="Open export options"
                  disabled={isExportingMap}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  {showExportPanel ? "Close Export" : "Export Plan"}
                </button>
              </div>
            </div>

            {showExportPanel && (
              <div className="export-panel fade-slide-in">
                <div className="export-panel-grid">
                  <label className="export-field">
                    Project Name
                    <input
                      type="text"
                      value={exportSettings.projectName}
                      onChange={(e) => updateExportSetting("projectName", e.target.value)}
                      placeholder="Survey Plan"
                    />
                  </label>
                  <label className="export-field">
                    Surveyor
                    <input
                      type="text"
                      value={exportSettings.surveyor}
                      onChange={(e) => updateExportSetting("surveyor", e.target.value)}
                      placeholder="Name / team"
                    />
                  </label>
                  <label className="export-field">
                    Scale
                    <input
                      type="text"
                      value={exportSettings.scale}
                      onChange={(e) => updateExportSetting("scale", e.target.value)}
                      placeholder="Example: 1:500"
                    />
                    {suggestedPrintScale && (
                      <div className="export-scale-suggestion">
                        Suggested: <strong>1:{suggestedPrintScale.toLocaleString()}</strong>
                        <button
                          type="button"
                          className="export-scale-apply"
                          onClick={() => updateExportSetting("scale", `1:${suggestedPrintScale.toLocaleString()}`)}
                        >
                          Apply
                        </button>
                      </div>
                    )}
                  </label>
                  <label className="export-field">
                    PDF Paper
                    <select
                      value={exportSettings.pdfPageSize}
                      onChange={(e) => updateExportSetting("pdfPageSize", e.target.value)}
                    >
                      <option value="a4">A4</option>
                      <option value="a3">A3</option>
                    </select>
                  </label>
                  <label className="export-field">
                    PDF Orientation
                    <select
                      value={exportSettings.pdfOrientation}
                      onChange={(e) => updateExportSetting("pdfOrientation", e.target.value)}
                    >
                      <option value="landscape">Landscape</option>
                      <option value="portrait">Portrait</option>
                    </select>
                  </label>
                  <label className="export-field export-field-wide">
                    Notes
                    <textarea
                      rows={2}
                      value={exportSettings.notes}
                      onChange={(e) => updateExportSetting("notes", e.target.value)}
                      placeholder="Site notes, datum remarks, quality controls..."
                    />
                  </label>
                </div>
                <div className="export-panel-actions">
                  <button
                    className="btn btn-ghost"
                    onClick={() => handleMapExport("png")}
                    disabled={isExportingMap}
                  >
                    Export PNG
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => handleMapExport("pdf")}
                    disabled={isExportingMap}
                  >
                    Export PDF
                  </button>
                </div>
              </div>
            )}

            {/* Leaflet map */}
            <div style={{ width: "100%", height: mapFocusMode ? "72vh" : "520px", flexShrink: 0 }}>
              <MapVisualization
                points={allPoints}
                cadGeometry={cadGeometry}
                isVisible={true}
                measureMode={measureMode}
                measurePoints={measurePoints}
                onPointSelect={handleMapPointSelect}
                onMapContainerReady={setMapExportRoot}
                onMapMetricsChange={setMapMetrics}
                onMapInstanceReady={setMapInstance}
              />
            </div>

            {/* Measure results panel */}
            {(measureMode || measurePoints.length > 0) && (
              <div className="measure-panel fade-slide-in">
                <div className="measure-panel-header">
                  <span className="measure-panel-title">Measure Results</span>
                  <div className="measure-unit-controls">
                    <label className="measure-unit-label">
                      Distance
                      <select
                        value={distanceDisplayUnit}
                        onChange={(e) => setDistanceDisplayUnit(e.target.value)}
                      >
                        <option value="m">meters</option>
                        <option value="km">kilometers</option>
                      </select>
                    </label>
                    <label className="measure-unit-label">
                      Angle
                      <select
                        value={angleDisplayUnit}
                        onChange={(e) => setAngleDisplayUnit(e.target.value)}
                      >
                        <option value="deg">degree (°)</option>
                        <option value="gon">gon</option>
                      </select>
                    </label>
                    {measureMode && (
                      <span className="measure-hint">
                        ↑ Click converted map points to set P1 then P2
                      </span>
                    )}
                  </div>
                </div>

                {measurePoints.length === 0 && (
                  <p className="measure-empty">
                    Turn on Measure, then click two converted points on the map.
                  </p>
                )}

                {measurePoints.length === 1 && (
                  <p className="measure-p1-info">
                    <strong>P1</strong> — {measurePoints[0].sourceLabel || "Converted point"}&nbsp;
                    ({measurePoints[0].lat.toFixed(5)}°, {measurePoints[0].lng.toFixed(5)}°)
                    &nbsp;· Click a second converted point for P2
                  </p>
                )}

                {measureLegs.length > 0 && (
                  <>
                    {measureLegs.map((leg, i) => (
                      <div key={i} className="leg-card fade-slide-in">
                        <div className="leg-card-header">
                          <span>Leg {leg.from} → {leg.to}</span>
                          <span style={{ opacity: 0.75, fontWeight: 500 }}>UTM zone {leg.utmZone}</span>
                        </div>
                        <table className="leg-table">
                          <thead>
                            <tr>
                              <th>Metric</th>
                              <th>Value</th>
                              <th>Use</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr>
                              <td>Slope Distance</td>
                              <td>{formatDistance(leg.slopeDistance)}</td>
                              <td>Total station raw</td>
                            </tr>
                            <tr>
                              <td>Horizontal Distance</td>
                              <td>{formatDistance(leg.horizontalDistance)}</td>
                              <td>Area / boundary</td>
                            </tr>
                            <tr>
                              <td>Grid Distance</td>
                              <td>{formatDistance(leg.gridDistance)}</td>
                              <td>CAD / GIS</td>
                            </tr>
                            <tr className="leg-row-highlight-green">
                              <td>Ground Distance</td>
                              <td>{formatDistance(leg.groundDistance)}</td>
                              <td>Legal surveys</td>
                            </tr>
                            <tr className="leg-row-highlight-blue">
                              <td>Geodesic Distance</td>
                              <td>{formatDistance(leg.geodesicDistance)}</td>
                              <td>GPS / most accurate</td>
                            </tr>
                            <tr>
                              <td>Forward Azimuth</td>
                              <td>{formatAngle(leg.azimuth)}</td>
                              <td>Direction P1 → P2</td>
                            </tr>
                            <tr className="leg-row-factors">
                              <td>Scale Factor</td>
                              <td>{leg.scaleFactor.toFixed(8)}</td>
                              <td>Projection correction</td>
                            </tr>
                            <tr className="leg-row-factors">
                              <td>Elevation Factor</td>
                              <td>{leg.elevationFactor.toFixed(8)}</td>
                              <td>Sea → ground</td>
                            </tr>
                            <tr className="leg-row-cf">
                              <td>Combined Factor</td>
                              <td>{leg.combinedFactor.toFixed(8)}</td>
                              <td>Scale × Elevation</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    ))}

                    {measureLegs.length > 1 && (
                      <table className="totals-table">
                        <thead>
                          <tr>
                            <th colSpan={2}>Traverse Totals</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td>Total Ground Distance</td>
                            <td>{formatDistance(totalGroundDistance)}</td>
                          </tr>
                          <tr>
                            <td>Total Geodesic Distance</td>
                            <td>{formatDistance(totalGeodesicDistance)}</td>
                          </tr>
                        </tbody>
                      </table>
                    )}

                    <div className="measure-legend">
                      <div><strong>Ground Distance:</strong> Grid Distance × Scale Factor × Elevation Factor</div>
                      <div><strong>Geodesic:</strong> Ellipsoidal arc on WGS-84 — most accurate over long distances</div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <footer className="app-signature">by FRAH Brahim</footer>
      <Analytics />
    </div>
  );
}
export default App;

