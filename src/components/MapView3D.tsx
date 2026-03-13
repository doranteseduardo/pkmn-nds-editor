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
import { parseNSBMD, nsbmdToFlatMesh, type FlatMeshData, type MaterialUVProps } from "../lib/nsbmd";
import { parseTEX0, makeTexture, type TEX0RawData, type RawNdsTexture, type RawNdsPalette, type NdsTexture } from "../lib/nsbtx";
import { BinaryReader } from "../lib/binary";
import TextureDebugPanel from "./TextureDebugPanel";

interface Props {
  bdhc: BDHC | null;
  permissions: PermissionGrid | null;
  eventData: EventData | null;
  showEvents: boolean;
  mapData: MapData | null;
  /** Raw NSBTX texture data from the ROM's map_tex NARC */
  mapTexData: ArrayBuffer | null;
  /** Raw NSBTX texture data from the ROM's building tileset NARC (supplementary) */
  buildingTexData: ArrayBuffer | null;
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

export default function MapView3D({ bdhc, permissions, eventData, showEvents, mapData, mapTexData, buildingTexData }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const frameRef = useRef<number>(0);
  const [info, setInfo] = useState("Initializing 3D view…");
  const [showModel, setShowModel] = useState(true);
  const [showWireframe, setShowWireframe] = useState(false);
  const [showTexDebug, setShowTexDebug] = useState(false);
  const [debugTextures, setDebugTextures] = useState<NdsTexture[]>([]);

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
    renderer.shadowMap.enabled = false;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Flat global lighting — no shadows, even illumination
    const ambient = new THREE.AmbientLight(0xffffff, 1.0);
    scene.add(ambient);

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
            // Get raw TEX0 data — embedded or external NSBTX
            let rawTexData = nsbmd.texData;
            const texPalMap = nsbmd.texturePaletteMap;

            if (!rawTexData && mapTexData && mapTexData.byteLength > 16) {
              try {
                const r = new BinaryReader(mapTexData);
                const magic = r.u32();
                if (magic === 0x30585442) { // "BTX0"
                  r.skip(2 + 2 + 4 + 2);
                  const numBlks = r.u16();
                  for (let bi = 0; bi < numBlks; bi++) {
                    const blkOff = r.u32();
                    const savedPos = r.offset;
                    rawTexData = parseTEX0(mapTexData, blkOff);
                    r.seek(savedPos);
                    if (rawTexData && rawTexData.textures.length > 0) break;
                  }
                } else {
                  rawTexData = parseTEX0(mapTexData, 0);
                }
                if (rawTexData) {
                  console.log(`[3D] Loaded external NSBTX: ${rawTexData.textures.length} textures, ${rawTexData.palettes.length} palettes`);
                }
              } catch (e) {
                console.warn("[3D] External NSBTX parse error:", e);
              }
            }

            // ─── Try loading building tileset as supplementary texture source ───
            // The building tileset NSBTX may contain textures referenced by the map model
            // that aren't in the main map tileset (goes beyond DSPRE's single-NSBTX approach)
            let buildingRawTexData: TEX0RawData | null = null;
            if (buildingTexData && buildingTexData.byteLength > 16) {
              try {
                const br = new BinaryReader(buildingTexData);
                const bMagic = br.u32();
                if (bMagic === 0x30585442) { // "BTX0"
                  br.skip(2 + 2 + 4 + 2);
                  const bNumBlks = br.u16();
                  for (let bi = 0; bi < bNumBlks; bi++) {
                    const bBlkOff = br.u32();
                    const bSavedPos = br.offset;
                    buildingRawTexData = parseTEX0(buildingTexData, bBlkOff);
                    br.seek(bSavedPos);
                    if (buildingRawTexData && buildingRawTexData.textures.length > 0) break;
                  }
                } else {
                  buildingRawTexData = parseTEX0(buildingTexData, 0);
                }
                if (buildingRawTexData) {
                  console.log(`[3D] Loaded building NSBTX: ${buildingRawTexData.textures.length} textures, ${buildingRawTexData.palettes.length} palettes`);
                }
              } catch (e) {
                console.warn("[3D] Building NSBTX parse error:", e);
              }
            }

            // ─── Merge texture data from map tileset + building tileset ───
            // Building tileset textures are appended as fallbacks (map tileset takes priority)
            let mergedTexData = rawTexData;
            if (rawTexData && buildingRawTexData) {
              const mapTexNames = new Set(rawTexData.textures.map(t => t.texname));
              const mapPalNames = new Set(rawTexData.palettes.map(p => p.palname));
              const extraTex = buildingRawTexData.textures.filter(t => !mapTexNames.has(t.texname));
              const extraPal = buildingRawTexData.palettes.filter(p => !mapPalNames.has(p.palname));
              if (extraTex.length > 0 || extraPal.length > 0) {
                mergedTexData = {
                  textures: [...rawTexData.textures, ...extraTex],
                  palettes: [...rawTexData.palettes, ...extraPal],
                };
                console.log(`[3D] Merged: +${extraTex.length} textures, +${extraPal.length} palettes from building tileset`);
              }
            } else if (!rawTexData && buildingRawTexData) {
              mergedTexData = buildingRawTexData;
              console.log("[3D] Using building NSBTX as sole texture source");
            }

            // ─── DSPRE MatchTextures + MakeTexture pipeline ───
            // Per-material matching: each mesh group provides its own texName+palName pair
            // from the MDL0 polygon→matId→texDef/palDef chain (faithful to DSPRE)
            const meshTextureInfo = flat.meshTextures.map(mt => ({
              textureName: mt.textureName,
              paletteName: mt.paletteName,
              matId: mt.matId,
            }));
            const decodedTextures = matchAndDecodeTextures(mergedTexData, meshTextureInfo, texPalMap);
            setDebugTextures(decodedTextures);
            const bounds = buildNSBMDMesh(scene, flat, showWireframe, decodedTextures);
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
  }, [bdhc, permissions, eventData, showEvents, mapData, mapTexData, buildingTexData, showModel, showWireframe]);

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
        {debugTextures.length > 0 && (
          <button
            className={`tool-btn ${showTexDebug ? "active" : ""}`}
            onClick={() => setShowTexDebug(v => !v)}
            style={{ fontSize: 11, padding: "2px 8px" }}
          >
            Tex
          </button>
        )}
      </div>
      <TextureDebugPanel
        textures={debugTextures}
        visible={showTexDebug}
        onClose={() => setShowTexDebug(false)}
      />
    </div>
  );
}

