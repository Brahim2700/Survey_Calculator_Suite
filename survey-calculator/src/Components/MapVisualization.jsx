import React, { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { emit } from '../utils/eventBus';

const BASEMAP_STORAGE_KEY = 'survey_calc_basemap';

const MapVisualization = ({ points, isVisible, onPointSelect, measureMode = false, measurePoints = [] }) => {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const markers = useRef([]);
  const measureLayerRef = useRef({ polyline: null, markers: [] });
  const basemapLayers = useRef(null);
  const layerControl = useRef(null);
  const [selectedPoint, setSelectedPoint] = useState(null);

  // Add CSS for detection labels on first render
  useEffect(() => {
    const style = document.createElement('style');
    style.innerHTML = `
      .detection-label .leaflet-tooltip-content {
        background-color: rgba(255, 255, 255, 0.95);
        border-radius: 4px;
        padding: 4px 8px;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
        font-size: 11px;
        font-weight: 600;
        color: #1f2937;
        white-space: nowrap;
      }
      .detection-label.leaflet-tooltip-top:before {
        border-top-color: rgba(255, 255, 255, 0.95);
      }
      .detection-cluster-label .leaflet-tooltip-content {
        background-color: rgba(30, 58, 138, 0.92);
        border-radius: 4px;
        padding: 4px 8px;
        box-shadow: 0 2px 4px rgba(0,0,0,0.25);
        font-size: 11px;
        font-weight: 700;
        color: #ffffff;
        white-space: nowrap;
      }
      .detection-cluster-label.leaflet-tooltip-top:before {
        border-top-color: rgba(30, 58, 138, 0.92);
      }
    `;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  // Color mapping for geoid undulation
  const getGeoidColor = useCallback((undulation) => {
    if (undulation === null || undulation === undefined) return '#888888'; // Gray for no data
    
    if (undulation < -10) return '#0000FF'; // Blue: far below
    if (undulation < -2) return '#00FFFF'; // Cyan: below
    if (undulation < 2) return '#00FF00'; // Green: near
    if (undulation < 10) return '#FFFF00'; // Yellow: above
    return '#FF0000'; // Red: far above
  }, []);

  const getGeoidLabel = (undulation) => {
    if (undulation === null || undulation === undefined) return 'No data';
    return `${undulation.toFixed(2)} m`;
  };

  const getMarkerColor = useCallback((point) => {
    if (point?.markerColor) return point.markerColor;
    return getGeoidColor(point?.geoidUndulation);
  }, [getGeoidColor]);

  const selectedPointStillVisible = selectedPoint && Array.isArray(points) && points.some((point) => {
    if (selectedPoint.id !== undefined && point.id !== undefined) {
      return String(point.id) === String(selectedPoint.id);
    }
    return point.lat === selectedPoint.lat && point.lng === selectedPoint.lng;
  });

  const getCoordKey = (lat, lng) => `${lat.toFixed(5)}|${lng.toFixed(5)}`;

  const extractCrsCode = (point) => {
    if (!point || !point.label) return null;
    const match = String(point.label).match(/EPSG:\d+/i);
    return match ? match[0].toUpperCase() : null;
  };

  const getPointConfidence = (point) => {
    if (!point) return 0;
    if (Number.isFinite(point.confidence)) return point.confidence;
    const match = String(point.label || '').match(/\((\d+)%\)/);
    return match ? Number(match[1]) / 100 : 0;
  };

  // ── Cursor: crosshair when measure mode is active ──
  useEffect(() => {
    if (map.current?.getContainer()) {
      map.current.getContainer().style.cursor = measureMode ? 'crosshair' : '';
    }
  }, [measureMode]);

  // ── Measure layer: polyline + numbered markers ──
  useEffect(() => {
    if (!map.current) return;

    // Clear previous measure layer
    if (measureLayerRef.current.polyline) {
      map.current.removeLayer(measureLayerRef.current.polyline);
      measureLayerRef.current.polyline = null;
    }
    measureLayerRef.current.markers.forEach(m => map.current.removeLayer(m));
    measureLayerRef.current.markers = [];

    if (!measurePoints || measurePoints.length === 0) return;

    // Draw polyline
    if (measurePoints.length >= 2) {
      const latlngs = measurePoints.map(p => [p.lat, p.lng]);
      measureLayerRef.current.polyline = L.polyline(latlngs, {
        color: '#f97316',
        weight: 3,
        dashArray: '8 5',
        opacity: 0.95,
      }).addTo(map.current);
    }

    // Draw numbered markers
    measurePoints.forEach(pt => {
      const icon = L.divIcon({
        html: `<div style="width:26px;height:26px;border-radius:50%;background:#f97316;color:white;font-weight:700;font-size:12px;display:flex;align-items:center;justify-content:center;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.35);line-height:1">${pt.id}</div>`,
        className: '',
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      });
      const marker = L.marker([pt.lat, pt.lng], { icon })
        .bindTooltip(
          `<b>Point ${pt.id}</b><br/>${pt.lat.toFixed(5)}°, ${pt.lng.toFixed(5)}°`,
          { direction: 'top', offset: [0, -14] }
        )
        .addTo(map.current);
      measureLayerRef.current.markers.push(marker);
    });

    // Fit map to measure points
    if (measurePoints.length >= 2 && measureLayerRef.current.polyline) {
      const group = L.featureGroup([
        measureLayerRef.current.polyline,
        ...measureLayerRef.current.markers,
      ]);
      map.current.fitBounds(group.getBounds().pad(0.25));
    } else if (measurePoints.length === 1) {
      map.current.setView(
        [measurePoints[0].lat, measurePoints[0].lng],
        Math.max(map.current.getZoom(), 12)
      );
    } else if (!points || points.length === 0) {
      map.current.setView([20, 0], 2);
    }
  }, [measurePoints, points]);

  // Clear selection when map is hidden or points are removed - handled in render
  useEffect(() => {
    if (!isVisible || !points || points.length === 0) {
      // We'll return early in the map setup if these conditions are true
      // This prevents the map from initializing when not needed
    }
  }, [isVisible, points]);

  useEffect(() => {
    if (!isVisible || !mapContainer.current) return;

    // Initialize map if not already done
    if (!map.current) {
      map.current = L.map(mapContainer.current).setView([20, 0], 2);

      basemapLayers.current = {
        'Street (OSM)': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '© OpenStreetMap contributors',
          maxZoom: 19,
        }),
        'Satellite (Esri)': L.tileLayer(
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          {
            attribution: 'Tiles © Esri',
            maxZoom: 19,
          }
        ),
        'Terrain (OpenTopoMap)': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
          attribution: '© OpenTopoMap contributors',
          maxZoom: 17,
        })
      };

      const savedBasemap = localStorage.getItem(BASEMAP_STORAGE_KEY);
      const initialBasemap = savedBasemap && basemapLayers.current[savedBasemap]
        ? savedBasemap
        : 'Street (OSM)';

      basemapLayers.current[initialBasemap].addTo(map.current);
      layerControl.current = L.control.layers(basemapLayers.current, null, { position: 'topleft' }).addTo(map.current);
    }

    // Attach a single click handler to publish raw map clicks
    const handleMapClick = (e) => {
      const { lat, lng } = e.latlng || {};
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        emit('map:click', { lat, lon: lng, lng });
      }
    };

    const handleBasemapChange = (e) => {
      if (e?.name) {
        localStorage.setItem(BASEMAP_STORAGE_KEY, e.name);
      }
    };

    map.current.on('click', handleMapClick);
    map.current.on('baselayerchange', handleBasemapChange);

    // Clear existing markers
    markers.current.forEach((marker) => map.current.removeLayer(marker));
    markers.current = [];

    const validPoints = points.filter((point, idx) => {
      if (!point || typeof point !== 'object') {
        console.warn(`[MapViz] Point ${idx} is not an object:`, point);
        return false;
      }
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
        console.warn(`[MapViz] Point ${idx} has invalid coordinates:`, {
          lat: point.lat,
          lng: point.lng,
          latType: typeof point.lat,
          lngType: typeof point.lng,
          fullPoint: point
        });
        return false;
      }
      return true;
    });

    // Group detection points by near-identical position so superposed CRS can be labeled clearly.
    const detectionGroups = new Map();
    validPoints.forEach((point) => {
      if (!point.detectionMarker) return;
      const key = getCoordKey(point.lat, point.lng);
      const existing = detectionGroups.get(key);
      if (existing) {
        existing.points.push(point);
      } else {
        detectionGroups.set(key, {
          lat: point.lat,
          lng: point.lng,
          points: [point]
        });
      }
    });

    // For superposed groups, keep only top two labels permanently visible.
    const visibleDetectionLabelIds = new Set();
    detectionGroups.forEach((group) => {
      if (group.points.length <= 1) {
        group.points.forEach((p) => visibleDetectionLabelIds.add(p.id));
        return;
      }
      const ranked = [...group.points].sort((a, b) => getPointConfidence(b) - getPointConfidence(a));
      ranked.slice(0, 2).forEach((p) => visibleDetectionLabelIds.add(p.id));
    });

    // Add cluster labels for superposed detections (same position, multiple CRS).
    detectionGroups.forEach((group) => {
      if (group.points.length < 2) return;
      const ranked = [...group.points].sort((a, b) => getPointConfidence(b) - getPointConfidence(a));
      const topTwoCodes = ranked.slice(0, 2).map((p) => extractCrsCode(p)).filter(Boolean);
      const topTwoText = topTwoCodes.length > 0 ? topTwoCodes.join(', ') : 'Top 2';
      const hiddenCount = Math.max(group.points.length - 2, 0);
      const clusterTooltip = L.tooltip({
        permanent: true,
        direction: 'top',
        className: 'detection-cluster-label',
        offset: [0, -34]
      })
        .setContent(`Superposed (${group.points.length}): ${topTwoText}${hiddenCount > 0 ? ` (+${hiddenCount} in popup)` : ''}`)
        .setLatLng([group.lat, group.lng])
        .addTo(map.current);
      markers.current.push(clusterTooltip);
    });

    // Add new markers for each point
    validPoints.forEach((point) => {
      const coordKey = getCoordKey(point.lat, point.lng);
      const group = point.detectionMarker ? detectionGroups.get(coordKey) : null;
      const groupSize = group ? group.points.length : 1;
      const groupIndex = group ? group.points.indexOf(point) : -1;
      const isSelectableConverted = measureMode && point.sourceType === 'converted';

      let displayLat = point.lat;
      let displayLng = point.lng;
      let tooltipOffset = [0, -15];

      // Slightly spread markers so identical points remain visible/clickable.
      if (group && groupSize > 1 && groupIndex >= 0) {
        const angle = (2 * Math.PI * groupIndex) / groupSize;
        const spreadDeg = 0.00008; // ~9m lat offset; visual aid only
        displayLat = point.lat + Math.sin(angle) * spreadDeg;
        displayLng = point.lng + Math.cos(angle) * spreadDeg;
        tooltipOffset = [Math.round(Math.cos(angle) * 28), Math.round(Math.sin(angle) * 20) - 20];
      }

      const color = getMarkerColor(point);
      const undulationLabel = getGeoidLabel(point.geoidUndulation);
      const markerRadius = isSelectableConverted ? 10 : 8;
      const markerStroke = isSelectableConverted ? '#f97316' : '#fff';
      const markerWeight = isSelectableConverted ? 4 : 2;
      const markerFillOpacity = isSelectableConverted ? 0.95 : 0.8;

      // Create custom circle marker
      const circleMarker = L.circleMarker([displayLat, displayLng], {
        radius: markerRadius,
        fillColor: color,
        color: markerStroke,
        weight: markerWeight,
        opacity: 1,
        fillOpacity: markerFillOpacity,
      })
        .bindPopup(
          `<div style="font-size: 12px; min-width: 180px;">
            <b>${point.label || 'Point'}</b><br/>
            Lat: ${point.lat.toFixed(4)}°<br/>
            Lng: ${point.lng.toFixed(4)}°<br/>
            Height: ${(point.height || 0).toFixed(2)} m<br/>
            ${isSelectableConverted ? `<span style="color:#ea580c"><b>Measure:</b> Click to select this converted point</span><br/>` : ''}
            ${groupSize > 1 ? `<span style="color:#1e3a8a"><b>Note:</b> Marker position is slightly offset for overlap clarity (${groupIndex + 1}/${groupSize}).</span><br/>` : ''}
            ${point.validationMessage ? `<span style="color:#b45309"><b>Validation:</b> ${point.validationMessage}</span><br/>` : ''}
            <b style="color: ${color}">Geoid: ${undulationLabel}</b>
          </div>`
        )
        .on('click', () => {
          setSelectedPoint(point);
          if (onPointSelect) onPointSelect(point);
        })
        .addTo(map.current);

      // Add permanent label for detection markers
      if (point.detectionMarker && point.label && visibleDetectionLabelIds.has(point.id)) {
        const markerTooltip = L.tooltip({
          permanent: true,
          direction: 'top',
          className: 'detection-label',
          offset: tooltipOffset
        })
          .setContent(point.label)
          .setLatLng([displayLat, displayLng])
          .addTo(map.current);
        markers.current.push(markerTooltip);
      }

      if (isSelectableConverted) {
        circleMarker.bringToFront();
      }

      markers.current.push(circleMarker);
    });

    // Fit map to show all markers; otherwise restore world extent when empty.
    if (markers.current.length > 0) {
      const group = new L.featureGroup(markers.current);
      map.current.fitBounds(group.getBounds().pad(0.1));
    } else if (!measurePoints || measurePoints.length === 0) {
      map.current.setView([20, 0], 2);
    }
    return () => {
      if (map.current) {
        map.current.off('click', handleMapClick);
        map.current.off('baselayerchange', handleBasemapChange);
      }
    };
  }, [points, isVisible, onPointSelect, getMarkerColor, measureMode, measurePoints]);

  return (
    <div
      style={{
        display: isVisible ? 'block' : 'none',
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
        backgroundColor: '#f5f5f5',
        margin: 0,
        padding: 0,
        lineHeight: 0
      }}
    >
      {/* Legend */}
      <div
        style={{
          position: 'absolute',
          top: '10px',
          right: '10px',
          backgroundColor: 'rgba(15,32,64,0.92)',
          backdropFilter: 'blur(6px)',
          padding: '10px 13px',
          borderRadius: '10px',
          boxShadow: '0 4px 16px rgba(0,0,0,0.28)',
          zIndex: 999,
          fontSize: '11px',
          lineHeight: '1.55',
          border: '1px solid rgba(255,255,255,0.10)',
          color: '#cbd5e1',
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: '6px', color: '#e0eaff', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Geoid Undulation</div>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '3px' }}>
          <div style={{ width: '10px', height: '10px', backgroundColor: '#0000FF', marginRight: '6px', borderRadius: '2px', flexShrink: 0 }} />
          &lt; −10 m
        </div>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '3px' }}>
          <div style={{ width: '10px', height: '10px', backgroundColor: '#f59e0b', marginRight: '6px', borderRadius: '2px', flexShrink: 0 }} />
          Zone warning
        </div>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '3px' }}>
          <div style={{ width: '10px', height: '10px', backgroundColor: '#dc2626', marginRight: '6px', borderRadius: '2px', flexShrink: 0 }} />
          Outlier warning
        </div>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '3px' }}>
          <div style={{ width: '10px', height: '10px', backgroundColor: '#00FFFF', marginRight: '6px', borderRadius: '2px', flexShrink: 0 }} />
          −10 → −2 m
        </div>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '3px' }}>
          <div style={{ width: '10px', height: '10px', backgroundColor: '#00FF00', marginRight: '6px', borderRadius: '2px', flexShrink: 0 }} />
          −2 → +2 m
        </div>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '3px' }}>
          <div style={{ width: '10px', height: '10px', backgroundColor: '#FFFF00', marginRight: '6px', borderRadius: '2px', flexShrink: 0 }} />
          +2 → +10 m
        </div>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <div style={{ width: '10px', height: '10px', backgroundColor: '#FF0000', marginRight: '6px', borderRadius: '2px', flexShrink: 0 }} />
          &gt; +10 m
        </div>
      </div>

      {/* Map container */}
      <div
        ref={mapContainer}
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          margin: 0,
          padding: 0,
          lineHeight: 0
        }}
      />

      {/* Selected point info */}
      {selectedPointStillVisible && (
        <div
          style={{
            position: 'absolute',
            bottom: '10px',
            left: '10px',
            backgroundColor: 'rgba(15,32,64,0.92)',
            backdropFilter: 'blur(6px)',
            padding: '10px 13px',
            borderRadius: '10px',
            boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
            zIndex: 999,
            fontSize: '11px',
            lineHeight: 1.55,
            maxWidth: '200px',
            border: '1px solid rgba(255,255,255,0.10)',
            color: '#cbd5e1',
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: '4px', color: '#e0eaff', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {selectedPoint.label || 'Selected Point'}
          </div>
          <div>Lat: {selectedPoint.lat.toFixed(6)}°</div>
          <div>Lng: {selectedPoint.lng.toFixed(6)}°</div>
          <div>Height: {(selectedPoint.height || 0).toFixed(3)} m</div>
          {selectedPoint.validationMessage && (
            <div style={{ color: '#fbbf24', fontWeight: 600, marginTop: '3px' }}>⚠ {selectedPoint.validationMessage}</div>
          )}
          <div style={{ color: getMarkerColor(selectedPoint), fontWeight: 700, marginTop: '3px' }}>
            Geoid: {getGeoidLabel(selectedPoint.geoidUndulation)}
          </div>
        </div>
      )}
    </div>
  );
};

export default MapVisualization;
