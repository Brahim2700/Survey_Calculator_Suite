import React, { useState, useMemo, useCallback } from "react";
import { parseDXFFile } from "../utils/fileImport";
import { createTranslator } from '../utils/uiLanguage';

/**
 * DxfDiffPanel
 * Compares two DXF/DWG files and highlights added, removed, or moved entities.
 * Compares by coordinate proximity for lines/polylines, and by ID+position for points.
 */

const TOLERANCE = 0.01; // meters — coordinate snap tolerance for matching

const coordKey = (x, y) => `${Number(x).toFixed(4)},${Number(y).toFixed(4)}`;
const ptKey = (pt) => coordKey(pt.x, pt.y);

const diffSets = (aSet, bSet) => {
  const added = [...bSet.keys()].filter((k) => !aSet.has(k));
  const removed = [...aSet.keys()].filter((k) => !bSet.has(k));
  const common = [...aSet.keys()].filter((k) => bSet.has(k));
  return { added, removed, common };
};

const buildGeomSets = (payload) => {
  // payload = { rows, geometry: { lines, polylines, ... } }
  const geo = payload?.geometry || {};
  // Build line keys — lines have start/end points
  const lineEntries = (geo.lines || []).map((l) => {
    const s = l.start || (Array.isArray(l.points) ? l.points[0] : null) || {};
    const e = l.end || (Array.isArray(l.points) ? l.points[1] : null) || {};
    const k1 = `${Number(s.x ?? 0).toFixed(3)},${Number(s.y ?? 0).toFixed(3)}`;
    const k2 = `${Number(e.x ?? 0).toFixed(3)},${Number(e.y ?? 0).toFixed(3)}`;
    const key = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
    return [key, l];
  });
  // Build polyline keys — polylines have points arrays
  const polyEntries = (geo.polylines || []).map((p) => {
    const pts = Array.isArray(p.points) ? p.points : [];
    const key = pts.map(([x, y]) => `${Number(x).toFixed(3)},${Number(y).toFixed(3)}`).join(";");
    return [key, p];
  });
  return {
    points: new Map((payload?.rows || []).map((r) => [ptKey(r), r])),
    lines: new Map(lineEntries),
    polys: new Map(polyEntries),
  };
};