// ─── DSPRE MatchTextures + MakeTexture Pipeline ──────────────
// Faithful reimplementation of DSPRE's NSBMD.MatchTextures() (lines 50-102):
//
// For each polygon:
//   1. Get polygon's MatId from code section
//   2. Find model texture def whose texmatid list contains MatId → get texture NAME
//   3. Look up texture NAME in external NSBTX texture list → get raw texture data
//   4. Find model palette def whose palmatid list contains MatId → get palette NAME
//   5. Look up palette NAME in external NSBTX palette list → get raw palette data
//   6. Decode raw texture + raw palette → RGBA image (MakeTexture)
//
// KEY INSIGHT: The same texture name may need DIFFERENT palettes for different materials.
// So we decode per-material (texName+palName pair), not per-texture-name.

// ─── Dynamic Texture Placeholders ─────────────────────────────
// The NDS game engine loads certain textures into VRAM at runtime
// (snow, water, shadows, grass, etc.). These don't exist in any
// static NSBTX file. We generate colored placeholders so the map
// doesn't have blank holes where these textures should be.

function getDynamicTexturePlaceholder(texName: string): NdsTexture | null {
  // Map texture name patterns to RGBA colors
  const patterns: [RegExp, [number, number, number, number]][] = [
    [/^s_snow/i,    [230, 240, 255, 200]], // Snow — light blue-white, semi-transparent
    [/^s_sonw/i,    [230, 240, 255, 200]], // Snow variant (typo in ROM data)
    [/^lake/i,      [ 40, 100, 180, 160]], // Lake water — blue, semi-transparent
    [/^puddle/i,    [ 80, 130, 200, 120]], // Puddle — lighter blue, more transparent
    [/^tshadow/i,   [ 20,  20,  20,  80]], // Tree shadow — dark, very transparent
    [/^hage/i,      [ 80, 140,  60, 200]], // Grass/undergrowth — green
    [/^tree/i,      [ 50, 120,  50, 220]], // Tree texture — darker green
    [/^shadow/i,    [ 20,  20,  20,  80]], // Generic shadow
  ];

  for (const [pattern, color] of patterns) {
    if (pattern.test(texName)) {
      const size = 8; // Small placeholder texture
      const rgba = new Uint8Array(size * size * 4);
      for (let i = 0; i < size * size; i++) {
        rgba[i * 4] = color[0];
        rgba[i * 4 + 1] = color[1];
        rgba[i * 4 + 2] = color[2];
        rgba[i * 4 + 3] = color[3];
      }
      return { name: texName, width: size, height: size, format: -1, rgba };
    }
  }
  return null;
}

