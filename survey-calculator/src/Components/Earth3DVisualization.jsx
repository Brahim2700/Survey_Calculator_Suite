import { useEffect, useMemo, useRef, useCallback } from 'react';
import * as THREE from 'three';

/**
 * Earth3DVisualization - Three.js 3D Earth
 */
const Earth3DVisualization = ({ points = [], isVisible = true }) => {
  const containerRef = useRef();
  const sceneRef = useRef();
  const cameraRef = useRef();
  const rendererRef = useRef();
  const sphereRef = useRef();
  const pointsGroupRef = useRef();

  const colorCache = useMemo(() => ({
    gray: new THREE.Color('#999999'),
    blue: new THREE.Color('#0000ff'),
    cyan: new THREE.Color('#00ffff'),
    green: new THREE.Color('#00ff00'),
    yellow: new THREE.Color('#ffff00'),
    red: new THREE.Color('#ff0000')
  }), []);

  const getPointColor = useCallback((undulation) => {
    if (undulation === undefined || undulation === null || Number.isNaN(undulation)) {
      return colorCache.gray;
    }
    if (undulation < -10) return colorCache.blue;
    if (undulation < -2) return colorCache.cyan;
    if (undulation >= -2 && undulation <= 2) return colorCache.green;
    if (undulation > 2 && undulation <= 10) return colorCache.yellow;
    return colorCache.red;
  }, [colorCache]);

  // Prepare points data
  const pointsData = useMemo(() => {
    if (!points || points.length === 0) return [];
    
    return points.map(point => {
      const undulation = point.geoidUndulation ?? point.N ?? point.ondulation ?? 0;
      const lat = point.lat !== undefined ? point.lat : point.latitude;
      const lng = point.lng !== undefined ? point.lng : point.longitude;
      
      return {
        lat,
        lng,
        undulation,
        label: point.label || point.id || `Point`,
        color: getPointColor(undulation)
      };
    });
  }, [points, getPointColor]);

  // Initialize Three.js scene
  useEffect(() => {
    if (!containerRef.current || !isVisible) return;

    const container = containerRef.current;
    const width = container.clientWidth;
    const height = 350;

    // Scene
    const scene = new THREE.Scene();
    sceneRef.current = scene;
    scene.background = new THREE.Color('#000011');

    // Camera
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
    camera.position.z = 2.5;
    cameraRef.current = camera;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    rendererRef.current = renderer;
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    // Create procedural Earth texture
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d');
    
    // Ocean base
    ctx.fillStyle = '#1a5f7a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Add gradient for depth
    const oceanGrad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    oceanGrad.addColorStop(0, '#2a7fa8');
    oceanGrad.addColorStop(0.5, '#1a5f7a');
    oceanGrad.addColorStop(1, '#0d3d52');
    ctx.fillStyle = oceanGrad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Land masses
    ctx.fillStyle = '#2d8659';
    
    // North America
    ctx.beginPath();
    ctx.ellipse(250, 350, 90, 100, -0.3, 0, Math.PI * 2);
    ctx.fill();
    
    // South America
    ctx.beginPath();
    ctx.ellipse(350, 450, 50, 80, 0.2, 0, Math.PI * 2);
    ctx.fill();
    
    // Europe & Africa
    ctx.beginPath();
    ctx.ellipse(800, 350, 150, 130, 0, 0, Math.PI * 2);
    ctx.fill();
    
    // Asia
    ctx.beginPath();
    ctx.ellipse(1100, 300, 200, 120, 0, 0, Math.PI * 2);
    ctx.fill();
    
    // Australia
    ctx.beginPath();
    ctx.ellipse(1350, 500, 60, 70, 0, 0, Math.PI * 2);
    ctx.fill();
    
    const procTexture = new THREE.CanvasTexture(canvas);
    procTexture.colorSpace = THREE.SRGBColorSpace;
    
    if (sphereRef.current && sphereRef.current.material) {
      sphereRef.current.material.map = procTexture;
      sphereRef.current.material.needsUpdate = true;
      console.log('Procedural Earth texture applied on init');
    }
    
    // Try CDN texture as enhancement (real satellite imagery)
    const textureLoader = new THREE.TextureLoader();
    
    // Try multiple CDN sources in order
    const textureSources = [
      'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets/earth_atmos_2048.jpg',
      'https://unpkg.com/three-globe@2.31.0/example/img/earth-blue-marble.jpg',
      'https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg'
    ];
    
    let textureAttempt = 0;
    const tryNextTexture = () => {
      if (textureAttempt >= textureSources.length) {
        console.log('All CDN sources failed, keeping procedural texture');
        return;
      }
      
      const url = textureSources[textureAttempt];
      console.log(`Attempting texture source ${textureAttempt + 1}: ${url}`);
      
      textureLoader.load(
        url,
        (texture) => {
          console.log('✅ Real satellite texture loaded successfully');
          if (sphereRef.current && sphereRef.current.material) {
            texture.colorSpace = THREE.SRGBColorSpace;
            sphereRef.current.material.map = texture;
            sphereRef.current.material.needsUpdate = true;
          }
        },
        undefined,
        () => {
          textureAttempt++;
          console.log(`Source ${textureAttempt} failed, trying next...`);
          tryNextTexture();
        }
      );
    };
    
    tryNextTexture();

    // Earth sphere
    const geometry = new THREE.SphereGeometry(1, 64, 64);
    const material = new THREE.MeshPhongMaterial({
      color: 0xffffff,
      shininess: 5,
      emissive: 0x0
    });
    const sphere = new THREE.Mesh(geometry, material);
    scene.add(sphere);
    sphereRef.current = sphere;

    // Lighting
    const sunLight = new THREE.DirectionalLight(0xffffff, 2);
    sunLight.position.set(5, 3, 5);
    scene.add(sunLight);
    
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    // Points group
    const pointsGroup = new THREE.Group();
    scene.add(pointsGroup);
    pointsGroupRef.current = pointsGroup;

    // Mouse controls
    let isDragging = false;
    let previousMouse = { x: 0, y: 0 };

    const onMouseDown = (e) => {
      isDragging = true;
      previousMouse = { x: e.clientX, y: e.clientY };
      console.log('Mouse down, ready to drag');
    };

    const onMouseMove = (e) => {
      if (isDragging && sphereRef.current && pointsGroupRef.current) {
        const deltaX = e.clientX - previousMouse.x;
        const deltaY = e.clientY - previousMouse.y;
        
        sphereRef.current.rotation.y += deltaX * 0.005;
        sphereRef.current.rotation.x += deltaY * 0.005;
        pointsGroupRef.current.rotation.copy(sphereRef.current.rotation);
        
        previousMouse = { x: e.clientX, y: e.clientY };
      }
    };

    const onMouseUp = () => {
      isDragging = false;
    };

    const onWheel = (e) => {
      e.preventDefault();
      if (cameraRef.current) {
        // Inverted: scroll down zooms in (decrease Z), scroll up zooms out (increase Z)
        cameraRef.current.position.z -= e.deltaY * 0.001;
        cameraRef.current.position.z = Math.max(1.1, Math.min(10, cameraRef.current.position.z));
        console.log('Zoom to Z:', cameraRef.current.position.z.toFixed(2));
      }
    };

    renderer.domElement.addEventListener('mousedown', onMouseDown);
    renderer.domElement.addEventListener('mousemove', onMouseMove);
    renderer.domElement.addEventListener('mouseup', onMouseUp);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

    // Animation
    const animate = () => {
      requestAnimationFrame(animate);
      renderer.render(scene, camera);
    };
    animate();

    // Cleanup
    return () => {
      renderer.domElement.removeEventListener('mousedown', onMouseDown);
      renderer.domElement.removeEventListener('mousemove', onMouseMove);
      renderer.domElement.removeEventListener('mouseup', onMouseUp);
      renderer.domElement.removeEventListener('wheel', onWheel, { passive: false });
      
      if (container && renderer.domElement) {
        try { container.removeChild(renderer.domElement); } catch { /* ignore */ }
      }
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    };
  }, [isVisible]);

  // Update points
  useEffect(() => {
    if (!pointsGroupRef.current || !sceneRef.current) return;

    // Clear old points
    while (pointsGroupRef.current.children.length > 0) {
      const child = pointsGroupRef.current.children[0];
      child.geometry?.dispose();
      child.material?.dispose();
      pointsGroupRef.current.removeChild(child);
    }

    if (pointsData.length === 0) return;

    console.log(`Rendering ${pointsData.length} points on globe`);

    // Add new points
    pointsData.forEach((point, idx) => {
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
        console.warn(`Point ${idx} invalid:`, point);
        return;
      }

      // Convert to 3D position (lat=latitude in degrees, lng=longitude in degrees)
      const latRad = point.lat * (Math.PI / 180);
      const lonRad = point.lng * (Math.PI / 180);
      
      const x = 1.02 * Math.cos(latRad) * Math.cos(lonRad);
      const y = 1.02 * Math.sin(latRad);
      const z = 1.02 * Math.cos(latRad) * Math.sin(lonRad);

      // Create large visible point marker
      const pointGeom = new THREE.SphereGeometry(0.08, 32, 32);
      const pointMat = new THREE.MeshBasicMaterial({
        color: point.color,
        transparent: false
      });
      const pointMesh = new THREE.Mesh(pointGeom, pointMat);
      pointMesh.position.set(x, y, z);
      pointsGroupRef.current.add(pointMesh);

      // Add bright glow
      const glowGeom = new THREE.SphereGeometry(0.12, 32, 32);
      const glowMat = new THREE.MeshBasicMaterial({
        color: point.color,
        transparent: true,
        opacity: 0.7
      });
      const glowMesh = new THREE.Mesh(glowGeom, glowMat);
      glowMesh.position.set(x, y, z);
      pointsGroupRef.current.add(glowMesh);
    });
  }, [pointsData]);

  return (
    <div
      style={{
        display: isVisible ? 'block' : 'none',
        width: '100%',
        height: '350px',
        position: 'relative',
        overflow: 'hidden',
        borderRadius: '12px',
        boxShadow: '0 2px 12px rgba(0,0,0,0.2)',
        backgroundColor: '#000'
      }}
    >
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
          position: 'relative'
        }}
      />

      {/* Legend */}
      <div style={{
        position: 'absolute',
        bottom: '20px',
        right: '20px',
        background: 'rgba(255,255,255,0.95)',
        padding: '15px',
        borderRadius: '8px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
        fontSize: '12px',
        minWidth: '200px',
        pointerEvents: 'none',
        zIndex: 100
      }}>
        <div style={{ fontWeight: 'bold', marginBottom: '10px', fontSize: '14px' }}>
          Geoid Undulation Legend
        </div>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '5px' }}>
          <div style={{ width: '20px', height: '20px', background: '#0000ff', marginRight: '8px', border: '1px solid #ccc' }}></div>
          <span>&lt; -10m (Far below)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '5px' }}>
          <div style={{ width: '20px', height: '20px', background: '#00ffff', marginRight: '8px', border: '1px solid #ccc' }}></div>
          <span>-10m to -2m (Below)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '5px' }}>
          <div style={{ width: '20px', height: '20px', background: '#00ff00', marginRight: '8px', border: '1px solid #ccc' }}></div>
          <span>-2m to +2m (Near)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '5px' }}>
          <div style={{ width: '20px', height: '20px', background: '#ffff00', marginRight: '8px', border: '1px solid #ccc' }}></div>
          <span>+2m to +10m (Above)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '5px' }}>
          <div style={{ width: '20px', height: '20px', background: '#ff0000', marginRight: '8px', border: '1px solid #ccc' }}></div>
          <span>&gt; +10m (Far above)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <div style={{ width: '20px', height: '20px', background: '#999999', marginRight: '8px', border: '1px solid #ccc' }}></div>
          <span>No geoid data</span>
        </div>
        <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid #ddd', fontSize: '11px', color: '#666' }}>
          Left-click points • Scroll to zoom • Drag to pan
        </div>
      </div>

      {/* Empty state */}
      {pointsData.length === 0 && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          background: 'rgba(255,255,255,0.95)',
          padding: '20px',
          borderRadius: '8px',
          textAlign: 'center',
          boxShadow: '0 2px 12px rgba(0,0,0,0.2)',
          zIndex: 10,
          pointerEvents: 'none'
        }}>
          <div style={{ fontSize: '16px', fontWeight: 'bold', marginBottom: '8px' }}>
            No Points to Display
          </div>
          <div style={{ fontSize: '14px', color: '#666' }}>
            Perform coordinate conversion to see points
          </div>
        </div>
      )}
    </div>
  );
};

export default Earth3DVisualization;
