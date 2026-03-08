/**
 * 3D heightmap viewer using Three.js.
 * Renders BDHC terrain plates as a 3D mesh with permission-based coloring.
 */

import { useRef, useEffect, useCallback, useState } from "react";
import * as THREE from "three";
import type { BDHC, PlateGeometry } from "../lib/bdhc";
import { buildHeightmap, PLATE_TYPES } from "../lib/bdhc";
import type { PermissionGrid } from "../lib/map-data";
import { getPermColor } from "../lib/map-data";
import type { EventData } from "../lib/events";

interface Props {
  bdhc: BDHC | null;
  permissions: PermissionGrid | null;
  eventData: EventData | null;
  showEvents: boolean;
}

// ─── Plate type colors ──────────────────────────────────────

const PLATE_COLORS: Record<number, number> = {
  [PLATE_TYPES.PLANE]: 0x4a7c4e,
  [PLATE_TYPES.BRIDGE]: 0xa0522d,
  [PLATE_TYPES.LEFT_STAIRS]: 0xf59e0b,
  [PLATE_TYPES.RIGHT_STAIRS]: 0xf59e0b,
  [PLATE_TYPES.UP_STAIRS]: 0xf59e0b,
  [PLATE_TYPES.DOWN_STAIRS]: 0xf59e0b,
  [PLATE_TYPES.OTHER]: 0x7c3aed,
};

// ─── Component ───────────────────────────────────────────────

