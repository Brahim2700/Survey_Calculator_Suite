import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { emit } from '../utils/eventBus';
import { resolveCadWebFont } from '../utils/cadFontMap';

const BASEMAP_STORAGE_KEY = 'survey_calc_basemap';
const IGN_FRANCE_BOUNDS = L.latLngBounds([41.0, -5.8], [51.5, 9.8]);
const LABEL_AUTO_HIDE_THRESHOLD = 300;
const CAD_HEAVY_VERTEX_THRESHOLD = 90000;
const CAD_EXTREME_VERTEX_THRESHOLD = 180000;
const SHOW_DETECTION_LABELS = false;
const SHOW_CLUSTER_COUNTERS = false;
const SHOW_CAD_TEXT_ANNOTATIONS = false;
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
const normalizeHexColor = (value, fallback = '#3b82f6') => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return /^#([0-9a-fA-F]{6})$/.test(trimmed) ? trimmed : fallback;
};

const toCoordKey = (lat, lng, precision = 7) => `${Number(lat).toFixed(precision)}|${Number(lng).toFixed(precision)}`;

const normalizePolylineVertices = (points, precision = 7) => {
  const normalized = [];
  let removedVertices = 0;
  let prevKey = null;

  (Array.isArray(points) ? points : []).forEach((pt) => {
    if (!Array.isArray(pt) || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) return;
    const key = toCoordKey(pt[0], pt[1], precision);
    if (key === prevKey) {
      removedVertices += 1;
      return;
    }
    normalized.push([pt[0], pt[1]]);
    prevKey = key;
  });

  return { vertices: normalized, removedVertices };
};

const dedupeGeometryPayload = ({ points, lines, polylines }) => {
  const seenPoints = new Set();
  const dedupedPoints = [];

  (Array.isArray(points) ? points : []).forEach((point) => {
    if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)) return;
    const labelKey = String(point?.importedCadName || point?.label || point?.id || '').trim();
    const heightKey = Number.isFinite(Number(point?.height)) ? Number(point.height).toFixed(3) : '';
    const key = `${toCoordKey(point.lat, point.lng)}|${labelKey}|${heightKey}|${String(point?.sourceType || '')}`;
    if (seenPoints.has(key)) return;
    seenPoints.add(key);
    dedupedPoints.push(point);
  });

  const seenLines = new Set();
  const dedupedLines = [];
  (Array.isArray(lines) ? lines : []).forEach((line) => {
    const start = Array.isArray(line?.start) ? line.start : null;
    const end = Array.isArray(line?.end) ? line.end : null;
    if (!start || !end || !Number.isFinite(start[0]) || !Number.isFinite(start[1]) || !Number.isFinite(end[0]) || !Number.isFinite(end[1])) return;
    const a = toCoordKey(start[0], start[1]);
    const b = toCoordKey(end[0], end[1]);
    const ordered = a < b ? `${a}|${b}` : `${b}|${a}`;
    const layerKey = String(line?.layerStandardized || line?.layerNormalized || line?.layer || '').trim();
    const key = `${ordered}|${layerKey}|${String(line?.sourceType || 'LINE')}`;
    if (seenLines.has(key)) return;
    seenLines.add(key);
    dedupedLines.push(line);
  });

  const seenPolylines = new Set();
  const dedupedPolylines = [];
  let removedVertices = 0;
  (Array.isArray(polylines) ? polylines : []).forEach((polyline) => {
    const { vertices, removedVertices: rv } = normalizePolylineVertices(polyline?.points);
    removedVertices += rv;
    if (vertices.length < 2) return;
    const forward = vertices.map((pt) => toCoordKey(pt[0], pt[1])).join(';');
    const reverse = [...vertices].reverse().map((pt) => toCoordKey(pt[0], pt[1])).join(';');
    const pathKey = forward < reverse ? forward : reverse;
    const layerKey = String(polyline?.layerStandardized || polyline?.layerNormalized || polyline?.layer || '').trim();
    const key = `${pathKey}|${layerKey}|${String(polyline?.sourceType || 'POLYLINE')}`;
    if (seenPolylines.has(key)) return;
    seenPolylines.add(key);
    dedupedPolylines.push({ ...polyline, points: vertices });
  });

  return {
    points: dedupedPoints,
    lines: dedupedLines,
    polylines: dedupedPolylines,
    stats: {
      pointsRemoved: Math.max(0, (Array.isArray(points) ? points.length : 0) - dedupedPoints.length),
      linesRemoved: Math.max(0, (Array.isArray(lines) ? lines.length : 0) - dedupedLines.length),
      polylinesRemoved: Math.max(0, (Array.isArray(polylines) ? polylines.length : 0) - dedupedPolylines.length),
      verticesRemoved: Math.max(0, removedVertices),
    },
  };
};

