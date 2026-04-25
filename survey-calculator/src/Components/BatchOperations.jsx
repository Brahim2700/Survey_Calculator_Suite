import React, { useState } from 'react';

const BatchOperations = ({ points = [], filteredPoints = null, onBatchOperation }) => {
  const [selectedOperation, setSelectedOperation] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [transformationElevationOffset, setTransformationElevationOffset] = useState('0');

  const activePoints = filteredPoints !== null ? filteredPoints : points;
  const totalPoints = Array.isArray(points) ? points.length : 0;
  const activeCount = Array.isArray(activePoints) ? activePoints.length : 0;

  const handleBatchDelete = () => {
    if (typeof onBatchOperation === 'function') {
      onBatchOperation({
        operation: 'delete',
        points: activePoints,
      });
    }
    setConfirmDelete(false);
  };

  const handleBatchExport = () => {
    if (activeCount === 0) return;

    const csv = [
      ['ID', 'Label', 'Latitude', 'Longitude', 'Height (m)', 'CRS', 'Source Type', 'Imported Name'].join(','),
      ...activePoints.map((p) =>
        [
          `"${p?.id || ''}"`,
          `"${p?.label || ''}"`,
          p?.lat || '',
          p?.lng || '',
          p?.height || '',
          `"${p?.crs || ''}"`,
          `"${p?.sourceType || ''}"`,
          `"${p?.importedCadName || ''}"`,
        ].join(',')
      ),
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `points_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleBatchTransform = () => {
    const offset = Number(transformationElevationOffset);
    if (!Number.isFinite(offset)) {
      alert('Invalid elevation offset');
      return;
    }

    if (typeof onBatchOperation === 'function') {
      onBatchOperation({
        operation: 'elevationOffset',
        points: activePoints,
        offset,
      });
    }
    setTransformationElevationOffset('0');
    setSelectedOperation('');
  };

  const handleShowStats = () => {
    if (activeCount === 0) return;

    const elevations = activePoints.map((p) => Number(p?.height || 0)).filter(Number.isFinite);
    const crsCounts = {};
    const sourceTypeCounts = {};

    activePoints.forEach((p) => {
      if (p?.crs) crsCounts[p.crs] = (crsCounts[p.crs] || 0) + 1;
      if (p?.sourceType) sourceTypeCounts[p.sourceType] = (sourceTypeCounts[p.sourceType] || 0) + 1;
    });

    const stats = `
=== Batch Statistics ===
Points: ${activeCount} / ${totalPoints}

Elevations:
  Min: ${Math.min(...elevations).toFixed(2)} m
  Max: ${Math.max(...elevations).toFixed(2)} m
  Avg: ${(elevations.reduce((a, b) => a + b, 0) / elevations.length).toFixed(2)} m

CRS Distribution:
${Object.entries(crsCounts).map(([crs, count]) => `  ${crs}: ${count}`).join('\n')}

Source Types:
${Object.entries(sourceTypeCounts).map(([type, count]) => `  ${type}: ${count}`).join('\n')}
    `;

    alert(stats);
  };

  return (
    <div
      style={{
        background: 'rgba(15, 32, 64, 0.92)',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: '12px',
        padding: '12px',
        color: '#cbd5e1',
        fontSize: '10px',
        lineHeight: 1.5,
      }}
    >
      <div style={{ fontWeight: 800, marginBottom: '8px', color: '#e0eaff', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        Batch Operations
      </div>

      <div style={{ fontSize: '9px', color: '#93c5fd', marginBottom: '8px', padding: '6px 8px', background: 'rgba(37,99,235,0.15)', borderRadius: '6px' }}>
        {filteredPoints !== null ? (
          <>
            <strong>{activeCount}</strong> points selected from <strong>{totalPoints}</strong> total
          </>
        ) : (
          <>
            <strong>{totalPoints}</strong> points total
          </>
        )}
      </div>

      {/* Operation selector */}
      <div style={{ display: 'grid', gap: '6px', marginBottom: '8px' }}>
        <label style={{ fontSize: '9px', color: '#cbd5e1' }}>
          Operation:
          <select
            value={selectedOperation}
            onChange={(e) => {
              setSelectedOperation(e.target.value);
              setConfirmDelete(false);
            }}
            style={{
              border: '1px solid rgba(148,163,184,0.45)',
              background: 'rgba(15,23,42,0.65)',
              color: '#e2e8f0',
              borderRadius: '6px',
              fontSize: '9px',
              padding: '5px 8px',
              width: '100%',
              marginTop: '4px',
              boxSizing: 'border-box',
            }}
          >
            <option value="">-- Select Operation --</option>
            <option value="stats">📊 View Statistics</option>
            <option value="export">📥 Export as CSV</option>
            <option value="elevationOffset">📐 Add Elevation Offset</option>
            <option value="delete">🗑️ Delete Selected</option>
          </select>
        </label>
      </div>

      {/* Operation-specific UI */}
      {selectedOperation === 'elevationOffset' && (
        <div style={{ display: 'grid', gap: '6px', marginBottom: '8px', padding: '8px', background: 'rgba(15,23,42,0.6)', borderRadius: '6px', borderLeft: '2px solid rgba(249,115,22,0.5)' }}>
          <label style={{ fontSize: '9px' }}>
            Elevation Offset (m):
            <input
              type="number"
              placeholder="e.g., 2.5 or -1.5"
              value={transformationElevationOffset}
              onChange={(e) => setTransformationElevationOffset(e.target.value)}
              step="0.1"
              style={{
                border: '1px solid rgba(148,163,184,0.45)',
                background: 'rgba(15,23,42,0.65)',
                color: '#e2e8f0',
                borderRadius: '5px',
                fontSize: '9px',
                padding: '5px 6px',
                width: '100%',
                marginTop: '3px',
                boxSizing: 'border-box',
              }}
            />
          </label>
          <div style={{ fontSize: '8px', color: '#94a3b8' }}>
            Will add {transformationElevationOffset} m to all {activeCount} point elevation values
          </div>
        </div>
      )}

      {selectedOperation === 'delete' && (
        <div style={{ padding: '8px', background: 'rgba(239,68,68,0.15)', borderRadius: '6px', borderLeft: '2px solid rgba(239,68,68,0.5)', marginBottom: '8px' }}>
          <div style={{ fontSize: '9px', color: '#fca5a5', marginBottom: '6px' }}>
            ⚠️ This will permanently delete <strong>{activeCount}</strong> point(s). This cannot be undone.
          </div>
          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              style={{
                border: '1px solid rgba(239,68,68,0.6)',
                background: 'rgba(239,68,68,0.3)',
                color: '#fca5a5',
                borderRadius: '5px',
                fontSize: '9px',
                padding: '5px 8px',
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              Confirm Delete
            </button>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
              <button
                onClick={handleBatchDelete}
                style={{
                  border: '1px solid rgba(239,68,68,0.6)',
                  background: 'rgba(239,68,68,0.5)',
                  color: '#fff',
                  borderRadius: '5px',
                  fontSize: '9px',
                  padding: '5px 8px',
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                Yes, Delete
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                style={{
                  border: '1px solid rgba(148,163,184,0.45)',
                  background: 'rgba(15,23,42,0.65)',
                  color: '#cbd5e1',
                  borderRadius: '5px',
                  fontSize: '9px',
                  padding: '5px 8px',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
        {selectedOperation === 'stats' && (
          <button
            onClick={handleShowStats}
            disabled={activeCount === 0}
            style={{
              gridColumn: '1 / -1',
              border: '1px solid rgba(148,163,184,0.55)',
              background: activeCount > 0 ? 'rgba(59,130,246,0.65)' : 'rgba(107,114,128,0.3)',
              color: activeCount > 0 ? '#e2e8f0' : '#9ca3af',
              borderRadius: '6px',
              fontSize: '9px',
              padding: '6px 8px',
              cursor: activeCount > 0 ? 'pointer' : 'not-allowed',
              fontWeight: 600,
            }}
          >
            View Statistics
          </button>
        )}

        {selectedOperation === 'export' && (
          <button
            onClick={handleBatchExport}
            disabled={activeCount === 0}
            style={{
              gridColumn: '1 / -1',
              border: '1px solid rgba(148,163,184,0.55)',
              background: activeCount > 0 ? 'rgba(34,197,94,0.65)' : 'rgba(107,114,128,0.3)',
              color: activeCount > 0 ? '#e2e8f0' : '#9ca3af',
              borderRadius: '6px',
              fontSize: '9px',
              padding: '6px 8px',
              cursor: activeCount > 0 ? 'pointer' : 'not-allowed',
              fontWeight: 600,
            }}
          >
            Export {activeCount} Points
          </button>
        )}

        {selectedOperation === 'elevationOffset' && (
          <button
            onClick={handleBatchTransform}
            disabled={activeCount === 0 || !Number.isFinite(Number(transformationElevationOffset))}
            style={{
              gridColumn: '1 / -1',
              border: '1px solid rgba(148,163,184,0.55)',
              background:
                activeCount > 0 && Number.isFinite(Number(transformationElevationOffset))
                  ? 'rgba(249,115,22,0.65)'
                  : 'rgba(107,114,128,0.3)',
              color: activeCount > 0 && Number.isFinite(Number(transformationElevationOffset)) ? '#e2e8f0' : '#9ca3af',
              borderRadius: '6px',
              fontSize: '9px',
              padding: '6px 8px',
              cursor:
                activeCount > 0 && Number.isFinite(Number(transformationElevationOffset))
                  ? 'pointer'
                  : 'not-allowed',
              fontWeight: 600,
            }}
          >
            Apply Offset to {activeCount} Points
          </button>
        )}

        {!selectedOperation && (
          <div
            style={{
              gridColumn: '1 / -1',
              padding: '12px',
            textAlign: 'center',
            color: '#94a3b8',
            fontSize: '9px',
          }}
          >
            Select an operation above
          </div>
        )}
      </div>
    </div>
  );
};

export default BatchOperations;