interface DecodedMaterialTexture extends NdsTexture {
  /** Unique key: "texName|palName" — different materials sharing a texture name
   *  but with different palettes get separate decoded textures */
  materialKey: string;
}

function matchAndDecodeTextures(
  rawTexData: TEX0RawData | null,
  meshTextures: { textureName: string; paletteName: string; matId: number }[],
  texPalMap: Map<string, string>
): DecodedMaterialTexture[] {
  if (!rawTexData) return [];

  const { textures: rawTextures, palettes: rawPalettes } = rawTexData;
  const decoded: DecodedMaterialTexture[] = [];
  const decodedKeys = new Set<string>();

  // Build quick lookup maps
  const texByName = new Map<string, RawNdsTexture>();
  for (const t of rawTextures) texByName.set(t.texname, t);
  const palByName = new Map<string, RawNdsPalette>();
  for (const p of rawPalettes) palByName.set(p.palname, p);

  console.log(`[MatchTex] DSPRE-style matching: ${rawTextures.length} textures, ${rawPalettes.length} palettes, ${meshTextures.length} mesh groups, ${texPalMap.size} MDL0 mappings`);

  // For each mesh group (polygon), decode its specific texture+palette pair
  for (const mt of meshTextures) {
    if (!mt.textureName) continue;

    // Step 1: Find raw texture by name in NSBTX
    let rawTex = texByName.get(mt.textureName);
    if (!rawTex) {
      // Try prefix matching (DSPRE falls back to index-based, we try prefix)
      for (const [tname, t] of texByName) {
        if (mt.textureName.startsWith(tname) || tname.startsWith(mt.textureName)) {
          rawTex = t;
          break;
        }
      }
    }
    if (!rawTex) {
      // Generate a smart placeholder for known dynamic texture types
      // These are runtime textures the NDS loads into VRAM (not in any static NSBTX)
      const placeholder = getDynamicTexturePlaceholder(mt.textureName);
      if (placeholder) {
        const materialKey = `${mt.textureName}|${mt.paletteName}`;
        if (!decodedKeys.has(materialKey)) {
          decodedKeys.add(materialKey);
          decoded.push({ ...placeholder, materialKey });
          console.log(`[MatchTex] Using placeholder for dynamic texture "${mt.textureName}"`);
        }
      }
      continue;
    }

    // Step 2: Find raw palette — DSPRE approach: per-polygon via palmatid → name → NSBTX
    let palName = mt.paletteName; // From polygon's matId → palDef mapping
    let matchMethod = "";

    // Priority 1: Direct palette name from MDL0 palDef (polygon→matId→palDef→name)
    if (palName) {
      matchMethod = `mdl0-paldef "${palName}"`;
    }

    // Priority 2: texturePaletteMap (texture name → palette name from MDL0)
    if (!palName) {
      palName = texPalMap.get(rawTex.texname) ?? "";
      if (palName) matchMethod = `mdl0-texpalmap "${palName}"`;
    }

    // Priority 3: Exact name match in NSBTX palettes
    if (!palName) {
      const exactPal = palByName.get(rawTex.texname);
      if (exactPal) { palName = exactPal.palname; matchMethod = "exact-name"; }
    }

    // Priority 4: Prefix matching
    if (!palName) {
      let bestLen = 0;
      for (const p of rawPalettes) {
        if (rawTex.texname.startsWith(p.palname) && p.palname.length > bestLen) {
          palName = p.palname;
          bestLen = p.palname.length;
          matchMethod = `prefix "${p.palname}"`;
        }
        if (p.palname.startsWith(rawTex.texname) && rawTex.texname.length > bestLen) {
          palName = p.palname;
          bestLen = rawTex.texname.length;
          matchMethod = `prefix "${p.palname}"`;
        }
      }
    }

    // Priority 5: Fallback to first palette
    if (!palName && rawPalettes.length > 0 && rawTex.format !== 7) {
      palName = rawPalettes[0].palname;
      matchMethod = `fallback "${palName}"`;
    }

    // Build unique key for this texture+palette combination
    const materialKey = `${rawTex.texname}|${palName}`;

    // Skip if already decoded this exact combination
    if (decodedKeys.has(materialKey)) continue;
    decodedKeys.add(materialKey);

    const matchedPal = palName ? (palByName.get(palName) ?? null) : null;
    console.log(`[MatchTex] "${rawTex.texname}" fmt=${rawTex.format} ${rawTex.width}x${rawTex.height} + pal=${matchMethod || "none"} → key="${materialKey}"`);

    // Step 3: Decode texture using matched palette (DSPRE MakeTexture)
    const rgba = makeTexture(rawTex, matchedPal);
    if (rgba) {
      decoded.push({
        name: rawTex.texname,
        width: rawTex.width,
        height: rawTex.height,
        format: rawTex.format,
        rgba,
        materialKey,
      });
    } else {
      console.warn(`[MatchTex] Failed to decode "${rawTex.texname}"`);
    }
  }

  // Also decode any NSBTX textures not referenced by mesh groups
  // (for debug panel and completeness)
  for (const rawTex of rawTextures) {
    const fallbackKey = `${rawTex.texname}|`;
    if (decodedKeys.has(fallbackKey)) continue;

    // Check if this texture was already decoded with some palette
    let alreadyDecoded = false;
    for (const key of decodedKeys) {
      if (key.startsWith(rawTex.texname + "|")) { alreadyDecoded = true; break; }
    }
    if (alreadyDecoded) continue;

    // Decode with best-guess palette for debug
    let pal: RawNdsPalette | null = null;
    const palNameFromMap = texPalMap.get(rawTex.texname);
    if (palNameFromMap) pal = palByName.get(palNameFromMap) ?? null;
    if (!pal) pal = palByName.get(rawTex.texname) ?? null;
    if (!pal && rawPalettes.length > 0 && rawTex.format !== 7) pal = rawPalettes[0];

    const key = `${rawTex.texname}|${pal?.palname ?? ""}`;
    if (decodedKeys.has(key)) continue;
    decodedKeys.add(key);

    const rgba = makeTexture(rawTex, pal);
    if (rgba) {
      decoded.push({ name: rawTex.texname, width: rawTex.width, height: rawTex.height, format: rawTex.format, rgba, materialKey: key });
    }
  }

  console.log(`[MatchTex] Decoded ${decoded.length} unique texture+palette combinations`);
  return decoded;
}

