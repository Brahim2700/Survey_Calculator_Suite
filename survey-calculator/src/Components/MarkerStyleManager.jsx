import React, { useRef, useState } from 'react';

const DEFAULT_ELEVATION_RULES = [
  { id: 1, minElev: '', maxElev: '100', color: '#3b82f6', label: 'Below 100 m' },
  { id: 2, minElev: '100', maxElev: '500', color: '#22c55e', label: '100 – 500 m' },
  { id: 3, minElev: '500', maxElev: '2000', color: '#f59e0b', label: '500 – 2000 m' },
  { id: 4, minElev: '2000', maxElev: '', color: '#ef4444', label: 'Above 2000 m' },
];

const SOURCE_TYPES = [
  { id: 'converted', label: 'Converted Points' },
  { id: 'cad-point', label: 'CAD Points' },
  { id: 'detection', label: 'CRS Detection' },
];

const inputStyle = {
  border: '1px solid rgba(148,163,184,0.45)',
  background: 'rgba(15,23,42,0.65)',
  color: '#e2e8f0',
  borderRadius: '4px',
  fontSize: '9px',
  padding: '3px 5px',
};

const MarkerStyleManager = ({ onChange }) => {
  const [activeTab, setActiveTab] = useState('color');
  const [elevRulesEnabled, setElevRulesEnabled] = useState(false);
  const [elevationRules, setElevationRules] = useState(DEFAULT_ELEVATION_RULES);
  const [pointSizeScale, setPointSizeScale] = useState(1.0);
  const [customIcons, setCustomIcons] = useState({});
  const [showLegend, setShowLegend] = useState(true);
  const fileInputRefs = useRef({});

  const notify = (patch) => {
    if (typeof onChange !== 'function') return;
    onChange({ elevationRules: elevRulesEnabled ? elevationRules : [], pointSizeScale, customIcons, showLegend, ...patch });
  };

  const handleElevToggle = (enabled) => {
    setElevRulesEnabled(enabled);
    if (enabled && elevationRules.length === 0) {
      setElevationRules(DEFAULT_ELEVATION_RULES);
      notify({ elevationRules: DEFAULT_ELEVATION_RULES });
    } else {
      notify({ elevationRules: enabled ? elevationRules : [] });
    }
  };

  const updateRule = (id, field, value) => {
    const next = elevationRules.map((r) => (r.id === id ? { ...r, [field]: value } : r));
    setElevationRules(next);
    notify({ elevationRules: elevRulesEnabled ? next : [] });
  };

  const addRule = () => {
    const next = [...elevationRules, { id: Date.now(), minElev: '', maxElev: '', color: '#a855f7', label: 'New range' }];
    setElevationRules(next);
    notify({ elevationRules: elevRulesEnabled ? next : [] });
  };

  const removeRule = (id) => {
    const next = elevationRules.filter((r) => r.id !== id);
    setElevationRules(next);
    notify({ elevationRules: elevRulesEnabled ? next : [] });
  };

  const handleSizeChange = (val) => {
    setPointSizeScale(val);
    notify({ pointSizeScale: val });
  };

  const handleIconUpload = (sourceType, e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const next = { ...customIcons, [sourceType]: { url, name: file.name } };
    setCustomIcons(next);
    notify({ customIcons: next });
    e.target.value = '';
  };

  const removeIcon = (sourceType) => {
    const icon = customIcons[sourceType];
    if (icon?.url?.startsWith('blob:')) URL.revokeObjectURL(icon.url);
    const { [sourceType]: _removed, ...next } = customIcons;
    setCustomIcons(next);
    notify({ customIcons: next });
  };

  const tabBtn = (id, label) => (
    <button
      key={id}
      type="button"
      onClick={() => setActiveTab(id)}
      style={{
        flex: 1,
        padding: '4px 5px',
        fontSize: '8px',
        cursor: 'pointer',
        border: 'none',
        borderRadius: '5px',
        background: activeTab === id ? 'rgba(59,130,246,0.5)' : 'rgba(15,23,42,0.5)',
        color: activeTab === id ? '#93c5fd' : '#94a3b8',
        fontWeight: activeTab === id ? 700 : 400,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ background: 'rgba(15,32,64,0.92)', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '12px', padding: '12px', color: '#cbd5e1', fontSize: '10px', lineHeight: 1.5 }}>
      <div style={{ fontWeight: 800, marginBottom: '8px', color: '#e0eaff', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        Marker Styles &amp; Legend
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '10px' }}>
        {tabBtn('color', '🎨 Color')}
        {tabBtn('icons', '📌 Icons')}
        {tabBtn('legend', '📋 Legend')}
      </div>

      {/* ── Color by elevation ── */}
      {activeTab === 'color' && (
        <div style={{ display: 'grid', gap: '8px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
            <input type="checkbox" checked={elevRulesEnabled} onChange={(e) => handleElevToggle(e.target.checked)} />
            <span style={{ fontSize: '9px', color: '#e2e8f0' }}>Color points by elevation rules</span>
          </label>

          {/* External size scale */}
          <div>
            <div style={{ fontSize: '9px', color: '#94a3b8', marginBottom: '3px' }}>
              Point size scale: <strong style={{ color: '#e0eaff' }}>{pointSizeScale.toFixed(1)}×</strong>
            </div>
            <input
              type="range" min="0.3" max="3.0" step="0.1" value={pointSizeScale}
              onChange={(e) => handleSizeChange(Number(e.target.value))}
              style={{ width: '100%', accentColor: '#3b82f6' }}
            />
          </div>

          {/* Rules editor */}
          {elevRulesEnabled && (
            <div style={{ display: 'grid', gap: '5px' }}>
              <div style={{ fontSize: '8px', color: '#93c5fd', fontWeight: 600 }}>Elevation ranges (m)</div>
              {elevationRules.map((rule) => (
                <div key={rule.id} style={{ display: 'grid', gridTemplateColumns: '22px 1fr 1fr 1.5fr 22px', gap: '4px', alignItems: 'center', background: 'rgba(15,23,42,0.5)', padding: '5px', borderRadius: '5px' }}>
                  <input
                    type="color" value={rule.color}
                    onChange={(e) => updateRule(rule.id, 'color', e.target.value)}
                    style={{ width: '20px', height: '20px', borderRadius: '3px', border: 'none', cursor: 'pointer', padding: 0 }}
                    title="Pick color"
                  />
                  <input type="number" placeholder="Min" value={rule.minElev} onChange={(e) => updateRule(rule.id, 'minElev', e.target.value)} style={inputStyle} />
                  <input type="number" placeholder="Max" value={rule.maxElev} onChange={(e) => updateRule(rule.id, 'maxElev', e.target.value)} style={inputStyle} />
                  <input type="text" placeholder="Label" value={rule.label} onChange={(e) => updateRule(rule.id, 'label', e.target.value)} style={inputStyle} />
                  <button type="button" onClick={() => removeRule(rule.id)} style={{ border: 'none', background: 'rgba(239,68,68,0.3)', color: '#fca5a5', borderRadius: '3px', fontSize: '9px', padding: '0 4px', cursor: 'pointer', lineHeight: '20px' }}>✕</button>
                </div>
              ))}
              <button type="button" onClick={addRule} style={{ border: '1px dashed rgba(148,163,184,0.4)', background: 'transparent', color: '#94a3b8', borderRadius: '5px', fontSize: '9px', padding: '4px', cursor: 'pointer', width: '100%' }}>
                + Add range
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Custom icons ── */}
      {activeTab === 'icons' && (
        <div style={{ display: 'grid', gap: '7px' }}>
          <div style={{ fontSize: '9px', color: '#94a3b8' }}>Upload PNG/SVG icons to replace default circle markers per point type.</div>
          {SOURCE_TYPES.map((src) => (
            <div key={src.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(15,23,42,0.5)', padding: '6px 8px', borderRadius: '6px' }}>
              {customIcons[src.id] ? (
                <img src={customIcons[src.id].url} alt={customIcons[src.id].name} style={{ width: '22px', height: '22px', objectFit: 'contain', borderRadius: '3px' }} />
              ) : (
                <div style={{ width: '22px', height: '22px', borderRadius: '11px', background: '#3b82f6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', color: '#fff', flexShrink: 0 }}>•</div>
              )}
              <span style={{ flex: 1, color: '#e2e8f0', fontSize: '9px' }}>{src.label}</span>
              <button type="button" onClick={() => fileInputRefs.current[src.id]?.click()} style={{ border: '1px solid rgba(148,163,184,0.45)', background: 'rgba(37,99,235,0.2)', color: '#93c5fd', borderRadius: '4px', fontSize: '8px', padding: '3px 7px', cursor: 'pointer' }}>Upload</button>
              {customIcons[src.id] && (
                <button type="button" onClick={() => removeIcon(src.id)} style={{ border: 'none', background: 'rgba(239,68,68,0.3)', color: '#fca5a5', borderRadius: '3px', fontSize: '8px', padding: '2px 5px', cursor: 'pointer' }}>✕</button>
              )}
              <input type="file" accept="image/*,.svg" ref={(el) => { fileInputRefs.current[src.id] = el; }} onChange={(e) => handleIconUpload(src.id, e)} style={{ display: 'none' }} />
            </div>
          ))}
          <div style={{ fontSize: '8px', color: '#64748b' }}>Icons render at 24×24 px on the map.</div>
        </div>
      )}

      {/* ── Legend ── */}
      {activeTab === 'legend' && (
        <div style={{ display: 'grid', gap: '8px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
            <input type="checkbox" checked={showLegend} onChange={(e) => { setShowLegend(e.target.checked); notify({ showLegend: e.target.checked }); }} />
            <span style={{ fontSize: '9px', color: '#e2e8f0' }}>Show legend overlay on map</span>
          </label>

          {/* Preview */}
          <div style={{ background: 'rgba(15,23,42,0.7)', borderRadius: '6px', padding: '8px', border: '1px solid rgba(148,163,184,0.2)' }}>
            <div style={{ fontSize: '9px', color: '#93c5fd', fontWeight: 700, marginBottom: '6px' }}>Legend Preview</div>

            {Object.entries(customIcons).length > 0 && (
              <div style={{ marginBottom: '6px' }}>
                <div style={{ fontSize: '8px', color: '#94a3b8', marginBottom: '3px', textTransform: 'uppercase', letterSpacing: '0.03em' }}>Custom Icons</div>
                {Object.entries(customIcons).map(([type, icon]) => (
                  <div key={type} style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '3px' }}>
                    <img src={icon.url} alt={icon.name} style={{ width: '14px', height: '14px', objectFit: 'contain' }} />
                    <span style={{ fontSize: '8px', color: '#cbd5e1' }}>{SOURCE_TYPES.find((s) => s.id === type)?.label || type}</span>
                  </div>
                ))}
              </div>
            )}

            {elevRulesEnabled && elevationRules.length > 0 && (
              <div>
                <div style={{ fontSize: '8px', color: '#94a3b8', marginBottom: '3px', textTransform: 'uppercase', letterSpacing: '0.03em' }}>Elevation Colors</div>
                {elevationRules.map((rule) => (
                  <div key={rule.id} style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '3px' }}>
                    <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: rule.color, flexShrink: 0 }} />
                    <span style={{ fontSize: '8px', color: '#cbd5e1' }}>{rule.label || `${rule.minElev || '−∞'} – ${rule.maxElev || '+∞'} m`}</span>
                  </div>
                ))}
              </div>
            )}

            {!elevRulesEnabled && Object.entries(customIcons).length === 0 && (
              <div style={{ fontSize: '8px', color: '#64748b', fontStyle: 'italic' }}>
                Enable elevation color rules or upload icons to populate the legend.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default MarkerStyleManager;
