import { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import * as THREE from 'three';

const EARTH_RADIUS_M = 6378137;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

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

  const { transformedSurfaces, transformedTriangles, zExaggeration, autoExaggeration, fitLayerOptions } = useMemo(() => {
    if (allTriangles.length === 0) {
      return {
        transformedSurfaces: [],
        transformedTriangles: [],
        zExaggeration: 1,
        autoExaggeration: 1,
        fitLayerOptions: [],
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
      fitLayerOptions: nextSurfaces.map((surface) => ({
        layerKey: surface.layerKey,
        layerLabel: surface.layerLabel,
        triangleCount: surface.triangles.length,
      })),
    };
  }, [allTriangles, minZ, maxZ, zScalePreset, normalizedSurfaces]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || transformedTriangles.length === 0) return;

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
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);

    // ── Lights ─────────────────────────────────────────────────────────────
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(1, 2, 3);
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

    transformedTriangles.forEach(({ v1, v2, v3 }) => {
      [v1, v2, v3].forEach((v) => {
        positions.push(Number(v.x) || 0, Number(v.y) || 0, Number(v.z) || 0);
        const c = getColor(Number(v.rawZ));
        colors.push(c.r, c.g, c.b);
      });
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    if (renderStyle !== 'wire') scene.add(mesh);

    // Wireframe overlay — always available when style is 'mesh' or 'wire'; for 'smooth' skip it
    const wireOpacity = renderStyle === 'wire' ? 0.85 : 0.28;
    const wireColor = renderStyle === 'wire' ? '#94a3b8' : '#1e293b';
    const wireMat = new THREE.LineBasicMaterial({ color: wireColor, transparent: true, opacity: wireOpacity });
    const wireGeo = renderStyle !== 'smooth' ? new THREE.WireframeGeometry(geo) : new THREE.BufferGeometry();
    const wire = new THREE.LineSegments(wireGeo, wireMat);
    if (renderStyle !== 'smooth') scene.add(wire);

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
      sun.position.copy(camera.position).normalize();
    };
    updateCamera();

    // ── Pointer events ─────────────────────────────────────────────────────
    const onDown = (e) => {
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
    let needsRender = true;
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
      renderer.dispose();
      if (el.contains(dom)) el.removeChild(dom);
    };
  }, [transformedTriangles, transformedSurfaces, fitLayerKey, minZ, maxZ, viewPreset, renderStyle, cameraResetToken, isFullscreen]);

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
        {/* Gradient bar */}
        <div style={{
          width: 14, height: 80, borderRadius: 4, marginBottom: '0.3rem',
          background: 'linear-gradient(to bottom, #ef4444, #eab308, #22c55e, #06b6d4, #3b82f6)',
        }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
          <span style={{ color: '#ef4444', fontWeight: 600 }}>{maxZ.toFixed(1)}</span>
          <span style={{ color: '#3b82f6', fontWeight: 600 }}>{minZ.toFixed(1)}</span>
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
        <div style={{ fontWeight: 700, color: '#cbd5e1' }}>3D Controls</div>
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

      {/* Fullscreen toggle */}
      <button
        type="button"
        onClick={toggleFullscreen}
        title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Enter fullscreen'}
        style={{
          position: 'absolute', top: 12, left: isFullscreen ? 12 : undefined,
          right: isFullscreen ? undefined : 228,
          background: 'rgba(15,23,42,0.82)',
          border: '1px solid #334155',
          borderRadius: 6,
          color: '#94a3b8',
          cursor: 'pointer',
          padding: '0.28rem 0.5rem',
          fontSize: '0.78rem',
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          gap: '0.3rem',
          zIndex: 10,
        }}
      >
        {isFullscreen
          ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v3a2 2 0 01-2 2H3"/><path d="M21 8h-3a2 2 0 01-2-2V3"/><path d="M3 16h3a2 2 0 012 2v3"/><path d="M16 21v-3a2 2 0 012-2h3"/></svg>
          : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 00-2 2v3"/><path d="M21 8V5a2 2 0 00-2-2h-3"/><path d="M3 16v3a2 2 0 002 2h3"/><path d="M16 21h3a2 2 0 002-2v-3"/></svg>
        }
        {isFullscreen ? 'Exit' : 'Full'}
      </button>

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
