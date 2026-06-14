import React, { useEffect, useRef, useState } from 'react';
import { createTranslator } from '../utils/uiLanguage';

const PerformanceDiagnostics = ({ points = [], cadGeometry = {}, mapMetrics = {}, t: tProp }) => {
  const t = tProp || createTranslator('en');
  const [stats, setStats] = useState({
    pointCount: 0,
    lineCount: 0,
    polylineCount: 0,
    arcCount: 0,
    circleCount: 0,
    ellipseCount: 0,
    splineCount: 0,
    bulgeSegmentCount: 0,
    proxyCurveCount: 0,
    approximatedCurveCount: 0,
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
    const arcCount = Array.isArray(cadGeometry?.arcs) ? cadGeometry.arcs.length : 0;
    const circleCount = Array.isArray(cadGeometry?.circles) ? cadGeometry.circles.length : 0;
    const ellipseCount = Array.isArray(cadGeometry?.ellipses) ? cadGeometry.ellipses.length : 0;
    const splineCount = Array.isArray(cadGeometry?.splines) ? cadGeometry.splines.length : 0;
    const bulgeSegmentCount = Number(cadGeometry?.curveSummary?.polylineBulgeSegments || 0);
    const proxyCurveCount = Number(cadGeometry?.curveSummary?.proxyCurveEntities || 0);
    const approximatedCurveCount = Number(cadGeometry?.curveSummary?.approximatedCurves || 0);

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
      arcCount,
      circleCount,
      ellipseCount,
      splineCount,
      bulgeSegmentCount,
      proxyCurveCount,
      approximatedCurveCount,
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

    if (totalObjects > 15000 || totalVerts > 500000) return { status: `ℹ ${t('panels.healthLarge')}`, color: '#f59e0b' };
    if (totalObjects > 8000 || totalVerts > 200000) return { status: `⚠ ${t('panels.healthModerate')}`, color: '#fbbf24' };
    return { status: `✓ ${t('panels.healthGood')}`, color: '#22c55e' };
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
          {t('panels.diagnosticsTitle')}
        </div>
        <div style={{ color: health.color, fontWeight: 700, fontSize: '9px' }}>{health.status}</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
        {/* Data Section */}
        <div style={{ background: 'rgba(15,23,42,0.6)', padding: '8px', borderRadius: '6px', borderLeft: '2px solid rgba(59,130,246,0.5)' }}>
          <div style={{ fontSize: '8px', color: '#93c5fd', textTransform: 'uppercase', marginBottom: '4px', letterSpacing: '0.05em' }}>
            {t('panels.data')}
          </div>
          <div>{t('panels.points')}: <strong style={{ color: '#e0eaff' }}>{stats.pointCount.toLocaleString()}</strong></div>
          <div>{t('panels.lines')}: <strong style={{ color: '#e0eaff' }}>{stats.lineCount.toLocaleString()}</strong></div>
          <div>{t('panels.polylines')}: <strong style={{ color: '#e0eaff' }}>{stats.polylineCount.toLocaleString()}</strong></div>
          <div>{t('panels.arcs')}: <strong style={{ color: '#e0eaff' }}>{stats.arcCount.toLocaleString()}</strong></div>
          <div>{t('panels.circles')}: <strong style={{ color: '#e0eaff' }}>{stats.circleCount.toLocaleString()}</strong></div>
          <div>{t('panels.ellipses')}: <strong style={{ color: '#e0eaff' }}>{stats.ellipseCount.toLocaleString()}</strong></div>
          <div>{t('panels.splines')}: <strong style={{ color: '#e0eaff' }}>{stats.splineCount.toLocaleString()}</strong></div>
          <div>{t('panels.bulgeArcs')}: <strong style={{ color: '#e0eaff' }}>{stats.bulgeSegmentCount.toLocaleString()}</strong></div>
          <div>{t('panels.proxyCurves')}: <strong style={{ color: '#e0eaff' }}>{stats.proxyCurveCount.toLocaleString()}</strong></div>
          <div>{t('panels.approxCurves')}: <strong style={{ color: '#e0eaff' }}>{stats.approximatedCurveCount.toLocaleString()}</strong></div>
          <div>{t('panels.vertices')}: <strong style={{ color: '#e0eaff' }}>{stats.totalVertices.toLocaleString()}</strong></div>
        </div>

        {/* Performance Section */}
        <div style={{ background: 'rgba(15,23,42,0.6)', padding: '8px', borderRadius: '6px', borderLeft: '2px solid rgba(34,197,94,0.5)' }}>
          <div style={{ fontSize: '8px', color: '#86efac', textTransform: 'uppercase', marginBottom: '4px', letterSpacing: '0.05em' }}>
            {t('panels.performance')}
          </div>
          <div>{t('panels.memory')}: <strong style={{ color: '#e0eaff' }}>{stats.estimatedMemory} MB</strong></div>
          <div>{t('panels.render')}: <strong style={{ color: '#e0eaff' }}>{stats.renderTime}</strong></div>
          <div>{t('panels.fps')}: <strong style={{ color: stats.fps >= 50 ? '#22c55e' : stats.fps >= 30 ? '#f59e0b' : '#ef4444' }}>{stats.fps}</strong></div>
        </div>
      </div>

      {/* Health indicators */}
      <div style={{ fontSize: '8px', color: '#94a3b8', background: 'rgba(15,23,42,0.4)', padding: '6px 8px', borderRadius: '6px' }}>
        <div style={{ marginBottom: '3px', fontWeight: 600 }}>💡 {t('panels.optimizationTips')}:</div>
        <ul style={{ margin: '0', paddingLeft: '16px' }}>
          {stats.pointCount > 5000 && (
            <li>{t('panels.tipsLargePointCount')}</li>
          )}
          {stats.totalVertices > 100000 && (
            <li>{t('panels.tipsManyVertices')}</li>
          )}
          {Number(stats.estimatedMemory) > 50 && (
            <li>{t('panels.tipsHighMemory')}</li>
          )}
          {stats.fps < 50 && (
            <li>{t('panels.tipsLowFps')}</li>
          )}
        </ul>
      </div>
    </div>
  );
};

export default PerformanceDiagnostics;
