import React, { useMemo } from "react";

/**
 * HatchAreaPanel
 * Displays HATCH entities extracted from a DXF/DWG file,
 * with computed boundary areas using the shoelace formula.
 *
 * Props:
 *  - hatches: array of hatch records from geometry.hatches
 *  - areaUnit: 'sqm' | 'sqkm' | 'ha' — display unit for areas
 */
export default function HatchAreaPanel({ hatches = [], areaUnit = 'sqm' }) {
  const sorted = useMemo(() => [...hatches].sort((a, b) => (b.area || 0) - (a.area || 0)), [hatches]);

  const formatArea = (sqm) => {
    if (!Number.isFinite(sqm) || sqm <= 0) return '—';
    if (areaUnit === 'sqkm') return `${(sqm / 1e6).toFixed(6)} km²`;
    if (areaUnit === 'ha') return `${(sqm / 1e4).toFixed(4)} ha`;
    return `${sqm.toFixed(3)} m²`;
  };

  const totalArea = sorted.reduce((s, h) => s + (h.area || 0), 0);

  if (hatches.length === 0) {
    return (
      <div className="tool-panel">
        <div className="tool-panel-header">
          <span className="tool-panel-title">⬛ Hatch Areas</span>
        </div>
        <div className="tool-panel-body" style={{ color: "var(--text-muted)", fontSize: "0.78rem", padding: "0.75rem" }}>
          No HATCH entities found. Import a DXF file with hatched regions to compute boundary areas.
        </div>
      </div>
    );
  }

  return (
    <div className="tool-panel">
      <div className="tool-panel-header">
        <span className="tool-panel-title">⬛ Hatch Areas</span>
        <span className="tool-panel-badge">{hatches.length} region{hatches.length !== 1 ? "s" : ""}</span>
      </div>

      {/* Total area summary */}
      <div style={{ padding: "0.5rem 0.75rem", borderBottom: "1px solid var(--border)", fontSize: "0.78rem" }}>
        <span style={{ color: "var(--text-muted)" }}>Total enclosed area: </span>
        <strong style={{ color: "var(--accent-primary, #818cf8)" }}>{formatArea(totalArea)}</strong>
      </div>

      {/* Hatch list */}
      <div style={{ overflowY: "auto", maxHeight: "340px" }}>
        {sorted.map((hatch, idx) => (
          <div
            key={idx}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.4rem 0.75rem",
              borderBottom: "1px solid var(--border-faint, rgba(255,255,255,0.05))",
              fontSize: "0.78rem",
            }}
          >
            {/* Color swatch */}
            <span
              style={{
                display: "inline-block",
                width: "10px",
                height: "10px",
                borderRadius: "2px",
                backgroundColor: hatch.colorHex || "#94a3b8",
                border: "1px solid rgba(255,255,255,0.15)",
                flexShrink: 0,
              }}
            />

            {/* Pattern name */}
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={`Layer: ${hatch.layerOriginal || hatch.layer}`}>
              {hatch.patternName}
              {hatch.isSolid && (
                <span style={{ fontSize: "0.65rem", marginLeft: "4px", color: "var(--text-muted)" }}>SOLID</span>
              )}
            </span>

            {/* Layer tag */}
            <span style={{ fontSize: "0.65rem", color: "var(--text-muted)", flexShrink: 0, maxWidth: "80px", overflow: "hidden", textOverflow: "ellipsis" }}>
              {hatch.layerOriginal || hatch.layer}
            </span>

            {/* Area */}
            <span style={{ fontWeight: 600, color: "var(--text-primary)", flexShrink: 0 }}>
              {formatArea(hatch.area)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
