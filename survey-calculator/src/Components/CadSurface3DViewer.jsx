import { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import * as THREE from 'three';

const EARTH_RADIUS_M = 6378137;
const CAD_API_BASE_URL = import.meta.env.VITE_CAD_API_BASE_URL || '/api/cad';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const WEB_MERCATOR_MAX_LAT = 85.05112878;

const deriveImageryApiBaseUrl = (cadApiBaseUrl) => {
  const base = String(cadApiBaseUrl || '').trim();
  if (!base) return '/api/imagery';
  if (base.endsWith('/api/cad')) return `${base.slice(0, -'/api/cad'.length)}/api/imagery`;
  if (base.endsWith('/api/cad/')) return `${base.slice(0, -'/api/cad/'.length)}/api/imagery`;
  return '/api/imagery';
};

const IMAGERY_API_BASE_URL = import.meta.env.VITE_IMAGERY_API_BASE_URL || deriveImageryApiBaseUrl(CAD_API_BASE_URL);

const latLngToWebMercator = (lat, lng) => {
  const safeLat = clamp(Number(lat) || 0, -WEB_MERCATOR_MAX_LAT, WEB_MERCATOR_MAX_LAT);
  const safeLng = clamp(Number(lng) || 0, -180, 180);
  const x = (safeLng * 20037508.34) / 180;
  const y = Math.log(Math.tan(((90 + safeLat) * Math.PI) / 360)) / (Math.PI / 180);
  return {
    x,
    y: (y * 20037508.34) / 180,
  };
};

const buildEsriWorldImageryExportUrls = ({ minLat, maxLat, minLng, maxLng }, size = 1024) => {
  if (![minLat, maxLat, minLng, maxLng].every(Number.isFinite)) return [];
  const px = clamp(Math.round(size), 256, 2048);

  const proxyParams = new URLSearchParams({
    minLat: String(minLat),
    maxLat: String(maxLat),
    minLng: String(minLng),
    maxLng: String(maxLng),
    size: String(px),
  });
  const proxyUrl = `${IMAGERY_API_BASE_URL}/esri-export?${proxyParams.toString()}`;

  const sw = latLngToWebMercator(minLat, minLng);
  const ne = latLngToWebMercator(maxLat, maxLng);
  const directParams = new URLSearchParams({
    bbox: `${sw.x},${sw.y},${ne.x},${ne.y}`,
    bboxSR: '3857',
    imageSR: '3857',
    size: `${px},${px}`,
    format: 'jpg',
    f: 'image',
  });
  const directUrl = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?${directParams.toString()}`;

  return [proxyUrl, directUrl];
};

const getViewAngles = (preset) => {
  if (preset === 'top') return { theta: 0, phi: 0.12 };
  if (preset === 'side') return { theta: Math.PI / 2, phi: Math.PI / 2.2 };
  return { theta: -Math.PI / 6, phi: Math.PI / 3.5 };
};

const computeBoundsFromTriangles = (triangles) => {
  if (!Array.isArray(triangles) || triangles.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  triangles.forEach(({ v1, v2, v3 }) => {
    [v1, v2, v3].forEach((v) => {
      if (!v) return;
      if (v.x < minX) minX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.z < minZ) minZ = v.z;
      if (v.x > maxX) maxX = v.x;
      if (v.y > maxY) maxY = v.y;
      if (v.z > maxZ) maxZ = v.z;
    });
  });

  if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) return null;
  return new THREE.Box3(
    new THREE.Vector3(minX, minY, minZ),
    new THREE.Vector3(maxX, maxY, maxZ)
  );
};

const normalizeVertex = (vertex) => {
  if (Array.isArray(vertex) && vertex.length >= 3) {
    const x = Number(vertex[0]);
    const y = Number(vertex[1]);
    const z = Number(vertex[2]);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      return { x, y, z };
    }
    return null;
  }

  const x = Number(vertex?.x);
  const y = Number(vertex?.y);
  const z = Number(vertex?.z);
  if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
    return { x, y, z };
  }
  return null;
};

const normalizeTriangle = (tri, vertices) => {
  // Common CAD/TIN format: triangle is [i0, i1, i2] over a vertices array.
  if (Array.isArray(tri) && tri.length === 3 && tri.every(Number.isInteger)) {
    const v1 = normalizeVertex(vertices?.[tri[0]]);
    const v2 = normalizeVertex(vertices?.[tri[1]]);
    const v3 = normalizeVertex(vertices?.[tri[2]]);
    if (v1 && v2 && v3) return { v1, v2, v3 };
  }

  // Alternate object style triangles.
  const v1 = normalizeVertex(tri?.v1 || tri?.a || tri?.p1);
  const v2 = normalizeVertex(tri?.v2 || tri?.b || tri?.p2);
  const v3 = normalizeVertex(tri?.v3 || tri?.c || tri?.p3);
  if (v1 && v2 && v3) return { v1, v2, v3 };

  return null;
};

// Helper: Calculate triangle area (Heron's formula)
const calculateTriangleArea = (v1, v2, v3) => {
  const dx1 = v2.x - v1.x, dy1 = v2.y - v1.y, dz1 = v2.z - v1.z;
  const dx2 = v3.x - v1.x, dy2 = v3.y - v1.y, dz2 = v3.z - v1.z;
  const cx = dy1 * dz2 - dz1 * dy2;
  const cy = dz1 * dx2 - dx1 * dz2;
  const cz = dx1 * dy2 - dy1 * dx2;
  return Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
};

const calculatePolylineLength = (points) => {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += points[i - 1].distanceTo(points[i]);
  }
  return total;
};

const snapIntersectionToSurface = (intersection, geometry) => {
  const fallback = intersection?.point?.clone?.() || null;
  if (!intersection || !geometry) return fallback;

  const pos = geometry.getAttribute('position');
  const face = intersection.face;
  if (!pos || !face) return fallback;

  const vA = new THREE.Vector3().fromBufferAttribute(pos, face.a);
  const vB = new THREE.Vector3().fromBufferAttribute(pos, face.b);
  const vC = new THREE.Vector3().fromBufferAttribute(pos, face.c);
  const hit = intersection.point;

  const candidates = [vA, vB, vC];
  let snapped = candidates[0];
  let bestDist = hit.distanceToSquared(candidates[0]);
  for (let i = 1; i < candidates.length; i += 1) {
    const d = hit.distanceToSquared(candidates[i]);
    if (d < bestDist) {
      bestDist = d;
      snapped = candidates[i];
    }
  }
  return snapped.clone();
};

const projectTrianglesForStats = (surfaces, minZ, maxZ) => {
  if (!Array.isArray(surfaces) || surfaces.length === 0) return [];

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  surfaces.forEach((surface) => {
    surface.triangles.forEach(({ v1, v2, v3 }) => {
      [v1, v2, v3].forEach((v) => {
        if (v.x < minLat) minLat = v.x;
        if (v.x > maxLat) maxLat = v.x;
        if (v.y < minLng) minLng = v.y;
        if (v.y > maxLng) maxLng = v.y;
      });
    });
  });

  if (!Number.isFinite(minLat) || !Number.isFinite(minLng)) return [];

  const degToRad = Math.PI / 180;
  const centerLat = (minLat + maxLat) / 2;
  const centerLng = (minLng + maxLng) / 2;
  const cosLat = Math.max(0.01, Math.cos(centerLat * degToRad));
  const centerZ = (minZ + maxZ) / 2;

  const projectVertex = (v) => ({
    x: (v.y - centerLng) * degToRad * EARTH_RADIUS_M * cosLat,
    y: (v.x - centerLat) * degToRad * EARTH_RADIUS_M,
    z: Number(v.z) - centerZ,
  });

  return surfaces.flatMap((surface) => surface.triangles.map(({ v1, v2, v3 }) => ({
    v1: projectVertex(v1),
    v2: projectVertex(v2),
    v3: projectVertex(v3),
  })));
};

// Helper: Calculate bounding box
const calculateBoundingBox = (triangles) => {
  if (!Array.isArray(triangles) || triangles.length === 0) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  triangles.forEach(({ v1, v2, v3 }) => {
    [v1, v2, v3].forEach((v) => {
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
      minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
      minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
    });
  });
  return { minX, maxX, minY, maxY, minZ, maxZ };
};

// Helper: Export screenshot
const exportScreenshot = (canvas) => {
  if (canvas) {
    try {
      const link = document.createElement('a');
      link.href = canvas.toDataURL('image/png');
      link.download = `3d-surface-${Date.now()}.png`;
      link.click();
    } catch (error) {
      console.warn('Screenshot export blocked (likely cross-origin imagery texture restriction).', error);
    }
  }
};

// Helper: Export CSV elevation profile
const exportCSV = (triangles) => {
  if (triangles.length === 0) return;
  const rows = [['X', 'Y', 'Z']];
  const vertexSet = new Set();
  triangles.forEach(({ v1, v2, v3 }) => {
    [v1, v2, v3].forEach((v) => {
      const key = `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;
      if (!vertexSet.has(key)) {
        vertexSet.add(key);
        rows.push([v.x.toFixed(4), v.y.toFixed(4), v.z.toFixed(4)]);
      }
    });
  });
  const csv = rows.map((r) => r.join(',')).join('\n');
  const link = document.createElement('a');
  link.href = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
  link.download = `surface-points-${Date.now()}.csv`;
  link.click();
};

