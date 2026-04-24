import React, { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { emit } from '../utils/eventBus';
import { resolveCadWebFont } from '../utils/cadFontMap';

const BASEMAP_STORAGE_KEY = 'survey_calc_basemap';
const LABEL_AUTO_HIDE_THRESHOLD = 300;
const CAD_HEAVY_VERTEX_THRESHOLD = 90000;
const CAD_EXTREME_VERTEX_THRESHOLD = 180000;
const EMPTY_CAD_GEOMETRY = {
  lines: [],
  polylines: [],
  texts: [],
  layerSummary: null,
  validation: null,
  notifications: [],
  repairs: null,
  localPreview: false,
};

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');
const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));

const getZoomBasedMarkerRadius = (zoom) => {
  if (zoom <= 10) return 3;
  if (zoom <= 12) return 4;
  if (zoom <= 14) return 5;
  if (zoom <= 16) return 6;
  if (zoom <= 18) return 7;
  return 8;
};

const getCadPolylineDecimationStep = (zoom, totalVertices, featureVertices) => {
  if (totalVertices >= CAD_EXTREME_VERTEX_THRESHOLD || featureVertices >= 12000) {
    if (zoom <= 10) return 6;
    if (zoom <= 12) return 4;
    if (zoom <= 14) return 3;
    if (zoom <= 16) return 2;
    return 1;
  }

  if (totalVertices >= CAD_HEAVY_VERTEX_THRESHOLD || featureVertices >= 7000) {
    if (zoom <= 10) return 4;
    if (zoom <= 12) return 3;
    if (zoom <= 14) return 2;
    return 1;
  }

  return 1;
};

const decimateLatLngs = (latlngs, step) => {
  if (step <= 1 || latlngs.length <= 2) return latlngs;

  const simplified = [latlngs[0]];
  for (let i = step; i < latlngs.length - 1; i += step) {
    simplified.push(latlngs[i]);
  }
  simplified.push(latlngs[latlngs.length - 1]);
  return simplified.length >= 2 ? simplified : latlngs;
};

const getCadPolylineSmoothFactor = (zoom, totalVertices, featureVertices) => {
  if (totalVertices >= CAD_EXTREME_VERTEX_THRESHOLD || featureVertices >= 12000) {
    if (zoom <= 10) return 2.6;
    if (zoom <= 12) return 2.1;
    if (zoom <= 14) return 1.7;
    return 1.3;
  }

  if (totalVertices >= CAD_HEAVY_VERTEX_THRESHOLD || featureVertices >= 7000) {
    if (zoom <= 10) return 2.1;
    if (zoom <= 12) return 1.7;
    if (zoom <= 14) return 1.4;
    return 1.2;
  }

  return 1.0;
};

const getRoundedScaleDenominator = (rawDenominator) => {
  if (!Number.isFinite(rawDenominator) || rawDenominator <= 0) return null;
  if (rawDenominator < 1000) return Math.round(rawDenominator / 10) * 10;
  if (rawDenominator < 5000) return Math.round(rawDenominator / 50) * 50;
  if (rawDenominator < 10000) return Math.round(rawDenominator / 100) * 100;
  if (rawDenominator < 50000) return Math.round(rawDenominator / 500) * 500;
  if (rawDenominator < 100000) return Math.round(rawDenominator / 1000) * 1000;
  return Math.round(rawDenominator / 5000) * 5000;
};

const getMapScaleDenominator = (zoom, latitudeDeg) => {
  const latRad = (Math.max(-85, Math.min(85, latitudeDeg)) * Math.PI) / 180;
  const metersPerPixel = (40075016.686 * Math.cos(latRad)) / (2 ** (zoom + 8));
  const screenDpi = 96;
  const denominator = (metersPerPixel * screenDpi) / 0.0254;
  return getRoundedScaleDenominator(denominator);
};

