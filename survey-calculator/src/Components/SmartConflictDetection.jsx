import React, { useMemo } from 'react';
import { createTranslator } from '../utils/uiLanguage';

const FEET_PER_METER = 3.28084;

const toBaseId = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const splitAt = raw.lastIndexOf(':');
  return splitAt >= 0 ? raw.slice(splitAt + 1) : raw;
};

const roundedKey = (lat, lng, precision = 7) => `${Number(lat).toFixed(precision)}|${Number(lng).toFixed(precision)}`;

const approxFeetMeterPair = (a, b, tolerance = 0.12) => {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const absA = Math.abs(a);
  const absB = Math.abs(b);
  if (absA < 0.01 || absB < 0.01) return false;
  const ratio = absA > absB ? absA / absB : absB / absA;
  return Math.abs(ratio - FEET_PER_METER) <= tolerance;
};

const pickSeverityColor = (severity) => {
  if (severity === 'high') return '#fca5a5';
  if (severity === 'medium') return '#fcd34d';
  return '#93c5fd';
};

const SmartConflictDetection = ({ points = [], t: tProp }) => {
  const t = tProp || createTranslator('en');
  const analysis = useMemo(() => {
    const validPoints = (Array.isArray(points) ? points : []).filter(
      (p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lng))
    );

    const idCount = new Map();
    const baseIdCount = new Map();
    const coordGroups = new Map();
    const coordSet = new Set();

    validPoints.forEach((point) => {
      const id = String(point?.id ?? '').trim();
      if (id) {
        idCount.set(id, (idCount.get(id) || 0) + 1);
        const base = toBaseId(id);
        if (base) baseIdCount.set(base, (baseIdCount.get(base) || 0) + 1);
      }

      const lat = Number(point.lat);
      const lng = Number(point.lng);
      const key = roundedKey(lat, lng);
      const withCoord = coordGroups.get(key) || [];
      withCoord.push(point);
      coordGroups.set(key, withCoord);
      coordSet.add(key);
    });

    const duplicateIdEntries = Array.from(idCount.entries())
      .filter(([, count]) => count > 1)
      .sort((a, b) => b[1] - a[1]);

    const duplicateBaseIdEntries = Array.from(baseIdCount.entries())
      .filter(([, count]) => count > 1)
      .sort((a, b) => b[1] - a[1]);

    const overlappingElevationConflicts = [];
    let overlapFeetMeterCandidates = 0;

    coordGroups.forEach((group, key) => {
      if (group.length < 2) return;
      const heights = group
        .map((point) => Number(point?.height))
        .filter((value) => Number.isFinite(value));
      if (heights.length < 2) return;

      const minH = Math.min(...heights);
      const maxH = Math.max(...heights);
      const delta = maxH - minH;
      if (delta >= 0.5) {
        overlappingElevationConflicts.push({
          key,
          count: group.length,
          minH,
          maxH,
          delta,
        });
      }

      for (let i = 0; i < heights.length; i += 1) {
        for (let j = i + 1; j < heights.length; j += 1) {
          if (approxFeetMeterPair(heights[i], heights[j])) {
            overlapFeetMeterCandidates += 1;
            return;
          }
        }
      }
    });

    const impossibleAxisCount = validPoints.filter(
      (point) => Math.abs(Number(point.lat)) > 90 || Math.abs(Number(point.lng)) > 180
    ).length;

    const swapPairKeys = new Set();
    coordSet.forEach((key) => {
      const [latText, lngText] = key.split('|');
      const swapped = `${lngText}|${latText}`;
      if (key !== swapped && coordSet.has(swapped)) {
        const pairKey = key < swapped ? `${key}__${swapped}` : `${swapped}__${key}`;
        swapPairKeys.add(pairKey);
      }
    });

    const heights = validPoints
      .map((point) => Number(point?.height))
      .filter((value) => Number.isFinite(value));
    const maxAbsHeight = heights.length ? Math.max(...heights.map((value) => Math.abs(value))) : 0;
    const globalUnitSuspicion = maxAbsHeight > 12000;

    const findings = [];

    if (duplicateIdEntries.length > 0) {
      findings.push({
        severity: 'high',
        title: t('panels.duplicatePointIds'),
        detail: t('panels.duplicatePointIdsDetail', { count: duplicateIdEntries.length }),
      });
    }

    if (duplicateBaseIdEntries.length > 0) {
      findings.push({
        severity: 'medium',
        title: t('panels.duplicateLogicalIds'),
        detail: t('panels.duplicateLogicalIdsDetail', { count: duplicateBaseIdEntries.length }),
      });
    }

    if (overlappingElevationConflicts.length > 0) {
      findings.push({
        severity: 'high',
        title: t('panels.overlapElevations'),
        detail: t('panels.overlapElevationsDetail', { count: overlappingElevationConflicts.length }),
      });
    }

    if (overlapFeetMeterCandidates > 0 || globalUnitSuspicion) {
      findings.push({
        severity: 'medium',
        title: t('panels.inconsistentHeightUnits'),
        detail: overlapFeetMeterCandidates > 0
          ? t('panels.inconsistentHeightUnitsDetail', { count: overlapFeetMeterCandidates })
          : t('panels.inconsistentHeightUnitsMax', { value: maxAbsHeight.toFixed(1) }),
      });
    }

    if (impossibleAxisCount > 0 || swapPairKeys.size > 0) {
      findings.push({
        severity: impossibleAxisCount > 0 ? 'high' : 'medium',
        title: t('panels.mixedAxisOrder'),
        detail: impossibleAxisCount > 0
          ? t('panels.mixedAxisOrderImpossible', { count: impossibleAxisCount })
          : t('panels.mixedAxisOrderSwap', { count: swapPairKeys.size }),
      });
    }

    return {
      totalPoints: validPoints.length,
      duplicateIdEntries,
      duplicateBaseIdEntries,
      overlappingElevationConflicts: overlappingElevationConflicts.sort((a, b) => b.delta - a.delta),
      overlapFeetMeterCandidates,
      impossibleAxisCount,
      swapPairCount: swapPairKeys.size,
      findings,
    };
  }, [points, t]);

  const hasFindings = analysis.findings.length > 0;

  return (
    <div
      style={{
        background: 'rgba(15, 32, 64, 0.92)',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: '12px',
        padding: '12px',
        color: '#cbd5e1',
        fontSize: '10px',
        lineHeight: 1.55,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <div style={{ fontWeight: 800, color: '#e0eaff', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {t('panels.smartConflictTitle')}
        </div>
        <div style={{
          fontSize: '9px',
          fontWeight: 700,
          color: hasFindings ? '#fcd34d' : '#86efac',
          border: `1px solid ${hasFindings ? 'rgba(245,158,11,0.45)' : 'rgba(34,197,94,0.45)'}`,
          borderRadius: '999px',
          padding: '1px 8px',
          background: hasFindings ? 'rgba(245,158,11,0.15)' : 'rgba(34,197,94,0.15)',
        }}>
          {hasFindings ? t('panels.issueTypes', { count: analysis.findings.length }) : t('panels.noConflicts')}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px', marginBottom: '8px', fontSize: '9px' }}>
        <div style={{ background: 'rgba(15,23,42,0.55)', borderRadius: '6px', padding: '6px 8px' }}>
          {t('panels.pointsChecked')}: <strong style={{ color: '#e2e8f0' }}>{analysis.totalPoints}</strong>
        </div>
        <div style={{ background: 'rgba(15,23,42,0.55)', borderRadius: '6px', padding: '6px 8px' }}>
          {t('panels.axisAlerts')}: <strong style={{ color: '#e2e8f0' }}>{analysis.impossibleAxisCount + analysis.swapPairCount}</strong>
        </div>
      </div>

      {hasFindings ? (
        <div style={{ display: 'grid', gap: '6px' }}>
          {analysis.findings.map((finding) => (
            <div key={finding.title} style={{
              borderRadius: '7px',
              border: `1px solid ${pickSeverityColor(finding.severity)}66`,
              background: 'rgba(15,23,42,0.5)',
              padding: '6px 8px',
            }}>
              <div style={{ fontWeight: 700, color: pickSeverityColor(finding.severity), marginBottom: '2px' }}>{finding.title}</div>
              <div>{finding.detail}</div>
            </div>
          ))}

          {analysis.duplicateIdEntries.length > 0 && (
            <div style={{ fontSize: '9px', color: '#bfdbfe' }}>
              {t('panels.topDuplicateIds')}: {analysis.duplicateIdEntries.slice(0, 4).map(([id, count]) => `${id} (${count})`).join(', ')}
            </div>
          )}

          {analysis.overlappingElevationConflicts.length > 0 && (
            <div style={{ fontSize: '9px', color: '#bfdbfe' }}>
              {t('panels.largestOverlapDelta')}: {analysis.overlappingElevationConflicts[0].delta.toFixed(3)} m at {analysis.overlappingElevationConflicts[0].key}
            </div>
          )}
        </div>
      ) : (
        <div style={{ color: '#94a3b8', fontSize: '9px' }}>
          {t('panels.noMajorConflicts')}
        </div>
      )}
    </div>
  );
};

export default SmartConflictDetection;
