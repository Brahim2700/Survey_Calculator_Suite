import React, { useEffect, useMemo, useState } from 'react';
import { buildElevationProfileData, ELEVATION_PROVIDERS, fetchElevationProfile } from '../utils/elevationProfileApi';

const ElevationProfile = ({ measurePoints = [] }) => {
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [profileData, setProfileData] = useState(null);
  const [hoverIndex, setHoverIndex] = useState(null);
  const [providerId, setProviderId] = useState('ign');

  const selectedPointSummary = useMemo(() => {
    const points = Array.isArray(measurePoints) ? measurePoints : [];
    return points
      .filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng))
      .map((point, index) => ({
        id: point.id ?? index,
        label: String(point.label || point.sourceLabel || `P${index + 1}`),
        elevation: Number(point?.height || 0),
      }));
  }, [measurePoints]);

  useEffect(() => {
    const pts = Array.isArray(measurePoints) ? measurePoints : [];
    if (pts.length < 2) {
      return;
    }

    const abortController = new AbortController();
    const fallbackProfile = buildElevationProfileData(
      pts.map((point, index) => ({
        lat: point.lat,
        lng: point.lng,
        elevation: Number(point?.height || 0),
        label: point.label || point.sourceLabel || `P${index + 1}`,
      })),
      {
        sourceLabel: 'Measured point heights',
        sampled: false,
        selectedPointCount: pts.length,
      }
    );

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setErrorMessage('');
    setHoverIndex(null);

    fetchElevationProfile(pts, providerId, { signal: abortController.signal })
      .then((nextProfile) => {
        setProfileData(nextProfile);
      })
      .catch((error) => {
        if (abortController.signal.aborted) return;
        setProfileData(fallbackProfile);
        setErrorMessage(error?.message || 'Unable to fetch the online elevation profile.');
      })
      .finally(() => {
        if (!abortController.signal.aborted) {
          setIsLoading(false);
        }
      });

    return () => {
      abortController.abort();
    };
  }, [measurePoints, providerId]);

  const chartMetrics = useMemo(() => {
    if (!profileData || profileData.points.length < 2) return null;

    const width = 640;
    const height = 220;
    const padding = { top: 16, right: 16, bottom: 34, left: 46 };
    const innerWidth = width - padding.left - padding.right;
    const innerHeight = height - padding.top - padding.bottom;
    const baselineY = padding.top + innerHeight;

    const chartPoints = profileData.points.map((point) => {
      const x = padding.left + (profileData.totalDistance > 0 ? (point.distance / profileData.totalDistance) * innerWidth : 0);
      const normalizedElevation = (point.elevation - profileData.minElev) / profileData.elevRange;
      const y = padding.top + ((1 - normalizedElevation) * innerHeight);
      return { ...point, x, y };
    });

    const areaPath = [
      `M ${chartPoints[0].x} ${baselineY}`,
      ...chartPoints.map((point) => `L ${point.x} ${point.y}`),
      `L ${chartPoints[chartPoints.length - 1].x} ${baselineY}`,
      'Z',
    ].join(' ');

    const linePath = chartPoints.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');

    const horizontalGrid = Array.from({ length: 4 }, (_, index) => {
      const ratio = index / 3;
      const y = padding.top + (ratio * innerHeight);
      const elevation = profileData.maxElev - (ratio * profileData.elevRange);
      return { y, elevation };
    });

    return {
      width,
      height,
      padding,
      innerWidth,
      innerHeight,
      baselineY,
      chartPoints,
      areaPath,
      linePath,
      horizontalGrid,
    };
  }, [profileData]);

  const hoverPoint = chartMetrics && chartMetrics.chartPoints.length
    ? chartMetrics.chartPoints[Math.min(hoverIndex ?? chartMetrics.chartPoints.length - 1, chartMetrics.chartPoints.length - 1)]
    : null;

  const formatDistance = (distanceMeters) => {
    if (!Number.isFinite(distanceMeters)) return '--';
    if (distanceMeters >= 1000) return `${(distanceMeters / 1000).toFixed(2)} km`;
    return `${distanceMeters.toFixed(0)} m`;
  };

  const handleChartMove = (event) => {
    if (!chartMetrics) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const localX = event.clientX - rect.left;

    let closestIndex = 0;
    let closestDistance = Number.POSITIVE_INFINITY;
    chartMetrics.chartPoints.forEach((point, index) => {
      const delta = Math.abs(point.x - localX);
      if (delta < closestDistance) {
        closestDistance = delta;
        closestIndex = index;
      }
    });

    setHoverIndex(closestIndex);
  };

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
        <div style={{ color: '#94a3b8', fontSize: '9px', marginBottom: '10px' }}>Add 2+ measurement points to generate profile</div>
        {/* Still show provider switcher in empty state so user can pre-select */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', justifyContent: 'center' }}>
          {ELEVATION_PROVIDERS.map((provider) => {
            const isActive = providerId === provider.id;
            return (
              <button
                key={provider.id}
                type="button"
                title={`${provider.description}\nCoverage: ${provider.coverage}`}
                onClick={() => setProviderId(provider.id)}
                style={{
                  padding: '2px 8px',
                  borderRadius: '999px',
                  border: `1px solid ${isActive ? 'rgba(96,165,250,0.7)' : 'rgba(148,163,184,0.25)'}`,
                  background: isActive ? 'rgba(37,99,235,0.35)' : 'rgba(15,23,42,0.5)',
                  color: isActive ? '#93c5fd' : '#94a3b8',
                  fontSize: '8px',
                  cursor: 'pointer',
                  fontWeight: isActive ? 700 : 400,
                  whiteSpace: 'nowrap',
                }}
              >
                {provider.flag} {provider.label}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 800, color: '#e0eaff', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          Elevation Profile
        </span>
        {/* Provider switcher */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
          {ELEVATION_PROVIDERS.map((provider) => {
            const isActive = providerId === provider.id;
            return (
              <button
                key={provider.id}
                type="button"
                title={`${provider.description}\nCoverage: ${provider.coverage}`}
                onClick={() => setProviderId(provider.id)}
                style={{
                  padding: '2px 8px',
                  borderRadius: '999px',
                  border: `1px solid ${isActive ? 'rgba(96,165,250,0.7)' : 'rgba(148,163,184,0.25)'}`,
                  background: isActive ? 'rgba(37,99,235,0.35)' : 'rgba(15,23,42,0.5)',
                  color: isActive ? '#93c5fd' : '#94a3b8',
                  fontSize: '8px',
                  cursor: 'pointer',
                  fontWeight: isActive ? 700 : 400,
                  whiteSpace: 'nowrap',
                  transition: 'all 0.15s',
                }}
              >
                {provider.flag} {provider.label}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '8px', color: '#cbd5e1', padding: '4px 8px', borderRadius: '999px', background: 'rgba(37,99,235,0.18)', border: '1px solid rgba(96,165,250,0.3)' }}>
          <span style={{ width: '6px', height: '6px', borderRadius: '999px', background: profileData.sampled ? '#22c55e' : '#f59e0b' }} />
          {profileData.sampled ? 'IGN GeoPlateforme terrain profile' : 'Fallback: selected point heights only'}
        </span>
        <span style={{ fontSize: '8px', color: '#94a3b8' }}>
          {profileData.sampled ? `${profileData.points.length} sampled elevations` : `${profileData.selectedPointCount} selected points`}
        </span>
      </div>

      {errorMessage && (
        <div style={{ marginBottom: '10px', padding: '8px 10px', borderRadius: '8px', background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.26)', color: '#fcd34d', fontSize: '8px' }}>
          {errorMessage}
        </div>
      )}

      <div
        style={{
          background: 'rgba(15,23,42,0.6)',
          padding: '10px 8px 6px',
          borderRadius: '6px',
          marginBottom: '10px',
          position: 'relative',
          overflow: 'hidden',
        }}
        onMouseMove={handleChartMove}
        onMouseLeave={() => setHoverIndex(null)}
      >
        {isLoading && (
          <div style={{ position: 'absolute', top: '10px', right: '10px', fontSize: '8px', color: '#93c5fd', zIndex: 2 }}>
            Loading terrain samples...
          </div>
        )}
        {chartMetrics && (
          <svg viewBox={`0 0 ${chartMetrics.width} ${chartMetrics.height}`} style={{ width: '100%', height: '220px', display: 'block' }} role="img" aria-label="Elevation profile chart">
            <defs>
              <linearGradient id="elevationProfileFill" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#6d28d9" stopOpacity="0.95" />
                <stop offset="50%" stopColor="#06b6d4" stopOpacity="0.95" />
                <stop offset="100%" stopColor="#7c3aed" stopOpacity="0.95" />
              </linearGradient>
              <linearGradient id="elevationProfileStroke" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#c084fc" />
                <stop offset="55%" stopColor="#67e8f9" />
                <stop offset="100%" stopColor="#8b5cf6" />
              </linearGradient>
            </defs>

            {chartMetrics.horizontalGrid.map((gridLine) => (
              <g key={gridLine.y}>
                <line x1={chartMetrics.padding.left} y1={gridLine.y} x2={chartMetrics.width - chartMetrics.padding.right} y2={gridLine.y} stroke="rgba(148,163,184,0.22)" strokeWidth="1" />
                <text x={chartMetrics.padding.left - 8} y={gridLine.y + 3} textAnchor="end" fill="#94a3b8" fontSize="10">
                  {gridLine.elevation.toFixed(0)}
                </text>
              </g>
            ))}

            <path d={chartMetrics.areaPath} fill="url(#elevationProfileFill)" opacity="0.92" />
            <path d={chartMetrics.linePath} fill="none" stroke="url(#elevationProfileStroke)" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />

            <line x1={chartMetrics.padding.left} y1={chartMetrics.baselineY} x2={chartMetrics.width - chartMetrics.padding.right} y2={chartMetrics.baselineY} stroke="rgba(148,163,184,0.22)" strokeWidth="1" />

            {[0, 0.5, 1].map((ratio) => {
              const x = chartMetrics.padding.left + (ratio * chartMetrics.innerWidth);
              const distanceLabel = formatDistance(profileData.totalDistance * ratio);
              return (
                <g key={ratio}>
                  <line x1={x} y1={chartMetrics.padding.top} x2={x} y2={chartMetrics.baselineY} stroke="rgba(148,163,184,0.08)" strokeWidth="1" />
                  <text x={x} y={chartMetrics.height - 8} textAnchor={ratio === 0 ? 'start' : ratio === 1 ? 'end' : 'middle'} fill="#94a3b8" fontSize="10">
                    {distanceLabel}
                  </text>
                </g>
              );
            })}

            {hoverPoint && (
              <g>
                <line x1={hoverPoint.x} y1={chartMetrics.padding.top} x2={hoverPoint.x} y2={chartMetrics.baselineY} stroke="#0ea5e9" strokeWidth="1.5" strokeDasharray="4 4" />
                <circle cx={hoverPoint.x} cy={hoverPoint.y} r="4.5" fill="#e2e8f0" stroke="#0ea5e9" strokeWidth="2" />
              </g>
            )}
          </svg>
        )}

        {hoverPoint && (
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', fontSize: '9px', color: '#e2e8f0', padding: '2px 6px 4px' }}>
            <strong style={{ color: '#f8fafc' }}>{formatDistance(hoverPoint.distance)}</strong>
            <span>{hoverPoint.elevation.toFixed(2)} m</span>
            <span>{hoverPoint.label}</span>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '8px', marginBottom: '10px' }}>
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
            Avg: <strong style={{ color: '#e0eaff' }}>{profileData.avgElev.toFixed(2)} m</strong>
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
            Samples: <strong style={{ color: '#e0eaff' }}>{profileData.points.length}</strong>
          </div>
          <div style={{ fontSize: '9px' }}>
            Selected: <strong style={{ color: '#e0eaff' }}>{profileData.selectedPointCount}</strong>
          </div>
        </div>

        <div style={{ background: 'rgba(15,23,42,0.6)', padding: '8px', borderRadius: '6px', borderLeft: '2px solid rgba(245,158,11,0.5)' }}>
          <div style={{ fontSize: '8px', color: '#fbbf24', marginBottom: '3px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Terrain Change
          </div>
          <div style={{ fontSize: '9px' }}>
            Gain: <strong style={{ color: '#e0eaff' }}>{profileData.positiveGain.toFixed(2)} m</strong>
          </div>
          <div style={{ fontSize: '9px' }}>
            Loss: <strong style={{ color: '#e0eaff' }}>{profileData.negativeGain.toFixed(2)} m</strong>
          </div>
          <div style={{ fontSize: '9px' }}>
            Slope: <strong style={{ color: '#e0eaff' }}>{profileData.maxSlopePercent.toFixed(2)}%</strong> / <strong style={{ color: '#e0eaff' }}>{profileData.minSlopePercent.toFixed(2)}%</strong>
          </div>
        </div>
      </div>

      <div style={{ fontSize: '8px', color: '#94a3b8', maxHeight: '100px', overflowY: 'auto', paddingRight: '4px' }}>
        {selectedPointSummary.map((point, index) => (
          <div
            key={`${point.id}-${index}`}
            style={{
              display: 'grid',
              gridTemplateColumns: '20px 1fr auto',
              gap: '6px',
              padding: '4px 6px',
              borderBottom: index < selectedPointSummary.length - 1 ? '1px solid rgba(148,163,184,0.1)' : 'none',
              alignItems: 'center',
            }}
          >
            <span style={{ fontSize: '9px', color: '#93c5fd', fontWeight: 600 }}>P{index + 1}</span>
            <span style={{ fontSize: '9px', color: '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {point.label}
            </span>
            <span style={{ fontSize: '8px', color: '#a7f3d0', whiteSpace: 'nowrap' }}>
              {point.elevation.toFixed(2)}m
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ElevationProfile;
