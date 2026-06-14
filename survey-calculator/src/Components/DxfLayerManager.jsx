import React, { useMemo } from "react";
import MapToolTip from "./MapToolTip";
import { createTranslator } from '../utils/uiLanguage';

/**
 * DxfLayerManager
 * Displays the DXF layer tree extracted from a loaded DXF/DWG file.
 * Each layer shows its color, entity counts, and a visibility toggle.
 *
 * Props:
 *  - layerSummary: object from buildLayerSummary (has .layers array)
 *  - hiddenDxfLayers: string[] — list of layerStandardized names that are hidden
 *  - onToggleLayer(layerStandardized): toggle one layer
 *  - onToggleAll(visible: boolean): show / hide all layers
 */
export default function DxfLayerManager({ layerSummary, hiddenDxfLayers = [], onToggleLayer, onToggleAll, t: tProp }) {
  const t = tProp || createTranslator('en');
  const layers = useMemo(() => (Array.isArray(layerSummary?.layers) ? layerSummary.layers : []), [layerSummary]);

  const allVisible = layers.length > 0 && layers.every((l) => !hiddenDxfLayers.includes(l.standardizedName));
  const anyVisible = layers.some((l) => !hiddenDxfLayers.includes(l.standardizedName));

  if (!layerSummary || layers.length === 0) {
    return (
      <div className="tool-panel">
        <div className="tool-panel-header">
          <span className="tool-panel-title">🗂️ DXF Layers</span>
        </div>
        <div className="tool-panel-body" style={{ color: "var(--text-muted)", fontSize: "0.78rem", padding: "0.75rem" }}>
          {t('panels.noDxfLayerData')}
        </div>
      </div>
    );
  }

  return (
    <div className="tool-panel">
      <div className="tool-panel-header">
        <span className="tool-panel-title">🗂️ {t('panels.dxfLayersTitle')}</span>
        <span className="tool-panel-badge">
          {t('panels.visibleFraction', { visible: layers.length - hiddenDxfLayers.filter((k) => layers.some((l) => l.standardizedName === k)).length, total: layers.length })}
        </span>
      </div>

      {/* Header stats */}
      <div style={{ display: "flex", gap: "0.5rem", padding: "0.5rem 0.75rem 0", flexWrap: "wrap", fontSize: "0.72rem", color: "var(--text-muted)" }}>
        <span>{t('panels.declared')}: <strong>{layerSummary.totalDeclaredLayers ?? layers.length}</strong></span>
        <span>{t('panels.standardized')}: <strong>{layerSummary.totalStandardizedLayers ?? layers.length}</strong></span>
        {layerSummary.renamedLayers > 0 && (
          <span style={{ color: "var(--accent-warning, #f59e0b)" }}>{t('panels.renamed')}: <strong>{layerSummary.renamedLayers}</strong></span>
        )}
      </div>

      {/* Select all / none controls */}
      <div style={{ display: "flex", gap: "0.4rem", padding: "0.4rem 0.75rem", borderBottom: "1px solid var(--border)" }}>
        <MapToolTip
          title={t('panels.showAllLayers')}
          description={t('panels.showAllLayersDescription')}
        >
          <button
            className="btn btn-xs btn-ghost"
            onClick={() => onToggleAll && onToggleAll(true)}
            disabled={allVisible}
          >
            {t('panels.showAll')}
          </button>
        </MapToolTip>
        <MapToolTip
          title={t('panels.hideAllLayers')}
          description={t('panels.hideAllLayersDescription')}
        >
          <button
            className="btn btn-xs btn-ghost"
            onClick={() => onToggleAll && onToggleAll(false)}
            disabled={!anyVisible}
          >
            {t('panels.hideAll')}
          </button>
        </MapToolTip>
      </div>

      {/* Layer list */}
      <div style={{ overflowY: "auto", maxHeight: "340px" }}>
        {layers.map((layer) => {
          const isHidden = hiddenDxfLayers.includes(layer.standardizedName);
          const colorSwatch = layer.colorHex || "#94a3b8";
          return (
            <div
              key={layer.standardizedName}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                padding: "0.35rem 0.75rem",
                borderBottom: "1px solid var(--border-faint, rgba(255,255,255,0.05))",
                opacity: isHidden ? 0.45 : 1,
                cursor: "pointer",
                transition: "opacity 0.15s",
              }}
              onClick={() => onToggleLayer && onToggleLayer(layer.standardizedName)}
              title={t('panels.toggleLayerTitle', { name: layer.displayName, originalNames: (layer.originalNames || []).join(', ') })}
            >
              {/* Visibility checkbox */}
              <input
                type="checkbox"
                checked={!isHidden}
                onChange={() => onToggleLayer && onToggleLayer(layer.standardizedName)}
                onClick={(e) => e.stopPropagation()}
                style={{ cursor: "pointer", flexShrink: 0 }}
              />

              {/* Color swatch */}
              <span
                style={{
                  display: "inline-block",
                  width: "12px",
                  height: "12px",
                  borderRadius: "3px",
                  backgroundColor: colorSwatch,
                  border: "1px solid rgba(255,255,255,0.15)",
                  flexShrink: 0,
                }}
              />

              {/* Layer name */}
              <span style={{ flex: 1, minWidth: 0, fontSize: "0.78rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {layer.displayName}
              </span>

              {/* Entity count badges */}
              <div style={{ display: "flex", gap: "0.25rem", flexShrink: 0 }}>
                {layer.entityCount > 0 && (
                  <span
                    className="tool-panel-badge"
                    style={{ fontSize: "0.65rem", padding: "1px 5px" }}
                    title={t('panels.totalEntities')}
                  >
                    {layer.entityCount}
                  </span>
                )}
                {layer.lineCount > 0 && (
                  <span style={{ fontSize: "0.65rem", color: "var(--text-muted)", whiteSpace: "nowrap" }} title={t('panels.lines')}>
                    {layer.lineCount}L
                  </span>
                )}
                {layer.polylineCount > 0 && (
                  <span style={{ fontSize: "0.65rem", color: "var(--text-muted)", whiteSpace: "nowrap" }} title={t('panels.polylines')}>
                    {layer.polylineCount}P
                  </span>
                )}
                {layer.textCount > 0 && (
                  <span style={{ fontSize: "0.65rem", color: "var(--text-muted)", whiteSpace: "nowrap" }} title={t('panels.textEntities')}>
                    {layer.textCount}T
                  </span>
                )}
              </div>

              {/* Category tag */}
              {layer.category && layer.category !== "OTHER" && (
                <span
                  style={{
                    fontSize: "0.6rem",
                    padding: "1px 4px",
                    borderRadius: "3px",
                    backgroundColor: "var(--accent-muted, rgba(99,102,241,0.2))",
                    color: "var(--accent-primary, #818cf8)",
                    flexShrink: 0,
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                  }}
                >
                  {layer.category}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