// Helper: Generate contour lines by slicing raw elevation and drawing in transformed coordinates.
const generateContours = (triangles, minZ, maxZ, interval) => {
  const contours = [];
  const eps = 1e-6;

  const pushUniquePoint = (arr, point) => {
    const exists = arr.some((p) => Math.abs(p.x - point.x) < 1e-6 && Math.abs(p.y - point.y) < 1e-6 && Math.abs(p.z - point.z) < 1e-6);
    if (!exists) arr.push(point);
  };

  const intersectEdgeAtLevel = (va, vb, zLevel) => {
    const za = Number.isFinite(va.rawZ) ? va.rawZ : va.z;
    const zb = Number.isFinite(vb.rawZ) ? vb.rawZ : vb.z;
    const da = za - zLevel;
    const db = zb - zLevel;

    // Entire edge is coplanar with contour level: skip to avoid duplicates.
    if (Math.abs(da) < eps && Math.abs(db) < eps) return null;

    // Contour passes exactly through one endpoint.
    if (Math.abs(da) < eps) return { x: va.x, y: va.y, z: va.z + 0.02 };
    if (Math.abs(db) < eps) return { x: vb.x, y: vb.y, z: vb.z + 0.02 };

    // Standard crossing.
    if (da * db < 0) {
      const t = (zLevel - za) / (zb - za);
      return {
        x: va.x + t * (vb.x - va.x),
        y: va.y + t * (vb.y - va.y),
        z: va.z + t * (vb.z - va.z) + 0.02,
      };
    }

    return null;
  };

  for (let z = Math.ceil(minZ / interval) * interval; z <= maxZ + eps; z += interval) {
    const lines = [];
    const zLevel = z;
    triangles.forEach(({ v1, v2, v3 }) => {
      const vertices = [v1, v2, v3];
      const crossings = [];

      for (let i = 0; i < 3; i += 1) {
        const va = vertices[i];
        const vb = vertices[(i + 1) % 3];
        const point = intersectEdgeAtLevel(va, vb, zLevel);
        if (point) pushUniquePoint(crossings, point);
      }

      if (crossings.length >= 2) {
        lines.push([crossings[0], crossings[1]]);
      }
    });

    if (lines.length > 0) contours.push({ z: zLevel, lines });
  }

  return contours;
};

/**
 * CadSurface3DViewer
 * Three.js 3D viewer for CAD surfaces (3DFACE / TIN triangles).
 * Supports orbit (left-drag), pan (right-drag), and zoom (scroll).
 */
