import React, { useMemo, useState } from 'react';

const PointSearchFilter = ({ points = [], onFilter, onClearFilter }) => {
  const [searchText, setSearchText] = useState('');
  const [filterCrs, setFilterCrs] = useState('all');
  const [filterSourceType, setFilterSourceType] = useState('all');
  const [elevationMin, setElevationMin] = useState('');
  const [elevationMax, setElevationMax] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Extract unique CRS and source types
  const metadata = useMemo(() => {
    const crsList = new Set();
    const sourceTypeList = new Set();
    (Array.isArray(points) ? points : []).forEach((p) => {
      if (p?.crs) crsList.add(p.crs);
      if (p?.sourceType) sourceTypeList.add(p.sourceType);
    });
    return {
      crsList: Array.from(crsList).sort(),
      sourceTypeList: Array.from(sourceTypeList).sort(),
    };
  }, [points]);

  // Apply filters
  const filtered = useMemo(() => {
    let result = Array.isArray(points) ? [...points] : [];

    // Search by name/label/ID
    if (searchText.trim()) {
      const searchLower = searchText.toLowerCase();
      result = result.filter((p) => {
        const label = String(p?.label || p?.id || p?.importedCadName || '').toLowerCase();
        return label.includes(searchLower);
      });
    }

    // Filter by CRS
    if (filterCrs !== 'all') {
      result = result.filter((p) => p?.crs === filterCrs);
    }

    // Filter by source type
    if (filterSourceType !== 'all') {
      result = result.filter((p) => p?.sourceType === filterSourceType);
    }

    // Filter by elevation range
    if (elevationMin !== '' || elevationMax !== '') {
      const min = elevationMin !== '' ? Number(elevationMin) : -Infinity;
      const max = elevationMax !== '' ? Number(elevationMax) : Infinity;
      result = result.filter((p) => {
        const h = Number(p?.height);
        return Number.isFinite(h) && h >= min && h <= max;
      });
    }

    return result;
  }, [points, searchText, filterCrs, filterSourceType, elevationMin, elevationMax]);

  const handleApplyFilter = () => {
    if (typeof onFilter === 'function') {
      onFilter(filtered);
    }
  };

  const handleClearFilters = () => {
    setSearchText('');
    setFilterCrs('all');
    setFilterSourceType('all');
    setElevationMin('');
    setElevationMax('');
    if (typeof onClearFilter === 'function') {
      onClearFilter();
    }
  };

  const matchCount = filtered.length;
  const totalCount = Array.isArray(points) ? points.length : 0;

  return (
    <div
      style={{
        background: 'rgba(15, 32, 64, 0.92)',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: '12px',
        padding: '12px',
        color: '#cbd5e1',
        fontSize: '11px',
        lineHeight: 1.5,
      }}
    >
      <div style={{ fontWeight: 800, marginBottom: '8px', color: '#e0eaff', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        Point Search & Filter
      </div>

      <div style={{ display: 'grid', gap: '8px' }}>
        {/* Search by name/label */}
        <input
          type="text"
          placeholder="Search by name, ID..."
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          style={{
            border: '1px solid rgba(148,163,184,0.45)',
            background: 'rgba(15,23,42,0.65)',
            color: '#e2e8f0',
            borderRadius: '7px',
            fontSize: '10px',
            padding: '5px 8px',
            width: '100%',
            boxSizing: 'border-box',
          }}
        />

        {/* Quick filters */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
          <label style={{ display: 'grid', gap: '2px', fontSize: '9px' }}>
            CRS
            <select
              value={filterCrs}
              onChange={(e) => setFilterCrs(e.target.value)}
              style={{
                border: '1px solid rgba(148,163,184,0.45)',
                background: 'rgba(15,23,42,0.65)',
                color: '#e2e8f0',
                borderRadius: '5px',
                fontSize: '9px',
                padding: '3px 5px',
              }}
            >
              <option value="all">All CRS</option>
              {metadata.crsList.map((crs) => (
                <option key={crs} value={crs}>
                  {crs}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'grid', gap: '2px', fontSize: '9px' }}>
            Source Type
            <select
              value={filterSourceType}
              onChange={(e) => setFilterSourceType(e.target.value)}
              style={{
                border: '1px solid rgba(148,163,184,0.45)',
                background: 'rgba(15,23,42,0.65)',
                color: '#e2e8f0',
                borderRadius: '5px',
                fontSize: '9px',
                padding: '3px 5px',
              }}
            >
              <option value="all">All Types</option>
              {metadata.sourceTypeList.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Advanced filters */}
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          style={{
            border: '1px solid rgba(148,163,184,0.55)',
            background: 'rgba(15,23,42,0.65)',
            color: '#93c5fd',
            borderRadius: '6px',
            fontSize: '9px',
            padding: '4px 6px',
            cursor: 'pointer',
          }}
        >
          {showAdvanced ? '▼ Hide Advanced' : '▶ Show Advanced'}
        </button>

        {showAdvanced && (
          <div style={{ display: 'grid', gap: '6px', borderTop: '1px solid rgba(148,163,184,0.2)', paddingTop: '6px' }}>
            <label style={{ display: 'grid', gap: '2px', fontSize: '9px' }}>
              Elevation Min (m)
              <input
                type="number"
                placeholder="Min"
                value={elevationMin}
                onChange={(e) => setElevationMin(e.target.value)}
                style={{
                  border: '1px solid rgba(148,163,184,0.45)',
                  background: 'rgba(15,23,42,0.65)',
                  color: '#e2e8f0',
                  borderRadius: '5px',
                  fontSize: '9px',
                  padding: '3px 5px',
                }}
              />
            </label>

            <label style={{ display: 'grid', gap: '2px', fontSize: '9px' }}>
              Elevation Max (m)
              <input
                type="number"
                placeholder="Max"
                value={elevationMax}
                onChange={(e) => setElevationMax(e.target.value)}
                style={{
                  border: '1px solid rgba(148,163,184,0.45)',
                  background: 'rgba(15,23,42,0.65)',
                  color: '#e2e8f0',
                  borderRadius: '5px',
                  fontSize: '9px',
                  padding: '3px 5px',
                }}
              />
            </label>
          </div>
        )}

        {/* Filter results */}
        <div style={{ padding: '6px 8px', background: 'rgba(37,99,235,0.15)', borderRadius: '6px', fontSize: '9px', color: '#93c5fd' }}>
          Matching: <strong>{matchCount}</strong> / {totalCount} points
        </div>

        {/* Action buttons */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
          <button
            onClick={handleApplyFilter}
            disabled={matchCount === 0}
            style={{
              border: '1px solid rgba(148,163,184,0.55)',
              background: matchCount > 0 ? 'rgba(34,197,94,0.65)' : 'rgba(107,114,128,0.3)',
              color: matchCount > 0 ? '#e2e8f0' : '#9ca3af',
              borderRadius: '6px',
              fontSize: '9px',
              padding: '5px 6px',
              cursor: matchCount > 0 ? 'pointer' : 'not-allowed',
              fontWeight: 600,
            }}
          >
            Apply Filter
          </button>

          <button
            onClick={handleClearFilters}
            style={{
              border: '1px solid rgba(148,163,184,0.55)',
              background: 'rgba(15,23,42,0.65)',
              color: '#e2e8f0',
              borderRadius: '6px',
              fontSize: '9px',
              padding: '5px 6px',
              cursor: 'pointer',
            }}
          >
            Clear
          </button>
        </div>
      </div>
    </div>
  );
};

export default PointSearchFilter;
