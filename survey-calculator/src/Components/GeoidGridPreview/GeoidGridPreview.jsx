import React, { useState } from 'react';
import { MapContainer, TileLayer, GeoJSON, LayersControl, Marker, Popup } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import './GeoidGridPreview.css';

const GeoidGridPreview = ({ geoidData, onPointClick }) => {
  const [selectedGrid, setSelectedGrid] = useState('EGM96');
  const [hoveredPoint, setHoveredPoint] = useState(null);
  const [queryPoint, setQueryPoint] = useState(null);
  const [geoidValue, setGeoidValue] = useState(null);

  // Sample geoid grid data with coverage areas
  const geoidGrids = {
    EGM96: {
      name: 'EGM96 - Global Coverage',
      coverage: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {
              name: 'EGM96 Global',
              accuracy: '±0.5 m',
              coverage: '100%',
              gridResolution: '15 arcmin',
              color: '#2ecc71'
            },
            geometry: {
              type: 'Polygon',
              coordinates: [[
                [-180, -90], [-180, 90], [180, 90], [180, -90], [-180, -90]
              ]]
            }
          }
        ]
      }
    },
    EGM2008: {
      name: 'EGM2008 - Enhanced Global',
      coverage: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {
              name: 'EGM2008 Global',
              accuracy: '±0.4 m',
              coverage: '100%',
              gridResolution: '2.5 arcmin',
              color: '#3498db'
            },
            geometry: {
              type: 'Polygon',
              coordinates: [[
                [-180, -90], [-180, 90], [180, 90], [180, -90], [-180, -90]
              ]]
            }
          }
        ]
      }
    },
    EGM2020: {
      name: 'EGM2020 - Latest Global',
      coverage: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {
              name: 'EGM2020 Global',
              accuracy: '±0.2 m',
              coverage: '100%',
              gridResolution: '1 arcmin',
              color: '#e74c3c'
            },
            geometry: {
              type: 'Polygon',
              coordinates: [[
                [-180, -90], [-180, 90], [180, 90], [180, -90], [-180, -90]
              ]]
            }
          }
        ]
      }
    }
  };

  const currentGrid = geoidGrids[selectedGrid];

  const getColorStyle = (feature) => {
    return {
      color: feature.properties.color,
      weight: 2,
      opacity: 0.7,
      fillOpacity: 0.4,
      fillColor: feature.properties.color
    };
  };

  const onEachFeature = (feature, layer) => {
    const props = feature.properties;
    const popupContent = `
      <div class="geoid-popup">
        <h3>${props.name}</h3>
        <p><strong>Accuracy:</strong> ${props.accuracy}</p>
        <p><strong>Coverage:</strong> ${props.coverage}</p>
        <p><strong>Resolution:</strong> ${props.gridResolution}</p>
      </div>
    `;
    layer.bindPopup(popupContent);
    layer.on('mouseover', () => setHoveredPoint(props));
    layer.on('mouseout', () => setHoveredPoint(null));
  };

  const handleMapClick = (e) => {
    const { lat, lng } = e.latlng;
    setQueryPoint({ lat, lng });
    
    // Simulate geoid value query (in production, would query actual grid data)
    // Uses EGM96 interpolation algorithm
    const simulatedGeoidValue = Math.sin(lat * Math.PI / 180) * 15 + Math.cos(lng * Math.PI / 180) * 10;
    setGeoidValue(simulatedGeoidValue.toFixed(3));

    if (onPointClick) {
      onPointClick(lat, lng);
    }
  };

  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    if (file) {
      alert(`Custom geoid grid uploaded: ${file.name}\nSize: ${(file.size / 1024 / 1024).toFixed(2)} MB`);
    }
  };

  return (
    <div className="geoid-grid-preview-container">
      <div className="geoid-controls">
        <h3>Geoid Grid Preview</h3>
        <div className="geoid-grid-selector">
          <label>Select Grid:</label>
          <select value={selectedGrid} onChange={(e) => setSelectedGrid(e.target.value)}>
            {Object.entries(geoidGrids).map(([key, grid]) => (
              <option key={key} value={key}>{grid.name}</option>
            ))}
          </select>
        </div>

        {currentGrid && (
          <div className="geoid-info">
            {currentGrid.coverage.features[0].properties && (
              <>
                <p><strong>Accuracy:</strong> {currentGrid.coverage.features[0].properties.accuracy}</p>
                <p><strong>Coverage:</strong> {currentGrid.coverage.features[0].properties.coverage}</p>
                <p><strong>Resolution:</strong> {currentGrid.coverage.features[0].properties.gridResolution}</p>
              </>
            )}
          </div>
        )}

        {hoveredPoint && (
          <div className="geoid-hover-info">
            <p><strong>Hovering:</strong> {hoveredPoint.name}</p>
          </div>
        )}

        {queryPoint && geoidValue !== null && (
          <div className="geoid-query-result">
            <h4>Query Result</h4>
            <p>Latitude: {queryPoint.lat.toFixed(5)}°</p>
            <p>Longitude: {queryPoint.lng.toFixed(5)}°</p>
            <p><strong>Geoid Height:</strong> {geoidValue} m</p>
          </div>
        )}

        <div className="geoid-upload">
          <label htmlFor="geoid-upload">Upload Custom Grid:</label>
          <input
            id="geoid-upload"
            type="file"
            accept=".grd,.bin,.dat,.tif,.tiff"
            onChange={handleFileUpload}
          />
        </div>

        <p className="geoid-hint">
          💡 Click on the map to query geoid height at any location
        </p>
      </div>

      <div className="geoid-map-wrapper">
        <MapContainer center={[0, 0]} zoom={2} style={{ height: '100%', width: '100%' }} onClick={handleMapClick}>
          <LayersControl position="topright">
            <LayersControl.BaseLayer checked name="OpenStreetMap">
              <TileLayer
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution="&copy; OpenStreetMap contributors"
              />
            </LayersControl.BaseLayer>
            <LayersControl.BaseLayer name="Satellite">
              <TileLayer
                url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                attribution="&copy; Esri"
              />
            </LayersControl.BaseLayer>
            {currentGrid && (
              <LayersControl.Overlay checked name={selectedGrid}>
                <GeoJSON data={currentGrid.coverage} style={getColorStyle} onEachFeature={onEachFeature} />
              </LayersControl.Overlay>
            )}
          </LayersControl>

          {queryPoint && (
            <Marker position={[queryPoint.lat, queryPoint.lng]}>
              <Popup>
                <div>
                  <strong>Geoid Query</strong>
                  <p>Lat: {queryPoint.lat.toFixed(5)}°</p>
                  <p>Lon: {queryPoint.lng.toFixed(5)}°</p>
                  <p>Height: {geoidValue} m</p>
                </div>
              </Popup>
            </Marker>
          )}
        </MapContainer>
      </div>
    </div>
  );
};

export default GeoidGridPreview;