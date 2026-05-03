import { useEffect, useRef, useMemo } from 'react';
import * as THREE from 'three';

/**
 * CadSurface3DViewer
 * Three.js 3D viewer for CAD surfaces (3DFACE / TIN triangles).
 * Supports orbit (left-drag), pan (right-drag), and zoom (scroll).
 */
const CadSurface3DViewer = ({ surfaces = [] }) => {
  const containerRef = useRef(null);

  // Flatten all triangles from all surfaces
  const allTriangles = useMemo(() => {
    const tris = [];
    surfaces.forEach((surface) => {
      if (!Array.isArray(surface?.triangles)) return;
      surface.triangles.forEach((tri) => {
        if (tri?.v1 && tri?.v2 && tri?.v3) tris.push(tri);
      });
    });
    return tris;
  }, [surfaces]);

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

  useEffect(() => {
    const el = containerRef.current;
    if (!el || allTriangles.length === 0) return;

    const W = el.clientWidth || 800;
    const H = 520;

    // ── Scene ──────────────────────────────────────────────────────────────
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0f172a');

    // Subtle grid on Z=minZ plane
    const gridHelper = new THREE.GridHelper(1, 10, '#1e293b', '#1e293b');
    scene.add(gridHelper); // positioned after bounds are known

    // ── Camera ─────────────────────────────────────────────────────────────
    const camera = new THREE.PerspectiveCamera(45, W / H, 1e-3, 1e7);

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

    allTriangles.forEach(({ v1, v2, v3 }) => {
      [v1, v2, v3].forEach((v) => {
        positions.push(Number(v.x) || 0, Number(v.y) || 0, Number(v.z) || 0);
        const c = getColor(Number(v.z));
        colors.push(c.r, c.g, c.b);
      });
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);

    // Wireframe overlay (thin, low opacity)
    const wireMat = new THREE.LineBasicMaterial({ color: '#1e293b', transparent: true, opacity: 0.25 });
    const wireGeo = new THREE.WireframeGeometry(geo);
    const wire = new THREE.LineSegments(wireGeo, wireMat);
    scene.add(wire);

    // ── Fit camera ─────────────────────────────────────────────────────────
    geo.computeBoundingBox();
    const box = geo.boundingBox;
    const center = new THREE.Vector3();
    box.getCenter(center);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;

    // Position grid at the min Z level
    gridHelper.scale.setScalar(maxDim);
    gridHelper.position.set(center.x, minZ, center.y); // GridHelper is in XZ by default

    const orbitState = {
      theta: -Math.PI / 6,
      phi: Math.PI / 3.5,
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
        target.x + radius * Math.sin(phi) * Math.sin(theta),
        target.y + radius * Math.cos(phi),
        target.z + radius * Math.sin(phi) * Math.cos(theta),
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
        orbitState.theta -= dx * 0.006;
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
    };
    const onWheel = (e) => {
      e.preventDefault();
      orbitState.radius *= 1 + e.deltaY * 0.001;
      orbitState.radius = Math.max(maxDim * 0.005, Math.min(maxDim * 20, orbitState.radius));
      updateCamera();
    };

    const dom = renderer.domElement;
    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointerup', onUp);
    dom.addEventListener('pointermove', onMove);
    dom.addEventListener('wheel', onWheel, { passive: false });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());

    // ── Render loop ────────────────────────────────────────────────────────
    let animId;
    const animate = () => {
      animId = requestAnimationFrame(animate);
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
  }, [allTriangles, minZ, maxZ]);

  if (allTriangles.length === 0) {
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
    <div style={{ position: 'relative', userSelect: 'none' }}>
      <div
        ref={containerRef}
        style={{ width: '100%', height: 520, borderRadius: 8, overflow: 'hidden', cursor: 'grab' }}
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
          {allTriangles.length.toLocaleString()} triangles
        </div>
        <div style={{ color: '#475569', fontSize: '0.68rem', marginTop: '0.2rem', lineHeight: 1.4 }}>
          Drag: orbit<br />
          Right-drag: pan<br />
          Scroll: zoom
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
