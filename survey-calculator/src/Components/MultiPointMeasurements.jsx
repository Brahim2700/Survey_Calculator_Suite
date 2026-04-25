import React, { useMemo, useState } from 'react';
import { calculateGeodesicDistance } from '../utils/calculations';

const MultiPointMeasurements = ({ measurePoints = [] }) => {
  const [measurementName, setMeasurementName] = useState('');
  const [savedMeasurements, setSavedMeasurements] = useState([]);

  const measurements = useMemo(() => {
    const pts = Array.isArray(measurePoints) ? measurePoints : [];
    if (pts.length < 2) return null;

    let totalDistance = 0;
    let totalElevationChange = 0;
    let minElevation = Infinity;
    let maxElevation = -Infinity;

    // Calculate distances between consecutive points
    const segments = [];
    for (let i = 0; i < pts.length - 1; i += 1) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const distResult = calculateGeodesicDistance(p1.lat, p1.lng, p2.lat, p2.lng);
      const dist = Number(distResult?.distance) || 0;
      segments.push({ from: i, to: i + 1, distance: dist });
      totalDistance += dist;
    }

    // Calculate elevation stats
    pts.forEach((p, i) => {
      const h = Number(p?.height || 0);
      if (i > 0) {
        totalElevationChange += Math.abs(h - (pts[i - 1]?.height || h));
      }
      minElevation = Math.min(minElevation, h);
      maxElevation = Math.max(maxElevation, h);
    });

    // Calculate polygon area if path is closed (first == last)
    let polygonArea = 0;
    const isClosed = pts.length >= 3 &&
      Math.abs(pts[0].lat - pts[pts.length - 1].lat) < 0.00001 &&
      Math.abs(pts[0].lng - pts[pts.length - 1].lng) < 0.00001;

    if (isClosed) {
      // Shoelace formula for area
      let sum = 0;
      for (let i = 0; i < pts.length - 1; i += 1) {
        sum += pts[i].lat * pts[i + 1].lng - pts[i + 1].lat * pts[i].lng;
      }
      polygonArea = Math.abs(sum) / 2;
      // Very rough conversion to m² (1° ≈ 111km, so 1°² ≈ 111km × 111km)
      polygonArea *= 111000 * 111000;
    }

    const avgElevation = pts.reduce((sum, p) => sum + (Number(p?.height) || 0), 0) / pts.length;

    return {
      pointCount: pts.length,
      segments,
      totalDistance,
      totalElevationChange,
      minElevation,
      maxElevation,
      avgElevation,
      polygonArea,
      isClosed,
    };
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
        totalElevationChange: measurements.totalElevationChange,
        avgElevation: measurements.avgElevation,
        minElevation: measurements.minElevation,
        maxElevation: measurements.maxElevation,
        polygonArea: measurements.polygonArea,
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
    const csv = [
      ['Measurement Name', 'Timestamp', 'Points', 'Distance (m)', 'Elevation Change (m)', 'Min Elev (m)', 'Max Elev (m)', 'Avg Elev (m)', 'Area (m²)', 'Closed Path'].join(','),
      ...savedMeasurements.map((m) =>
        [
          `"${m.name}"`,
          `"${m.timestamp}"`,
          m.data.pointCount,
          m.data.totalDistance.toFixed(2),
          m.data.totalElevationChange.toFixed(2),
          m.data.minElevation.toFixed(2),
          m.data.maxElevation.toFixed(2),
          m.data.avgElevation.toFixed(2),
          m.data.polygonArea.toFixed(2),
          m.data.isClosed ? 'Yes' : 'No',
        ].join(',')
      ),
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'measurements.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div
      style={{
        background: 'rgba(15, 32, 64, 0.92)',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: '12px',
        padding: '12px',
        color: '#cbd5e1',
        fontSize: '10px',
        lineHeight: 1.5,
      }}
    >
      <div style={{ fontWeight: 800, marginBottom: '8px', color: '#e0eaff', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        Multi-Point Measurements
      </div>

      {measurements ? (
        <div style={{ display: 'grid', gap: '10px' }}>
          {/* Current measurement */}
          <div style={{ background: 'rgba(37,99,235,0.15)', padding: '10px', borderRadius: '8px', borderLeft: '3px solid rgba(59,130,246,0.7)' }}>
            <div style={{ marginBottom: '6px', fontSize: '9px', color: '#93c5fd', fontWeight: 600 }}>
              🔴 Live Measurement ({measurements.pointCount} points)
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '10px' }}>
              <div>
                <span style={{ color: '#94a3b8' }}>Distance:</span> <strong style={{ color: '#e0eaff' }}>{(measurements.totalDistance / 1000).toFixed(3)} km</strong>
              </div>
              <div>
                <span style={{ color: '#94a3b8' }}>Elevation Δ:</span> <strong style={{ color: '#e0eaff' }}>{measurements.totalElevationChange.toFixed(2)} m</strong>
              </div>
              <div>
                <span style={{ color: '#94a3b8' }}>Min/Max:</span> <strong style={{ color: '#e0eaff' }}>{measurements.minElevation.toFixed(2)} / {measurements.maxElevation.toFixed(2)} m</strong>
              </div>
              <div>
                <span style={{ color: '#94a3b8' }}>Avg Elev:</span> <strong style={{ color: '#e0eaff' }}>{measurements.avgElevation.toFixed(2)} m</strong>
              </div>
              {measurements.isClosed && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <span style={{ color: '#94a3b8' }}>Area:</span> <strong style={{ color: '#22c55e' }}>{(measurements.polygonArea / 1000000).toFixed(3)} km²</strong>
                </div>
              )}
            </div>

            {/* Save measurement */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px', marginTop: '8px' }}>
              <input
                type="text"
                placeholder="Name this measurement..."
                value={measurementName}
                onChange={(e) => setMeasurementName(e.target.value)}
                style={{
                  border: '1px solid rgba(148,163,184,0.45)',
                  background: 'rgba(15,23,42,0.65)',
                  color: '#e2e8f0',
                  borderRadius: '5px',
                  fontSize: '9px',
                  padding: '4px 6px',
                }}
              />
              <button
                onClick={handleSaveMeasurement}
                disabled={!measurementName.trim()}
                style={{
                  border: '1px solid rgba(148,163,184,0.55)',
                  background: measurementName.trim() ? 'rgba(34,197,94,0.65)' : 'rgba(107,114,128,0.3)',
                  color: measurementName.trim() ? '#e2e8f0' : '#9ca3af',
                  borderRadius: '5px',
                  fontSize: '9px',
                  padding: '4px 10px',
                  cursor: measurementName.trim() ? 'pointer' : 'not-allowed',
                  fontWeight: 600,
                }}
              >
                Save
              </button>
            </div>
          </div>

          {/* Saved measurements */}
          {savedMeasurements.length > 0 && (
            <div style={{ borderTop: '1px solid rgba(148,163,184,0.2)', paddingTop: '8px' }}>
              <div style={{ fontSize: '9px', color: '#93c5fd', fontWeight: 600, marginBottom: '6px' }}>
                📋 Saved ({savedMeasurements.length})
              </div>

              <div style={{ display: 'grid', gap: '6px', maxHeight: '120px', overflowY: 'auto', paddingRight: '4px' }}>
                {savedMeasurements.map((m) => (
                  <div key={m.id} style={{ background: 'rgba(15,23,42,0.6)', padding: '6px 8px', borderRadius: '5px', fontSize: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '2px' }}>
                      <div>
                        <strong style={{ color: '#e0eaff' }}>{m.name}</strong>
                        <div style={{ color: '#94a3b8', fontSize: '7px' }}>{m.timestamp}</div>
                      </div>
                      <button
                        onClick={() => handleDeleteSaved(m.id)}
                        style={{
                          border: 'none',
                          background: 'rgba(239,68,68,0.3)',
                          color: '#fca5a5',
                          borderRadius: '3px',
                          fontSize: '7px',
                          padding: '2px 4px',
                          cursor: 'pointer',
                        }}
                      >
                        ✕
                      </button>
                    </div>
                    <div style={{ color: '#cbd5e1', lineHeight: 1.3 }}>
                      {m.data.totalDistance > 0 && <div>↔ {(m.data.totalDistance / 1000).toFixed(2)} km</div>}
                      {m.data.polygonArea > 0 && <div>◻ {(m.data.polygonArea / 1000000).toFixed(3)} km²</div>}
                      <div>⬍ {m.data.minElevation.toFixed(0)}-{m.data.maxElevation.toFixed(0)} m</div>
                    </div>
                  </div>
                ))}
              </div>

              <button
                onClick={handleExportMeasurements}
                style={{
                  width: '100%',
                  marginTop: '8px',
                  border: '1px solid rgba(148,163,184,0.55)',
                  background: 'rgba(15,23,42,0.65)',
                  color: '#e2e8f0',
                  borderRadius: '6px',
                  fontSize: '9px',
                  padding: '5px 6px',
                  cursor: 'pointer',
                }}
              >
                📥 Export CSV
              </button>
            </div>
          )}
        </div>
      ) : (
        <div style={{ padding: '20px', textAlign: 'center', color: '#94a3b8', fontSize: '10px' }}>
          Click on the map to start measuring (measure mode must be enabled)
        </div>
      )}
    </div>
  );
};

export default MultiPointMeasurements;
