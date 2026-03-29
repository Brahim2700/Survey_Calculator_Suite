// src/Components/DistanceBearingTool.jsx
// Professional distance and bearing calculator for land surveying
// Calculates 5 distance types: Slope, Horizontal, Grid, Ground, Geodesic
// Plus scale factors and forward/reverse azimuths

import { useEffect, useState } from 'react';
import proj4 from 'proj4';
import {
  calculateAllDistances,
  calculateGridBearing,
  formatDMS
} from '../utils/calculations';
import { on, emit } from '../utils/eventBus';

const DistanceBearingTool = () => {
  const [point1, setPoint1] = useState({
    id: 'A',
    lat: '',
    lon: '',
    elev: '',
    e: '',
    n: '',
    crs: 'EPSG:4326'
  });
  
  const [point2, setPoint2] = useState({
    id: 'B',
    lat: '',
    lon: '',
    elev: '',
    e: '',
    n: '',
    crs: 'EPSG:4326'
  });
  
  const [results, setResults] = useState(null);
  const [projectionType, setProjectionType] = useState('UTM');
  const [utmZone, setUtmZone] = useState('');
  const [utmZoneError, setUtmZoneError] = useState('');
  const [pickTarget, setPickTarget] = useState(null); // 'A' | 'B' | null
  const [pointAConfirmed, setPointAConfirmed] = useState(false);
  const [pointBConfirmed, setPointBConfirmed] = useState(false);
  const [angleUnit, setAngleUnit] = useState('degree'); // 'degree' or 'grade'

  // Initialize with empty points on mount - no auto-load
  useEffect(() => {
    // Emit empty points to ensure map starts clean
    emit('distanceTool:pointsForMap', { points: [] });
  }, []);

  // Pre-fill Points A & B from map measure panel
  useEffect(() => {
    const off = on('measure:sendToDistanceTool', ({ point1: p1, point2: p2 }) => {
      setPoint1(prev => ({ ...prev, lat: String(p1.lat), lon: String(p1.lng ?? p1.lon ?? '') }));
      setPoint2(prev => ({ ...prev, lat: String(p2.lat), lon: String(p2.lng ?? p2.lon ?? '') }));
    });
    return () => off && off();
  }, []);

  // Subscribe to map click events to fill Point A/B when armed
  useEffect(() => {
    const off = on('map:click', ({ lat, lon }) => {
      if (!pickTarget) return;
      const setter = pickTarget === 'A' ? setPoint1 : setPoint2;
      const confirmSetter = pickTarget === 'A' ? setPointAConfirmed : setPointBConfirmed;
      setter(prev => ({ ...prev, lat: String(lat), lon: String(lon) }));
      confirmSetter(true);
      setPickTarget(null);
      // Clear confirmation after 3 seconds
      setTimeout(() => confirmSetter(false), 3000);
    });
    return () => off && off();
  }, [pickTarget]);

  /**
   * Handle point input changes
   */
  const handlePointChange = (pointNum, field, value) => {
    const setter = pointNum === 1 ? setPoint1 : setPoint2;
    setter(prev => ({ ...prev, [field]: value }));
  };

  /**
   * Convert geographic to projected coordinates if needed
   */
  const ensureProjectedCoords = (point, opts = {}) => {
    const { projectionType = 'UTM', utmZoneOverride } = opts;
    const lat = parseFloat(point.lat);
    const lon = parseFloat(point.lon);
    const elev = parseFloat(point.elev) || 0;

    // If we have lat/lon, compute projected E/N using override when provided
    if (!isNaN(lat) && !isNaN(lon)) {
      if (projectionType === 'UTM') {
        const detectedZone = Math.floor((lon + 180) / 6) + 1;
        const zone = Number.isFinite(utmZoneOverride) && utmZoneOverride >= 1 && utmZoneOverride <= 60
          ? utmZoneOverride
          : detectedZone;
        const utmCode = `EPSG:${lat >= 0 ? 326 : 327}${zone.toString().padStart(2, '0')}`;
        try {
          const [e, n] = proj4('EPSG:4326', utmCode, [lon, lat]);
          return { ...point, lat, lon, elev, e, n, utmZone: zone };
        } catch (err) {
          console.error('Projection error:', err);
        }
      }
    }

    // Fallback: keep given projected values (if any)
    return {
      ...point,
      lat,
      lon,
      elev,
      e: parseFloat(point.e) || 0,
      n: parseFloat(point.n) || 0
    };
  };

  /**
   * Calculate all distances
   */
  const handleCalculate = () => {
    try {
      const parsedZone = parseInt(utmZone, 10);
      const isValidZone = Number.isFinite(parsedZone) && parsedZone >= 1 && parsedZone <= 60;
      const zoneOverride = isValidZone ? parsedZone : undefined;
      if (utmZone && !isValidZone) {
        setUtmZoneError('Enter a number from 1 to 60');
      } else {
        setUtmZoneError('');
      }

      const p1 = ensureProjectedCoords(point1, { projectionType, utmZoneOverride: zoneOverride });
      const p2 = ensureProjectedCoords(point2, { projectionType, utmZoneOverride: zoneOverride });
      
      // Validate inputs
      if (isNaN(p1.lat) || isNaN(p1.lon) || isNaN(p2.lat) || isNaN(p2.lon)) {
        alert('Please enter valid coordinates for both points');
        return;
      }
      
      const zone = isValidZone ? parsedZone : p1.utmZone;
      const calculatedResults = calculateAllDistances(p1, p2, projectionType, zone);
      
      // Add grid bearing
      calculatedResults.gridBearing = calculateGridBearing(p1, p2);
      // Add metadata: zone source and hemisphere
      calculatedResults.zoneSource = isValidZone ? 'manual' : 'auto';
      calculatedResults.hemisphere = (((p1.lat || 0) + (p2.lat || 0)) / 2) >= 0 ? 'N' : 'S';
      
      setResults(calculatedResults);

      // Emit points to map
      emit('distanceTool:pointsForMap', {
        points: [
          { 
            id: 'A', 
            lat: parseFloat(p1.lat), 
            lng: parseFloat(p1.lon), 
            height: parseFloat(p1.elev) || 0,
            label: 'Point A'
          },
          { 
            id: 'B', 
            lat: parseFloat(p2.lat), 
            lng: parseFloat(p2.lon), 
            height: parseFloat(p2.elev) || 0,
            label: 'Point B'
          }
        ]
      });
    } catch (err) {
      console.error('Calculation error:', err);
      alert('Error calculating distances: ' + err.message);
    }
  };

  /**
   * Clear all inputs and results
   */
  const handleClear = () => {
    setPoint1({ id: 'A', lat: '', lon: '', elev: '', e: '', n: '', crs: 'EPSG:4326' });
    setPoint2({ id: 'B', lat: '', lon: '', elev: '', e: '', n: '', crs: 'EPSG:4326' });
    setResults(null);
    // Clear points from map
    emit('distanceTool:pointsForMap', { points: [] });
  };

  /**
   * Load example data
   */
  const loadExample = () => {
    setPoint1({
      id: 'A',
      lat: '48.8606',
      lon: '2.3376',
      elev: '35',
      e: '',
      n: '',
      crs: 'EPSG:4326'
    });
    setPoint2({
      id: 'B',
      lat: '48.8584',
      lon: '2.2945',
      elev: '35',
      e: '',
      n: '',
      crs: 'EPSG:4326'
    });
  };

  /**
   * Convert degrees to grades (400 grads = 360 degrees)
   */
  const toGrades = (degrees) => (degrees * 400) / 360;

  /**
   * Format angle in selected unit with appropriate symbol
   */
  const formatAngle = (degrees) => {
    if (angleUnit === 'grade') {
      return `${toGrades(degrees).toFixed(4)} gon`;
    }
    return `${degrees.toFixed(4)}°`;
  };

  return (
    <div style={{
      width: '100%',
      maxWidth: '1200px',
      minHeight: '700px',
      background: 'rgba(255, 255, 255, 0.95)',
      borderRadius: '12px',
      padding: '2rem',
      boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15)',
      display: 'flex',
      flexDirection: 'column'
    }}>
      <h2 style={{ 
        marginTop: 0, 
        marginBottom: '1.5rem',
        color: '#1e3c72',
        fontSize: '1.75rem',
        fontWeight: '600',
        borderBottom: '3px solid #2a5298',
        paddingBottom: '0.5rem'
      }}>
        📏 Distance & Bearing Calculator
      </h2>

      <p style={{ marginBottom: '1.5rem', color: '#555', lineHeight: '1.6' }}>
        Professional surveying tool for calculating distances, bearings, and correction factors.
        Enter coordinates in geographic (lat/lon) or projected (E/N) format.
      </p>

      {/* Input Section */}
      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: '1fr 1fr', 
        gap: '2rem',
        marginBottom: '1.5rem'
      }}>
        {/* Point 1 */}
        <div style={{
          padding: '1.5rem',
          background: '#f8f9fa',
          borderRadius: '8px',
          border: '2px solid #e0e0e0'
        }}>
          <h3 style={{ marginTop: 0, marginBottom: '1rem', color: '#1e3c72' }}>
            📍 Point {point1.id}
          </h3>
          
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', marginBottom: '0.3rem', fontWeight: '500', color: '#333' }}>
              Latitude (°)
            </label>
            <input
              type="text"
              value={point1.lat}
              onChange={(e) => handlePointChange(1, 'lat', e.target.value)}
              placeholder="37.7749"
              style={{
                width: '100%',
                padding: '0.6rem',
                borderRadius: '4px',
                border: '1px solid #ccc',
                fontSize: '1rem',
                boxSizing: 'border-box'
              }}
            />
          </div>
          
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', marginBottom: '0.3rem', fontWeight: '500', color: '#333' }}>
              Longitude (°)
            </label>
            <input
              type="text"
              value={point1.lon}
              onChange={(e) => handlePointChange(1, 'lon', e.target.value)}
              placeholder="-122.4194"
              style={{
                width: '100%',
                padding: '0.6rem',
                borderRadius: '4px',
                border: '1px solid #ccc',
                fontSize: '1rem',
                boxSizing: 'border-box'
              }}
            />
          </div>
          
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', marginBottom: '0.3rem', fontWeight: '500', color: '#333' }}>
              Elevation (m)
            </label>
            <input
              type="text"
              value={point1.elev}
              onChange={(e) => handlePointChange(1, 'elev', e.target.value)}
              placeholder="150"
              style={{
                width: '100%',
                padding: '0.6rem',
                borderRadius: '4px',
                border: '1px solid #ccc',
                fontSize: '1rem',
                boxSizing: 'border-box'
              }}
            />
          </div>
        </div>

        {/* Point 2 */}
        <div style={{
          padding: '1.5rem',
          background: '#f8f9fa',
          borderRadius: '8px',
          border: '2px solid #e0e0e0'
        }}>
          <h3 style={{ marginTop: 0, marginBottom: '1rem', color: '#1e3c72' }}>
            📍 Point {point2.id}
          </h3>
          
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', marginBottom: '0.3rem', fontWeight: '500', color: '#333' }}>
              Latitude (°)
            </label>
            <input
              type="text"
              value={point2.lat}
              onChange={(e) => handlePointChange(2, 'lat', e.target.value)}
              placeholder="37.7759"
              style={{
                width: '100%',
                padding: '0.6rem',
                borderRadius: '4px',
                border: '1px solid #ccc',
                fontSize: '1rem',
                boxSizing: 'border-box'
              }}
            />
          </div>
          
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', marginBottom: '0.3rem', fontWeight: '500', color: '#333' }}>
              Longitude (°)
            </label>
            <input
              type="text"
              value={point2.lon}
              onChange={(e) => handlePointChange(2, 'lon', e.target.value)}
              placeholder="-122.4184"
              style={{
                width: '100%',
                padding: '0.6rem',
                borderRadius: '4px',
                border: '1px solid #ccc',
                fontSize: '1rem',
                boxSizing: 'border-box'
              }}
            />
          </div>
          
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', marginBottom: '0.3rem', fontWeight: '500', color: '#333' }}>
              Elevation (m)
            </label>
            <input
              type="text"
              value={point2.elev}
              onChange={(e) => handlePointChange(2, 'elev', e.target.value)}
              placeholder="165"
              style={{
                width: '100%',
                padding: '0.6rem',
                borderRadius: '4px',
                border: '1px solid #ccc',
                fontSize: '1rem',
                boxSizing: 'border-box'
              }}
            />
          </div>
        </div>
      </div>

      {/* Options */}
      <div style={{ 
        marginBottom: '1.5rem',
        padding: '1rem',
        background: '#fff3cd',
        borderRadius: '8px',
        border: '1px solid #ffc107'
      }}>
        <div style={{ display: 'flex', gap: '2rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <label style={{ marginRight: '0.5rem', fontWeight: '500' }}>Projection Type:</label>
            <select
              value={projectionType}
              onChange={(e) => setProjectionType(e.target.value)}
              style={{
                padding: '0.5rem',
                borderRadius: '4px',
                border: '1px solid #ccc',
                fontSize: '1rem'
              }}
            >
              <option value="UTM">UTM</option>
              <option value="StatePlane">State Plane</option>
              <option value="Other">Other</option>
            </select>
          </div>
          
          <div>
            <label style={{ marginRight: '0.5rem', fontWeight: '500' }}>Angle Unit:</label>
            <select
              value={angleUnit}
              onChange={(e) => setAngleUnit(e.target.value)}
              style={{
                padding: '0.5rem',
                borderRadius: '4px',
                border: '1px solid #ccc',
                fontSize: '1rem'
              }}
            >
              <option value="degree">Degrees (°)</option>
              <option value="grade">Grades (gon)</option>
            </select>
          </div>
          
          {projectionType === 'UTM' && (
            <div>
              <label style={{ marginRight: '0.5rem', fontWeight: '500' }}>UTM Zone (optional):</label>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={60}
                step={1}
                value={utmZone}
                onChange={(e) => {
                  const val = e.target.value;
                  setUtmZone(val);
                  if (val === '') { setUtmZoneError(''); return; }
                  const n = parseInt(val, 10);
                  if (!Number.isFinite(n) || n < 1 || n > 60) {
                    setUtmZoneError('Enter a number from 1 to 60');
                  } else {
                    setUtmZoneError('');
                  }
                }}
                placeholder="Auto-detect"
                style={{
                  width: '120px',
                  padding: '0.5rem',
                  borderRadius: '4px',
                  border: utmZoneError ? '1px solid #dc3545' : '1px solid #ccc',
                  fontSize: '1rem'
                }}
              />
              {/* Zone badge next to input when results exist */}
              {results && (
                <span style={{
                  marginLeft: '0.75rem',
                  padding: '0.25rem 0.5rem',
                  borderRadius: '9999px',
                  background: results.zoneSource === 'manual' ? '#e8f5e9' : '#e3f2fd',
                  border: `1px solid ${results.zoneSource === 'manual' ? '#4caf50' : '#2196f3'}`,
                  color: results.zoneSource === 'manual' ? '#1b5e20' : '#0d47a1',
                  fontSize: '0.8rem',
                  verticalAlign: 'middle'
                }}>
                  Zone {results.utmZone} • {results.zoneSource} • {results.hemisphere}
                </span>
              )}
              {utmZoneError && (
                <div style={{ color: '#dc3545', fontSize: '0.85rem', marginTop: '0.35rem' }}>{utmZoneError}</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Map pick controls */}
      <div style={{
        marginTop: '0.5rem',
        marginBottom: '1.5rem',
        display: 'flex',
        gap: '0.75rem',
        alignItems: 'center'
      }}>
        <span style={{ color: '#555', fontSize: '0.95rem' }}>Pick from map:</span>
        <button
          type="button"
          onClick={() => {
            if (pickTarget === 'A') {
              setPickTarget(null);
            } else {
              setPickTarget('A');
              emit('distanceTool:pickMode', { target: 'A' });
            }
          }}
          style={{
            padding: '0.4rem 0.8rem',
            borderRadius: '6px',
            border: pickTarget === 'A' ? '2px solid #2a5298' : pointAConfirmed ? '2px solid #4caf50' : '1px solid #ccc',
            background: pickTarget === 'A' ? '#e3f2fd' : pointAConfirmed ? '#e8f5e9' : '#fff',
            cursor: 'pointer',
            fontWeight: pointAConfirmed ? '600' : '400',
            color: pointAConfirmed ? '#2e7d32' : '#000'
          }}
        >
          {pointAConfirmed ? '✓ Set Point A' : 'Set Point A'}
        </button>
        <button
          type="button"
          onClick={() => {
            if (pickTarget === 'B') {
              setPickTarget(null);
            } else {
              setPickTarget('B');
              emit('distanceTool:pickMode', { target: 'B' });
            }
          }}
          style={{
            padding: '0.4rem 0.8rem',
            borderRadius: '6px',
            border: pickTarget === 'B' ? '2px solid #2a5298' : pointBConfirmed ? '2px solid #4caf50' : '1px solid #ccc',
            background: pickTarget === 'B' ? '#e3f2fd' : pointBConfirmed ? '#e8f5e9' : '#fff',
            cursor: 'pointer',
            fontWeight: pointBConfirmed ? '600' : '400',
            color: pointBConfirmed ? '#2e7d32' : '#000'
          }}
        >
          {pointBConfirmed ? '✓ Set Point B' : 'Set Point B'}
        </button>
        {pickTarget && (
          <span style={{ color: '#0d47a1', fontSize: '0.9rem', fontWeight: '500' }}>📍 Map shown above ⬆️ • Click to set {pickTarget}…</span>
        )}
        {pointAConfirmed && pickTarget !== 'A' && !pointBConfirmed && (
          <span style={{ color: '#2e7d32', fontSize: '0.9rem', fontWeight: '500' }}>✓ Point A captured</span>
        )}
        {pointBConfirmed && pickTarget !== 'B' && (
          <span style={{ color: '#2e7d32', fontSize: '0.9rem', fontWeight: '500' }}>✓ Point B captured</span>
        )}
        {pointAConfirmed && pointBConfirmed && !pickTarget && (
          <span style={{ color: '#2e7d32', fontSize: '0.9rem', fontWeight: '500' }}>✓ Both points ready • Click Calculate</span>
        )}
      </div>

      {/* Action Buttons */}
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem' }}>
        <button
          onClick={handleCalculate}
          style={{
            padding: '0.75rem 2rem',
            background: 'linear-gradient(135deg, #2a5298 0%, #1e3c72 100%)',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            fontSize: '1rem',
            fontWeight: '600',
            cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.2)',
            transition: 'transform 0.2s, box-shadow 0.2s'
          }}
          onMouseOver={(e) => e.currentTarget.style.transform = 'translateY(-2px)'}
          onMouseOut={(e) => e.currentTarget.style.transform = 'translateY(0)'}
        >
          🧮 Calculate
        </button>
        
        <button
          onClick={loadExample}
          style={{
            padding: '0.75rem 2rem',
            background: '#6c757d',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            fontSize: '1rem',
            fontWeight: '600',
            cursor: 'pointer'
          }}
        >
          📋 Load Example
        </button>
        
        <button
          onClick={handleClear}
          style={{
            padding: '0.75rem 2rem',
            background: '#dc3545',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            fontSize: '1rem',
            fontWeight: '600',
            cursor: 'pointer'
          }}
        >
          🗑️ Clear
        </button>
      </div>

      {/* Results Display */}
      {results && (
        <div style={{
          background: '#e8f5e9',
          padding: '2rem',
          borderRadius: '8px',
          border: '2px solid #4caf50'
        }}>
          <h3 style={{ 
            marginTop: 0, 
            marginBottom: '1.5rem',
            color: '#1e3c72',
            fontSize: '1.5rem'
          }}>
            📊 Results: Point {point1.id} → Point {point2.id}
          </h3>

          {/* Distances Section */}
          <div style={{ marginBottom: '2rem' }}>
            <h4 style={{ 
              color: '#2a5298', 
              marginBottom: '1rem',
              fontSize: '1.25rem',
              borderBottom: '2px solid #2a5298',
              paddingBottom: '0.5rem'
            }}>
              📏 DISTANCES
            </h4>
            
            <table style={{ 
              width: '100%', 
              borderCollapse: 'collapse',
              background: 'white',
              borderRadius: '6px',
              overflow: 'hidden'
            }}>
              <thead>
                <tr style={{ background: '#2a5298', color: 'white' }}>
                  <th style={{ padding: '0.75rem', textAlign: 'left', fontWeight: '600' }}>Distance Type</th>
                  <th style={{ padding: '0.75rem', textAlign: 'right', fontWeight: '600' }}>Value (m)</th>
                  <th style={{ padding: '0.75rem', textAlign: 'left', fontWeight: '600' }}>Use Case</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ borderBottom: '1px solid #e0e0e0' }}>
                  <td style={{ padding: '0.75rem', fontWeight: '500' }}>
                    🔴 Slope Distance
                  </td>
                  <td style={{ padding: '0.75rem', textAlign: 'right', fontFamily: 'monospace', fontSize: '1.1rem' }}>
                    {results.slopeDistance.toFixed(3)}
                  </td>
                  <td style={{ padding: '0.75rem', color: '#666', fontSize: '0.9rem' }}>
                    Total station raw measurement
                  </td>
                </tr>
                
                <tr style={{ borderBottom: '1px solid #e0e0e0', background: '#f8f9fa' }}>
                  <td style={{ padding: '0.75rem', fontWeight: '500' }}>
                    🟢 Horizontal Distance
                  </td>
                  <td style={{ padding: '0.75rem', textAlign: 'right', fontFamily: 'monospace', fontSize: '1.1rem' }}>
                    {results.horizontalDistance.toFixed(3)}
                  </td>
                  <td style={{ padding: '0.75rem', color: '#666', fontSize: '0.9rem' }}>
                    Area calculations, boundary dimensions
                  </td>
                </tr>
                
                <tr style={{ borderBottom: '1px solid #e0e0e0' }}>
                  <td style={{ padding: '0.75rem', fontWeight: '500' }}>
                    🟠 Grid Distance
                  </td>
                  <td style={{ padding: '0.75rem', textAlign: 'right', fontFamily: 'monospace', fontSize: '1.1rem' }}>
                    {results.gridDistance.toFixed(3)}
                  </td>
                  <td style={{ padding: '0.75rem', color: '#666', fontSize: '0.9rem' }}>
                    CAD/GIS coordinates
                  </td>
                </tr>
                
                <tr style={{ 
                  borderBottom: '2px solid #4caf50',
                  background: '#fffde7'
                }}>
                  <td style={{ padding: '0.75rem', fontWeight: '700', color: '#2a5298' }}>
                    ⭐ Ground Distance
                  </td>
                  <td style={{ 
                    padding: '0.75rem', 
                    textAlign: 'right', 
                    fontFamily: 'monospace', 
                    fontSize: '1.2rem',
                    fontWeight: '700',
                    color: '#2a5298'
                  }}>
                    {results.groundDistance.toFixed(3)}
                  </td>
                  <td style={{ padding: '0.75rem', color: '#666', fontSize: '0.9rem', fontWeight: '600' }}>
                    ⭐ Legal surveys, true distance
                  </td>
                </tr>
                
                <tr>
                  <td style={{ padding: '0.75rem', fontWeight: '500' }}>
                    🌍 Geodesic Distance
                  </td>
                  <td style={{ padding: '0.75rem', textAlign: 'right', fontFamily: 'monospace', fontSize: '1.1rem' }}>
                    {results.geodesicDistance.toFixed(3)}
                  </td>
                  <td style={{ padding: '0.75rem', color: '#666', fontSize: '0.9rem' }}>
                    GPS processing, most accurate
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Bearings Section */}
          <div style={{ marginBottom: '2rem' }}>
            <h4 style={{ 
              color: '#2a5298', 
              marginBottom: '1rem',
              fontSize: '1.25rem',
              borderBottom: '2px solid #2a5298',
              paddingBottom: '0.5rem'
            }}>
              🧭 BEARINGS / AZIMUTHS
            </h4>
            
            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: '1fr 1fr', 
              gap: '1rem',
              background: 'white',
              padding: '1rem',
              borderRadius: '6px'
            }}>
              <div style={{ padding: '1rem', background: '#f8f9fa', borderRadius: '4px' }}>
                <div style={{ fontSize: '0.9rem', color: '#666', marginBottom: '0.5rem' }}>
                  Forward Azimuth ({point1.id} → {point2.id})
                </div>
                <div style={{ fontSize: '1.5rem', fontWeight: '700', color: '#2a5298', fontFamily: 'monospace' }}>
                  {formatAngle(results.forwardAzimuth)}
                </div>
                <div style={{ fontSize: '0.9rem', color: '#666', marginTop: '0.3rem' }}>
                  {formatDMS(results.forwardAzimuth)}
                </div>
              </div>
              
              <div style={{ padding: '1rem', background: '#f8f9fa', borderRadius: '4px' }}>
                <div style={{ fontSize: '0.9rem', color: '#666', marginBottom: '0.5rem' }}>
                  Reverse Azimuth ({point2.id} → {point1.id})
                </div>
                <div style={{ fontSize: '1.5rem', fontWeight: '700', color: '#2a5298', fontFamily: 'monospace' }}>
                  {formatAngle(results.reverseAzimuth)}
                </div>
                <div style={{ fontSize: '0.9rem', color: '#666', marginTop: '0.3rem' }}>
                  {formatDMS(results.reverseAzimuth)}
                </div>
              </div>
              
              <div style={{ padding: '1rem', background: '#f8f9fa', borderRadius: '4px' }}>
                <div style={{ fontSize: '0.9rem', color: '#666', marginBottom: '0.5rem' }}>
                  Grid Bearing
                </div>
                <div style={{ fontSize: '1.5rem', fontWeight: '700', color: '#2a5298', fontFamily: 'monospace' }}>
                  {formatAngle(results.gridBearing)}
                </div>
                <div style={{ fontSize: '0.9rem', color: '#666', marginTop: '0.3rem' }}>
                  {formatDMS(results.gridBearing)}
                </div>
              </div>
              
              <div style={{ padding: '1rem', background: '#f8f9fa', borderRadius: '4px' }}>
                <div style={{ fontSize: '0.9rem', color: '#666', marginBottom: '0.5rem' }}>
                  Elevation Difference
                </div>
                <div style={{ fontSize: '1.5rem', fontWeight: '700', color: '#2a5298', fontFamily: 'monospace' }}>
                  {results.elevationDifference > 0 ? '+' : ''}{results.elevationDifference.toFixed(3)} m
                </div>
                <div style={{ fontSize: '0.9rem', color: '#666', marginTop: '0.3rem' }}>
                  Vertical angle: {results.verticalAngle.toFixed(2)}°
                </div>
              </div>
            </div>
          </div>

          {/* Correction Factors Section */}
          <div>
            <h4 style={{ 
              color: '#2a5298', 
              marginBottom: '1rem',
              fontSize: '1.25rem',
              borderBottom: '2px solid #2a5298',
              paddingBottom: '0.5rem'
            }}>
              🔧 CORRECTION FACTORS
            </h4>
            
            <div style={{
              background: 'white',
              padding: '1.5rem',
              borderRadius: '6px'
            }}>
              <div style={{ 
                display: 'grid', 
                gridTemplateColumns: '1fr 1fr 1fr', 
                gap: '1.5rem',
                marginBottom: '1rem'
              }}>
                <div>
                  <div style={{ fontSize: '0.85rem', color: '#666', marginBottom: '0.3rem' }}>
                    Scale Factor
                  </div>
                  <div style={{ fontSize: '1.3rem', fontWeight: '700', color: '#2a5298', fontFamily: 'monospace' }}>
                    {results.scaleFactor.toFixed(8)}
                  </div>
                </div>
                
                <div>
                  <div style={{ fontSize: '0.85rem', color: '#666', marginBottom: '0.3rem' }}>
                    Elevation Factor
                  </div>
                  <div style={{ fontSize: '1.3rem', fontWeight: '700', color: '#2a5298', fontFamily: 'monospace' }}>
                    {results.elevationFactor.toFixed(8)}
                  </div>
                </div>
                
                <div>
                  <div style={{ fontSize: '0.85rem', color: '#666', marginBottom: '0.3rem' }}>
                    Combined Factor
                  </div>
                  <div style={{ fontSize: '1.3rem', fontWeight: '700', color: '#2a5298', fontFamily: 'monospace' }}>
                    {results.combinedFactor.toFixed(8)}
                  </div>
                </div>
              </div>
              
              <div style={{
                padding: '1rem',
                background: '#fff3cd',
                borderRadius: '4px',
                border: '1px solid #ffc107',
                fontSize: '0.9rem',
                color: '#856404'
              }}>
                <strong>📝 Formula:</strong> Ground Distance = Grid Distance × Scale Factor × Elevation Factor
                <br />
                <strong>🌍 Details:</strong> UTM Zone {results.utmZone} ({results.zoneSource}), Hemisphere {results.hemisphere}
                <br />
                Central Meridian {results.centralMeridian.toFixed(2)}°, Avg Elevation {results.avgElevation.toFixed(1)} m
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Info Box */}
      <div style={{
        marginTop: '2rem',
        padding: '1rem',
        background: '#e3f2fd',
        borderRadius: '6px',
        border: '1px solid #2196f3',
        fontSize: '0.9rem',
        color: '#0d47a1'
      }}>
        <strong>💡 Professional Tips:</strong>
        <ul style={{ marginTop: '0.5rem', marginBottom: 0, paddingLeft: '1.5rem' }}>
          <li>Use <strong>Ground Distance</strong> for legal property descriptions</li>
          <li>Use <strong>Geodesic Distance</strong> for GPS network adjustments</li>
          <li>Grid distance requires scale and elevation corrections for accuracy</li>
          <li>Forward and reverse azimuths differ due to Earth's curvature</li>
        </ul>
      </div>
    </div>
  );
};

export default DistanceBearingTool;