const getZoomBasedMarkerRadius = (zoom) => {
  if (zoom <= 10) return 2;
  if (zoom <= 12) return 2.5;
  if (zoom <= 14) return 3;
  if (zoom <= 16) return 3.5;
  if (zoom <= 18) return 4;
  return 4.5;
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

const MapVisualization = ({ points, cadGeometry = EMPTY_CAD_GEOMETRY, isVisible, onPointSelect, measureMode = false, measurePoints = [], onMapContainerReady = null, onMapMetricsChange = null, onMapInstanceReady = null, markerStyleConfig = null }) => {
  const mapContainer = useRef(null);
  const mapRootContainer = useRef(null);
  const map = useRef(null);
  const markers = useRef([]);
  const pointLayersRef = useRef([]);
  const geometryLayersRef = useRef([]);
  const canvasRendererRef = useRef(null);
  const fittedPointsSignatureRef = useRef('');
  const dataExtentBoundsRef = useRef(null);
  const snapCandidatesRef = useRef([]);
  const measureLayerRef = useRef({ polyline: null, markers: [] });
  const basemapLayers = useRef(null);
  const layerControl = useRef(null);
  const smartScaleControl = useRef(null);
  const smartScaleLabel = useRef(null);
  const [selectedPoint, setSelectedPoint] = useState(null);
  const [showPointLayer, setShowPointLayer] = useState(true);
  const [showLineLayer, setShowLineLayer] = useState(true);
  const [showPolylineLayer, setShowPolylineLayer] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [removeDuplicates, setRemoveDuplicates] = useState(false);
  const [snapMode, setSnapMode] = useState(false);
  const [snapRadiusPx, setSnapRadiusPx] = useState(14);
  const [pointSymbol, setPointSymbol] = useState('circle');
  const [pointSizeScale, setPointSizeScale] = useState(0.7);
  const [pointBaseColor, setPointBaseColor] = useState('#3b82f6');
  const [legendCollapsed, setLegendCollapsed] = useState(true);
  const [labelsTouched, setLabelsTouched] = useState(false);
  const [hiddenCadLayers, setHiddenCadLayers] = useState({});

  const effectiveShowLabels =
    Array.isArray(points) && points.length === 0
      ? true
      : (!labelsTouched && Array.isArray(points) && points.length > LABEL_AUTO_HIDE_THRESHOLD)
        ? false
        : showLabels;
  const annotationsVisible = effectiveShowLabels;
  const cadNotifications = Array.isArray(cadGeometry?.notifications)
    ? cadGeometry.notifications
    : (Array.isArray(cadGeometry?.validation?.notifications) ? cadGeometry.validation.notifications : []);
  const cadLayers = Array.isArray(cadGeometry?.layerSummary?.layers) ? cadGeometry.layerSummary.layers : [];

  const dedupePreviewStats = useMemo(() => {
    if (!removeDuplicates) {
      return { pointsRemoved: 0, linesRemoved: 0, polylinesRemoved: 0, verticesRemoved: 0 };
    }

    const rawPoints = (showPointLayer ? points : []).filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng));
    const rawLines = Array.isArray(cadGeometry?.lines) ? cadGeometry.lines : [];
    const rawPolylines = Array.isArray(cadGeometry?.polylines) ? cadGeometry.polylines : [];
    return dedupeGeometryPayload({ points: rawPoints, lines: rawLines, polylines: rawPolylines }).stats;
  }, [removeDuplicates, showPointLayer, points, cadGeometry]);

  useEffect(() => {
    const externalPointColor = normalizeHexColor(markerStyleConfig?.pointColor, null);
    if (externalPointColor) {
      setPointBaseColor(externalPointColor);
    }
  }, [markerStyleConfig?.pointColor]);

  useEffect(() => {
    if (typeof onMapContainerReady !== 'function') return;
    onMapContainerReady(mapRootContainer.current);
    return () => onMapContainerReady(null);
  }, [onMapContainerReady]);

  // Add CSS for detection labels on first render
  useEffect(() => {
    const style = document.createElement('style');
    style.innerHTML = `
      .leaflet-tooltip.detection-label {
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
      .leaflet-tooltip.detection-cluster-label {
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
      .leaflet-tooltip.point-name-label {
        background: rgba(9, 17, 30, 0.86);
        color: #e6edf7;
        border: 1px solid rgba(147, 197, 253, 0.48);
        border-radius: 7px;
        padding: 2px 6px 3px;
        font-size: 10px;
        font-weight: 600;
        line-height: 1.2;
        letter-spacing: 0.01em;
        font-family: 'Avenir Next', 'Segoe UI Variable Text', 'Trebuchet MS', sans-serif;
        text-shadow: 0 1px 0 rgba(0, 0, 0, 0.3);
        box-shadow: 0 2px 8px rgba(2, 6, 23, 0.45);
        white-space: normal;
      }
      .point-name-label .point-label-stack {
        display: grid;
        gap: 2px;
        min-width: 64px;
      }
      .point-name-label .point-main-label {
        font-weight: 700;
        color: #e6edf7;
        white-space: nowrap;
      }
      .point-name-label .cad-point-name {
        font-weight: 700;
        color: #67e8f9;
        white-space: nowrap;
      }
      .point-name-label .cad-point-elevation {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        color: #fbbf24;
        font-weight: 650;
        margin-top: 0;
        padding-top: 1px;
        border-top: 1px solid rgba(148, 163, 184, 0.34);
        font-size: 0.88em;
        line-height: 1.15;
      }
      .point-name-label .cad-point-elevation-key {
        display: inline-block;
        padding: 1px 4px;
        border-radius: 999px;
        background: rgba(251, 191, 36, 0.2);
        color: #fde68a;
        font-size: 0.78em;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .point-name-label .cad-point-elevation-value {
        white-space: nowrap;
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
      .leaflet-tooltip.point-name-label.dense {
        font-size: 9px;
        padding: 1px 6px 2px;
        background: rgba(7, 13, 24, 0.9);
      }
      .point-name-label.dense .point-label-stack {
        gap: 2px;
      }
      .point-name-label.dense .cad-point-elevation {
        gap: 4px;
      }
      .leaflet-tooltip.point-cluster-label {
        background: rgba(30, 41, 59, 0.92);
        color: #f8fafc;
        border: 1px solid rgba(148, 163, 184, 0.58);
        border-radius: 999px;
        font-size: 9px;
        font-weight: 700;
        padding: 1px 7px;
        box-shadow: 0 2px 6px rgba(2, 6, 23, 0.4);
        font-family: 'Avenir Next', 'Segoe UI Variable Text', 'Trebuchet MS', sans-serif;
      }
      .point-cluster-label.leaflet-tooltip-top:before {
        border-top-color: rgba(30, 41, 59, 0.92);
      }
      .point-symbol-icon {
        background: transparent;
        border: none;
      }
      .map-export-mode .map-legend-overlay {
        display: none !important;
      }
      .map-export-mode .leaflet-tooltip.point-name-label {
        font-size: 12px;
        padding: 4px 10px 5px;
        background: rgba(9, 17, 30, 0.92);
        border-width: 1.2px;
      }
      .map-export-mode .leaflet-tooltip.point-name-label.dense {
        font-size: 11px;
        padding: 3px 8px 4px;
      }
      .map-export-mode .leaflet-tooltip.detection-label,
      .map-export-mode .leaflet-tooltip.detection-cluster-label,
      .map-export-mode .leaflet-tooltip.point-cluster-label {
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
        display: inline-flex;
        align-items: center;
        gap: 5px;
        white-space: nowrap;
        padding: 2px 6px;
        border-radius: 6px;
        background: rgba(8, 15, 28, 0.9);
        border: 1px solid rgba(148, 163, 184, 0.32);
        color: #e2e8f0;
        font-weight: 650;
        font-size: 10px;
        line-height: 1.1;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
        box-shadow: 0 2px 7px rgba(2, 6, 23, 0.38);
        transform-origin: left center;
      }
      .cad-text-label .cad-text-badge {
        display: inline-block;
        padding: 1px 4px;
        border-radius: 999px;
        background: rgba(56, 189, 248, 0.22);
        color: #bae6fd;
        letter-spacing: 0.03em;
        font-size: 0.72em;
        font-weight: 700;
      }
      .cad-text-label .cad-text-value {
        color: var(--cad-text-color, #e2e8f0);
        font-weight: 700;
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
    if (point?.color) return point.color;
    // Apply elevation-based color rules from markerStyleConfig
    if (markerStyleConfig?.elevationRules?.length > 0) {
      const h = Number(point?.height) || 0;
      const matched = markerStyleConfig.elevationRules.find((rule) => {
        const min = rule.minElev === '' || rule.minElev === null || rule.minElev === undefined ? -Infinity : Number(rule.minElev);
        const max = rule.maxElev === '' || rule.maxElev === null || rule.maxElev === undefined ? Infinity : Number(rule.maxElev);
        return h >= min && h < max;
      });
      if (matched) return matched.color;
    }
    return normalizeHexColor(pointBaseColor, getGeoidColor(point?.geoidUndulation));
  }, [getGeoidColor, markerStyleConfig, pointBaseColor]);

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

  const isGeometryInBounds = useCallback((geometry, bounds) => {
    if (!bounds) return false;
    if (geometry.start && geometry.end) {
      // Line: check if either endpoint is visible
      return bounds.contains(geometry.start) || bounds.contains(geometry.end);
    }
    if (Array.isArray(geometry.points) && geometry.points.length > 0) {
      // Polyline: check if any vertex is visible (sample for perf at very high vertex counts)
      const step = Math.max(1, Math.floor(geometry.points.length / 100));
      for (let i = 0; i < geometry.points.length; i += step) {
        const pt = geometry.points[i];
        if (Array.isArray(pt) && bounds.contains(pt)) return true;
      }
      // Also check first and last point to catch long lines
      const firstPt = geometry.points[0];
      const lastPt = geometry.points[geometry.points.length - 1];
      return (Array.isArray(firstPt) && bounds.contains(firstPt)) 
        || (Array.isArray(lastPt) && bounds.contains(lastPt));
    }
    return false;
  }, []);

  const getPointLabel = useCallback((point) => {
    const raw = String(point?.label || point?.id || 'Point');
    return raw.length > 42 ? `${raw.slice(0, 39)}...` : raw;
  }, []);

  const formatPointElevation = (value) => {
    const text = String(value || '').trim();
    if (!text) return '';
    if (/[a-zA-Z]/.test(text)) return text;
    const numeric = Number(text.replace(',', '.'));
    if (Number.isFinite(numeric)) return `${numeric.toFixed(3)} m`;
    return text;
  };

  const buildPointAltitudeMarkup = (elevationText) => {
    if (!elevationText) return '';
    return `<div class="cad-point-elevation"><span class="cad-point-elevation-key">Z</span><span class="cad-point-elevation-value">${escapeHtml(elevationText)}</span></div>`;
  };

  const getPointLabelMarkup = useCallback((point) => {
    const importedName = String(point?.importedCadName || '').trim();
    const importedElevationText = String(point?.importedCadElevationText || '').trim();
    const fallbackName = getPointLabel(point);
    const hasHeight = Number.isFinite(Number(point?.height));
    const fallbackElevation = hasHeight ? `${Number(point.height).toFixed(2)} m` : '';
    const pointName = importedName || fallbackName;
    const pointElevation = formatPointElevation(importedElevationText || fallbackElevation);

    if (point?.sourceType === 'cad-point' && (pointName || pointElevation)) {
      const nameHtml = pointName ? `<div class="cad-point-name">${escapeHtml(pointName)}</div>` : '';
      return `<div class="point-label-stack">${nameHtml}${buildPointAltitudeMarkup(pointElevation)}</div>`;
    }

    if (pointElevation) {
      return `<div class="point-label-stack"><div class="point-main-label">${escapeHtml(getPointLabel(point))}</div>${buildPointAltitudeMarkup(pointElevation)}</div>`;
    }

    return `<div class="point-label-stack"><div class="point-main-label">${escapeHtml(getPointLabel(point))}</div></div>`;
  }, [getPointLabel]);

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
    // Aggressive label reduction for very large datasets (performance optimization)
    if (totalPoints >= 15000) {
      if (zoom >= 18) return 8;
      if (zoom >= 16) return 4;
      return 2;
    }
    if (totalPoints >= 8000) {
      if (zoom >= 18) return 24;
      if (zoom >= 16) return 16;
      if (zoom >= 14) return 8;
      return 4;
    }
    if (totalPoints >= 3500) {
      if (zoom >= 18) return 32;
      if (zoom >= 16) return 20;
      if (zoom >= 14) return 12;
      return 6;
    }
    if (zoom >= 18) return Math.min(totalPoints, 52);
    if (zoom >= 17) return Math.min(totalPoints, 42);
    if (zoom >= 16) return Math.min(totalPoints, 34);
    if (zoom >= 15) return Math.min(totalPoints, 24);
    if (zoom >= 14) return Math.min(totalPoints, 16);
    if (zoom >= 13) return Math.min(totalPoints, 12);
    return Math.min(totalPoints, 8);
  };

  const getDetectionLabelBudget = (zoom, totalPoints) => {
    // Aggressive label reduction for very large datasets (performance optimization)
    if (totalPoints >= 3000) {
      if (zoom >= 18) return 24;
      if (zoom >= 16) return 16;
      if (zoom >= 14) return 8;
      return 4;
    }
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

  const createPointSymbolLayer = (lat, lng, style) => {
    if (style.symbol === 'circle') {
      return L.circleMarker([lat, lng], {
        renderer: canvasRendererRef.current || undefined,
        radius: style.size,
        fillColor: style.fillColor,
        color: style.strokeColor,
        weight: style.strokeWidth,
        opacity: 1,
        fillOpacity: style.fillOpacity,
      });
    }

    const box = Math.max(9, Math.round(style.size * 2.6));
    const stroke = Math.max(1, Math.round(style.strokeWidth));
    let symbolMarkup = '';

    if (style.symbol === 'square') {
      symbolMarkup = `<rect x="4" y="4" width="16" height="16" fill="${style.fillColor}" stroke="${style.strokeColor}" stroke-width="${stroke}" />`;
    } else if (style.symbol === 'diamond') {
      symbolMarkup = `<polygon points="12,2 22,12 12,22 2,12" fill="${style.fillColor}" stroke="${style.strokeColor}" stroke-width="${stroke}" />`;
    } else if (style.symbol === 'cross') {
      symbolMarkup = `<line x1="12" y1="3" x2="12" y2="21" stroke="${style.strokeColor}" stroke-width="${Math.max(2, stroke)}" stroke-linecap="round" /><line x1="3" y1="12" x2="21" y2="12" stroke="${style.strokeColor}" stroke-width="${Math.max(2, stroke)}" stroke-linecap="round" />`;
    } else {
      symbolMarkup = `<circle cx="12" cy="12" r="8" fill="${style.fillColor}" stroke="${style.strokeColor}" stroke-width="${stroke}" />`;
    }

    const html = `<svg width="${box}" height="${box}" viewBox="0 0 24 24" aria-hidden="true">${symbolMarkup}</svg>`;
    return L.marker([lat, lng], {
      icon: L.divIcon({
        className: 'point-symbol-icon',
        html,
        iconSize: [box, box],
        iconAnchor: [box / 2, box / 2],
      }),
      keyboard: false,
    });
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

  const handleZoomToExtent = useCallback(() => {
    if (!map.current || !dataExtentBoundsRef.current) return;
    if (typeof dataExtentBoundsRef.current.isValid === 'function' && !dataExtentBoundsRef.current.isValid()) return;
    map.current.fitBounds(dataExtentBoundsRef.current.pad(0.1));
  }, []);

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
        }),
        'IGN Plan (France)': L.tileLayer(
          'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
          '&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png' +
          '&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
          {
            attribution: '© IGN Géoplateforme',
            maxNativeZoom: 19,
            maxZoom: 23,
            crossOrigin: true,
          }
        ),
        'IGN Ortho (France)': L.tileLayer(
          'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
          '&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg' +
          '&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
          {
            attribution: '© IGN Géoplateforme',
            maxNativeZoom: 20,
            maxZoom: 23,
            crossOrigin: true,
          }
        ),
        'CartoDB Light': L.tileLayer(
          'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
          {
            attribution: '© OpenStreetMap contributors © CARTO',
            subdomains: 'abcd',
            maxNativeZoom: 20,
            maxZoom: 23,
          }
        ),
        'CartoDB Dark': L.tileLayer(
          'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
          {
            attribution: '© OpenStreetMap contributors © CARTO',
            subdomains: 'abcd',
            maxNativeZoom: 20,
            maxZoom: 23,
          }
        ),
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
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

      const hasCandidates = Array.isArray(snapCandidatesRef.current) && snapCandidatesRef.current.length > 0;

      // In measure mode: always try to snap to nearest converted point (auto-snap, no toggle needed)
      if (measureMode && hasCandidates) {
        const clickPoint = map.current.latLngToContainerPoint([lat, lng]);
        // Use snapRadiusPx when snap mode is on, otherwise use a generous 30px default
        const measureSnapPx = snapMode ? clampNumber(snapRadiusPx, 6, 24) : 30;
        const measureSnapSq = measureSnapPx * measureSnapPx;
        let bestPoint = null;
        let bestPointDistSq = Number.POSITIVE_INFINITY;

        snapCandidatesRef.current.forEach((candidate) => {
          if (candidate.type !== 'point') return;
          if (!Number.isFinite(candidate?.lat) || !Number.isFinite(candidate?.lng)) return;
          const cp = map.current.latLngToContainerPoint([candidate.lat, candidate.lng]);
          const dx = clickPoint.x - cp.x;
          const dy = clickPoint.y - cp.y;
          const distSq = (dx * dx) + (dy * dy);
          if (distSq < bestPointDistSq) {
            bestPointDistSq = distSq;
            bestPoint = candidate;
          }
        });

        if (bestPoint && bestPointDistSq <= measureSnapSq && bestPoint.pointRef) {
          setSelectedPoint(bestPoint.pointRef);
          if (onPointSelect) onPointSelect(bestPoint.pointRef);
          return;
        }
      }

      // Regular snap mode for non-measure clicks (CAD vertices, line ends, etc.)
      if (snapMode && hasCandidates) {
        const clickPoint = map.current.latLngToContainerPoint([lat, lng]);
        let best = null;
        let bestDistSq = Number.POSITIVE_INFINITY;
        const maxSnapPx = clampNumber(snapRadiusPx, 6, 24);
        const maxSnapSq = maxSnapPx * maxSnapPx;

        snapCandidatesRef.current.forEach((candidate) => {
          if (!Number.isFinite(candidate?.lat) || !Number.isFinite(candidate?.lng)) return;
          const cp = map.current.latLngToContainerPoint([candidate.lat, candidate.lng]);
          const dx = clickPoint.x - cp.x;
          const dy = clickPoint.y - cp.y;
          const distSq = (dx * dx) + (dy * dy);
          if (distSq < bestDistSq) {
            bestDistSq = distSq;
            best = candidate;
          }
        });

        if (best && bestDistSq <= maxSnapSq) {
          emit('map:click', { lat: best.lat, lon: best.lng, lng: best.lng, snapped: true, snapType: best.type || 'vertex' });
          return;
        }
      }

      emit('map:click', { lat, lon: lng, lng });
    };

    const handleBasemapChange = (e) => {
      if (e?.name) {
        localStorage.setItem(BASEMAP_STORAGE_KEY, e.name);

        if (e.name === 'IGN Plan (France)' || e.name === 'IGN Ortho (France)') {
          const currentCenter = map.current?.getCenter?.();
          const insideFrance = currentCenter ? IGN_FRANCE_BOUNDS.contains(currentCenter) : false;
          const currentZoom = map.current?.getZoom?.() ?? 2;
          if (!insideFrance || currentZoom < 5) {
            map.current.fitBounds(IGN_FRANCE_BOUNDS, { padding: [24, 24], maxZoom: 12 });
          }
        }
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
    const rawPoints = inputPoints.filter((point, idx) => {
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

    const rawCadLines = Array.isArray(cadGeometry?.lines) ? cadGeometry.lines : [];
    const rawCadPolylines = Array.isArray(cadGeometry?.polylines) ? cadGeometry.polylines : [];
    const cadTexts = Array.isArray(cadGeometry?.texts) ? cadGeometry.texts : [];

    const dedupeResult = removeDuplicates
      ? dedupeGeometryPayload({ points: rawPoints, lines: rawCadLines, polylines: rawCadPolylines })
      : {
          points: rawPoints,
          lines: rawCadLines,
          polylines: rawCadPolylines,
          stats: { pointsRemoved: 0, linesRemoved: 0, polylinesRemoved: 0, verticesRemoved: 0 },
        };

    const validPoints = dedupeResult.points;
    const cadLines = dedupeResult.lines;
    const cadPolylines = dedupeResult.polylines;

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
    if (annotationsVisible && SHOW_DETECTION_LABELS) detectionGroups.forEach((group) => {
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
    const viewportBounds = map.current.getBounds().pad(0.02);
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
      // In measure mode, all points are selectable (snap handles selection via map click)
      const isSelectableConverted = measureMode && (point.sourceType === 'converted' || point.sourceType === 'cad-point');

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
      const externalScale = Number(markerStyleConfig?.pointSizeScale) || 1.0;
      const scaledRadius = clampNumber(baseRadius * pointSizeScale * externalScale, 1, 18);
      // In measure mode: make selectable points significantly larger for easier clicking
      const markerRadius = isSelectableConverted ? Math.max(scaledRadius + 3, 7) : scaledRadius;
      const markerStroke = isSelectableConverted ? '#f97316' : '#fff';
      const markerWeight = isSelectableConverted ? 3 : 2;
      const markerFillOpacity = isSelectableConverted ? 0.95 : 0.8;

      // Check for custom uploaded icon
      const customIcon = markerStyleConfig?.customIcons?.[point.sourceType];
      let pointLayer;
      if (customIcon?.url) {
        const iconSize = Math.round(markerRadius * 2.5);
        const iconColor = normalizeHexColor(color, '#3b82f6');
        const innerIconSize = Math.max(12, Math.round(iconSize * 0.72));
        pointLayer = L.marker([displayLat, displayLng], {
          icon: L.divIcon({
            className: 'point-symbol-icon',
            html: `<div style="width:${iconSize}px;height:${iconSize}px;border-radius:999px;background:${iconColor};border:2px solid ${markerStroke};display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.35);"><img src="${escapeHtml(customIcon.url)}" alt="" style="width:${innerIconSize}px;height:${innerIconSize}px;object-fit:contain;pointer-events:none;" /></div>`,
            iconSize: [iconSize, iconSize],
            iconAnchor: [Math.round(iconSize / 2), Math.round(iconSize / 2)],
            popupAnchor: [0, -Math.round(iconSize / 2)],
          }),
          keyboard: false,
        });
      } else {
        pointLayer = createPointSymbolLayer(displayLat, displayLng, {
          symbol: pointSymbol,
          size: markerRadius,
          fillColor: color,
          strokeColor: markerStroke,
          strokeWidth: markerWeight,
          fillOpacity: markerFillOpacity,
        });
      }
      pointLayer
        .bindPopup(
          `<div style="font-size: 12px; min-width: 180px;">
            <b>${escapeHtml(getPointPopupTitle(point))}</b><br/>
            Lat: ${point.lat.toFixed(4)}°<br/>
            Lng: ${point.lng.toFixed(4)}°<br/>
            Height: ${(point.height || 0).toFixed(2)} m<br/>
            ${isSelectableConverted ? `<span style="color:#ea580c"><b>Measure:</b> Click or snap to select this point</span><br/>` : ''}
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
      if (annotationsVisible && SHOW_DETECTION_LABELS && point.detectionMarker && point.label && visibleDetectionLabelIds.has(point.id)) {
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
        const hasImportedCadLabel = Boolean(
          String(point?.importedCadName || '').trim()
          || String(point?.importedCadElevationText || '').trim()
          || String(point?.label || '').trim()
          || Number.isFinite(Number(point?.height))
        );
        const shouldShowConvertedLabel = pointId
          ? visibleConvertedLabelIds.has(pointId)
          : false;

        if (annotationsVisible && shouldShowConvertedLabel && (point.sourceType !== 'cad-point' || hasImportedCadLabel)) {
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
        if (typeof pointLayer.bringToFront === 'function') {
          pointLayer.bringToFront();
        }
      }

      pointLayersRef.current.push(pointLayer);
      markers.current.push(pointLayer);
    });

    if (annotationsVisible && SHOW_CLUSTER_COUNTERS) hiddenCountByCoordKey.forEach((hiddenCount, key) => {
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
    const currentZoom = map.current.getZoom();
    const totalCadPolylineVertices = cadPolylines.reduce((sum, poly) => {
      const pts = Array.isArray(poly?.points) ? poly.points : [];
      return sum + pts.length;
    }, 0);

    // Build snap candidates when snap mode or measure mode is active
    if (snapMode || measureMode) {
      const snapCandidates = [];
      // Always include converted points with full reference (needed for measure mode snap)
      validPoints.forEach((point) => {
        if (Number.isFinite(point?.lat) && Number.isFinite(point?.lng)) {
          // Store pointRef so measure-mode map clicks can call onPointSelect
          snapCandidates.push({ lat: point.lat, lng: point.lng, type: 'point', pointRef: point });
        }
      });
      // Add CAD geometry candidates only when snap mode toggle is on
      if (snapMode) {
        cadLines.forEach((line) => {
          const start = Array.isArray(line?.start) ? line.start : null;
          const end = Array.isArray(line?.end) ? line.end : null;
          if (start && Number.isFinite(start[0]) && Number.isFinite(start[1])) snapCandidates.push({ lat: start[0], lng: start[1], type: 'line-end' });
          if (end && Number.isFinite(end[0]) && Number.isFinite(end[1])) snapCandidates.push({ lat: end[0], lng: end[1], type: 'line-end' });
        });
        cadPolylines.forEach((polyline) => {
          (Array.isArray(polyline?.points) ? polyline.points : []).forEach((pt) => {
            if (Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) {
              snapCandidates.push({ lat: pt[0], lng: pt[1], type: 'poly-vertex' });
            }
          });
        });
      }

      const snapSeen = new Set();
      const dedupedSnapCandidates = [];
      for (let i = 0; i < snapCandidates.length; i += 1) {
        const candidate = snapCandidates[i];
        const key = toCoordKey(candidate.lat, candidate.lng, 7);
        if (snapSeen.has(key)) continue;
        snapSeen.add(key);
        dedupedSnapCandidates.push(candidate);
        if (dedupedSnapCandidates.length >= 12000) break;
      }
      snapCandidatesRef.current = dedupedSnapCandidates;
    } else {
      snapCandidatesRef.current = [];
    }

    // Render CAD lines with viewport culling (performance optimization)
    if (showLineLayer) {
      const visibleCadLines = cadLines.filter((line) => isCadLayerVisible(line) && isGeometryInBounds(line, viewportBounds));
      visibleCadLines.forEach((line) => {
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
    }

    // Render CAD polylines with viewport culling (performance optimization)
    if (showPolylineLayer) {
      const visibleCadPolylines = cadPolylines.filter((poly) => isCadLayerVisible(poly) && isGeometryInBounds(poly, viewportBounds));
      visibleCadPolylines.forEach((poly) => {
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
    }

    if (annotationsVisible && SHOW_CAD_TEXT_ANNOTATIONS) {
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
        const fontSize = Math.round(clampNumber((Number(textEntity?.textHeight) || 2.5) * 2.2, 9, 18));
        const rotation = Number.isFinite(Number(textEntity?.rotation)) ? Number(textEntity.rotation) : 0;
        const color = textEntity?.colorHex || '#0f172a';
        const fontResolution = resolveCadWebFont({
          styleName: textEntity?.styleName,
          fontFamily: textEntity?.fontFamily,
        });
        const fontFamily = escapeHtml(fontResolution.cssFamily);
        const html = `<div class="cad-text-label" style="font-family:${fontFamily};font-size:${fontSize}px;--cad-text-color:${escapeHtml(color)};transform:rotate(${rotation}deg);"><span class="cad-text-badge">TXT</span><span class="cad-text-value">${escapeHtml(textEntity?.text || '')}</span></div>`;
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
      dataExtentBoundsRef.current = group.getBounds();
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
      dataExtentBoundsRef.current = null;
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
  }, [points, cadGeometry, isVisible, onPointSelect, onMapMetricsChange, onMapInstanceReady, getMarkerColor, getPointLabelMarkup, isCadLayerVisible, isGeometryInBounds, measureMode, measurePoints, selectedPoint, showPointLayer, showLineLayer, showPolylineLayer, showLabels, effectiveShowLabels, annotationsVisible, hiddenCadLayers, pointSymbol, pointSizeScale, removeDuplicates, snapMode, snapRadiusPx, markerStyleConfig]);

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
                  onClick={handleZoomToExtent}
                  style={{
                    border: '1px solid rgba(148,163,184,0.55)',
                    background: 'rgba(15,23,42,0.65)',
                    color: '#e2e8f0',
                    borderRadius: '999px',
                    fontSize: '9px',
                    padding: '2px 7px',
                    cursor: 'pointer'
                  }}
                >
                  Zoom Extent
                </button>
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
                    background: annotationsVisible ? 'rgba(56,189,248,0.75)' : 'rgba(15,23,42,0.65)',
                    color: '#e2e8f0',
                    borderRadius: '999px',
                    fontSize: '9px',
                    padding: '2px 7px',
                    cursor: 'pointer'
                  }}
                >
                  Names + Altitude
                </button>
                <button
                  onClick={() => setRemoveDuplicates((v) => !v)}
                  style={{
                    border: '1px solid rgba(148,163,184,0.55)',
                    background: removeDuplicates ? 'rgba(34,197,94,0.72)' : 'rgba(15,23,42,0.65)',
                    color: '#e2e8f0',
                    borderRadius: '999px',
                    fontSize: '9px',
                    padding: '2px 7px',
                    cursor: 'pointer'
                  }}
                >
                  Duplicate Remover
                </button>
                <button
                  onClick={() => setSnapMode((v) => !v)}
                  style={{
                    border: '1px solid rgba(148,163,184,0.55)',
                    background: snapMode ? 'rgba(59,130,246,0.75)' : 'rgba(15,23,42,0.65)',
                    color: '#e2e8f0',
                    borderRadius: '999px',
                    fontSize: '9px',
                    padding: '2px 7px',
                    cursor: 'pointer'
                  }}
                >
                  Snap Mode
                </button>
              </div>
              {removeDuplicates && (
                <div style={{ marginBottom: '8px', fontSize: '9px', color: '#a7f3d0', lineHeight: 1.35 }}>
                  Removed: P {dedupePreviewStats.pointsRemoved} · L {dedupePreviewStats.linesRemoved} · PL {dedupePreviewStats.polylinesRemoved} · V {dedupePreviewStats.verticesRemoved}
                </div>
              )}
              {snapMode && (
                <div style={{ marginBottom: '8px', display: 'grid', gap: '3px', fontSize: '9px', color: '#bfdbfe' }}>
                  <div>Snap Radius ({snapRadiusPx}px)</div>
                  <input
                    type="range"
                    min="6"
                    max="24"
                    step="1"
                    value={snapRadiusPx}
                    onChange={(e) => setSnapRadiusPx(Number(e.target.value))}
                  />
                </div>
              )}
              <div style={{ display: 'grid', gap: '6px', marginBottom: '9px' }}>
                <label style={{ display: 'grid', gap: '3px', fontSize: '9px', color: '#cbd5e1' }}>
                  Point Symbol
                  <select
                    value={pointSymbol}
                    onChange={(e) => setPointSymbol(e.target.value)}
                    style={{
                      border: '1px solid rgba(148,163,184,0.45)',
                      background: 'rgba(15,23,42,0.65)',
                      color: '#e2e8f0',
                      borderRadius: '7px',
                      fontSize: '10px',
                      padding: '3px 6px'
                    }}
                  >
                    <option value="circle">Circle</option>
                    <option value="square">Square</option>
                    <option value="diamond">Diamond</option>
                    <option value="cross">Cross</option>
                  </select>
                </label>
                <label style={{ display: 'grid', gap: '3px', fontSize: '9px', color: '#cbd5e1' }}>
                  Point Size ({pointSizeScale.toFixed(2)}x)
                  <input
                    type="range"
                    min="0.4"
                    max="2.4"
                    step="0.1"
                    value={pointSizeScale}
                    onChange={(e) => setPointSizeScale(Number(e.target.value))}
                  />
                </label>
                <label style={{ display: 'grid', gap: '3px', fontSize: '9px', color: '#cbd5e1' }}>
                  Point Color
                  <div style={{ display: 'grid', gridTemplateColumns: '34px 1fr', gap: '6px', alignItems: 'center' }}>
                    <input
                      type="color"
                      value={normalizeHexColor(pointBaseColor)}
                      onChange={(e) => setPointBaseColor(normalizeHexColor(e.target.value))}
                      style={{ width: '34px', height: '24px', padding: 0, border: '1px solid rgba(148,163,184,0.45)', borderRadius: '6px', background: 'rgba(15,23,42,0.65)' }}
                    />
                    <input
                      type="text"
                      value={normalizeHexColor(pointBaseColor)}
                      onChange={(e) => setPointBaseColor(normalizeHexColor(e.target.value, pointBaseColor))}
                      style={{ border: '1px solid rgba(148,163,184,0.45)', background: 'rgba(15,23,42,0.65)', color: '#e2e8f0', borderRadius: '7px', fontSize: '10px', padding: '3px 6px' }}
                    />
                  </div>
                </label>
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