const CadSurface3DViewer = ({ surfaces = [] }) => {
  const containerRef = useRef(null);
  const wrapperRef = useRef(null);
  const [zScalePreset, setZScalePreset] = useState('auto');
  const [viewPreset, setViewPreset] = useState('iso');
  const [renderStyle, setRenderStyle] = useState('smooth');
  const [cameraResetToken, setCameraResetToken] = useState(0);
  const [selectedFitLayerKey, setSelectedFitLayerKey] = useState('__all__');
  const [fitLayerKey, setFitLayerKey] = useState('__all__');
  const [isFullscreen, setIsFullscreen] = useState(false);
  
  // Feature states
  const [meshOpacity, setMeshOpacity] = useState(1.0);
  const [showStats, setShowStats] = useState(false);
  const [showContours, setShowContours] = useState(false);
  const [contourInterval, setContourInterval] = useState(10);
  const [measurementMode, setMeasurementMode] = useState(false);
  const [measurementPoints, setMeasurementPoints] = useState([]);
  const [showLightingPanel, setShowLightingPanel] = useState(false);
  const [showSurfacePanel, setShowSurfacePanel] = useState(false);
  const [showExportPanel, setShowExportPanel] = useState(false);
  const [showImagery, setShowImagery] = useState(true);
  const [imageryProvider, setImageryProvider] = useState('esri');
  const [imageryLoadState, setImageryLoadState] = useState('idle');
  const [imageryLoadMessage, setImageryLoadMessage] = useState('');
  const [lightAzimuth, setLightAzimuth] = useState(45);
  const [lightElevation, setLightElevation] = useState(45);
  const [lightIntensity, setLightIntensity] = useState(0.8);

  const [visibleSurfaces, setVisibleSurfaces] = useState({});

  useEffect(() => {
    if (showImagery && meshOpacity >= 0.99) {
      setMeshOpacity(0.8);
    }
  }, [showImagery, meshOpacity]);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      wrapperRef.current?.requestFullscreen().catch((err) => {
        console.warn('Fullscreen request failed:', err);
      });
    } else {
      document.exitFullscreen();
    }
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => {
      const entering = document.fullscreenElement === wrapperRef.current;
      setIsFullscreen(entering);
      // Trigger a camera/canvas re-setup after the element resizes
      setCameraResetToken((v) => v + 1);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);


  const normalizedSurfaces = useMemo(() => {
    const next = [];
    surfaces.forEach((surface, surfaceIndex) => {
      if (!Array.isArray(surface?.triangles)) return;
      const vertices = Array.isArray(surface?.vertices) ? surface.vertices : [];
      const triangles = [];
      surface.triangles.forEach((tri) => {
        const normalized = normalizeTriangle(tri, vertices);
        if (normalized) triangles.push(normalized);
      });
      if (triangles.length === 0) return;
      const layerLabel = String(surface?.layerStandardized || surface?.layerNormalized || surface?.layer || `Surface ${surfaceIndex + 1}`);
      next.push({
        layerKey: `${layerLabel}::${surfaceIndex}`,
        layerLabel,
        triangles,
      });
    });
    return next;
  }, [surfaces]);

  const allTriangles = useMemo(() => normalizedSurfaces.flatMap((surface) => surface.triangles), [normalizedSurfaces]);

  const { minZ, maxZ } = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    allTriangles.forEach(({ v1, v2, v3 }) => {
      [v1, v2, v3].forEach((v) => {
        const z = Number(v.z);
        if (Number.isFinite(z)) {
          if (z < min) min = z;
          if (z > max) max = z;
        }
      });
    });
    if (!Number.isFinite(min)) min = 0;
    if (!Number.isFinite(max)) max = 1;
    if (min === max) { min -= 1; max += 1; }
    return { minZ: min, maxZ: max };
  }, [allTriangles]);

  const { transformedSurfaces, transformedTriangles, zExaggeration, autoExaggeration, fitLayerOptions, projectionMeta } = useMemo(() => {
    if (allTriangles.length === 0) {
      return {
        transformedSurfaces: [],
        transformedTriangles: [],
        zExaggeration: 1,
        autoExaggeration: 1,
        fitLayerOptions: [],
        projectionMeta: null,
      };
    }

    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;

    allTriangles.forEach(({ v1, v2, v3 }) => {
      [v1, v2, v3].forEach((v) => {
        if (v.x < minLat) minLat = v.x;
        if (v.x > maxLat) maxLat = v.x;
        if (v.y < minLng) minLng = v.y;
        if (v.y > maxLng) maxLng = v.y;
      });
    });

    const centerLat = (minLat + maxLat) / 2;
    const centerLng = (minLng + maxLng) / 2;
    const centerZ = (minZ + maxZ) / 2;

    const degToRad = Math.PI / 180;
    const cosLat = Math.max(0.01, Math.cos(centerLat * degToRad));

    const lonSpanM = (maxLng - minLng) * degToRad * EARTH_RADIUS_M * cosLat;
    const latSpanM = (maxLat - minLat) * degToRad * EARTH_RADIUS_M;
    const xySpan = Math.max(1, lonSpanM, latSpanM);
    const zSpan = Math.max(0.1, maxZ - minZ);
    const computedAutoExaggeration = clamp((xySpan / zSpan) * 0.08, 1, 120);
    const selectedExaggeration = zScalePreset === 'auto'
      ? computedAutoExaggeration
      : clamp(Number(zScalePreset) || 1, 0.1, 200);

    const projectVertex = (v) => {
      const x = (v.y - centerLng) * degToRad * EARTH_RADIUS_M * cosLat;
      const y = (v.x - centerLat) * degToRad * EARTH_RADIUS_M;
      const rawZ = Number(v.z) || 0;
      const z = (rawZ - centerZ) * selectedExaggeration;
      return { x, y, z, rawZ };
    };

    const nextSurfaces = normalizedSurfaces.map((surface) => ({
      layerKey: surface.layerKey,
      layerLabel: surface.layerLabel,
      triangles: surface.triangles.map(({ v1, v2, v3 }) => ({
        v1: projectVertex(v1),
        v2: projectVertex(v2),
        v3: projectVertex(v3),
      })),
    }));

    return {
      transformedSurfaces: nextSurfaces,
      transformedTriangles: nextSurfaces.flatMap((surface) => surface.triangles),
      zExaggeration: selectedExaggeration,
      autoExaggeration: computedAutoExaggeration,
      projectionMeta: {
        centerLat,
        centerLng,
        minLat,
        maxLat,
        minLng,
        maxLng,
        lonSpanM,
        latSpanM,
      },
      fitLayerOptions: nextSurfaces.map((surface) => ({
        layerKey: surface.layerKey,
        layerLabel: surface.layerLabel,
        triangleCount: surface.triangles.length,
      })),
    };
  }, [allTriangles, minZ, maxZ, zScalePreset, normalizedSurfaces]);

  const imageryConfig = useMemo(() => {
    if (!showImagery || imageryProvider !== 'esri' || !projectionMeta) return null;
    const imageryUrls = buildEsriWorldImageryExportUrls(
      {
        minLat: projectionMeta.minLat,
        maxLat: projectionMeta.maxLat,
        minLng: projectionMeta.minLng,
        maxLng: projectionMeta.maxLng,
      },
      1024
    ).filter(Boolean);
    if (imageryUrls.length === 0) return null;
    return {
      key: 'esri',
      label: 'Esri World Imagery',
      attribution: 'Imagery © Esri',
      urls: imageryUrls,
      widthMeters: Math.max(1, projectionMeta.lonSpanM) * 1.35,
      heightMeters: Math.max(1, projectionMeta.latSpanM) * 1.35,
    };
  }, [showImagery, imageryProvider, projectionMeta]);

  // Calculate surface statistics using projected coordinates in meters.
  const statistics = useMemo(() => {
    const projectedTriangles = projectTrianglesForStats(normalizedSurfaces, minZ, maxZ);
    const stats = {};

    let triangleCursor = 0;
    normalizedSurfaces.forEach((surface) => {
      const surfaceTriangles = projectedTriangles.slice(triangleCursor, triangleCursor + surface.triangles.length);
      triangleCursor += surface.triangles.length;

      let area = 0;
      surfaceTriangles.forEach(({ v1, v2, v3 }) => {
        area += calculateTriangleArea(v1, v2, v3);
      });

      const bbox = calculateBoundingBox(surfaceTriangles);
      if (bbox) {
        const cx = (bbox.minX + bbox.maxX) / 2;
        const cy = (bbox.minY + bbox.maxY) / 2;
        const cz = (bbox.minZ + bbox.maxZ) / 2;
        stats[surface.layerKey] = {
          area: area.toFixed(2),
          triangles: surface.triangles.length,
          bbox,
          centroid: { x: cx.toFixed(2), y: cy.toFixed(2), z: cz.toFixed(2) },
        };
      }
    });

    return stats;
  }, [normalizedSurfaces, minZ, maxZ]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || transformedTriangles.length === 0) return;
    let isDisposed = false;

    const W = el.clientWidth || 800;
    const H = isFullscreen ? (el.clientHeight || window.innerHeight || 520) : 520;

    // ── Scene ──────────────────────────────────────────────────────────────
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0f172a');

    // Subtle grid on Z=minZ plane
    const gridHelper = new THREE.GridHelper(1, 10, '#1e293b', '#1e293b');
    scene.add(gridHelper); // positioned after bounds are known

    // ── Camera ─────────────────────────────────────────────────────────────
    const camera = new THREE.PerspectiveCamera(45, W / H, 1e-3, 1e7);
    camera.up.set(0, 0, 1);

    // ── Renderer ───────────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);

    // ── Lights ─────────────────────────────────────────────────────────────
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, lightIntensity);
    const azRad = (lightAzimuth * Math.PI) / 180;
    const elRad = (lightElevation * Math.PI) / 180;
    sun.position.set(
      Math.cos(azRad) * Math.cos(elRad),
      Math.sin(azRad) * Math.cos(elRad),
      Math.sin(elRad)
    );
    scene.add(sun);

    // ── Build mesh ─────────────────────────────────────────────────────────
    const zRange = maxZ - minZ;
    const getColor = (z) => {
      const t = Number.isFinite(z) ? Math.max(0, Math.min(1, (z - minZ) / zRange)) : 0;
      const c = new THREE.Color();
      // Blue (low) → Cyan → Green → Yellow → Red (high)
      c.setHSL(0.66 - t * 0.66, 1.0, 0.45);
      return c;
    };

    const positions = [];
    const colors = [];
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    transformedTriangles.forEach(({ v1, v2, v3 }) => {
      [v1, v2, v3].forEach((v) => {
        const px = Number(v.x) || 0;
        const py = Number(v.y) || 0;
        const pz = Number(v.z) || 0;
        positions.push(px, py, pz);
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        const c = getColor(Number(v.rawZ));
        colors.push(c.r, c.g, c.b);
      });
    });

    const uvs = [];
    const spanX = Math.max(1e-6, maxX - minX);
    const spanY = Math.max(1e-6, maxY - minY);
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i];
      const y = positions[i + 1];
      uvs.push((x - minX) / spanX, 1 - ((y - minY) / spanY));
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.computeVertexNormals();

    const drapeImageryEnabled = Boolean(imageryConfig);
    // Always start with vertex colors so failed imagery fetch never leaves the mesh flat grey.
    const mat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: meshOpacity,
      color: 0xffffff,
    });
    const mesh = new THREE.Mesh(geo, mat);
    if (renderStyle !== 'wire') scene.add(mesh);

    // Wireframe overlay — always available when style is 'mesh' or 'wire'; for 'smooth' skip it
    const wireOpacity = renderStyle === 'wire' ? 0.85 : 0.28;
    const wireColor = renderStyle === 'wire' ? '#94a3b8' : '#1e293b';
    const wireMat = new THREE.LineBasicMaterial({ color: wireColor, transparent: true, opacity: wireOpacity });
    const wireGeo = renderStyle !== 'smooth' ? new THREE.WireframeGeometry(geo) : new THREE.BufferGeometry();
    const wire = new THREE.LineSegments(wireGeo, wireMat);
    if (renderStyle !== 'smooth') scene.add(wire);

    // Add contour lines if enabled
    if (showContours && contourInterval > 0) {
      const contours = generateContours(transformedTriangles, minZ, maxZ, contourInterval);
      contours.forEach(({ lines }) => {
        lines.forEach(([p1, p2]) => {
          const cGeo = new THREE.BufferGeometry();
          cGeo.setAttribute('position', new THREE.Float32BufferAttribute([
            p1.x, p1.y, p1.z, p2.x, p2.y, p2.z,
          ], 3));
          const cMat = new THREE.LineBasicMaterial({ color: '#e2e8f0', transparent: true, opacity: 0.9, depthTest: false });
          const line = new THREE.Line(cGeo, cMat);
          scene.add(line);
        });
      });
    }

    // ── Fit camera ─────────────────────────────────────────────────────────
    geo.computeBoundingBox();
    const box = geo.boundingBox;
    const focusTriangles = fitLayerKey === '__all__'
      ? transformedTriangles
      : (transformedSurfaces.find((surface) => surface.layerKey === fitLayerKey)?.triangles || transformedTriangles);
    const focusBox = computeBoundsFromTriangles(focusTriangles) || box;
    const center = new THREE.Vector3();
    focusBox.getCenter(center);
    const size = new THREE.Vector3();
    focusBox.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;

    let needsRender = true;
    let imageryTexture = null;
    if (drapeImageryEnabled) {
      if (!isDisposed) {
        setImageryLoadState('loading');
        setImageryLoadMessage('Loading imagery…');
      }

      const imageryLoader = new THREE.TextureLoader();
      imageryLoader.setCrossOrigin('anonymous');

      const tryLoadImagery = (index) => {
        const sourceUrl = Array.isArray(imageryConfig?.urls) ? imageryConfig.urls[index] : null;
        if (!sourceUrl) {
          mat.vertexColors = true;
          mat.map = null;
          mat.needsUpdate = true;
          needsRender = true;
          if (!isDisposed) {
            setImageryLoadState('failed');
            setImageryLoadMessage('Imagery unavailable (proxy/direct failed)');
          }
          return;
        }

        imageryLoader.load(
          sourceUrl,
          (texture) => {
            if (isDisposed) {
              texture.dispose();
              return;
            }
            imageryTexture = texture;
            imageryTexture.colorSpace = THREE.SRGBColorSpace;
            imageryTexture.wrapS = THREE.ClampToEdgeWrapping;
            imageryTexture.wrapT = THREE.ClampToEdgeWrapping;
            const anisotropy = renderer?.capabilities?.getMaxAnisotropy?.() || 1;
            imageryTexture.anisotropy = Math.max(1, Math.min(8, anisotropy));
            mat.vertexColors = false;
            mat.map = imageryTexture;
            mat.needsUpdate = true;
            needsRender = true;
            if (!isDisposed) {
              setImageryLoadState('loaded');
              setImageryLoadMessage(index === 0 ? 'Loaded via proxy' : 'Loaded via direct source');
            }
          },
          undefined,
          (error) => {
            console.warn(`3D imagery source failed (${index + 1}).`, error);
            tryLoadImagery(index + 1);
          }
        );
      };

      tryLoadImagery(0);
    } else if (!isDisposed) {
      setImageryLoadState('idle');
      setImageryLoadMessage('');
    }

    const overlayObjects = [];
    if (measurementPoints.length > 0) {
      const markerRadius = Math.max(maxDim * 0.006, 0.15);
      const markerGeo = new THREE.SphereGeometry(markerRadius, 12, 12);
      const fromMat = new THREE.MeshBasicMaterial({ color: '#22c55e' });
      const toMat = new THREE.MeshBasicMaterial({ color: '#ef4444' });

      measurementPoints.forEach((point, index) => {
        const marker = new THREE.Mesh(markerGeo, index === 0 ? fromMat : toMat);
        marker.position.copy(point);
        scene.add(marker);
        overlayObjects.push(marker);
      });

      if (measurementPoints.length >= 2) {
        const lineGeo = new THREE.BufferGeometry().setFromPoints(measurementPoints);
        const lineMat = new THREE.LineBasicMaterial({ color: '#f59e0b', transparent: true, opacity: 1, depthTest: false });
        const line = new THREE.Line(lineGeo, lineMat);
        scene.add(line);
        overlayObjects.push({ geometry: lineGeo, material: lineMat });
      }

      overlayObjects.push({ geometry: markerGeo, material: fromMat });
      overlayObjects.push({ material: toMat });
    }

    // Position grid at the min Z level
    gridHelper.rotation.x = Math.PI / 2; // Put grid on XY plane for Z-up scenes
    gridHelper.scale.setScalar(Math.max(size.x, size.y, 1));
    gridHelper.position.set(center.x, center.y, focusBox.min.z);

    const initialAngles = getViewAngles(viewPreset);
    const orbitState = {
      theta: initialAngles.theta,
      phi: initialAngles.phi,
      radius: maxDim * 2.2,
      target: center.clone(),
      isDown: false,
      button: 0,
      lastX: 0,
      lastY: 0,
    };

    const updateCamera = () => {
      const { theta, phi, radius, target } = orbitState;
      camera.position.set(
        target.x + radius * Math.sin(phi) * Math.cos(theta),
        target.y + radius * Math.sin(phi) * Math.sin(theta),
        target.z + radius * Math.cos(phi),
      );
      camera.lookAt(target);
    };
    updateCamera();

    // ── Pointer events ─────────────────────────────────────────────────────
    const onDown = (e) => {
      if (measurementMode && e.button === 0) {
        // Measurement mode: capture click position
        const rect = renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1
        );
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObject(mesh);
        if (intersects.length > 0) {
          const point = snapIntersectionToSurface(intersects[0], geo) || intersects[0].point.clone();
          setMeasurementPoints((prev) => {
            const next = [...prev, point];
            if (next.length > 64) next.shift();
            return next;
          });
        }
        needsRender = true;
        return;
      }
      orbitState.isDown = true;
      orbitState.lastX = e.clientX;
      orbitState.lastY = e.clientY;
      orbitState.button = e.button;
      renderer.domElement.setPointerCapture(e.pointerId);
      needsRender = true;
    };
    const onUp = () => { orbitState.isDown = false; };
    const onMove = (e) => {
      if (!orbitState.isDown) return;
      const dx = e.clientX - orbitState.lastX;
      const dy = e.clientY - orbitState.lastY;
      orbitState.lastX = e.clientX;
      orbitState.lastY = e.clientY;

      if (orbitState.button === 0) {
        // Orbit
        orbitState.theta += dx * 0.006;
        orbitState.phi = Math.max(0.05, Math.min(Math.PI - 0.05, orbitState.phi - dy * 0.006));
      } else if (orbitState.button === 2) {
        // Pan
        const camDir = new THREE.Vector3();
        camera.getWorldDirection(camDir);
        const right = new THREE.Vector3().crossVectors(camDir, camera.up).normalize();
        const up = camera.up.clone().normalize();
        const speed = orbitState.radius * 0.0012;
        orbitState.target.addScaledVector(right, -dx * speed);
        orbitState.target.addScaledVector(up, dy * speed);
      }
      updateCamera();
      needsRender = true;
    };
    const onWheel = (e) => {
      e.preventDefault();
      // Normalize across deltaMode (0=pixel, 1=line≈30px, 2=page≈600px) and clamp to avoid runaway jumps
      const pixelDelta = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaMode === 2 ? e.deltaY * 600 : e.deltaY;
      const clamped = Math.max(-200, Math.min(200, pixelDelta));
      orbitState.radius *= Math.pow(1.001, clamped);
      orbitState.radius = Math.max(maxDim * 0.005, Math.min(maxDim * 50, orbitState.radius));
      updateCamera();
      needsRender = true;
    };

    const dom = renderer.domElement;
    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointerup', onUp);
    dom.addEventListener('pointermove', onMove);
    dom.addEventListener('wheel', onWheel, { passive: false });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());

    // ── Render loop (on-demand) ────────────────────────────────────────────
    let animId;
    const animate = () => {
      animId = requestAnimationFrame(animate);
      if (!needsRender) return;
      needsRender = false;
      renderer.render(scene, camera);
    };
    animate();

    // ── Resize observer ────────────────────────────────────────────────────
    const obs = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w > 0) {
        renderer.setSize(w, H);
        camera.aspect = w / H;
        camera.updateProjectionMatrix();
        needsRender = true;
      }
    });
    obs.observe(el);

    return () => {
      cancelAnimationFrame(animId);
      obs.disconnect();
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointerup', onUp);
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('wheel', onWheel);
      geo.dispose();
      mat.dispose();
      wireGeo.dispose();
      wireMat.dispose();
      overlayObjects.forEach((object) => {
        object?.geometry?.dispose?.();
        object?.material?.dispose?.();
      });
      isDisposed = true;
      imageryTexture?.dispose?.();
      renderer.dispose();
      if (el.contains(dom)) el.removeChild(dom);
    };
  }, [transformedTriangles, transformedSurfaces, fitLayerKey, minZ, maxZ, viewPreset, renderStyle, cameraResetToken, isFullscreen, meshOpacity, showContours, contourInterval, lightAzimuth, lightElevation, lightIntensity, measurementMode, measurementPoints, visibleSurfaces, imageryConfig]);

  if (transformedTriangles.length === 0) {
    return (
      <div style={{
        height: 520, display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', background: '#0f172a', borderRadius: 8,
        color: '#64748b', fontSize: '0.9rem', gap: '0.5rem',
      }}>
        <span style={{ fontSize: '2rem' }}>🏔</span>
        <span>No 3D surface data available.</span>
        <span style={{ fontSize: '0.78rem', color: '#475569' }}>Load a DWG/DXF file containing 3DFACE entities.</span>
      </div>
    );
  }

  return (
    <div
      ref={wrapperRef}
      style={{
        position: 'relative',
        userSelect: 'none',
        background: '#0f172a',
        ...(isFullscreen ? { width: '100vw', height: '100vh' } : {}),
      }}
    >
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: isFullscreen ? '100vh' : 520,
          borderRadius: isFullscreen ? 0 : 8,
          overflow: 'hidden',
          cursor: 'grab',
        }}
      />

      {/* Elevation legend */}
      <div style={{
        position: 'absolute', bottom: 14, right: 14,
        background: 'rgba(15,23,42,0.88)', borderRadius: 8, padding: '0.6rem 0.85rem',
        color: '#f1f5f9', fontSize: '0.76rem', border: '1px solid #334155',
        backdropFilter: 'blur(4px)',
      }}>
        <div style={{ fontWeight: 700, marginBottom: '0.4rem', fontSize: '0.78rem' }}>Elevation (m)</div>
        {/* Gradient bar with color indicators */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.3rem' }}>
          {/* Gradient bar */}
          <div style={{
            width: 14, height: 80, borderRadius: 4,
            background: 'linear-gradient(to bottom, #ef4444, #eab308, #22c55e, #06b6d4, #3b82f6)',
            flexShrink: 0,
          }} />
          {/* Value labels with color swatches */}
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height: 80 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <div style={{
                width: 8, height: 8, borderRadius: 2, background: '#ef4444',
              }} />
              <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{maxZ.toFixed(1)}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <div style={{
                width: 8, height: 8, borderRadius: 2, background: '#3b82f6',
              }} />
              <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{minZ.toFixed(1)}</span>
            </div>
          </div>
        </div>
        <div style={{ marginTop: '0.5rem', color: '#64748b', fontSize: '0.71rem', borderTop: '1px solid #1e293b', paddingTop: '0.4rem' }}>
          {transformedTriangles.length.toLocaleString()} triangles
        </div>
        <div style={{ color: '#64748b', fontSize: '0.71rem' }}>
          Vertical scale x{zExaggeration.toFixed(1)}
          {zScalePreset !== 'auto' ? ` (Auto x${autoExaggeration.toFixed(1)})` : ''}
        </div>
        <div style={{ color: '#475569', fontSize: '0.68rem', marginTop: '0.2rem', lineHeight: 1.4 }}>
          Drag: orbit<br />
          Right-drag: pan<br />
          Scroll: zoom
        </div>
      </div>

      {/* 3D controls */}
      <div style={{
        position: 'absolute', top: 12, right: 12,
        background: 'rgba(15,23,42,0.82)', borderRadius: 8, padding: '0.45rem',
        color: '#e2e8f0', fontSize: '0.74rem', border: '1px solid #1e293b',
        display: 'grid', gap: '0.35rem', minWidth: 210,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.4rem' }}>
          <div style={{ fontWeight: 700, color: '#cbd5e1' }}>3D Controls</div>
          <button
            type="button"
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Enter fullscreen'}
            style={{
              background: 'rgba(15,23,42,0.82)',
              border: '1px solid #334155',
              borderRadius: 6,
              color: '#94a3b8',
              cursor: 'pointer',
              padding: '0.18rem 0.45rem',
              fontSize: '0.72rem',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: '0.28rem',
              lineHeight: 1,
            }}
          >
            {isFullscreen
              ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v3a2 2 0 01-2 2H3"/><path d="M21 8h-3a2 2 0 01-2-2V3"/><path d="M3 16h3a2 2 0 012 2v3"/><path d="M16 21v-3a2 2 0 012-2h3"/></svg>
              : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 00-2 2v3"/><path d="M21 8V5a2 2 0 00-2-2h-3"/><path d="M3 16v3a2 2 0 002 2h3"/><path d="M16 21h3a2 2 0 002-2v-3"/></svg>
            }
            {isFullscreen ? 'Exit' : 'Full'}
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexWrap: 'wrap' }}>
          <span style={{ color: '#94a3b8' }}>Style</span>
          {[{ key: 'smooth', label: 'Smooth' }, { key: 'mesh', label: 'Mesh' }, { key: 'wire', label: 'Wire' }].map((style) => (
            <button
              key={`style-${style.key}`}
              type="button"
              onClick={() => setRenderStyle(style.key)}
              style={{
                padding: '0.16rem 0.45rem', borderRadius: 999, fontSize: '0.68rem', fontWeight: 700,
                border: renderStyle === style.key ? '1px solid #f59e0b' : '1px solid #334155',
                background: renderStyle === style.key ? '#78350f' : '#0f172a',
                color: renderStyle === style.key ? '#fde68a' : '#94a3b8',
                cursor: 'pointer',
              }}
            >
              {style.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexWrap: 'wrap' }}>
          <span style={{ color: '#94a3b8' }}>Z scale</span>
          {['auto', '1', '2', '5', '10'].map((value) => (
            <button
              key={`z-${value}`}
              type="button"
              onClick={() => setZScalePreset(value)}
              style={{
                padding: '0.16rem 0.4rem', borderRadius: 999, fontSize: '0.68rem', fontWeight: 700,
                border: zScalePreset === value ? '1px solid #60a5fa' : '1px solid #334155',
                background: zScalePreset === value ? '#1d4ed8' : '#0f172a',
                color: zScalePreset === value ? '#dbeafe' : '#94a3b8',
                cursor: 'pointer',
              }}
            >
              {value === 'auto' ? 'Auto' : `x${value}`}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexWrap: 'wrap' }}>
          <span style={{ color: '#94a3b8' }}>Imagery</span>
          <button
            type="button"
            onClick={() => setShowImagery((value) => !value)}
            style={{
              padding: '0.16rem 0.45rem', borderRadius: 999, fontSize: '0.68rem', fontWeight: 700,
              border: showImagery ? '1px solid #22c55e' : '1px solid #334155',
              background: showImagery ? '#14532d' : '#0f172a',
              color: showImagery ? '#dcfce7' : '#94a3b8',
              cursor: 'pointer',
            }}
          >
            {showImagery ? 'On' : 'Off'}
          </button>
          <select
            value={imageryProvider}
            onChange={(e) => setImageryProvider(e.target.value)}
            disabled={!showImagery}
            style={{
              minWidth: 108,
              background: showImagery ? '#0f172a' : '#111827',
              color: showImagery ? '#cbd5e1' : '#64748b',
              border: '1px solid #334155',
              borderRadius: 6,
              padding: '0.16rem 0.3rem',
              fontSize: '0.68rem',
            }}
          >
            <option value="esri">Esri imagery</option>
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexWrap: 'wrap' }}>
          <span style={{ color: '#94a3b8' }}>View</span>
          {[{ key: 'iso', label: 'Iso' }, { key: 'top', label: 'Top' }, { key: 'side', label: 'Side' }].map((view) => (
            <button
              key={`view-${view.key}`}
              type="button"
              onClick={() => setViewPreset(view.key)}
              style={{
                padding: '0.16rem 0.45rem', borderRadius: 999, fontSize: '0.68rem', fontWeight: 700,
                border: viewPreset === view.key ? '1px solid #34d399' : '1px solid #334155',
                background: viewPreset === view.key ? '#047857' : '#0f172a',
                color: viewPreset === view.key ? '#d1fae5' : '#94a3b8',
                cursor: 'pointer',
              }}
            >
              {view.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setCameraResetToken((v) => v + 1)}
            style={{
              marginLeft: '0.2rem', padding: '0.16rem 0.5rem', borderRadius: 999,
              fontSize: '0.68rem', fontWeight: 700, border: '1px solid #334155',
              background: '#1e293b', color: '#e2e8f0', cursor: 'pointer',
            }}
          >
            Reset
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
          <span style={{ color: '#94a3b8' }}>Fit</span>
          <select
            value={selectedFitLayerKey}
            onChange={(e) => setSelectedFitLayerKey(e.target.value)}
            style={{
              flex: 1,
              minWidth: 0,
              background: '#0f172a',
              color: '#cbd5e1',
              border: '1px solid #334155',
              borderRadius: 6,
              padding: '0.2rem 0.3rem',
              fontSize: '0.68rem',
            }}
          >
            <option value="__all__">All surfaces</option>
            {fitLayerOptions.map((layer) => (
              <option key={layer.layerKey} value={layer.layerKey}>
                {layer.layerLabel} ({layer.triangleCount})
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              setFitLayerKey(selectedFitLayerKey);
              setCameraResetToken((v) => v + 1);
            }}
            style={{
              padding: '0.16rem 0.5rem',
              borderRadius: 999,
              fontSize: '0.68rem',
              fontWeight: 700,
              border: '1px solid #334155',
              background: '#1e293b',
              color: '#e2e8f0',
              cursor: 'pointer',
            }}
          >
            Apply
          </button>
          <button
            type="button"
            onClick={() => {
              setSelectedFitLayerKey('__all__');
              setFitLayerKey('__all__');
              setCameraResetToken((v) => v + 1);
            }}
            style={{
              padding: '0.16rem 0.5rem',
              borderRadius: 999,
              fontSize: '0.68rem',
              fontWeight: 700,
              border: '1px solid #334155',
              background: '#0b3b2e',
              color: '#d1fae5',
              cursor: 'pointer',
            }}
            title="Fit camera to all currently visible surfaces"
          >
            Fit Visible
          </button>
        </div>
      </div>

      {imageryConfig && (
        <div style={{
          position: 'absolute', bottom: 12, left: 12,
          background: 'rgba(15,23,42,0.82)', borderRadius: 6, padding: '0.28rem 0.55rem',
          color: '#94a3b8', fontSize: '0.7rem', border: '1px solid #1e293b',
          display: 'grid', gap: '0.2rem',
        }}>
          <div>{imageryConfig.attribution}</div>
          <div style={{
            color: imageryLoadState === 'loaded' ? '#34d399' : imageryLoadState === 'failed' ? '#fda4af' : '#93c5fd',
            fontSize: '0.66rem',
          }}>
            Imagery: {imageryLoadMessage || imageryLoadState}
          </div>
        </div>
      )}

      {/* Feature Panels - Left side */}
      <div style={{ position: 'absolute', top: '50%', left: 14, transform: 'translateY(-50%)', display: 'flex', flexDirection: 'column', gap: '0.45rem', maxHeight: 'calc(100% - 120px)', overflowY: 'auto', paddingRight: 4, width: 140 }}>
        
        {/* Mesh Opacity Control */}
        <div style={{
          background: 'rgba(15,23,42,0.88)', borderRadius: 8, padding: '0.6rem 0.85rem',
          color: '#f1f5f9', fontSize: '0.76rem', border: '1px solid #334155',
          backdropFilter: 'blur(4px)', minWidth: 140, width: '100%',
        }}>
          <div style={{ fontWeight: 700, marginBottom: '0.4rem', fontSize: '0.78rem' }}>Opacity</div>
          <input
            type="range"
            min="0" max="100" step="5" value={meshOpacity * 100}
            onChange={(e) => setMeshOpacity(Number(e.target.value) / 100)}
            style={{ width: '100%', cursor: 'pointer' }}
          />
          <div style={{ marginTop: '0.3rem', color: '#94a3b8', fontSize: '0.71rem' }}>
            {(meshOpacity * 100).toFixed(0)}%
          </div>
        </div>

        {/* Lighting Controls */}
        <div style={{
          background: 'rgba(15,23,42,0.88)', borderRadius: 8, padding: '0.6rem 0.85rem',
          color: '#f1f5f9', fontSize: '0.76rem', border: '1px solid #334155',
          backdropFilter: 'blur(4px)', minWidth: 140, width: '100%',
        }}>
          <button
            type="button"
            onClick={() => setShowLightingPanel((value) => !value)}
            style={{ width: '100%', padding: '0.22rem', borderRadius: 6, fontSize: '0.72rem', fontWeight: 700, border: '1px solid #334155', background: showLightingPanel ? '#1d4ed8' : '#0f172a', color: showLightingPanel ? '#dbeafe' : '#e2e8f0', cursor: 'pointer' }}
          >
            {showLightingPanel ? 'Lighting ▼' : 'Lighting ▶'}
          </button>
          {showLightingPanel && (
            <div style={{ marginTop: '0.4rem' }}>
              <div style={{ marginBottom: '0.4rem' }}>
                <div style={{ fontSize: '0.68rem', color: '#94a3b8', marginBottom: '0.15rem' }}>Azimuth: {lightAzimuth}°</div>
                <input type="range" min="0" max="360" step="15" value={lightAzimuth} onChange={(e) => setLightAzimuth(Number(e.target.value))} style={{ width: '100%', cursor: 'pointer' }} />
              </div>
              <div style={{ marginBottom: '0.4rem' }}>
                <div style={{ fontSize: '0.68rem', color: '#94a3b8', marginBottom: '0.15rem' }}>Elevation: {lightElevation}°</div>
                <input type="range" min="0" max="90" step="10" value={lightElevation} onChange={(e) => setLightElevation(Number(e.target.value))} style={{ width: '100%', cursor: 'pointer' }} />
              </div>
              <div>
                <div style={{ fontSize: '0.68rem', color: '#94a3b8', marginBottom: '0.15rem' }}>Intensity</div>
                <input type="range" min="0" max="200" step="10" value={lightIntensity * 100} onChange={(e) => setLightIntensity(Number(e.target.value) / 100)} style={{ width: '100%', cursor: 'pointer' }} />
              </div>
            </div>
          )}
        </div>

        {/* Contour Settings */}
        <div style={{
          background: 'rgba(15,23,42,0.88)', borderRadius: 8, padding: '0.6rem 0.85rem',
          color: '#f1f5f9', fontSize: '0.76rem', border: '1px solid #334155',
          backdropFilter: 'blur(4px)', minWidth: 140, width: '100%',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.4rem' }}>
            <input type="checkbox" checked={showContours} onChange={(e) => setShowContours(e.target.checked)} />
            <span style={{ fontWeight: 700, fontSize: '0.78rem' }}>Contour Lines</span>
          </div>
          {showContours && (
            <div>
              <div style={{ fontSize: '0.71rem', color: '#94a3b8', marginBottom: '0.2rem' }}>Interval (m): {contourInterval}</div>
              <input type="range" min="1" max="50" step="1" value={contourInterval} onChange={(e) => setContourInterval(Number(e.target.value))} style={{ width: '100%', cursor: 'pointer' }} />
            </div>
          )}
        </div>

        {/* Surface Visibility */}
        {normalizedSurfaces.length > 1 && (
          <div style={{
            background: 'rgba(15,23,42,0.88)', borderRadius: 8, padding: '0.6rem 0.85rem',
            color: '#f1f5f9', fontSize: '0.76rem', border: '1px solid #334155',
            backdropFilter: 'blur(4px)', minWidth: 140, width: '100%', maxHeight: 150, overflowY: 'auto',
          }}>
            <button
              type="button"
              onClick={() => setShowSurfacePanel((value) => !value)}
              style={{ width: '100%', padding: '0.22rem', borderRadius: 6, fontSize: '0.72rem', fontWeight: 700, border: '1px solid #334155', background: showSurfacePanel ? '#1d4ed8' : '#0f172a', color: showSurfacePanel ? '#dbeafe' : '#e2e8f0', cursor: 'pointer' }}
            >
              {showSurfacePanel ? 'Surfaces ▼' : 'Surfaces ▶'}
            </button>
            {showSurfacePanel && (
              <div style={{ marginTop: '0.35rem' }}>
                {normalizedSurfaces.map((surface) => (
                  <div key={surface.layerKey} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', marginBottom: '0.3rem' }}>
                    <input
                      type="checkbox"
                      checked={visibleSurfaces[surface.layerKey] !== false}
                      onChange={(e) => setVisibleSurfaces((prev) => ({ ...prev, [surface.layerKey]: e.target.checked }))}
                    />
                    <span style={{ fontSize: '0.68rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {surface.layerLabel}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Measurement Tool */}
        <div style={{
          background: 'rgba(15,23,42,0.88)', borderRadius: 8, padding: '0.6rem 0.85rem',
          color: '#f1f5f9', fontSize: '0.76rem', border: '1px solid #334155',
          backdropFilter: 'blur(4px)', minWidth: 140, width: '100%',
        }}>
          <button
            type="button"
            onClick={() => {
              setMeasurementMode(!measurementMode);
              if (!measurementMode) setMeasurementPoints([]);
            }}
            style={{
              width: '100%', padding: '0.3rem', borderRadius: 6, fontSize: '0.75rem', fontWeight: 700,
              border: measurementMode ? '1px solid #f59e0b' : '1px solid #334155',
              background: measurementMode ? '#78350f' : '#0f172a',
              color: measurementMode ? '#fde68a' : '#e2e8f0',
              cursor: 'pointer',
              marginBottom: '0.3rem',
            }}
          >
            {measurementMode ? 'Measuring...' : 'Measure'}
          </button>
          {measurementPoints.length > 0 && (
            <div style={{ fontSize: '0.71rem', color: '#64748b' }}>
              {measurementPoints[0] && <div>Start: {measurementPoints[0].x.toFixed(2)}, {measurementPoints[0].y.toFixed(2)}, {measurementPoints[0].z.toFixed(2)}</div>}
              {measurementPoints.length > 1 && <div>End: {measurementPoints[measurementPoints.length - 1].x.toFixed(2)}, {measurementPoints[measurementPoints.length - 1].y.toFixed(2)}, {measurementPoints[measurementPoints.length - 1].z.toFixed(2)}</div>}
              {measurementPoints.length > 1 && (
                <div style={{ marginTop: '0.2rem', color: '#22c55e' }}>
                  Total ({measurementPoints.length - 1} seg): {calculatePolylineLength(measurementPoints).toFixed(2)} m
                </div>
              )}
            </div>
          )}
          {measurementPoints.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.3rem', marginTop: '0.3rem' }}>
              <button
                type="button"
                onClick={() => setMeasurementPoints((prev) => prev.slice(0, -1))}
                style={{
                  padding: '0.2rem', borderRadius: 4, fontSize: '0.68rem',
                  border: '1px solid #334155', background: '#0f172a', color: '#94a3b8', cursor: 'pointer',
                }}
                title="Remove last picked point"
              >
                Undo
              </button>
              <button
                type="button"
                onClick={() => setMeasurementPoints([])}
                style={{
                  padding: '0.2rem', borderRadius: 4, fontSize: '0.68rem',
                  border: '1px solid #334155', background: '#0f172a', color: '#94a3b8', cursor: 'pointer',
                }}
              >
                Clear
              </button>
            </div>
          )}
        </div>

        {/* Statistics Panel */}
        <div style={{
          background: 'rgba(15,23,42,0.88)', borderRadius: 8, padding: '0.6rem 0.85rem',
          color: '#f1f5f9', fontSize: '0.76rem', border: '1px solid #334155',
          backdropFilter: 'blur(4px)', minWidth: 140, width: '100%',
        }}>
          <button
            type="button"
            onClick={() => setShowStats(!showStats)}
            style={{
              width: '100%', padding: '0.3rem', borderRadius: 6, fontSize: '0.75rem', fontWeight: 700,
              border: showStats ? '1px solid #60a5fa' : '1px solid #334155',
              background: showStats ? '#1d4ed8' : '#0f172a',
              color: showStats ? '#dbeafe' : '#e2e8f0',
              cursor: 'pointer',
              marginBottom: showStats ? '0.4rem' : 0,
            }}
          >
            {showStats ? 'Statistics ▼' : 'Statistics ▶'}
          </button>
          {showStats && (
            <div style={{ fontSize: '0.71rem', color: '#cbd5e1', maxHeight: 200, overflowY: 'auto' }}>
              {Object.entries(statistics).map(([key, stats]) => (
                <div key={key} style={{ marginTop: '0.3rem', paddingTop: '0.3rem', borderTop: '1px solid #334155' }}>
                  <div style={{ fontWeight: 600, color: '#e2e8f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {key.split('::')[0]}
                  </div>
                  <div style={{ fontSize: '0.68rem', color: '#94a3b8' }}>Area: {stats.area} m²</div>
                  <div style={{ fontSize: '0.68rem', color: '#94a3b8' }}>Triangles: {stats.triangles}</div>
                  <div style={{ fontSize: '0.68rem', color: '#94a3b8' }}>Centroid: ({stats.centroid.x}, {stats.centroid.y}, {stats.centroid.z})</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Export Panel */}
        <div style={{
          background: 'rgba(15,23,42,0.88)', borderRadius: 8, padding: '0.6rem 0.85rem',
          color: '#f1f5f9', fontSize: '0.76rem', border: '1px solid #334155',
          backdropFilter: 'blur(4px)', minWidth: 160,
        }}>
          <button
            type="button"
            onClick={() => setShowExportPanel((value) => !value)}
            style={{ width: '100%', padding: '0.22rem', borderRadius: 6, fontSize: '0.72rem', fontWeight: 700, border: '1px solid #334155', background: showExportPanel ? '#1d4ed8' : '#0f172a', color: showExportPanel ? '#dbeafe' : '#e2e8f0', cursor: 'pointer' }}
          >
            {showExportPanel ? 'Export ▼' : 'Export ▶'}
          </button>
          {showExportPanel && (
            <div style={{ display: 'grid', gap: '0.3rem', marginTop: '0.35rem' }}>
              <button
                type="button"
                onClick={() => exportScreenshot(containerRef.current?.querySelector('canvas'))}
                style={{
                  width: '100%', padding: '0.22rem', borderRadius: 4, fontSize: '0.66rem', fontWeight: 600,
                  border: '1px solid #334155', background: '#0f172a', color: '#cbd5e1', cursor: 'pointer',
                }}
              >
                Screenshot
              </button>
              <button
                type="button"
                onClick={() => exportCSV(transformedTriangles)}
                style={{
                  width: '100%', padding: '0.22rem', borderRadius: 4, fontSize: '0.66rem', fontWeight: 600,
                  border: '1px solid #334155', background: '#0f172a', color: '#cbd5e1', cursor: 'pointer',
                }}
              >
                CSV Points
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Surface count badge */}
      <div style={{
        position: 'absolute', top: 12, left: 12,
        background: 'rgba(15,23,42,0.82)', borderRadius: 6, padding: '0.3rem 0.6rem',
        color: '#94a3b8', fontSize: '0.73rem', border: '1px solid #1e293b',
      }}>
        {surfaces.length} surface{surfaces.length !== 1 ? 's' : ''} · 3D view
      </div>
    </div>
  );
};

export default CadSurface3DViewer;
