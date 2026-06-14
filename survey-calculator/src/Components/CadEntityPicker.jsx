import React, { useEffect, useRef, useState } from "react";
import { on } from "../utils/eventBus";
import { createTranslator } from '../utils/uiLanguage';

/**
 * CadEntityPicker
 * Displays information about the last CAD entity picked (clicked) on the map.
 * Listens to the 'cad:entityPicked' event emitted from MapVisualization.jsx.
 */
export default function CadEntityPicker({ t: tProp }) {
  const t = tProp || createTranslator('en');
  const [entity, setEntity] = useState(null);
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef(null);

  useEffect(() => {
    return on("cad:entityPicked", (data) => {
      setEntity(data);
      setFlash(true);
      clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(false), 600);
    });
  }, []);

  return (
    <div className="tool-panel">
      <div className="tool-panel-header" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
        <span className="tool-panel-title">🖱 {t('panels.entityPickerTitle')}</span>
        {entity && <span className="tool-panel-badge">{t('panels.active')}</span>}
      </div>

      <div style={{ padding: "0.6rem 0.75rem", fontSize: "0.75rem" }}>
        {!entity ? (
          <div style={{ color: "var(--text-muted)" }}>
            {t('panels.clickEntityToInspect')}
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.3rem",
              transition: "background 0.3s",
              background: flash ? "rgba(129,140,248,0.08)" : "transparent",
              borderRadius: "6px",
              padding: "0.3rem",
            }}
          >
            {[
              [t('panels.type'), entity.type],
              [t('panels.layer'), entity.layer],
              [t('panels.color'), entity.colorHex],
              [t('panels.source'), entity.sourceType],
              [t('panels.length'), entity.length != null ? `${Number(entity.length).toFixed(3)} ${t('panels.mapUnits')}` : null],
              [t('panels.verticesLabel'), entity.vertexCount],
              [t('panels.handle'), entity.handle],
            ]
              .filter(([, v]) => v != null && v !== "")
              .map(([label, value]) => (
                <div key={label} style={{ display: "flex", gap: "0.4rem" }}>
                  <span style={{ color: "var(--text-muted)", minWidth: "60px", flexShrink: 0 }}>{label}</span>
                  <span
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontWeight: label === "Type" ? 600 : 400,
                      color:
                        label === "Color" && entity.colorHex
                          ? entity.colorHex
                          : "var(--text-primary)",
                    }}
                  >
                    {label === "Color" ? (
                      <>
                        <span
                          style={{
                            display: "inline-block",
                            width: "10px",
                            height: "10px",
                            borderRadius: "2px",
                            backgroundColor: entity.colorHex,
                            border: "1px solid rgba(255,255,255,0.2)",
                            marginRight: "5px",
                            verticalAlign: "middle",
                          }}
                        />
                        {entity.colorHex}
                      </>
                    ) : (
                      String(value)
                    )}
                  </span>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