export default function MapView3D({ bdhc, permissions, eventData, showEvents }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const frameRef = useRef<number>(0);
  const [info, setInfo] = useState("Initializing 3D view…");

  // Camera orbit state
  const orbitRef = useRef({
    theta: Math.PI / 4,  // horizontal angle
    phi: Math.PI / 3,    // vertical angle
    radius: 600,
    target: new THREE.Vector3(256, 0, 256),
    isDragging: false,
    lastX: 0,
    lastY: 0,
  });

  // ─── Initialize Three.js ──────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x151625);
    scene.fog = new THREE.Fog(0x151625, 800, 1500);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      50,
      container.clientWidth / container.clientHeight,
      1,
      2000
    );
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Lighting
    const ambient = new THREE.AmbientLight(0x6677aa, 0.6);
    scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xffeedd, 1.0);
    sun.position.set(200, 400, 150);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 1024;
    sun.shadow.mapSize.height = 1024;
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 1200;
    sun.shadow.camera.left = -600;
    sun.shadow.camera.right = 600;
    sun.shadow.camera.top = 600;
    sun.shadow.camera.bottom = -600;
    scene.add(sun);

    const fill = new THREE.DirectionalLight(0x4488cc, 0.3);
    fill.position.set(-100, 200, -200);
    scene.add(fill);

    // Grid helper at y=0
    const grid = new THREE.GridHelper(512, 32, 0x333355, 0x222244);
    scene.add(grid);

    // Axes helper
    const axes = new THREE.AxesHelper(50);
    scene.add(axes);

    // Resize handler
    const onResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    // Animation loop
    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      updateCamera();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(frameRef.current);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      container.removeChild(renderer.domElement);
    };
  }, []);

  // ─── Update camera from orbit state ───────────
  const updateCamera = useCallback(() => {
    const cam = cameraRef.current;
    if (!cam) return;
    const { theta, phi, radius, target } = orbitRef.current;
    cam.position.set(
      target.x + radius * Math.sin(phi) * Math.cos(theta),
      target.y + radius * Math.cos(phi),
      target.z + radius * Math.sin(phi) * Math.sin(theta)
    );
    cam.lookAt(target);
  }, []);

  // ─── Build 3D scene from BDHC + permissions ───
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    // Remove old map meshes (keep lights, grid, axes)
    const toRemove = scene.children.filter(
      (c) => c.userData.isMapMesh || c.userData.isEventMesh
    );
    toRemove.forEach((c) => scene.remove(c));

    if (!permissions) {
      setInfo("No map data loaded");
      return;
    }

    const { width: gw, height: gh, tiles } = permissions;
    const TILE = 16; // world units per tile

    if (bdhc && bdhc.geometry.length > 0) {
      // ─── Mode A: Render BDHC plates as 3D quads ───
      const heightmap = buildHeightmap(bdhc, gw, gh, TILE);
      buildHeightmapMesh(scene, heightmap, tiles, gw, gh, TILE);
      buildPlateMeshes(scene, bdhc.geometry);
      setInfo(`${bdhc.plates.length} plates, ${bdhc.points.length} points`);
    } else {
      // ─── Mode B: Flat grid with permission colors ──
      buildFlatGrid(scene, tiles, gw, gh, TILE);
      setInfo("Flat view (no BDHC data)");
    }

    // Events
    if (showEvents && eventData) {
      buildEventMarkers(scene, eventData, TILE);
    }
  }, [bdhc, permissions, eventData, showEvents]);

  // ─── Mouse handlers for orbit controls ────────
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    orbitRef.current.isDragging = true;
    orbitRef.current.lastX = e.clientX;
    orbitRef.current.lastY = e.clientY;
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!orbitRef.current.isDragging) return;
    const dx = e.clientX - orbitRef.current.lastX;
    const dy = e.clientY - orbitRef.current.lastY;
    orbitRef.current.lastX = e.clientX;
    orbitRef.current.lastY = e.clientY;

    if (e.shiftKey || e.button === 1) {
      // Pan
      const cam = cameraRef.current;
      if (!cam) return;
      const right = new THREE.Vector3();
      const up = new THREE.Vector3();
      cam.getWorldDirection(up);
      right.crossVectors(up, cam.up).normalize();
      up.crossVectors(right, up).normalize();
      orbitRef.current.target.add(right.multiplyScalar(-dx * 0.5));
      orbitRef.current.target.add(up.multiplyScalar(-dy * 0.5));
    } else {
      // Rotate
      orbitRef.current.theta -= dx * 0.005;
      orbitRef.current.phi = Math.max(0.1, Math.min(Math.PI - 0.1, orbitRef.current.phi - dy * 0.005));
    }
  }, []);

  const handleMouseUp = useCallback(() => {
    orbitRef.current.isDragging = false;
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    orbitRef.current.radius = Math.max(50, Math.min(1500, orbitRef.current.radius + e.deltaY * 0.5));
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ flex: 1, position: "relative", cursor: "grab" }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="canvas-info">
        {info} | Drag: orbit, Shift+Drag: pan, Scroll: zoom
      </div>
    </div>
  );
}

// ─── Mesh Builders ───────────────────────────────────────────

/** Build a heightmap-based terrain mesh colored by permission types. */
function buildHeightmapMesh(
  scene: THREE.Scene,
  heights: Float32Array,
  tiles: Uint16Array,
  gw: number,
  gh: number,
  tileSize: number
) {
  const geometry = new THREE.BufferGeometry();
  const vertices: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  // Create vertices for each grid corner
  for (let gy = 0; gy <= gh; gy++) {
    for (let gx = 0; gx <= gw; gx++) {
      // Average height of surrounding tiles
      let h = 0;
      let count = 0;
      for (let dy = -1; dy <= 0; dy++) {
        for (let dx = -1; dx <= 0; dx++) {
          const tx = gx + dx;
          const ty = gy + dy;
          if (tx >= 0 && tx < gw && ty >= 0 && ty < gh) {
            h += heights[ty * gw + tx];
            count++;
          }
        }
      }
      h = count > 0 ? h / count : 0;

      vertices.push(gx * tileSize, h, gy * tileSize);

      // Color from nearest tile
      const tx = Math.min(gx, gw - 1);
      const ty = Math.min(gy, gh - 1);
      const permVal = tiles[ty * gw + tx];
      const colorHex = getPermColor(permVal);
      const c = new THREE.Color(colorHex);
      colors.push(c.r, c.g, c.b);
    }
  }

  // Create triangles
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const i = gy * (gw + 1) + gx;
      const i2 = i + 1;
      const i3 = i + (gw + 1);
      const i4 = i3 + 1;
      indices.push(i, i3, i2); // tri 1
      indices.push(i2, i3, i4); // tri 2
    }
  }

  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.userData.isMapMesh = true;
  scene.add(mesh);
}