const MapVisualization = ({ points, cadGeometry = EMPTY_CAD_GEOMETRY, isVisible, onPointSelect, measureMode = false, measurePoints = [], onMapContainerReady = null, onMapMetricsChange = null, onMapInstanceReady = null }) => {
  const mapContainer = useRef(null);
  const mapRootContainer = useRef(null);
  const map = useRef(null);
  const markers = useRef([]);
  const pointLayersRef = useRef([]);
  const geometryLayersRef = useRef([]);
  const canvasRendererRef = useRef(null);
  const fittedPointsSignatureRef = useRef('');
  const measureLayerRef = useRef({ polyline: null, markers: [] });
  const basemapLayers = useRef(null);
  const layerControl = useRef(null);
  const smartScaleControl = useRef(null);
  const smartScaleLabel = useRef(null);
  const [selectedPoint, setSelectedPoint] = useState(null);
  const [showPointLayer, setShowPointLayer] = useState(true);
  const [showLineLayer, setShowLineLayer] = useState(true);
  const [showPolylineLayer, setShowPolylineLayer] = useState(true);
  const [showTextLayer, setShowTextLayer] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [legendCollapsed, setLegendCollapsed] = useState(true);
  const [labelsTouched, setLabelsTouched] = useState(false);
  const [hiddenCadLayers, setHiddenCadLayers] = useState({});

  const effectiveShowLabels =
    Array.isArray(points) && points.length === 0
      ? true
      : (!labelsTouched && Array.isArray(points) && points.length > LABEL_AUTO_HIDE_THRESHOLD)
        ? false
        : showLabels;
  const cadNotifications = Array.isArray(cadGeometry?.notifications)
    ? cadGeometry.notifications
    : (Array.isArray(cadGeometry?.validation?.notifications) ? cadGeometry.validation.notifications : []);
  const cadLayers = Array.isArray(cadGeometry?.layerSummary?.layers) ? cadGeometry.layerSummary.layers : [];

  useEffect(() => {
    if (typeof onMapContainerReady !== 'function') return;
    onMapContainerReady(mapRootContainer.current);
    return () => onMapContainerReady(null);
  }, [onMapContainerReady]);

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
      .point-name-label .leaflet-tooltip-content {
        background: rgba(9, 17, 30, 0.86);
        color: #e6edf7;
        border: 1px solid rgba(147, 197, 253, 0.48);
        border-radius: 7px;
        padding: 3px 8px 4px;
        font-size: 11px;
        font-weight: 650;
        line-height: 1.2;
        letter-spacing: 0.01em;
        font-family: 'Avenir Next', 'Segoe UI Variable Text', 'Trebuchet MS', sans-serif;
        text-shadow: 0 1px 0 rgba(0, 0, 0, 0.3);
        box-shadow: 0 2px 8px rgba(2, 6, 23, 0.45);
        white-space: normal;
      }
      .point-name-label .cad-point-name {
        font-weight: 700;
        color: #67e8f9;
      }
      .point-name-label .cad-point-elevation {
        color: #fbbf24;
        font-weight: 600;
        margin-top: 2px;
        font-size: 0.95em;
      }
      .point-name-label.leaflet-tooltip-top:before {
        border-top-color: rgba(9, 17, 30, 0.86);
      }
      .point-name-label.leaflet-tooltip-right:before {
        border-right-color: rgba(9, 17, 30, 0.86);
      }
      .point-name-label.leaflet-tooltip-left:before {
        border-left-color: rgba(9, 17, 30, 0.86);
      }
      .point-name-label.leaflet-tooltip-bottom:before {
        border-bottom-color: rgba(9, 17, 30, 0.86);
      }
      .point-name-label.dense .leaflet-tooltip-content {
        font-size: 10px;
        padding: 2px 7px 3px;
        background: rgba(7, 13, 24, 0.9);
      }
      .point-cluster-label .leaflet-tooltip-content {
        background: rgba(30, 41, 59, 0.92);
        color: #f8fafc;
        border: 1px solid rgba(148, 163, 184, 0.58);
        border-radius: 999px;
        font-size: 10px;
        font-weight: 700;
        padding: 2px 8px;
        box-shadow: 0 2px 6px rgba(2, 6, 23, 0.4);
        font-family: 'Avenir Next', 'Segoe UI Variable Text', 'Trebuchet MS', sans-serif;
      }
      .point-cluster-label.leaflet-tooltip-top:before {
        border-top-color: rgba(30, 41, 59, 0.92);
      }
      .map-export-mode .map-legend-overlay {
        display: none !important;
      }
      .map-export-mode .point-name-label .leaflet-tooltip-content {
        font-size: 12px;
        padding: 4px 10px 5px;
        background: rgba(9, 17, 30, 0.92);
        border-width: 1.2px;
      }
      .map-export-mode .point-name-label.dense .leaflet-tooltip-content {
        font-size: 11px;
        padding: 3px 8px 4px;
      }
      .map-export-mode .detection-label .leaflet-tooltip-content,
      .map-export-mode .detection-cluster-label .leaflet-tooltip-content,
      .map-export-mode .point-cluster-label .leaflet-tooltip-content {
        font-size: 11px;
      }
      .leaflet-control.smart-scale-control {
        clear: none;
        margin-left: 6px;
        margin-bottom: 10px;
        background: rgba(15, 23, 42, 0.9);
        color: #e2e8f0;
        border: 1px solid rgba(148, 163, 184, 0.5);
        border-radius: 6px;
        box-shadow: 0 1px 5px rgba(0, 0, 0, 0.5);
        padding: 3px 8px;
        font-size: 11px;
        font-weight: 700;
        line-height: 1.2;
      }
      .cad-text-icon {
        background: transparent;
        border: none;
      }
      .cad-text-label {
        display: inline-block;
        white-space: nowrap;
        padding: 2px 6px;
        border-radius: 3px;
        background: rgba(15, 23, 42, 0.88);
        border: 1px solid rgba(229, 231, 235, 0.2);
        color: #e5e7eb;
        font-weight: 600;
        line-height: 1.15;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
        box-shadow: 0 1px 4px rgba(15, 23, 42, 0.16);
        transform-origin: left center;
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
  const infoPanelCount = (cadNotifications.length > 0 ? 1 : 0) + (selectedPointStillVisible ? 1 : 0) + 1;
  const infoRailColumns = infoPanelCount <= 1
    ? 'minmax(0, 1fr)'
    : `repeat(${infoPanelCount}, minmax(0, 1fr))`;

  const geoidLegendItems = [
    { color: '#0000FF', label: '< -10 m' },
    { color: '#00FFFF', label: '-10 to -2 m' },
    { color: '#00FF00', label: '-2 to +2 m' },
    { color: '#FFFF00', label: '+2 to +10 m' },
    { color: '#FF0000', label: '> +10 m' },
  ];

  const getCoordKey = (lat, lng) => `${lat.toFixed(5)}|${lng.toFixed(5)}`;

  const getPointLabel = (point) => {
    const raw = String(point?.label || point?.id || 'Point');
    return raw.length > 42 ? `${raw.slice(0, 39)}...` : raw;
  };

  const getPointLabelMarkup = (point) => {
    const importedName = String(point?.importedCadName || '').trim();
    const importedElevationText = String(point?.importedCadElevationText || '').trim();
    if (point?.sourceType === 'cad-point' && (importedName || importedElevationText)) {
      const nameHtml = importedName ? `<div class="cad-point-name">${escapeHtml(importedName)}</div>` : '';
      const elevationHtml = importedElevationText ? `<div class="cad-point-elevation">${escapeHtml(importedElevationText)}</div>` : '';
      return `${nameHtml}${elevationHtml}`;
    }
    return escapeHtml(getPointLabel(point));
  };

  const getPointPopupTitle = (point) => {
    const importedName = String(point?.importedCadName || '').trim();
    if (importedName) return importedName;
    const label = String(point?.label || '').trim();
    if (label) return label;
    const id = String(point?.id || '').trim();
    if (id) return id;
    return 'Point';
  };

  const getLabelBudget = (zoom, totalPoints) => {
    if (totalPoints >= 8000) {
      if (zoom >= 18) return 110;
      if (zoom >= 16) return 80;
      if (zoom >= 14) return 44;
      return 24;
    }
    if (totalPoints >= 3500) {
      if (zoom >= 18) return 140;
      if (zoom >= 16) return 100;
      if (zoom >= 14) return 56;
      return 30;
    }
    if (zoom >= 18) return Math.min(totalPoints, 240);
    if (zoom >= 17) return Math.min(totalPoints, 180);
    if (zoom >= 16) return Math.min(totalPoints, 130);
    if (zoom >= 15) return Math.min(totalPoints, 88);
    if (zoom >= 14) return Math.min(totalPoints, 60);
    if (zoom >= 13) return Math.min(totalPoints, 42);
    return Math.min(totalPoints, 28);
  };

  const getDetectionLabelBudget = (zoom, totalPoints) => {
    if (totalPoints >= 1200) {
      if (zoom >= 18) return 100;
      if (zoom >= 16) return 72;
      if (zoom >= 14) return 44;
      return 24;
    }
    if (zoom >= 18) return Math.min(totalPoints, 160);
    if (zoom >= 16) return Math.min(totalPoints, 120);
    if (zoom >= 14) return Math.min(totalPoints, 76);
    return Math.min(totalPoints, 40);
  };

  const getDeclutterCellSize = (zoom) => {
    if (zoom >= 17) return 24;
    if (zoom >= 16) return 28;
    if (zoom >= 15) return 34;
    if (zoom >= 14) return 40;
    return 48;
  };

  const getSmartLabelLayout = (index, total) => {
    if (total <= 1) {
      return { direction: 'top', offset: [0, -17], isDense: false };
    }

    const ring = total <= 4 ? 22 : total <= 9 ? 30 : 36;
    const angle = ((2 * Math.PI * index) / total) - Math.PI / 2;
    const ox = Math.round(Math.cos(angle) * ring);
    const oy = Math.round(Math.sin(angle) * ring);

    let direction = 'top';
    if (Math.abs(ox) > Math.abs(oy)) {
      direction = ox >= 0 ? 'right' : 'left';
    } else {
      direction = oy >= 0 ? 'bottom' : 'top';
    }

    return {
      direction,
      offset: [ox, oy],
      isDense: total >= 8,
    };
  };

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

  const getCadLayerKey = useCallback((feature) => String(feature?.layerStandardized || feature?.layerNormalized || feature?.layer || 'UNASSIGNED'), []);
  const isCadLayerVisible = useCallback((feature) => !hiddenCadLayers[getCadLayerKey(feature)], [getCadLayerKey, hiddenCadLayers]);

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

  }, [measurePoints, points]);

  useEffect(() => {
    if (!isVisible || !mapContainer.current) return;

    // Initialize map if not already done
    if (!map.current) {
      map.current = L.map(mapContainer.current, {
        preferCanvas: true,
        zoomSnap: 0.25,
        zoomDelta: 0.5,
        maxZoom: 23,
        minZoom: 2,
      }).setView([20, 0], 2);
      canvasRendererRef.current = L.canvas({ padding: 0.5 });

      basemapLayers.current = {
        'Street (OSM)': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '© OpenStreetMap contributors',
          maxNativeZoom: 19,
          maxZoom: 23,
        }),
        'Satellite (Esri)': L.tileLayer(
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          {
            attribution: 'Tiles © Esri',
            maxNativeZoom: 19,
            maxZoom: 23,
          }
        ),
        'Terrain (OpenTopoMap)': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
          attribution: '© OpenTopoMap contributors',
          maxNativeZoom: 17,
          maxZoom: 23,
        })
      };

      const savedBasemap = localStorage.getItem(BASEMAP_STORAGE_KEY);
      const initialBasemap = savedBasemap && basemapLayers.current[savedBasemap]
        ? savedBasemap
        : 'Street (OSM)';

      basemapLayers.current[initialBasemap].addTo(map.current);
      layerControl.current = L.control.layers(basemapLayers.current, null, { position: 'topleft' }).addTo(map.current);
      smartScaleControl.current = L.control({ position: 'bottomleft' });
      smartScaleControl.current.onAdd = () => {
        const div = L.DomUtil.create('div', 'leaflet-control smart-scale-control');
        div.innerHTML = 'Scale 1:--';
        smartScaleLabel.current = div;
        return div;
      };
      smartScaleControl.current.addTo(map.current);

      if (typeof onMapInstanceReady === 'function') {
        onMapInstanceReady(map.current);
      }
    }

    const updateSmartScale = () => {
      if (!map.current || !smartScaleLabel.current) return;
      const center = map.current.getCenter();
      const zoom = map.current.getZoom();
      const denominator = getMapScaleDenominator(zoom, center.lat);
      const formatted = Number.isFinite(denominator) ? denominator.toLocaleString() : '--';
      smartScaleLabel.current.innerHTML = `Scale 1:${formatted}`;
    };

    const publishMapMetrics = () => {
      if (!map.current || typeof onMapMetricsChange !== 'function') return;
      const bounds = map.current.getBounds();
      const south = bounds.getSouth();
      const north = bounds.getNorth();
      const west = bounds.getWest();
      const east = bounds.getEast();
      const midLat = (south + north) / 2;
      const widthMeters = map.current.distance([midLat, west], [midLat, east]);
      const heightMeters = map.current.distance([south, west], [north, west]);
      const zoom = map.current.getZoom();
      const denominator = getMapScaleDenominator(zoom, map.current.getCenter().lat);

      onMapMetricsChange({
        extentWidthMeters: Number.isFinite(widthMeters) ? widthMeters : null,
        extentHeightMeters: Number.isFinite(heightMeters) ? heightMeters : null,
        mapWidthPx: map.current.getSize().x,
        mapHeightPx: map.current.getSize().y,
        smartScaleDenominator: Number.isFinite(denominator) ? denominator : null,
      });
    };

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

    const handleViewChange = () => {
      updateSmartScale();
      publishMapMetrics();
    };

    const handleZoomStart = () => {
      const tooltipPane = map.current?.getPanes?.().tooltipPane;
      if (tooltipPane) {
        tooltipPane.style.display = 'none';
      }
    };

    const handleZoomEnd = () => {
      const tooltipPane = map.current?.getPanes?.().tooltipPane;
      if (tooltipPane) {
        tooltipPane.style.display = '';
      }
      handleViewChange();
    };

    map.current.on('click', handleMapClick);
    map.current.on('baselayerchange', handleBasemapChange);
    map.current.on('zoomstart', handleZoomStart);
    map.current.on('zoomend', handleZoomEnd);
    map.current.on('moveend', handleViewChange);
    updateSmartScale();
    publishMapMetrics();

    // Clear existing markers and geometry overlays
    markers.current.forEach((marker) => map.current.removeLayer(marker));
    markers.current = [];
    pointLayersRef.current = [];
    geometryLayersRef.current.forEach((layer) => map.current.removeLayer(layer));
    geometryLayersRef.current = [];

    const inputPoints = showPointLayer ? points : [];
    const validPoints = inputPoints.filter((point, idx) => {
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

    const overlapGroups = new Map();
    validPoints.forEach((point) => {
      const key = getCoordKey(point.lat, point.lng);
      const existing = overlapGroups.get(key);
      if (existing) {
        existing.points.push(point);
      } else {
        overlapGroups.set(key, {
          lat: point.lat,
          lng: point.lng,
          points: [point],
        });
      }
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
    const detectionLabelBudget = getDetectionLabelBudget(map.current.getZoom(), validPoints.length);
    detectionGroups.forEach((group) => {
      if (visibleDetectionLabelIds.size >= detectionLabelBudget) return;
      if (group.points.length <= 1) {
        if (group.points[0]?.id !== undefined) {
          visibleDetectionLabelIds.add(group.points[0].id);
        }
        return;
      }
      const ranked = [...group.points].sort((a, b) => getPointConfidence(b) - getPointConfidence(a));
      ranked.slice(0, 2).forEach((p) => {
        if (visibleDetectionLabelIds.size < detectionLabelBudget && p?.id !== undefined) {
          visibleDetectionLabelIds.add(p.id);
        }
      });
    });

    // Add cluster labels for superposed detections (same position, multiple CRS).
    if (effectiveShowLabels) detectionGroups.forEach((group) => {
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
    const convertedPoints = validPoints.filter((p) => !p.detectionMarker);
    const viewportBounds = map.current.getBounds().pad(0.08);
    const inViewConvertedPoints = convertedPoints.filter((p) => viewportBounds.contains([p.lat, p.lng]));
    const labelBudget = getLabelBudget(map.current.getZoom(), inViewConvertedPoints.length);
    const cellSize = getDeclutterCellSize(map.current.getZoom());
    const occupiedCells = new Set();
    const visibleConvertedLabelIds = new Set();

    const representativePoints = [];
    const secondaryPoints = [];
    overlapGroups.forEach((group) => {
      const groupConverted = group.points.filter((p) => !p.detectionMarker && viewportBounds.contains([p.lat, p.lng]));
      if (groupConverted.length === 0) return;
      representativePoints.push(groupConverted[0]);
      secondaryPoints.push(...groupConverted.slice(1));
    });

    const selectedId = selectedPoint?.id !== undefined ? String(selectedPoint.id) : null;
    const selectedCandidate = selectedId
      ? inViewConvertedPoints.find((p) => p.id !== undefined && String(p.id) === selectedId)
      : null;

    const placeLabelCandidate = (point) => {
      if (!point) return;
      const pointId = point.id !== undefined ? String(point.id) : null;
      if (pointId && visibleConvertedLabelIds.has(pointId)) return;
      if (visibleConvertedLabelIds.size >= labelBudget) return;
      const px = map.current.latLngToContainerPoint([point.lat, point.lng]);
      const cellKey = `${Math.floor(px.x / cellSize)}|${Math.floor(px.y / cellSize)}`;
      if (occupiedCells.has(cellKey)) return;
      occupiedCells.add(cellKey);
      if (pointId) visibleConvertedLabelIds.add(pointId);
    };

    if (selectedCandidate?.id !== undefined) {
      visibleConvertedLabelIds.add(String(selectedCandidate.id));
      const selectedPx = map.current.latLngToContainerPoint([selectedCandidate.lat, selectedCandidate.lng]);
      occupiedCells.add(`${Math.floor(selectedPx.x / cellSize)}|${Math.floor(selectedPx.y / cellSize)}`);
    }

    representativePoints.forEach(placeLabelCandidate);
    secondaryPoints.forEach(placeLabelCandidate);

    const hiddenCountByCoordKey = new Map();
    overlapGroups.forEach((group) => {
      const groupConverted = group.points.filter((p) => !p.detectionMarker);
      if (!groupConverted.length) return;
      const hidden = groupConverted.filter((p) => {
        if (p.id === undefined) return false;
        return !visibleConvertedLabelIds.has(String(p.id));
      }).length;
      if (hidden > 0) {
        hiddenCountByCoordKey.set(getCoordKey(group.lat, group.lng), hidden);
      }
    });

    validPoints.forEach((point) => {
      const coordKey = getCoordKey(point.lat, point.lng);
      const group = point.detectionMarker ? detectionGroups.get(coordKey) : null;
      const groupSize = group ? group.points.length : 1;
      const groupIndex = group ? group.points.indexOf(point) : -1;
      const isSelectableConverted = measureMode && point.sourceType === 'converted';

      const displayLat = point.lat;
      const displayLng = point.lng;
      let tooltipOffset = [0, -15];
      if (group && groupSize > 1 && groupIndex >= 0) {
        const angle = (2 * Math.PI * groupIndex) / groupSize;
        tooltipOffset = [Math.round(Math.cos(angle) * 28), Math.round(Math.sin(angle) * 20) - 20];
      }

      const color = getMarkerColor(point);
      const undulationLabel = getGeoidLabel(point.geoidUndulation);
      const baseRadius = getZoomBasedMarkerRadius(map.current.getZoom());
      const markerRadius = isSelectableConverted ? baseRadius + 2 : baseRadius;
      const markerStroke = isSelectableConverted ? '#f97316' : '#fff';
      const markerWeight = isSelectableConverted ? 4 : 2;
      const markerFillOpacity = isSelectableConverted ? 0.95 : 0.8;

      // Create custom circle marker
      const circleMarker = L.circleMarker([displayLat, displayLng], {
        renderer: canvasRendererRef.current || undefined,
        radius: markerRadius,
        fillColor: color,
        color: markerStroke,
        weight: markerWeight,
        opacity: 1,
        fillOpacity: markerFillOpacity,
      })
        .bindPopup(
          `<div style="font-size: 12px; min-width: 180px;">
            <b>${escapeHtml(getPointPopupTitle(point))}</b><br/>
            Lat: ${point.lat.toFixed(4)}°<br/>
            Lng: ${point.lng.toFixed(4)}°<br/>
            Height: ${(point.height || 0).toFixed(2)} m<br/>
            ${isSelectableConverted ? `<span style="color:#ea580c"><b>Measure:</b> Click to select this converted point</span><br/>` : ''}
            ${groupSize > 1 ? `<span style="color:#1e3a8a"><b>Note:</b> ${groupSize} points overlap at this location (${groupIndex + 1}/${groupSize}).</span><br/>` : ''}
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
      if (effectiveShowLabels && point.detectionMarker && point.label && visibleDetectionLabelIds.has(point.id)) {
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

      if (!point.detectionMarker) {
        const overlapGroup = overlapGroups.get(getCoordKey(point.lat, point.lng));
        const overlapSize = overlapGroup ? overlapGroup.points.length : 1;
        const overlapIndex = overlapGroup ? overlapGroup.points.findIndex((p) => String(p.id) === String(point.id) && p.label === point.label) : 0;
        const labelLayout = getSmartLabelLayout(Math.max(overlapIndex, 0), overlapSize);
        const pointId = point.id !== undefined ? String(point.id) : null;
        const hasImportedCadLabel = Boolean(String(point?.importedCadName || '').trim() || String(point?.importedCadElevationText || '').trim());
        const shouldShowConvertedLabel = pointId
          ? visibleConvertedLabelIds.has(pointId)
          : false;

        if (effectiveShowLabels && shouldShowConvertedLabel && (point.sourceType !== 'cad-point' || hasImportedCadLabel)) {
          const nameTooltip = L.tooltip({
            permanent: true,
            direction: labelLayout.direction,
            className: `point-name-label${labelLayout.isDense ? ' dense' : ''}`,
            offset: labelLayout.offset,
            opacity: 1,
          })
            .setContent(getPointLabelMarkup(point))
            .setLatLng([displayLat, displayLng])
            .addTo(map.current);
          markers.current.push(nameTooltip);
        }
      }

      if (isSelectableConverted) {
        circleMarker.bringToFront();
      }

      pointLayersRef.current.push(circleMarker);
      markers.current.push(circleMarker);
    });

    if (effectiveShowLabels) hiddenCountByCoordKey.forEach((hiddenCount, key) => {
      const group = overlapGroups.get(key);
      if (!group || !viewportBounds.contains([group.lat, group.lng])) return;
      const hiddenTooltip = L.tooltip({
        permanent: true,
        direction: 'top',
        className: 'point-cluster-label',
        offset: [0, -32],
        opacity: 1,
      })
        .setContent(`+${hiddenCount} more`)
        .setLatLng([group.lat, group.lng])
        .addTo(map.current);
      markers.current.push(hiddenTooltip);
    });

    // Render CAD geometry overlays (already projected to WGS84 by converter).
    const cadLines = Array.isArray(cadGeometry?.lines) ? cadGeometry.lines : [];
    const cadPolylines = Array.isArray(cadGeometry?.polylines) ? cadGeometry.polylines : [];
    const cadTexts = Array.isArray(cadGeometry?.texts) ? cadGeometry.texts : [];
    const currentZoom = map.current.getZoom();
    const totalCadPolylineVertices = cadPolylines.reduce((sum, poly) => {
      const pts = Array.isArray(poly?.points) ? poly.points : [];
      return sum + pts.length;
    }, 0);

    if (showLineLayer) cadLines.filter(isCadLayerVisible).forEach((line) => {
      const start = line?.start;
      const end = line?.end;
      if (!Array.isArray(start) || !Array.isArray(end)) return;
      if (!Number.isFinite(start[0]) || !Number.isFinite(start[1]) || !Number.isFinite(end[0]) || !Number.isFinite(end[1])) return;
      const layer = L.polyline(
        [
          [start[0], start[1]],
          [end[0], end[1]],
        ],
        {
          renderer: canvasRendererRef.current || undefined,
          color: '#0ea5e9',
          weight: 2.5,
          opacity: 0.85,
        }
      )
        .bindPopup(`<div style="font-size:12px;"><b>${escapeHtml(line.layer || 'CAD line')}</b><br/>Type: ${escapeHtml(line.sourceType || 'LINE')}</div>`)
        .addTo(map.current);
      geometryLayersRef.current.push(layer);
      markers.current.push(layer);
    });

    if (showPolylineLayer) cadPolylines.filter(isCadLayerVisible).forEach((poly) => {
      const pts = Array.isArray(poly?.points) ? poly.points : [];
      const latlngs = pts
        .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
        .map((p) => [p[0], p[1]]);
      if (latlngs.length < 2) return;
      const decimationStep = getCadPolylineDecimationStep(currentZoom, totalCadPolylineVertices, latlngs.length);
      const renderLatLngs = decimateLatLngs(latlngs, decimationStep);
      if (renderLatLngs.length < 2) return;
      const smoothFactor = getCadPolylineSmoothFactor(currentZoom, totalCadPolylineVertices, latlngs.length);
      const layer = L.polyline(renderLatLngs, {
        renderer: canvasRendererRef.current || undefined,
        color: '#2563eb',
        weight: 2,
        opacity: 0.8,
        smoothFactor,
      })
        .bindPopup(`<div style="font-size:12px;"><b>${escapeHtml(poly.layer || 'CAD polyline')}</b><br/>Type: ${escapeHtml(poly.sourceType || 'POLYLINE')}</div>`)
        .addTo(map.current);
      geometryLayersRef.current.push(layer);
      markers.current.push(layer);
    });

    if (showTextLayer) {
      // Collect all text assigned to points to avoid rendering duplicates
      const usedTextValues = new Set();
      validPoints.forEach((point) => {
        if (String(point?.importedCadName || '').trim()) {
          usedTextValues.add(String(point.importedCadName).trim());
        }
        if (String(point?.importedCadElevationText || '').trim()) {
          usedTextValues.add(String(point.importedCadElevationText).trim());
        }
      });

      cadTexts.filter(isCadLayerVisible).forEach((textEntity) => {
        // Skip CAD text that has been assigned to a point (avoid duplication)
        const textContent = String(textEntity?.text || '').trim();
        if (textContent && usedTextValues.has(textContent)) return;

        const position = Array.isArray(textEntity?.position) ? textEntity.position : [];
        if (!Number.isFinite(Number(position[0])) || !Number.isFinite(Number(position[1]))) return;
        const fontSize = Math.round(clampNumber((Number(textEntity?.textHeight) || 2.5) * 2.6, 10, 28));
        const rotation = Number.isFinite(Number(textEntity?.rotation)) ? Number(textEntity.rotation) : 0;
        const color = textEntity?.colorHex || '#0f172a';
        const fontResolution = resolveCadWebFont({
          styleName: textEntity?.styleName,
          fontFamily: textEntity?.fontFamily,
        });
        const fontFamily = escapeHtml(fontResolution.cssFamily);
        const html = `<div class="cad-text-label" style="font-family:${fontFamily};font-size:${fontSize}px;color:${color};transform:rotate(${rotation}deg);">${escapeHtml(textEntity?.text || '')}</div>`;
        const marker = L.marker([position[0], position[1]], {
          icon: L.divIcon({ html, className: 'cad-text-icon', iconAnchor: [0, 0] }),
          keyboard: false,
        })
          .bindPopup(
            `<div style="font-size:12px;min-width:180px;"><b>${escapeHtml(textEntity?.text || 'CAD text')}</b><br/>Layer: ${escapeHtml(textEntity?.layer || 'Annotation')}<br/>Style: ${escapeHtml(textEntity?.styleName || 'STANDARD')}<br/>CAD font: ${escapeHtml(textEntity?.fontFamily || 'Default')}<br/>Web font: ${escapeHtml(fontResolution.bundledName)}</div>`
          )
          .addTo(map.current);
        geometryLayersRef.current.push(marker);
        markers.current.push(marker);
      });
    }

    // Fit map only when point data changes; do not fight user zoom/pan interactions.
    const pointsSignature = validPoints.map((p) => `${p.id ?? ''}:${p.lat.toFixed(6)}:${p.lng.toFixed(6)}`).join('|');
    const geometrySignature = [
      cadLines.map((l) => `${l?.start?.[0] ?? ''},${l?.start?.[1] ?? ''}->${l?.end?.[0] ?? ''},${l?.end?.[1] ?? ''}`).join('|'),
      cadPolylines.map((pl) => (pl?.points || []).map((p) => `${p?.[0] ?? ''},${p?.[1] ?? ''}`).join(';')).join('|'),
      cadTexts.map((textEntity) => `${textEntity?.position?.[0] ?? ''},${textEntity?.position?.[1] ?? ''}:${textEntity?.text ?? ''}`).join('|'),
    ].join('||');
    const fitSignature = `${pointsSignature}__${geometrySignature}`;

    if (pointLayersRef.current.length > 0 || geometryLayersRef.current.length > 0) {
      const fitLayers = [...pointLayersRef.current, ...geometryLayersRef.current];
      const group = new L.featureGroup(fitLayers);
      if (fittedPointsSignatureRef.current !== fitSignature) {
        map.current.fitBounds(group.getBounds().pad(0.1));
        fittedPointsSignatureRef.current = fitSignature;
      }
    } else if (validPoints.length === 0 && (!measurePoints || measurePoints.length === 0)) {
      // Do not force-reset view on each zoom/move event when no data is loaded.
      if (fittedPointsSignatureRef.current !== '') {
        map.current.setView([20, 0], 2);
        fittedPointsSignatureRef.current = '';
      }
    }
    return () => {
      if (map.current) {
        const tooltipPane = map.current.getPanes?.().tooltipPane;
        if (tooltipPane) {
          tooltipPane.style.display = '';
        }
        map.current.off('click', handleMapClick);
        map.current.off('baselayerchange', handleBasemapChange);
        map.current.off('zoomstart', handleZoomStart);
        map.current.off('zoomend', handleZoomEnd);
        map.current.off('moveend', handleViewChange);
      }
    };
  }, [points, cadGeometry, isVisible, onPointSelect, onMapMetricsChange, getMarkerColor, isCadLayerVisible, measureMode, measurePoints, selectedPoint, showPointLayer, showLineLayer, showPolylineLayer, showTextLayer, showLabels, effectiveShowLabels, hiddenCadLayers]);

  return (
    <div
      ref={mapRootContainer}
      style={{
        display: isVisible ? 'flex' : 'none',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        minHeight: 0,
        gap: '10px',
        margin: 0,
        padding: 0,
      }}
    >
      <div
        style={{
          position: 'relative',
          flex: '1 1 auto',
          minHeight: 0,
          overflow: 'hidden',
          backgroundColor: '#f5f5f5',
          borderRadius: '12px',
          lineHeight: 0,
        }}
      >
        <div
          className="map-legend-overlay"
          style={{
            position: 'absolute',
            top: '10px',
            right: '10px',
            backgroundColor: 'rgba(15,32,64,0.9)',
            backdropFilter: 'blur(8px)',
            padding: '8px 9px',
            borderRadius: '12px',
            boxShadow: '0 4px 16px rgba(0,0,0,0.24)',
            zIndex: 999,
            fontSize: '10px',
            lineHeight: '1.35',
            border: '1px solid rgba(255,255,255,0.10)',
            color: '#cbd5e1',
            width: legendCollapsed ? '148px' : '188px',
            maxWidth: 'calc(100% - 20px)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <div>
              <div style={{ fontWeight: 800, color: '#e0eaff', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Map Tools</div>
              <div style={{ color: '#94a3b8', fontSize: '9px', marginTop: '2px' }}>{cadLayers.length} CAD layers</div>
            </div>
            <button
              onClick={() => setLegendCollapsed((v) => !v)}
              style={{
                border: '1px solid rgba(148,163,184,0.55)',
                background: 'rgba(15,23,42,0.65)',
                color: '#e2e8f0',
                borderRadius: '999px',
                fontSize: '10px',
                padding: '1px 8px',
                cursor: 'pointer'
              }}
            >
              {legendCollapsed ? 'Open' : 'Hide'}
            </button>
          </div>
          {!legendCollapsed && (
            <>
              <div style={{ marginTop: '8px', marginBottom: '8px', display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                <button
                  onClick={() => setShowPointLayer((v) => !v)}
                  style={{
                    border: '1px solid rgba(148,163,184,0.55)',
                    background: showPointLayer ? 'rgba(30,64,175,0.75)' : 'rgba(15,23,42,0.65)',
                    color: '#e2e8f0',
                    borderRadius: '999px',
                    fontSize: '9px',
                    padding: '2px 7px',
                    cursor: 'pointer'
                  }}
                >
                  Points
                </button>
                <button
                  onClick={() => setShowLineLayer((v) => !v)}
                  style={{
                    border: '1px solid rgba(148,163,184,0.55)',
                    background: showLineLayer ? 'rgba(14,165,233,0.75)' : 'rgba(15,23,42,0.65)',
                    color: '#e2e8f0',
                    borderRadius: '999px',
                    fontSize: '9px',
                    padding: '2px 7px',
                    cursor: 'pointer'
                  }}
                >
                  Lines
                </button>
                <button
                  onClick={() => setShowPolylineLayer((v) => !v)}
                  style={{
                    border: '1px solid rgba(148,163,184,0.55)',
                    background: showPolylineLayer ? 'rgba(37,99,235,0.75)' : 'rgba(15,23,42,0.65)',
                    color: '#e2e8f0',
                    borderRadius: '999px',
                    fontSize: '9px',
                    padding: '2px 7px',
                    cursor: 'pointer'
                  }}
                >
                  Polylines
                </button>
                <button
                  onClick={() => {
                    setLabelsTouched(true);
                    setShowLabels(!effectiveShowLabels);
                  }}
                  style={{
                    border: '1px solid rgba(148,163,184,0.55)',
                    background: effectiveShowLabels ? 'rgba(56,189,248,0.75)' : 'rgba(15,23,42,0.65)',
                    color: '#e2e8f0',
                    borderRadius: '999px',
                    fontSize: '9px',
                    padding: '2px 7px',
                    cursor: 'pointer'
                  }}
                >
                  Labels
                </button>
                <button
                  onClick={() => setShowTextLayer((v) => !v)}
                  style={{
                    border: '1px solid rgba(148,163,184,0.55)',
                    background: showTextLayer ? 'rgba(16,185,129,0.72)' : 'rgba(15,23,42,0.65)',
                    color: '#e2e8f0',
                    borderRadius: '999px',
                    fontSize: '9px',
                    padding: '2px 7px',
                    cursor: 'pointer'
                  }}
                >
                  Text
                </button>
              </div>
              {cadLayers.length > 0 && (
                <div>
                  <div style={{ fontWeight: 700, color: '#e0eaff', fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '5px' }}>
                    CAD Layers
                  </div>
                  <div style={{ display: 'grid', gap: '4px', maxHeight: '96px', overflowY: 'auto', paddingRight: '2px' }}>
                    {cadLayers.slice(0, 6).map((layer) => {
                      const layerKey = String(layer.standardizedName || layer.normalizedName || layer.displayName || '');
                      const visible = !hiddenCadLayers[layerKey];
                      return (
                        <button
                          key={layerKey}
                          title={layer.originalNames?.join(', ') || layer.displayName}
                          onClick={() => setHiddenCadLayers((prev) => ({ ...prev, [layerKey]: visible }))}
                          style={{
                            border: '1px solid rgba(148,163,184,0.45)',
                            background: visible ? 'rgba(30,41,59,0.82)' : 'rgba(15,23,42,0.35)',
                            color: visible ? '#f8fafc' : '#94a3b8',
                            borderRadius: '8px',
                            fontSize: '9px',
                            padding: '4px 6px',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '6px',
                          }}
                        >
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{layer.displayName}</span>
                          <span style={{ color: '#cbd5e1', flexShrink: 0 }}>{layer.entityCount}</span>
                        </button>
                      );
                    })}
                  </div>
                  {cadLayers.length > 6 && (
                    <div style={{ marginTop: '5px', color: '#94a3b8', fontSize: '9px' }}>
                      +{cadLayers.length - 6} more layers available
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

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
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: infoRailColumns,
          gap: '10px',
          alignItems: 'stretch',
        }}
      >
        {cadNotifications.length > 0 && (
          <div
            style={{
              background: 'rgba(15, 23, 42, 0.9)',
              border: '1px solid rgba(147, 197, 253, 0.2)',
              borderRadius: '12px',
              padding: '10px 12px',
              height: '100%',
              color: '#dbeafe',
              boxShadow: '0 10px 24px rgba(15, 23, 42, 0.12)',
              lineHeight: 1.4,
              fontSize: '11px',
            }}
          >
            <div style={{ fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px', color: '#e0eaff' }}>CAD Import Notices</div>
            <div style={{ display: 'grid', gap: '6px' }}>
              {cadNotifications.slice(0, 2).map((notice, index) => (
                <div key={`${notice?.code || notice?.title || 'cad-notice'}-${index}`}>
                  <div style={{ fontWeight: 700 }}>{notice?.title || 'CAD notice'}</div>
                  <div style={{ color: '#cbd5e1' }}>{notice?.message || ''}</div>
                </div>
              ))}
              {cadNotifications.length > 2 && (
                <div style={{ color: '#93c5fd' }}>+{cadNotifications.length - 2} more notice(s)</div>
              )}
            </div>
          </div>
        )}

        {selectedPointStillVisible && (
          <div
            style={{
              background: 'rgba(15, 32, 64, 0.92)',
              border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: '12px',
              padding: '10px 12px',
              height: '100%',
              color: '#cbd5e1',
              boxShadow: '0 10px 24px rgba(15, 23, 42, 0.12)',
              fontSize: '11px',
              lineHeight: 1.5,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: '4px', color: '#e0eaff', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {selectedPoint.label || 'Selected Point'}
            </div>
            <div>Lat: {selectedPoint.lat.toFixed(6)}°</div>
            <div>Lng: {selectedPoint.lng.toFixed(6)}°</div>
            <div>Height: {(selectedPoint.height || 0).toFixed(3)} m</div>
            {selectedPoint.validationMessage && (
              <div style={{ color: '#fbbf24', fontWeight: 600, marginTop: '3px' }}>Validation: {selectedPoint.validationMessage}</div>
            )}
            <div style={{ color: getMarkerColor(selectedPoint), fontWeight: 700, marginTop: '3px' }}>
              Geoid: {getGeoidLabel(selectedPoint.geoidUndulation)}
            </div>
          </div>
        )}

        <div
          style={{
            background: 'rgba(15, 32, 64, 0.92)',
            border: '1px solid rgba(255,255,255,0.10)',
            borderRadius: '12px',
            padding: '10px 12px',
            height: '100%',
            color: '#cbd5e1',
            boxShadow: '0 10px 24px rgba(15, 23, 42, 0.12)',
            fontSize: '11px',
            lineHeight: 1.45,
          }}
        >
          <div style={{ fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px', color: '#e0eaff' }}>Geoid Bands</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', justifyContent: infoPanelCount === 1 ? 'center' : 'flex-start' }}>
            {geoidLegendItems.map((item) => (
              <div
                key={item.label}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '3px 8px',
                  borderRadius: '999px',
                  background: 'rgba(15,23,42,0.55)',
                  border: '1px solid rgba(148,163,184,0.35)',
                }}
              >
                <span style={{ width: '9px', height: '9px', backgroundColor: item.color, borderRadius: '999px', flexShrink: 0 }} />
                <span>{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default MapVisualization;
