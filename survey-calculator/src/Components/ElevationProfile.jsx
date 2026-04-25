import React, { useEffect, useState } from 'react';
import { calculateGeodesicDistance } from '../utils/calculations';

const ElevationProfile = ({ measurePoints = [] }) => {
  const [profileData, setProfileData] = useState(null);

  useEffect(() => {
    const pts = Array.isArray(measurePoints) ? measurePoints : [];
    if (pts.length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProfileData(null);
      return;
    }

    // Build elevation profile data
    const profile = [];
    let cumulativeDistance = 0;

    pts.forEach((p, i) => {
      const elevation = Number(p?.height || 0);
      const label = String(p?.label || p?.id || `Point ${i + 1}`);

      if (i > 0) {
        const prevP = pts[i - 1];
        const distance = calculateGeodesicDistance(prevP.lat, prevP.lng, p.lat, p.lng);
        cumulativeDistance += distance;
      }

      profile.push({
        index: i,
        label,
        elevation,
        distance: cumulativeDistance,
      });
    });

    // Calculate min/max for scaling
    const elevations = profile.map((p) => p.elevation);
    const minElev = Math.min(...elevations);
    const maxElev = Math.max(...elevations);
    const elevRange = maxElev - minElev || 1;

    setProfileData({
      points: profile,
      minElev,
      maxElev,
      elevRange,
      totalDistance: cumulativeDistance,
    });
  }, [measurePoints]);

  if (!profileData || profileData.points.length < 2) {
    return (
      <div
        style={{
          background: 'rgba(15, 32, 64, 0.92)',
          border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: '12px',
          padding: '12px',
          color: '#cbd5e1',
          fontSize: '10px',
          textAlign: 'center',
        }}
      >
        <div style={{ fontWeight: 800, marginBottom: '8px', color: '#e0eaff', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          Elevation Profile
        </div>
        <div style={{ color: '#94a3b8', fontSize: '9px' }}>Add 2+ measurement points to generate profile</div>
      </div>
    );
  }

  // Simple ASCII chart rendering
  const chartHeight = 8;
  const chartWidth = 40;
  const chart = Array(chartHeight).fill('').map(() => Array(chartWidth).fill(' '));

  profileData.points.forEach((p) => {
    const x = Math.floor((p.distance / profileData.totalDistance) * (chartWidth - 1));
    const normalizedElev = (p.elevation - profileData.minElev) / profileData.elevRange;
    const y = Math.floor((1 - normalizedElev) * (chartHeight - 1));

    if (x >= 0 && x < chartWidth && y >= 0 && y < chartHeight) {
      chart[y][x] = '█';
    }
  });

  const chartStr = chart.map((row) => row.join('')).join('\n');

  return (
    <div
      style={{
        background: 'rgba(15, 32, 64, 0.92)',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: '12px',
        padding: '12px',
        color: '#cbd5e1',
        fontSize: '10px',
      }}
    >
      <div style={{ fontWeight: 800, marginBottom: '8px', color: '#e0eaff', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        Elevation Profile
      </div>

      {/* Mini chart */}
      <div
        style={{
          background: 'rgba(15,23,42,0.6)',
          padding: '10px 8px',
          borderRadius: '6px',
          fontFamily: 'monospace',
          fontSize: '7px',
          lineHeight: 1.2,
          color: '#93c5fd',
          marginBottom: '10px',
          whiteSpace: 'pre',
          overflowX: 'auto',
        }}
      >
        {chartStr}
      </div>

      {/* Statistics */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '10px' }}>
        <div style={{ background: 'rgba(15,23,42,0.6)', padding: '8px', borderRadius: '6px', borderLeft: '2px solid rgba(34,197,94,0.5)' }}>
          <div style={{ fontSize: '8px', color: '#86efac', marginBottom: '3px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Elevation
          </div>
          <div style={{ fontSize: '9px' }}>
            Min: <strong style={{ color: '#e0eaff' }}>{profileData.minElev.toFixed(2)} m</strong>
          </div>
          <div style={{ fontSize: '9px' }}>
            Max: <strong style={{ color: '#e0eaff' }}>{profileData.maxElev.toFixed(2)} m</strong>
          </div>
          <div style={{ fontSize: '9px' }}>
            Δ: <strong style={{ color: '#e0eaff' }}>{profileData.elevRange.toFixed(2)} m</strong>
          </div>
        </div>

        <div style={{ background: 'rgba(15,23,42,0.6)', padding: '8px', borderRadius: '6px', borderLeft: '2px solid rgba(59,130,246,0.5)' }}>
          <div style={{ fontSize: '8px', color: '#93c5fd', marginBottom: '3px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Distance
          </div>
          <div style={{ fontSize: '9px' }}>
            Total: <strong style={{ color: '#e0eaff' }}>{(profileData.totalDistance / 1000).toFixed(2)} km</strong>
          </div>
          <div style={{ fontSize: '9px' }}>
            Points: <strong style={{ color: '#e0eaff' }}>{profileData.points.length}</strong>
          </div>
        </div>
      </div>

      {/* Detailed points */}
      <div style={{ fontSize: '8px', color: '#94a3b8', maxHeight: '100px', overflowY: 'auto', paddingRight: '4px' }}>
        {profileData.points.map((p, i) => (
          <div
            key={p.index}
            style={{
              display: 'grid',
              gridTemplateColumns: '20px 1fr auto',
              gap: '6px',
              padding: '4px 6px',
              borderBottom: i < profileData.points.length - 1 ? '1px solid rgba(148,163,184,0.1)' : 'none',
              alignItems: 'center',
            }}
          >
            <span style={{ fontSize: '9px', color: '#93c5fd', fontWeight: 600 }}>P{p.index + 1}</span>
            <span style={{ fontSize: '9px', color: '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {p.label}
            </span>
            <span style={{ fontSize: '8px', color: '#a7f3d0', whiteSpace: 'nowrap' }}>
              {p.elevation.toFixed(1)}m @ {(p.distance / 1000).toFixed(2)}km
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ElevationProfile;
