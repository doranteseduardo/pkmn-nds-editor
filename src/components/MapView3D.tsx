/**
 * 3D map viewer using Three.js.
 * Renders NSBMD map terrain models, buildings, BDHC heightmap,
 * and event markers in a 3D scene with orbit controls.
 */

import { useRef, useEffect, useCallback, useState } from "react";
import * as THREE from "three";
import type { BDHC, PlateGeometry } from "../lib/bdhc";
import { buildHeightmap, PLATE_TYPES } from "../lib/bdhc";
import type { PermissionGrid, Building, MapData } from "../lib/map-data";
import { getPermColor, getBuildingWorldPos, rotU16ToDeg } from "../lib/map-data";
import type { EventData } from "../lib/events";
import { parseNSBMD, nsbmdToFlatMesh, type FlatMeshData } from "../lib/nsbmd";
import type { TEX0Data } from "../lib/nsbtx";

interface Props {
  bdhc: BDHC | null;
  permissions: PermissionGrid | null;
  eventData: EventData | null;
  showEvents: boolean;
  mapData: MapData | null;
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

export default function MapView3D({ bdhc, permissions, eventData, showEvents, mapData }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const frameRef = useRef<number>(0);
  const [info, setInfo] = useState("Initializing 3D view…");
  const [showModel, setShowModel] = useState(true);
  const [showWireframe, setShowWireframe] = useState(false);

  // Camera orbit state
  const orbitRef = useRef({
    theta: Math.PI / 4,
    phi: Math.PI / 3,
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
      0.1,
      5000
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

    const axes = new THREE.AxesHelper(50);
    scene.add(axes);

    const onResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

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

  // ─── Build 3D scene ─────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    // Remove old dynamic meshes (including Groups for buildings)
    const toRemove = scene.children.filter(
      (c) => c.userData.isMapMesh || c.userData.isEventMesh || c.userData.isBuildingMesh
    );
    const disposeMesh = (obj: THREE.Object3D) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry?.dispose();
        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
        else obj.material?.dispose();
      }
    };
    toRemove.forEach((c) => {
      c.traverse(disposeMesh);
      scene.remove(c);
    });

    if (!permissions) {
      setInfo("No map data loaded");
      return;
    }

    const { width: gw, height: gh, tiles } = permissions;
    const TILE = 16;
    let infoStr = "";

    // ─── Try NSBMD model rendering first ───
    let hasNSBMD = false;
    if (showModel && mapData?.modelData && mapData.modelData.byteLength > 16) {
      try {
        const nsbmd = parseNSBMD(mapData.modelData);
        if (nsbmd && nsbmd.models.length > 0) {
          const flat = nsbmdToFlatMesh(nsbmd);
          if (flat && flat.positions.length > 0) {
            const bounds = buildNSBMDMesh(scene, flat, showWireframe, nsbmd.textures);
            hasNSBMD = true;
            const triCount = flat.indices.length / 3;
            infoStr += `Model: ${triCount} tris (${(flat.positions.length / 3)} verts)`;

            // Auto-adjust camera to fit model bounds
            if (bounds) {
              const center = new THREE.Vector3(
                (bounds.min.x + bounds.max.x) / 2,
                (bounds.min.y + bounds.max.y) / 2,
                (bounds.min.z + bounds.max.z) / 2
              );
              const size = Math.max(
                bounds.max.x - bounds.min.x,
                bounds.max.y - bounds.min.y,
                bounds.max.z - bounds.min.z
              );
              orbitRef.current.target.copy(center);
              orbitRef.current.radius = Math.max(size * 1.5, 20);
              console.log(`[3D] Model bounds: min=(${bounds.min.x.toFixed(1)},${bounds.min.y.toFixed(1)},${bounds.min.z.toFixed(1)}), max=(${bounds.max.x.toFixed(1)},${bounds.max.y.toFixed(1)},${bounds.max.z.toFixed(1)}), radius=${orbitRef.current.radius.toFixed(1)}`);
            }
          }
        }
      } catch (e) {
        console.warn("NSBMD parse error:", e);
      }
    }

    // ─── BDHC heightmap (if no NSBMD or as supplement) ───
    if (bdhc && bdhc.geometry.length > 0) {
      const heightmap = buildHeightmap(bdhc, gw, gh, TILE);
      if (!hasNSBMD) {
        buildHeightmapMesh(scene, heightmap, tiles, gw, gh, TILE);
      }
      buildPlateMeshes(scene, bdhc.geometry);
      infoStr += `${infoStr ? " | " : ""}BDHC: ${bdhc.plates.length} plates`;
    } else if (!hasNSBMD) {
      // Flat grid fallback
      buildFlatGrid(scene, tiles, gw, gh, TILE);
      infoStr += "Flat view";
    }

    // ─── Buildings ───
    if (mapData?.buildings && mapData.buildings.length > 0) {
      buildBuildingMarkers(scene, mapData.buildings, TILE);
      infoStr += ` | ${mapData.buildings.length} buildings`;
    }

    // ─── Events ───
    if (showEvents && eventData) {
      buildEventMarkers(scene, eventData, TILE);
    }

    setInfo(infoStr || "No data");
  }, [bdhc, permissions, eventData, showEvents, mapData, showModel, showWireframe]);

  // ─── Mouse handlers ─────────────────────────────
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
      orbitRef.current.theta -= dx * 0.005;
      orbitRef.current.phi = Math.max(0.1, Math.min(Math.PI - 0.1, orbitRef.current.phi - dy * 0.005));
    }
  }, []);

  const handleMouseUp = useCallback(() => {
    orbitRef.current.isDragging = false;
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    const r = orbitRef.current.radius;
    orbitRef.current.radius = Math.max(5, Math.min(3000, r + e.deltaY * r * 0.001));
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
      <div style={{ position: "absolute", top: 8, right: 8, display: "flex", gap: 4 }}>
        <button
          className={`tool-btn ${showModel ? "active" : ""}`}
          onClick={() => setShowModel(m => !m)}
          style={{ fontSize: 11, padding: "2px 8px" }}
        >
          Model
        </button>
        <button
          className={`tool-btn ${showWireframe ? "active" : ""}`}
          onClick={() => setShowWireframe(w => !w)}
          style={{ fontSize: 11, padding: "2px 8px" }}
        >
          Wire
        </button>
      </div>
    </div>
  );
}

