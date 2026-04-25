import React, { useMemo, useState } from 'react';
import { calculateGeodesicDistance, getUTMZone } from '../utils/calculations';

// Accurate polygon area (m²) using equirectangular local projection
const geodesicPolygonArea = (pts) => {
  if (pts.length < 3) return 0;
  const cosLat = Math.cos((pts.reduce((s, p) => s + p.lat, 0) / pts.length) * (Math.PI / 180));
  const R = 6371000;
  const proj = pts.map((p) => [
    (p.lng - pts[0].lng) * cosLat * R * (Math.PI / 180),
    (p.lat - pts[0].lat) * R * (Math.PI / 180),
  ]);
  let sum = 0;
  for (let i = 0; i < proj.length - 1; i += 1) {
    sum += proj[i][0] * proj[i + 1][1] - proj[i + 1][0] * proj[i][1];
  }
  return Math.abs(sum) / 2;
};

const downloadCsv = (filename, rows) => {
  const csv = rows.map((r) => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

const MultiPointMeasurements = ({ measurePoints = [], onUndoLastPoint, onClosePolygon }) => {
  const [measurementName, setMeasurementName] = useState('');
  const [savedMeasurements, setSavedMeasurements] = useState([]);
  const [showComparison, setShowComparison] = useState(false);

  const measurements = useMemo(() => {
    const pts = Array.isArray(measurePoints) ? measurePoints : [];
    if (pts.length < 2) return null;

    let totalDistance = 0;
    let totalElevationGain = 0;
    let totalElevationLoss = 0;
    let minElevation = Infinity;
    let maxElevation = -Infinity;
    const segments = [];

    for (let i = 0; i < pts.length - 1; i += 1) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const distResult = calculateGeodesicDistance(p1.lat, p1.lng, p2.lat, p2.lng);
      const dist = Number(distResult?.distance) || 0;
      const dh = (Number(p2.height) || 0) - (Number(p1.height) || 0);
      segments.push({ from: i, to: i + 1, distance: dist, dh });
      totalDistance += dist;
    }

    pts.forEach((p, i) => {
      const h = Number(p?.height || 0);
      if (i > 0) {
        const dh = h - (Number(pts[i - 1]?.height) || 0);
        if (dh > 0) totalElevationGain += dh;
        else totalElevationLoss += Math.abs(dh);
      }
      minElevation = Math.min(minElevation, h);
      maxElevation = Math.max(maxElevation, h);
    });

    const isClosed = pts.length >= 3 &&
      Math.abs(pts[0].lat - pts[pts.length - 1].lat) < 0.00001 &&
      Math.abs(pts[0].lng - pts[pts.length - 1].lng) < 0.00001;

    const polygonArea = isClosed ? geodesicPolygonArea(pts) : 0;
    const perimeter = isClosed ? totalDistance : 0;
    const avgElevation = pts.reduce((s, p) => s + (Number(p?.height) || 0), 0) / pts.length;
    const centerLon = pts.reduce((s, p) => s + p.lng, 0) / pts.length;
    const utmZone = getUTMZone(centerLon);

    return { pointCount: pts.length, segments, totalDistance, totalElevationGain, totalElevationLoss, minElevation, maxElevation, avgElevation, polygonArea, perimeter, isClosed, utmZone };
  }, [measurePoints]);

  const handleSaveMeasurement = () => {
    if (!measurementName.trim() || !measurements) return;
    const measurement = {
      id: Date.now(),
      name: measurementName,
      timestamp: new Date().toLocaleString(),
      data: {
        pointCount: measurements.pointCount,
        totalDistance: measurements.totalDistance,
        totalElevationGain: measurements.totalElevationGain,
        totalElevationLoss: measurements.totalElevationLoss,
        avgElevation: measurements.avgElevation,
        minElevation: measurements.minElevation,
        maxElevation: measurements.maxElevation,
        polygonArea: measurements.polygonArea,
        perimeter: measurements.perimeter,
        isClosed: measurements.isClosed,
      },
    };
    setSavedMeasurements((prev) => [measurement, ...prev]);
    setMeasurementName('');
  };

  const handleDeleteSaved = (id) => {
    setSavedMeasurements((prev) => prev.filter((m) => m.id !== id));
  };

  const handleExportMeasurements = () => {
    const header = ['Name', 'Timestamp', 'Pts', 'Dist_m', 'Gain_m', 'Loss_m', 'MinElev_m', 'MaxElev_m', 'AvgElev_m', 'Area_m2', 'Perimeter_m', 'Closed'];
    const rows = savedMeasurements.map((m) => [
      `"${m.name}"`, `"${m.timestamp}"`,
      m.data.pointCount, m.data.totalDistance.toFixed(2),
      m.data.totalElevationGain.toFixed(2), m.data.totalElevationLoss.toFixed(2),
      m.data.minElevation.toFixed(2), m.data.maxElevation.toFixed(2), m.data.avgElevation.toFixed(2),
      m.data.polygonArea.toFixed(2), m.data.perimeter.toFixed(2), m.data.isClosed ? 'Yes' : 'No',
    ]);
    downloadCsv('measurements.csv', [header, ...rows]);
  };

  const handleExportElevationProfile = () => {
    const pts = Array.isArray(measurePoints) ? measurePoints : [];
    if (pts.length === 0) return;
    const header = ['#', 'Label', 'Lat', 'Lng', 'Elevation_m', 'DistFromPrev_m', 'CumDist_m'];
    let cumDist = 0;
    const rows = pts.map((p, i) => {
      let distFromPrev = 0;
      if (i > 0) {
        const dr = calculateGeodesicDistance(pts[i - 1].lat, pts[i - 1].lng, p.lat, p.lng);
        distFromPrev = Number(dr?.distance) || 0;
        cumDist += distFromPrev;
      }
      return [i + 1, `"${p.label || p.sourceLabel || `P${i + 1}`}"`, p.lat.toFixed(7), p.lng.toFixed(7), (Number(p.height) || 0).toFixed(3), distFromPrev.toFixed(2), cumDist.toFixed(2)];
    });
    downloadCsv('elevation_profile.csv', [header, ...rows]);
  };

  return (
    <div style={{ background: 'rgba(15,32,64,0.92)', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '12px', padding: '12px', color: '#cbd5e1', fontSize: '10px', lineHeight: 1.5 }}>
      <div style={{ fontWeight: 800, marginBottom: '8px', color: '#e0eaff', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        Multi-Point Measurements
      </div>

      {measurements ? (
        <div style={{ display: 'grid', gap: '10px' }}>
          {/* Live stats */}
          <div style={{ background: 'rgba(37,99,235,0.15)', padding: '10px', borderRadius: '8px', borderLeft: '3px solid rgba(59,130,246,0.7)' }}>
            <div style={{ marginBottom: '6px', fontSize: '9px', color: '#93c5fd', fontWeight: 600 }}>
              🔴 Live — {measurements.pointCount} pts · UTM zone {measurements.utmZone}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px', fontSize: '10px' }}>
              <div><span style={{ color: '#94a3b8' }}>Distance:</span> <strong style={{ color: '#e0eaff' }}>{(measurements.totalDistance / 1000).toFixed(3)} km</strong></div>
              <div><span style={{ color: '#94a3b8' }}>Avg elev:</span> <strong style={{ color: '#e0eaff' }}>{measurements.avgElevation.toFixed(2)} m</strong></div>
              <div><span style={{ color: '#22c55e' }}>↑ Gain:</span> <strong style={{ color: '#22c55e' }}>{measurements.totalElevationGain.toFixed(1)} m</strong></div>
              <div><span style={{ color: '#f87171' }}>↓ Loss:</span> <strong style={{ color: '#f87171' }}>{measurements.totalElevationLoss.toFixed(1)} m</strong></div>
              <div><span style={{ color: '#94a3b8' }}>Min elev:</span> <strong style={{ color: '#e0eaff' }}>{measurements.minElevation.toFixed(2)} m</strong></div>
              <div><span style={{ color: '#94a3b8' }}>Max elev:</span> <strong style={{ color: '#e0eaff' }}>{measurements.maxElevation.toFixed(2)} m</strong></div>
              {measurements.isClosed && (
                <>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <span style={{ color: '#94a3b8' }}>Area:</span>{' '}
                    <strong style={{ color: '#22c55e' }}>{measurements.polygonArea.toFixed(0)} m²</strong>
                    {' / '}<strong style={{ color: '#22c55e' }}>{(measurements.polygonArea / 10000).toFixed(4)} ha</strong>
                    {' / '}<strong style={{ color: '#22c55e' }}>{(measurements.polygonArea / 1000000).toFixed(6)} km²</strong>
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <span style={{ color: '#94a3b8' }}>Perimeter:</span> <strong style={{ color: '#e0eaff' }}>{measurements.perimeter.toFixed(2)} m</strong>
                  </div>
                </>
              )}
            </div>

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: '5px', marginTop: '8px', flexWrap: 'wrap' }}>
              {typeof onUndoLastPoint === 'function' && (
                <button type="button" onClick={onUndoLastPoint} style={{ border: '1px solid rgba(148,163,184,0.4)', background: 'rgba(107,114,128,0.25)', color: '#e2e8f0', borderRadius: '5px', fontSize: '9px', padding: '3px 8px', cursor: 'pointer' }}>↩ Undo</button>
              )}
              {typeof onClosePolygon === 'function' && measurePoints.length >= 3 && !measurements.isClosed && (
                <button type="button" onClick={onClosePolygon} style={{ border: '1px solid rgba(34,197,94,0.5)', background: 'rgba(34,197,94,0.15)', color: '#86efac', borderRadius: '5px', fontSize: '9px', padding: '3px 8px', cursor: 'pointer' }}>🔷 Close polygon</button>
              )}
              <button type="button" onClick={handleExportElevationProfile} style={{ border: '1px solid rgba(148,163,184,0.4)', background: 'rgba(15,23,42,0.5)', color: '#e2e8f0', borderRadius: '5px', fontSize: '9px', padding: '3px 8px', cursor: 'pointer', marginLeft: 'auto' }}>📥 Export profile</button>
            </div>

            {/* Save */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px', marginTop: '8px' }}>
              <input
                type="text"
                placeholder="Name this measurement..."
                value={measurementName}
                onChange={(e) => setMeasurementName(e.target.value)}
                style={{ border: '1px solid rgba(148,163,184,0.45)', background: 'rgba(15,23,42,0.65)', color: '#e2e8f0', borderRadius: '5px', fontSize: '9px', padding: '4px 6px' }}
              />
              <button
                onClick={handleSaveMeasurement}
                disabled={!measurementName.trim()}
                style={{ border: '1px solid rgba(148,163,184,0.55)', background: measurementName.trim() ? 'rgba(34,197,94,0.65)' : 'rgba(107,114,128,0.3)', color: measurementName.trim() ? '#e2e8f0' : '#9ca3af', borderRadius: '5px', fontSize: '9px', padding: '4px 10px', cursor: measurementName.trim() ? 'pointer' : 'not-allowed', fontWeight: 600 }}
              >
                Save
              </button>
            </div>
          </div>

          {/* Saved measurements */}
          {savedMeasurements.length > 0 && (
            <div style={{ borderTop: '1px solid rgba(148,163,184,0.2)', paddingTop: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <div style={{ fontSize: '9px', color: '#93c5fd', fontWeight: 600 }}>📋 Saved ({savedMeasurements.length})</div>
                <button type="button" onClick={() => setShowComparison((v) => !v)} style={{ border: '1px solid rgba(148,163,184,0.35)', background: showComparison ? 'rgba(59,130,246,0.3)' : 'rgba(15,23,42,0.5)', color: '#93c5fd', borderRadius: '4px', fontSize: '8px', padding: '2px 7px', cursor: 'pointer' }}>
                  {showComparison ? 'List view' : 'Compare table'}
                </button>
              </div>

              {showComparison ? (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '8px' }}>
                    <thead>
                      <tr style={{ background: 'rgba(37,99,235,0.2)', color: '#93c5fd' }}>
                        {['Name', 'Pts', 'Dist m', '↑', '↓', 'Avg Z', 'Area m²', ''].map((h, i) => (
                          <th key={h || `col-${i}`} style={{ padding: '4px 5px', textAlign: i === 0 ? 'left' : 'right', borderBottom: '1px solid rgba(148,163,184,0.2)', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {savedMeasurements.map((m, idx) => (
                        <tr key={m.id} style={{ background: idx % 2 === 0 ? 'rgba(15,23,42,0.4)' : 'transparent' }}>
                          <td style={{ padding: '3px 5px', color: '#e0eaff', fontWeight: 600 }}>{m.name}</td>
                          <td style={{ padding: '3px 5px', textAlign: 'right' }}>{m.data.pointCount}</td>
                          <td style={{ padding: '3px 5px', textAlign: 'right' }}>{m.data.totalDistance.toFixed(0)}</td>
                          <td style={{ padding: '3px 5px', textAlign: 'right', color: '#86efac' }}>{m.data.totalElevationGain.toFixed(1)}</td>
                          <td style={{ padding: '3px 5px', textAlign: 'right', color: '#fca5a5' }}>{m.data.totalElevationLoss.toFixed(1)}</td>
                          <td style={{ padding: '3px 5px', textAlign: 'right' }}>{m.data.avgElevation.toFixed(1)}</td>
                          <td style={{ padding: '3px 5px', textAlign: 'right', color: '#22c55e' }}>{m.data.polygonArea > 0 ? m.data.polygonArea.toFixed(0) : '—'}</td>
                          <td style={{ padding: '3px 4px' }}><button onClick={() => handleDeleteSaved(m.id)} style={{ border: 'none', background: 'rgba(239,68,68,0.3)', color: '#fca5a5', borderRadius: '3px', fontSize: '7px', padding: '1px 4px', cursor: 'pointer' }}>✕</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ display: 'grid', gap: '6px', maxHeight: '130px', overflowY: 'auto', paddingRight: '4px' }}>
                  {savedMeasurements.map((m) => (
                    <div key={m.id} style={{ background: 'rgba(15,23,42,0.6)', padding: '6px 8px', borderRadius: '5px', fontSize: '8px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '2px' }}>
                        <div>
                          <strong style={{ color: '#e0eaff' }}>{m.name}</strong>
                          <div style={{ color: '#94a3b8', fontSize: '7px' }}>{m.timestamp}</div>
                        </div>
                        <button onClick={() => handleDeleteSaved(m.id)} style={{ border: 'none', background: 'rgba(239,68,68,0.3)', color: '#fca5a5', borderRadius: '3px', fontSize: '7px', padding: '2px 4px', cursor: 'pointer' }}>✕</button>
                      </div>
                      <div style={{ color: '#cbd5e1', lineHeight: 1.3 }}>
                        {m.data.totalDistance > 0 && <div>↔ {(m.data.totalDistance / 1000).toFixed(3)} km</div>}
                        {m.data.polygonArea > 0 && <div>◻ {m.data.polygonArea.toFixed(0)} m² / {(m.data.polygonArea / 10000).toFixed(4)} ha</div>}
                        <div>⬍ {m.data.minElevation.toFixed(0)} – {m.data.maxElevation.toFixed(0)} m</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <button onClick={handleExportMeasurements} style={{ width: '100%', marginTop: '8px', border: '1px solid rgba(148,163,184,0.55)', background: 'rgba(15,23,42,0.65)', color: '#e2e8f0', borderRadius: '6px', fontSize: '9px', padding: '5px 6px', cursor: 'pointer' }}>
                📥 Export saved CSV
              </button>
            </div>
          )}
        </div>
      ) : (
        <div style={{ padding: '20px', textAlign: 'center', color: '#94a3b8', fontSize: '10px' }}>
          Enable measure mode and click 2+ map points to start measuring
        </div>
      )}
    </div>
  );
};

export default MultiPointMeasurements;