/** Build wireframe outlines for each BDHC plate. */
function buildPlateMeshes(scene: THREE.Scene, plates: PlateGeometry[]) {
  for (const plate of plates) {
    if (plate.vertices.length < 3) continue;

    const points = plate.vertices.map(
      (v) => new THREE.Vector3(v[0], v[1], v[2])
    );
    // Close the loop
    points.push(points[0].clone());

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const color = PLATE_COLORS[plate.type] ?? 0x7c3aed;
    const material = new THREE.LineBasicMaterial({
      color,
      opacity: 0.5,
      transparent: true,
    });

    const line = new THREE.Line(geometry, material);
    line.userData.isMapMesh = true;
    scene.add(line);
  }
}

/** Build a flat colored grid when no BDHC is available. */
function buildFlatGrid(
  scene: THREE.Scene,
  tiles: Uint16Array,
  gw: number,
  gh: number,
  tileSize: number
) {
  const geometry = new THREE.BufferGeometry();
  const vertices: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  for (let gy = 0; gy <= gh; gy++) {
    for (let gx = 0; gx <= gw; gx++) {
      vertices.push(gx * tileSize, 0, gy * tileSize);
      const tx = Math.min(gx, gw - 1);
      const ty = Math.min(gy, gh - 1);
      const c = new THREE.Color(getPermColor(tiles[ty * gw + tx]));
      colors.push(c.r, c.g, c.b);
    }
  }

  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const i = gy * (gw + 1) + gx;
      indices.push(i, i + (gw + 1), i + 1);
      indices.push(i + 1, i + (gw + 1), i + (gw + 1) + 1);
    }
  }

  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
  }));
  mesh.receiveShadow = true;
  mesh.userData.isMapMesh = true;
  scene.add(mesh);
}

/** Build event markers (spheres, diamonds, boxes) in 3D space. */
function buildEventMarkers(scene: THREE.Scene, events: EventData, tileSize: number) {
  const addMarker = (
    x: number,
    y: number,
    z: number,
    color: number,
    geo: THREE.BufferGeometry,
    label?: string
  ) => {
    const mat = new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 0.8 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x * tileSize + tileSize / 2, z + 12, y * tileSize + tileSize / 2);
    mesh.castShadow = true;
    mesh.userData.isEventMesh = true;
    scene.add(mesh);
  };

  const sphereGeo = new THREE.SphereGeometry(6, 8, 8);
  const boxGeo = new THREE.BoxGeometry(10, 10, 10);
  const diamondGeo = new THREE.OctahedronGeometry(7);
  const coneGeo = new THREE.ConeGeometry(5, 12, 4);

  for (const ow of events.overworlds) {
    addMarker(ow.x, ow.y, ow.z, 0xee5a24, sphereGeo);
  }
  for (const wp of events.warps) {
    addMarker(wp.x, wp.y, 0, 0xff9f43, diamondGeo);
  }
  for (const tr of events.triggers) {
    const trigGeo = new THREE.BoxGeometry(
      (tr.width || 1) * tileSize * 0.8,
      6,
      (tr.height || 1) * tileSize * 0.8
    );
    addMarker(tr.x, tr.y, tr.z, 0x54a0ff, trigGeo);
  }
  for (const sg of events.signs) {
    addMarker(sg.x, sg.y, sg.z, 0x5f27cd, coneGeo);
  }
}