// ─── NSBMD Mesh Builder ──────────────────────────────────────

function buildNSBMDMesh(
  scene: THREE.Scene,
  flat: FlatMeshData,
  wireframe: boolean,
  decodedTextures: DecodedMaterialTexture[]
): { min: THREE.Vector3; max: THREE.Vector3 } | null {
  // Build texture lookup maps:
  // 1. By materialKey ("texName|palName") — exact per-material match
  // 2. By texture name — fallback for mesh groups without specific palette
  const texByKey = new Map<string, DecodedMaterialTexture>();
  const texByName = new Map<string, DecodedMaterialTexture>();
  for (const tex of decodedTextures) {
    texByKey.set(tex.materialKey, tex);
    if (!texByName.has(tex.name)) texByName.set(tex.name, tex);
  }

  // Helper: find texture for a mesh group using materialKey first, then name fallback
  const findTexForMesh = (mt: { textureName: string; paletteName: string }): DecodedMaterialTexture | undefined => {
    // Try exact materialKey match first
    const key = `${mt.textureName}|${mt.paletteName}`;
    const byKey = texByKey.get(key);
    if (byKey) return byKey;

    // Try texture name only (any palette)
    const byName = texByName.get(mt.textureName);
    if (byName) return byName;

    // Prefix matching fallback
    for (const [, tex] of texByName) {
      if (mt.textureName.startsWith(tex.name) || tex.name.startsWith(mt.textureName)) return tex;
    }
    return undefined;
  };

  // Normalize UVs from texel space to 0-1 based on texture dimensions
  // DSPRE formula: uv = (scaleS / width) * rawUV / (flipS + 1)
  const normalizedUvs = new Float32Array(flat.uvs.length);
  normalizedUvs.set(flat.uvs);

  if (decodedTextures.length > 0) {
    const normalized = new Uint8Array(flat.uvs.length / 2);

    for (const mt of flat.meshTextures) {
      const tex = findTexForMesh(mt);
      if (!tex) continue;

      const uv = mt.uvProps;
      // DSPRE: (scaleS / width) * rawUV / (flipS + 1)
      const scaleU = (uv.scaleS / tex.width) / (uv.flipS + 1);
      const scaleV = (uv.scaleT / tex.height) / (uv.flipT + 1);

      const idxSlice = flat.indices.subarray(mt.indexStart, mt.indexStart + mt.indexCount);
      let vertMin = Infinity, vertMax = -Infinity;
      for (let k = 0; k < idxSlice.length; k++) {
        const vi = idxSlice[k];
        if (vi < vertMin) vertMin = vi;
        if (vi > vertMax) vertMax = vi;
      }

      for (let v = vertMin; v <= vertMax && v * 2 + 1 < normalizedUvs.length; v++) {
        if (normalized[v]) continue;
        normalizedUvs[v * 2] *= scaleU;
        normalizedUvs[v * 2 + 1] *= scaleV;
        normalized[v] = 1;
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

  // Build Three.js textures per mesh group with correct wrap modes per material
  // DSPRE: repeatS+flipS → GL_MIRRORED_REPEAT, repeatS only → GL_REPEAT, else → GL_CLAMP
  const getWrapMode = (repeat: number, flip: number): THREE.Wrapping => {
    if (repeat && flip) return THREE.MirroredRepeatWrapping;
    if (repeat) return THREE.RepeatWrapping;
    return THREE.ClampToEdgeWrapping;
  };

  // Cache decoded RGBA data by materialKey to reuse
  const decodedByKey = new Map<string, DecodedMaterialTexture>();
  const decodedByName = new Map<string, DecodedMaterialTexture>();
  for (const tex of decodedTextures) {
    decodedByKey.set(tex.materialKey, tex);
    if (!decodedByName.has(tex.name)) decodedByName.set(tex.name, tex);
  }

  // Create Three.js textures per mesh group (unique key = materialKey + wrap mode)
  const threeTextures = new Map<string, THREE.Texture>();
  for (const mt of flat.meshTextures) {
    const tex = findTexForMesh(mt);
    if (!tex) continue;

    const uv = mt.uvProps;
    const wrapS = getWrapMode(uv.repeatS, uv.flipS);
    const wrapT = getWrapMode(uv.repeatT, uv.flipT);
    const fullKey = `${tex.materialKey}|${wrapS}|${wrapT}`;

    if (threeTextures.has(fullKey)) continue;

    const rgbaCopy = new Uint8Array(tex.rgba.length);
    rgbaCopy.set(tex.rgba);
    const dataTex = new THREE.DataTexture(
      rgbaCopy, tex.width, tex.height, THREE.RGBAFormat
    );
    dataTex.needsUpdate = true;
    dataTex.magFilter = THREE.NearestFilter;
    dataTex.minFilter = THREE.NearestFilter;
    dataTex.wrapS = wrapS;
    dataTex.wrapT = wrapT;
    dataTex.flipY = false;
    threeTextures.set(fullKey, dataTex);
    // Also store by materialKey and name for fallback
    if (!threeTextures.has(tex.materialKey)) threeTextures.set(tex.materialKey, dataTex);
    if (!threeTextures.has(tex.name)) threeTextures.set(tex.name, dataTex);
  }
  if (threeTextures.size > 0) {
    console.log(`[3D] Created ${threeTextures.size} Three.js textures (${decodedTextures.length} unique material+palette combos)`);
  }

  // Create materials per mesh group
  const materials: THREE.Material[] = [];
  let groupIndex = 0;

  if (!wireframe && flat.meshTextures.length > 0 && threeTextures.size > 0) {
    for (const mt of flat.meshTextures) {
      const decodedTex = findTexForMesh(mt);
      const uv = mt.uvProps;
      const wrapS = getWrapMode(uv.repeatS, uv.flipS);
      const wrapT = getWrapMode(uv.repeatT, uv.flipT);

      // Try full key with wrap modes, then materialKey, then name
      let tex: THREE.Texture | undefined;
      if (decodedTex) {
        const fullKey = `${decodedTex.materialKey}|${wrapS}|${wrapT}`;
        tex = threeTextures.get(fullKey);
        if (!tex) tex = threeTextures.get(decodedTex.materialKey);
      }
      if (!tex) tex = threeTextures.get(mt.textureName);
      if (tex) {
        materials.push(new THREE.MeshBasicMaterial({
          map: tex, vertexColors: true, side: THREE.DoubleSide,
          transparent: true, alphaTest: 0.1,
        }));
      } else {
        materials.push(new THREE.MeshBasicMaterial({
          vertexColors: true, side: THREE.DoubleSide,
        }));
      }
      geometry.addGroup(mt.indexStart, mt.indexCount, groupIndex++);
    }
    const matched = materials.filter(m => (m as THREE.MeshBasicMaterial).map).length;
    const unmatched = flat.meshTextures.filter(mt => !findTexForMesh(mt)).map(mt => `"${mt.textureName}|${mt.paletteName}"`);
    console.log(`[3D] Texture matching: ${matched}/${flat.meshTextures.length} matched, unmatched: ${unmatched.join(", ") || "none"}`);
  }

  let material: THREE.Material | THREE.Material[];
  if (wireframe) {
    material = new THREE.MeshBasicMaterial({ vertexColors: true, wireframe: true });
  } else if (materials.length > 0) {
    material = materials;
  } else {
    material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  }

  const mesh = new THREE.Mesh(geometry, material);

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
  const pinGeo = new THREE.CylinderGeometry(3, 3, 1, 6);
  const headGeo = new THREE.SphereGeometry(6, 8, 6);
  const pinMat = new THREE.MeshBasicMaterial({ color: 0x9966cc, transparent: true, opacity: 0.85 });
  const headMat = new THREE.MeshBasicMaterial({ color: 0xcc88ff, transparent: true, opacity: 0.85 });

  // Building positions are in a fixed-point coordinate system where ~1 unit ≈ 32 model-space units.
  // The model coords span roughly -260 to 292 (512+ range for 32×32 tile map),
  // while building positions span ~-6 to 6.
  // Scale factor of 32 places buildings correctly within the model bounds.
  const POS_SCALE = 32;

  for (const b of buildings) {
    const pos = getBuildingWorldPos(b);
    // Scale positions and flip Z to match the NSBMD mesh's scale.set(1,1,-1)
    const group = new THREE.Group();
    group.position.set(
      pos.x * POS_SCALE,
      pos.y * POS_SCALE,
      -pos.z * POS_SCALE
    );

    // Pin body
    const pin = new THREE.Mesh(pinGeo, pinMat);
    pin.scale.set(1, 16, 1);
    pin.position.y = 8;
    group.add(pin);

    // Pin head
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = 18;
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

  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.DoubleSide,
  }));
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

  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.DoubleSide,
  }));
  mesh.userData.isMapMesh = true;
  scene.add(mesh);
}

// ─── Event markers ───────────────────────────────────────────

function buildEventMarkers(scene: THREE.Scene, events: EventData, tileSize: number) {
  const addMarker = (
    x: number, y: number, z: number,
    color: number, geo: THREE.BufferGeometry,
  ) => {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x * tileSize + tileSize / 2, z + 12, y * tileSize + tileSize / 2);
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
