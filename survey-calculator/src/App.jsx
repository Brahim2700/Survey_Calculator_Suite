// src/App.jsx
import { useEffect, useState } from "react";
import { Analytics } from "@vercel/analytics/react";
import CoordinateConverter from "./Components/CoordinateConverter";
import MapVisualization from "./Components/MapVisualization";
import proj4 from "proj4";
import { calculateAllDistances, calculateGeodesicDistance, getUTMZone } from "./utils/calculations";
import { on } from "./utils/eventBus";
import { exportMapAsPdf, exportMapAsPng } from "./utils/mapExport";
import "./App.css";

function App() {
  const [converterPoints, setConverterPoints] = useState([]);
  const [cadGeometry, setCadGeometry] = useState({ lines: [], polylines: [] });
  const [measureMode, setMeasureMode] = useState(false);
  const [measurePoints, setMeasurePoints] = useState([]);
  const [distanceDisplayUnit, setDistanceDisplayUnit] = useState("m"); // m | km
  const [angleDisplayUnit, setAngleDisplayUnit] = useState("deg"); // deg | gon
  const [converterSessionKey, setConverterSessionKey] = useState(0);
  const [mapExportRoot, setMapExportRoot] = useState(null);
  const [isExportingMap, setIsExportingMap] = useState(false);

  const resetAppWorkspace = ({ remountConverter = false } = {}) => {
    setConverterPoints([]);
    setCadGeometry({ lines: [], polylines: [] });
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
      if (geometry && (Array.isArray(geometry.lines) || Array.isArray(geometry.polylines))) {
        setCadGeometry({
          lines: Array.isArray(geometry.lines) ? geometry.lines : [],
          polylines: Array.isArray(geometry.polylines) ? geometry.polylines : [],
        });
        return;
      }
      setCadGeometry({ lines: [], polylines: [] });
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
    if (point?.sourceType !== "converted") return;
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return;

    const selected = {
      lat: point.lat,
      lng: point.lng,
      source: "converted",
      sourceLabel: point.label || point.id || "Converted point",
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

  const getExportDetails = () => {
    const nowIso = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    return {
      stamp: nowIso,
      details: [
        { label: "Converted points", value: converterPoints.length },
        { label: "CAD lines", value: cadGeometry.lines.length },
        { label: "CAD polylines", value: cadGeometry.polylines.length },
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
      const exportInfo = {
        title: "Survey Plan",
        subtitle: "SurveyCalc Geomatics Suite",
        details: info.details,
      };

      if (format === "png") {
        await exportMapAsPng(mapExportRoot, exportInfo, `survey-plan-${info.stamp}.png`);
      } else {
        await exportMapAsPdf(mapExportRoot, exportInfo, `survey-plan-${info.stamp}.pdf`);
      }
    } catch (err) {
      console.error("Map export failed:", err);
      alert(`Map export failed: ${err.message || "Unknown error"}`);
    } finally {
      setIsExportingMap(false);
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
      <div className="app-columns">

        {/* Left column: tools */}
        <div className="app-col-left">
          <CoordinateConverter key={converterSessionKey} />
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
                  className="btn btn-ghost"
                  onClick={() => handleMapExport("png")}
                  title="Export plan as image (PNG)"
                  disabled={isExportingMap}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                  {isExportingMap ? "Exporting..." : "Export PNG"}
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => handleMapExport("pdf")}
                  title="Export plan as PDF"
                  disabled={isExportingMap}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  {isExportingMap ? "Exporting..." : "Export PDF"}
                </button>
              </div>
            </div>

            {/* Leaflet map */}
            <div style={{ width: "100%", height: "520px", flexShrink: 0 }}>
              <MapVisualization
                points={allPoints}
                cadGeometry={cadGeometry}
                isVisible={true}
                measureMode={measureMode}
                measurePoints={measurePoints}
                onPointSelect={handleMapPointSelect}
                onMapContainerReady={setMapExportRoot}
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

            {/* Geoid undulation legend */}
            <div className="geoid-bar">
              <strong>Geoid undulation:</strong>
              <span className="geoid-chip" style={{ background:"rgba(0,0,255,.15)", color:"#93c5fd" }}>&lt;−10 m</span>
              <span className="geoid-chip" style={{ background:"rgba(0,200,200,.12)", color:"#67e8f9" }}>−10 → −2 m</span>
              <span className="geoid-chip" style={{ background:"rgba(0,200,80,.12)", color:"#6ee7b7" }}>±2 m</span>
              <span className="geoid-chip" style={{ background:"rgba(220,200,0,.12)", color:"#fde68a" }}>+2 → +10 m</span>
              <span className="geoid-chip" style={{ background:"rgba(220,38,38,.12)", color:"#fca5a5" }}>&gt;+10 m</span>
            </div>
          </div>
        </div>
      </div>

      <footer className="app-signature">by FRAH Brahim</footer>
      <Analytics />
    </div>
  );
}
export default App;