// ─── NSBMD Mesh Builder ──────────────────────────────────────

function buildNSBMDMesh(
  scene: THREE.Scene,
  flat: FlatMeshData,
  wireframe: boolean,
  texData: TEX0Data | null
): { min: THREE.Vector3; max: THREE.Vector3 } | null {
  // Normalize UVs from texel space to 0-1 based on texture dimensions
  const normalizedUvs = new Float32Array(flat.uvs.length);
  normalizedUvs.set(flat.uvs);

  if (texData) {
    for (const mt of flat.meshTextures) {
      const texIdx = texData.textureMap.get(mt.textureName);
      if (texIdx !== undefined) {
        const tex = texData.textures[texIdx];
        // Convert texel coords to normalized UVs
        // UV data is interleaved: [s0, t0, s1, t1, ...]
        // We need to find which vertices belong to this mesh's index range
        // Since indices reference into the shared vertex array, we need
        // to find the vertex range for this mesh segment
        const vertStart = mt.indexStart > 0
          ? Math.min(...Array.from(flat.indices.slice(mt.indexStart, mt.indexStart + mt.indexCount)))
          : 0;
        const vertEnd = Math.max(...Array.from(flat.indices.slice(mt.indexStart, mt.indexStart + mt.indexCount))) + 1;
        for (let v = vertStart; v < vertEnd && v * 2 + 1 < normalizedUvs.length; v++) {
          normalizedUvs[v * 2] /= tex.width;
          normalizedUvs[v * 2 + 1] /= tex.height;
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(flat.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(flat.normals, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(flat.colors, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(normalizedUvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(flat.indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();

  // Build Three.js textures from TEX0 data
  const threeTextures = new Map<string, THREE.Texture>();
  if (texData) {
    for (const tex of texData.textures) {
      // Copy to a fresh ArrayBuffer to satisfy TypeScript's strict typing
      const rgbaCopy = new Uint8Array(tex.rgba.length);
      rgbaCopy.set(tex.rgba);
      const dataTex = new THREE.DataTexture(
        rgbaCopy, tex.width, tex.height, THREE.RGBAFormat
      );
      dataTex.needsUpdate = true;
      dataTex.magFilter = THREE.NearestFilter;
      dataTex.minFilter = THREE.NearestFilter;
      dataTex.wrapS = THREE.RepeatWrapping;
      dataTex.wrapT = THREE.RepeatWrapping;
      // NDS textures are stored top-to-bottom, Three.js expects bottom-to-top
      dataTex.flipY = true;
      threeTextures.set(tex.name, dataTex);
    }
    console.log(`[3D] Created ${threeTextures.size} Three.js textures`);
  }

  // Create materials per mesh group
  const materials: THREE.Material[] = [];
  let groupIndex = 0;

  if (!wireframe && flat.meshTextures.length > 0 && threeTextures.size > 0) {
    // Group geometry by texture for multi-material rendering
    for (const mt of flat.meshTextures) {
      const tex = threeTextures.get(mt.textureName);
      if (tex) {
        materials.push(new THREE.MeshLambertMaterial({
          map: tex,
          vertexColors: true,
          side: THREE.DoubleSide,
          transparent: true,
          alphaTest: 0.1,
        }));
      } else {
        materials.push(new THREE.MeshLambertMaterial({
          vertexColors: true,
          side: THREE.DoubleSide,
        }));
      }
      geometry.addGroup(mt.indexStart, mt.indexCount, groupIndex++);
    }
  }

  let material: THREE.Material | THREE.Material[];
  if (wireframe) {
    material = new THREE.MeshBasicMaterial({ vertexColors: true, wireframe: true });
  } else if (materials.length > 0) {
    material = materials;
  } else {
    material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  }

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mesh.userData.isMapMesh = true;

  // NDS coordinate system: Y=up, X=right, Z=into screen
  // Three.js: Y=up, X=right, Z=out of screen (right-handed)
  // NDS uses left-handed, so we flip Z
  mesh.scale.set(1, 1, -1);

  scene.add(mesh);

  if (geometry.boundingBox) {
    const bb = geometry.boundingBox;
    return {
      min: new THREE.Vector3(bb.min.x, bb.min.y, -bb.max.z),
      max: new THREE.Vector3(bb.max.x, bb.max.y, -bb.min.z),
    };
  }
  return null;
}

// ─── Building markers ────────────────────────────────────────

function buildBuildingMarkers(scene: THREE.Scene, buildings: Building[], _tileSize: number) {
  // Shared geometry & materials — small pin markers (not to-scale boxes)
  const pinGeo = new THREE.CylinderGeometry(2, 2, 1, 6);
  const headGeo = new THREE.SphereGeometry(4, 8, 6);
  const pinMat = new THREE.MeshLambertMaterial({ color: 0x9966cc, transparent: true, opacity: 0.85 });
  const headMat = new THREE.MeshLambertMaterial({ color: 0xcc88ff, transparent: true, opacity: 0.85 });

  for (const b of buildings) {
    const pos = getBuildingWorldPos(b);
    // Building positions are in NDS world coordinates (same space as model).
    // NSBMD mesh has scale.set(1,1,-1) for Z-flip, so building markers
    // need the same flip: scene X = pos.x, scene Y = pos.y (height), scene Z = -pos.z
    const group = new THREE.Group();
    group.position.set(pos.x, pos.y, -pos.z);

    // Pin body
    const pin = new THREE.Mesh(pinGeo, pinMat);
    pin.scale.set(1, 12, 1);
    pin.position.y = 6;
    group.add(pin);

    // Pin head
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = 14;
    group.add(head);

    // Rotation
    if (b.yRotation !== 0) {
      group.rotation.y = (rotU16ToDeg(b.yRotation) * Math.PI) / 180;
    }

    group.userData.isBuildingMesh = true;
    scene.add(group);

    console.log(`[3D] Building #${b.modelId}: pos=(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}), w/h/l=${b.width}/${b.height}/${b.length}`);
  }
}

// ─── Heightmap mesh ──────────────────────────────────────────

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

  for (let gy = 0; gy <= gh; gy++) {
    for (let gx = 0; gx <= gw; gx++) {
      let h = 0, count = 0;
      for (let dy = -1; dy <= 0; dy++) {
        for (let dx = -1; dx <= 0; dx++) {
          const tx = gx + dx, ty = gy + dy;
          if (tx >= 0 && tx < gw && ty >= 0 && ty < gh) {
            h += heights[ty * gw + tx];
            count++;
          }
        }
      }
      h = count > 0 ? h / count : 0;
      vertices.push(gx * tileSize, h, gy * tileSize);
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
    vertexColors: true, side: THREE.DoubleSide,
  }));
  mesh.receiveShadow = true;
  mesh.userData.isMapMesh = true;
  scene.add(mesh);
}

function buildPlateMeshes(scene: THREE.Scene, plates: PlateGeometry[]) {
  for (const plate of plates) {
    if (plate.vertices.length < 3) continue;
    const points = plate.vertices.map((v) => new THREE.Vector3(v[0], v[1], v[2]));
    points.push(points[0].clone());
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const color = PLATE_COLORS[plate.type] ?? 0x7c3aed;
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({
      color, opacity: 0.5, transparent: true,
    }));
    line.userData.isMapMesh = true;
    scene.add(line);
  }
}

function buildFlatGrid(
  scene: THREE.Scene, tiles: Uint16Array, gw: number, gh: number, tileSize: number
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
    vertexColors: true, side: THREE.DoubleSide,
  }));
  mesh.receiveShadow = true;
  mesh.userData.isMapMesh = true;
  scene.add(mesh);
}

// ─── Event markers ───────────────────────────────────────────

function buildEventMarkers(scene: THREE.Scene, events: EventData, tileSize: number) {
  const addMarker = (
    x: number, y: number, z: number,
    color: number, geo: THREE.BufferGeometry,
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

  for (const sp of events.spawnables) {
    addMarker(sp.x, sp.y, sp.z, 0x5f27cd, coneGeo);
  }
  for (const ow of events.overworlds) {
    addMarker(ow.x, ow.y, ow.z, 0xee5a24, sphereGeo);
  }
  for (const wp of events.warps) {
    addMarker(wp.x, wp.y, 0, 0xff9f43, diamondGeo);
  }
  for (const tr of events.triggers) {
    const trigGeo = new THREE.BoxGeometry(
      (tr.width || 1) * tileSize * 0.8, 6,
      (tr.height || 1) * tileSize * 0.8
    );
    addMarker(tr.x, tr.y, tr.z, 0x54a0ff, trigGeo);
  }
}
