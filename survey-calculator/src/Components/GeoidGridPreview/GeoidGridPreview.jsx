import React, { useState, useEffect } from 'react';
import { MapContainer, TileLayer, GeoJSON, LayersControl } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import './GeoidGridPreview.css';

const GeoidGridPreview = ({ geoidData, onPointClick }) => {
  const [geojsonData, setGeojsonData] = useState(null);

  useEffect(() => {
    if (geoidData) {
      // Simulate fetching or processing geoid data into GeoJSON
      setGeojsonData(geoidData);
    }
  }, [geoidData]);

  const handlePointClick = (event) => {
    const { lat, lng } = event.latlng;
    if (onPointClick) {
      onPointClick(lat, lng);
    }
  };

  return (
    <div className="geoid-grid-preview">
      <MapContainer center={[0, 0]} zoom={2} style={{ height: '100%', width: '100%' }} onClick={handlePointClick}>
        <LayersControl position="topright">
          <LayersControl.BaseLayer checked name="OpenStreetMap">
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          </LayersControl.BaseLayer>
          {geojsonData && (
            <LayersControl.Overlay checked name="Geoid Grid">
              <GeoJSON data={geojsonData} />
            </LayersControl.Overlay>
          )}
        </LayersControl>
      </MapContainer>
    </div>
  );
};

export default GeoidGridPreview;