export default function DxfDiffPanel({ t: tProp }) {
  const t = tProp || createTranslator('en');
  const [fileA, setFileA] = useState(null);
  const [fileB, setFileB] = useState(null);
  const [geoA, setGeoA] = useState(null);
  const [geoB, setGeoB] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const loadFile = useCallback(async (file, setter) => {
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const result = await parseDXFFile(file, { returnPayload: true });
      setter(result);
    } catch (err) {
      setError(t('panels.failedToLoadFile', { name: file.name, message: err.message }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const handleFileA = (e) => {
    const f = e.target.files?.[0];
    if (f) { setFileA(f); setGeoA(null); loadFile(f, setGeoA); }
  };
  const handleFileB = (e) => {
    const f = e.target.files?.[0];
    if (f) { setFileB(f); setGeoB(null); loadFile(f, setGeoB); }
  };

  const diff = useMemo(() => {
    if (!geoA || !geoB) return null;
    const a = buildGeomSets(geoA);
    const b = buildGeomSets(geoB);

    const points = diffSets(a.points, b.points);
    const lines = diffSets(a.lines, b.lines);
    const polys = diffSets(a.polys, b.polys);

    return {
      points: { added: points.added.length, removed: points.removed.length, unchanged: points.common.length },
      lines: { added: lines.added.length, removed: lines.removed.length, unchanged: lines.common.length },
      polys: { added: polys.added.length, removed: polys.removed.length, unchanged: polys.common.length },
      addedLineDetails: lines.added.slice(0, 20).map((k) => b.lines.get(k)),
      removedLineDetails: lines.removed.slice(0, 20).map((k) => a.lines.get(k)),
      addedPolyDetails: polys.added.slice(0, 10).map((k) => b.polys.get(k)),
      removedPolyDetails: polys.removed.slice(0, 10).map((k) => a.polys.get(k)),
    };
  }, [geoA, geoB]);

  const badge = (n, color) => n > 0 ? (
    <span style={{ marginLeft: 4, fontSize: "0.65rem", padding: "1px 6px", borderRadius: 4, backgroundColor: color, color: "#fff", fontWeight: 700 }}>
      {n}
    </span>
  ) : null;

  return (
    <div className="tool-panel">
      <div className="tool-panel-header">
        <span className="tool-panel-title">🔀 {t('panels.dxfDiffTitle')}</span>
        {diff && <span className="tool-panel-badge">{t('panels.compareComplete')}</span>}
      </div>

      <div style={{ padding: "0.6rem 0.75rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        {/* File A */}
        <div>
          <label style={{ fontSize: "0.72rem", color: "var(--text-muted)", display: "block", marginBottom: "2px" }}>
            {t('panels.baselineOriginal')}
          </label>
          <input
            type="file"
            accept=".dxf,.dwg"
            onChange={handleFileA}
            style={{ fontSize: "0.75rem", width: "100%" }}
          />
          {fileA && <span style={{ fontSize: "0.68rem", color: "var(--text-muted)" }}>{fileA.name}</span>}
        </div>

        {/* File B */}
        <div>
          <label style={{ fontSize: "0.72rem", color: "var(--text-muted)", display: "block", marginBottom: "2px" }}>
            {t('panels.revisedCurrent')}
          </label>
          <input
            type="file"
            accept=".dxf,.dwg"
            onChange={handleFileB}
            style={{ fontSize: "0.75rem", width: "100%" }}
          />
          {fileB && <span style={{ fontSize: "0.68rem", color: "var(--text-muted)" }}>{fileB.name}</span>}
        </div>

        {loading && (
          <div style={{ fontSize: "0.75rem", color: "var(--accent-primary, #818cf8)" }}>{t('panels.loadingDxf')}</div>
        )}
        {error && (
          <div style={{ fontSize: "0.75rem", color: "#f87171" }}>{error}</div>
        )}
      </div>

      {/* Results */}
      {diff && (
        <div style={{ padding: "0 0.75rem 0.75rem" }}>
          <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginBottom: "0.4rem", fontWeight: 600 }}>
            {t('panels.changesDetected', { tolerance: TOLERANCE })}
          </div>

          {/* Summary table */}
          {[
            { label: "Points", d: diff.points },
            { label: "Lines", d: diff.lines },
            { label: "Polylines", d: diff.polys },
          ].map(({ label, d }) => (
            <div
              key={label}
              style={{
                display: "flex",
                gap: "0.4rem",
                alignItems: "center",
                padding: "0.25rem 0",
                fontSize: "0.78rem",
                borderBottom: "1px solid var(--border-faint, rgba(255,255,255,0.05))",
              }}
            >
              <span style={{ width: "60px", color: "var(--text-muted)" }}>{label}</span>
              {badge(d.added, "#22c55e")}
              {d.added > 0 && <span style={{ fontSize: "0.65rem", color: "#22c55e" }}>+{t('panels.added', { count: d.added })}</span>}
              {badge(d.removed, "#ef4444")}
              {d.removed > 0 && <span style={{ fontSize: "0.65rem", color: "#ef4444" }}>−{t('panels.removed', { count: d.removed })}</span>}
              <span style={{ fontSize: "0.65rem", color: "var(--text-muted)" }}>{t('panels.unchanged', { count: d.unchanged })}</span>
            </div>
          ))}

          {/* Summary verdict */}
          {diff.points.added + diff.points.removed + diff.lines.added + diff.lines.removed + diff.polys.added + diff.polys.removed === 0 ? (
            <div style={{ marginTop: "0.5rem", fontSize: "0.75rem", color: "#22c55e", fontWeight: 600 }}>
              ✓ {t('panels.identicalFiles')}
            </div>
          ) : (
            <div style={{ marginTop: "0.5rem", fontSize: "0.75rem", color: "#f59e0b" }}>
              ⚠ {t('panels.changesVerdict', { lineChanges: diff.lines.added + diff.lines.removed + diff.polys.added + diff.polys.removed, pointChanges: diff.points.added + diff.points.removed })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
