import React, { useMemo, useState } from "react";

/**
 * EntityTypeBreakdown
 * Shows a breakdown of all CAD entity types found in the loaded DXF/DWG file.
 * Groups entities by type with counts and optional per-layer sub-breakdown.
 *
 * Props:
 *  - geometry: cadGeometry object from App.jsx state
 *              { lines, polylines, texts, dimensions, hatches, points, layerSummary }
 */
export default function EntityTypeBreakdown({ geometry = null }) {
  const [expandedType, setExpandedType] = useState(null);

  const breakdown = useMemo(() => {
    if (!geometry) return null;

    const countByLayer = (items, layerProp = "layer") => {
      const map = {};
      (items || []).forEach((item) => {
        const l = item?.[layerProp] || item?.layerOriginal || "—";
        map[l] = (map[l] || 0) + 1;
      });
      return Object.entries(map)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
    };

    return [
      {
        type: "Line",
        icon: "—",
        color: "#60a5fa",
        count: (geometry.lines || []).length,
        layers: countByLayer(geometry.lines),
      },
      {
        type: "Polyline",
        icon: "〰",
        color: "#818cf8",
        count: (geometry.polylines || []).length,
        layers: countByLayer(geometry.polylines),
      },
      {
        type: "Text / MText",
        icon: "T",
        color: "#34d399",
        count: (geometry.texts || []).length,
        layers: countByLayer(geometry.texts),
      },
      {
        type: "Dimension",
        icon: "↔",
        color: "#f59e0b",
        count: (geometry.dimensions || []).length,
        layers: countByLayer(geometry.dimensions),
      },
      {
        type: "Hatch",
        icon: "⬛",
        color: "#e879f9",
        count: (geometry.hatches || []).length,
        layers: countByLayer(geometry.hatches),
      },
    ].filter((e) => e.count > 0);
  }, [geometry]);

  const total = breakdown ? breakdown.reduce((s, e) => s + e.count, 0) : 0;

  if (!geometry) {
    return (
      <div className="tool-panel">
        <div className="tool-panel-header">
          <span className="tool-panel-title">📊 Entity Breakdown</span>
        </div>
        <div className="tool-panel-body" style={{ color: "var(--text-muted)", fontSize: "0.78rem", padding: "0.75rem" }}>
          Import a DXF or DWG file to see entity type statistics.
        </div>
      </div>
    );
  }

  return (
    <div className="tool-panel">
      <div className="tool-panel-header">
        <span className="tool-panel-title">📊 Entity Breakdown</span>
        <span className="tool-panel-badge">{total.toLocaleString()} entities</span>
      </div>

      <div style={{ overflowY: "auto", maxHeight: "380px" }}>
        {breakdown && breakdown.length > 0 ? breakdown.map((entry) => {
          const pct = total > 0 ? ((entry.count / total) * 100).toFixed(1) : 0;
          const isOpen = expandedType === entry.type;
          return (
            <div key={entry.type} style={{ borderBottom: "1px solid var(--border-faint, rgba(255,255,255,0.05))" }}>
              {/* Row header */}
              <button
                onClick={() => setExpandedType(isOpen ? null : entry.type)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  padding: "0.45rem 0.75rem",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  width: "100%",
                  textAlign: "left",
                  color: "inherit",
                }}
              >
                {/* Icon swatch */}
                <span style={{ fontSize: "0.9rem", color: entry.color, width: "18px", textAlign: "center", flexShrink: 0 }}>
                  {entry.icon}
                </span>

                {/* Type label */}
                <span style={{ flex: 1, fontSize: "0.78rem" }}>{entry.type}</span>

                {/* Progress bar */}
                <div style={{ width: "60px", height: "5px", borderRadius: "3px", backgroundColor: "var(--border)", overflow: "hidden", flexShrink: 0 }}>
                  <div style={{ width: `${pct}%`, height: "100%", backgroundColor: entry.color, borderRadius: "3px" }} />
                </div>

                {/* Count */}
                <span style={{ fontSize: "0.75rem", fontWeight: 700, color: entry.color, flexShrink: 0, minWidth: "38px", textAlign: "right" }}>
                  {entry.count.toLocaleString()}
                </span>
                <span style={{ fontSize: "0.65rem", color: "var(--text-muted)", flexShrink: 0 }}>
                  {pct}%
                </span>
                <span style={{ fontSize: "0.65rem", color: "var(--text-muted)", flexShrink: 0 }}>
                  {isOpen ? "▲" : "▼"}
                </span>
              </button>

              {/* Layer sub-breakdown */}
              {isOpen && entry.layers.length > 0 && (
                <div style={{ padding: "0.2rem 0.75rem 0.4rem 2.5rem", display: "flex", flexDirection: "column", gap: "2px" }}>
                  {entry.layers.map(([layer, cnt]) => (
                    <div key={layer} style={{ display: "flex", gap: "0.4rem", fontSize: "0.69rem", color: "var(--text-muted)" }}>
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{layer}</span>
                      <span style={{ fontWeight: 600 }}>{cnt}</span>
                    </div>
                  ))}
                  {entry.layers.length === 10 && (
                    <div style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginTop: "2px" }}>+ more layers…</div>
                  )}
                </div>
              )}
            </div>
          );
        }) : (
          <div style={{ padding: "0.75rem", fontSize: "0.78rem", color: "var(--text-muted)" }}>
            No entities found in loaded file.
          </div>
        )}
      </div>
    </div>
  );
}
