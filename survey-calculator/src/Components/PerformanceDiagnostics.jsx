import React, { useEffect, useRef, useState } from 'react';

const PerformanceDiagnostics = ({ points = [], cadGeometry = {}, mapMetrics = {} }) => {
  const [stats, setStats] = useState({
    pointCount: 0,
    lineCount: 0,
    polylineCount: 0,
    totalVertices: 0,
    estimatedMemory: '0 MB',
    renderTime: '0 ms',
    fps: '60',
  });

  const frameCountRef = useRef(0);
  const lastTimeRef = useRef(0);
  const animationIdRef = useRef(null);

  useEffect(() => {
    lastTimeRef.current = Date.now();
  }, []);

  useEffect(() => {
    // Calculate data statistics
    const pointCount = Array.isArray(points) ? points.length : 0;
    const lineCount = Array.isArray(cadGeometry?.lines) ? cadGeometry.lines.length : 0;
    const polylineCount = Array.isArray(cadGeometry?.polylines) ? cadGeometry.polylines.length : 0;

    let totalVertices = 0;
    (Array.isArray(cadGeometry?.polylines) ? cadGeometry.polylines : []).forEach((poly) => {
      if (Array.isArray(poly?.points)) {
        totalVertices += poly.points.length;
      }
    });
    totalVertices += lineCount * 2; // Each line has 2 endpoints

    // Estimate memory usage (rough estimate)
    const pointMemory = pointCount * 120; // ~120 bytes per point
    const vertexMemory = totalVertices * 24; // ~24 bytes per vertex
    const totalMemory = (pointMemory + vertexMemory) / (1024 * 1024); // Convert to MB

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStats((prev) => ({
      ...prev,
      pointCount,
      lineCount,
      polylineCount,
      totalVertices,
      estimatedMemory: totalMemory.toFixed(2),
    }));
  }, [points, cadGeometry]);

  // Measure FPS
  useEffect(() => {
    const measureFrame = () => {
      frameCountRef.current += 1;
      const now = Date.now();
      const elapsed = now - lastTimeRef.current;

      if (elapsed >= 1000) {
        const fps = Math.round((frameCountRef.current * 1000) / elapsed);
        setStats((prev) => ({
          ...prev,
          fps: String(fps),
        }));
        frameCountRef.current = 0;
        lastTimeRef.current = now;
      }

      animationIdRef.current = requestAnimationFrame(measureFrame);
    };

    animationIdRef.current = requestAnimationFrame(measureFrame);
    return () => {
      if (animationIdRef.current) {
        cancelAnimationFrame(animationIdRef.current);
      }
    };
  }, []);

  // Update render time from map metrics
  useEffect(() => {
    if (mapMetrics?.lastRenderTime) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStats((prev) => ({
        ...prev,
        renderTime: `${mapMetrics.lastRenderTime.toFixed(1)} ms`,
      }));
    }
  }, [mapMetrics]);

  const getHealthStatus = () => {
    const totalObjects = stats.pointCount + stats.lineCount + stats.polylineCount;
    const totalVerts = stats.totalVertices;

    if (totalObjects > 15000 || totalVerts > 500000) return { status: 'ℹ LARGE', color: '#f59e0b' };
    if (totalObjects > 8000 || totalVerts > 200000) return { status: '⚠ MODERATE', color: '#fbbf24' };
    return { status: '✓ GOOD', color: '#22c55e' };
  };

  const health = getHealthStatus();

  return (
    <div
      style={{
        background: 'rgba(15, 32, 64, 0.92)',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: '12px',
        padding: '12px',
        color: '#cbd5e1',
        fontSize: '10px',
        lineHeight: 1.6,
        fontFamily: 'monospace',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <div style={{ fontWeight: 800, color: '#e0eaff', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          Performance Diagnostics
        </div>
        <div style={{ color: health.color, fontWeight: 700, fontSize: '9px' }}>{health.status}</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
        {/* Data Section */}
        <div style={{ background: 'rgba(15,23,42,0.6)', padding: '8px', borderRadius: '6px', borderLeft: '2px solid rgba(59,130,246,0.5)' }}>
          <div style={{ fontSize: '8px', color: '#93c5fd', textTransform: 'uppercase', marginBottom: '4px', letterSpacing: '0.05em' }}>
            Data
          </div>
          <div>Points: <strong style={{ color: '#e0eaff' }}>{stats.pointCount.toLocaleString()}</strong></div>
          <div>Lines: <strong style={{ color: '#e0eaff' }}>{stats.lineCount.toLocaleString()}</strong></div>
          <div>Polylines: <strong style={{ color: '#e0eaff' }}>{stats.polylineCount.toLocaleString()}</strong></div>
          <div>Vertices: <strong style={{ color: '#e0eaff' }}>{stats.totalVertices.toLocaleString()}</strong></div>
        </div>

        {/* Performance Section */}
        <div style={{ background: 'rgba(15,23,42,0.6)', padding: '8px', borderRadius: '6px', borderLeft: '2px solid rgba(34,197,94,0.5)' }}>
          <div style={{ fontSize: '8px', color: '#86efac', textTransform: 'uppercase', marginBottom: '4px', letterSpacing: '0.05em' }}>
            Performance
          </div>
          <div>Memory: <strong style={{ color: '#e0eaff' }}>{stats.estimatedMemory} MB</strong></div>
          <div>Render: <strong style={{ color: '#e0eaff' }}>{stats.renderTime}</strong></div>
          <div>FPS: <strong style={{ color: stats.fps >= 50 ? '#22c55e' : stats.fps >= 30 ? '#f59e0b' : '#ef4444' }}>{stats.fps}</strong></div>
        </div>
      </div>

      {/* Health indicators */}
      <div style={{ fontSize: '8px', color: '#94a3b8', background: 'rgba(15,23,42,0.4)', padding: '6px 8px', borderRadius: '6px' }}>
        <div style={{ marginBottom: '3px', fontWeight: 600 }}>💡 Optimization Tips:</div>
        <ul style={{ margin: '0', paddingLeft: '16px' }}>
          {stats.pointCount > 5000 && (
            <li>Large point count: Enable Duplicate Remover or Filter points</li>
          )}
          {stats.totalVertices > 100000 && (
            <li>Many vertices: CAD geometry is complex; zoom out for faster rendering</li>
          )}
          {Number(stats.estimatedMemory) > 50 && (
            <li>High memory usage: Consider splitting into smaller files</li>
          )}
          {stats.fps < 50 && (
            <li>Low FPS: Try disabling labels or zooming to specific area</li>
          )}
        </ul>
      </div>
    </div>
  );
};

export default PerformanceDiagnostics;
