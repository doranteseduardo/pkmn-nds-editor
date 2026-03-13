import { useState, useCallback, useEffect } from "react";
import {
  parseNDSRom, findFile, extractFile, getGamePaths, patchFile,
  getAreaDataIdFromArm9,
  type NDSRom, type FileNode,
} from "./lib/nds-rom";
import { parseNARC, rebuildNARC, type NARC } from "./lib/narc";
import {
  parseMapData, serializePermissions, rebuildMapBuffer,
  type MapData,
} from "./lib/map-data";
import {
  parseEventData, serializeEventData,
  createDefaultSpawnable, createDefaultOverworld, createDefaultWarp, createDefaultTrigger,
  type EventData, type EventType,
} from "./lib/events";
import { parseEncounterData, type EncounterData } from "./lib/encounters";
import { parseMapMatrix, type MapMatrix } from "./lib/map-matrix";
import { parseBDHC, type BDHC } from "./lib/bdhc";
import { openRomFile, saveRomFile } from "./lib/tauri-bridge";

import MapCanvas from "./components/MapCanvas";
import MapView3D from "./components/MapView3D";
import Sidebar from "./components/Sidebar";
import RightPanel from "./components/RightPanel";
import FileTreeModal from "./components/FileTreeModal";

// ─── Toast system ─────────────────────────────────────────────

type ToastType = "success" | "error" | "info";
interface Toast { id: number; msg: string; type: ToastType }
let nextToastId = 0;

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const addToast = useCallback((msg: string, type: ToastType = "info") => {
    const id = ++nextToastId;
    setToasts(prev => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
  }, []);
  return { toasts, addToast };
}

// ─── Main App ─────────────────────────────────────────────────

export default function App() {
  const [rom, setRom] = useState<NDSRom | null>(null);
  const [romPath, setRomPath] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const { toasts, addToast } = useToasts();

  // Parsed NARCs
  const [landNarc, setLandNarc] = useState<NARC | null>(null);
  const [eventNarc, setEventNarc] = useState<NARC | null>(null);
  const [matrixNarc, setMatrixNarc] = useState<NARC | null>(null);
  const [encounterNarc, setEncounterNarc] = useState<NARC | null>(null);
  const [mapTexNarc, setMapTexNarc] = useState<NARC | null>(null);
  const [areaDataNarc, setAreaDataNarc] = useState<NARC | null>(null);

  /** Raw NSBTX texture data for the currently loaded map */
  const [mapTexData, setMapTexData] = useState<ArrayBuffer | null>(null);

  // Current map
  const [currentMapIdx, setCurrentMapIdx] = useState<number | null>(null);
  const [mapData, setMapData] = useState<MapData | null>(null);
  const [eventData, setEventData] = useState<EventData | null>(null);
  const [encounterData, setEncounterData] = useState<EncounterData | null>(null);
  const [matrixData, setMatrixData] = useState<MapMatrix | null>(null);
  const [currentMatrixIdx, setCurrentMatrixIdx] = useState(0);
  const [bdhcData, setBdhcData] = useState<BDHC | null>(null);

  // Editor state
  const [viewMode, setViewMode] = useState<"2d" | "3d">("2d");
  const [activeTool, setActiveTool] = useState("paint");
  const [selectedPerm, setSelectedPerm] = useState(0x00);
  const [selectedEvent, setSelectedEvent] = useState<{ type: string; index: number } | null>(null);
  const [showFileTree, setShowFileTree] = useState(false);
  const [showLayers, setShowLayers] = useState({ perms: true, events: true, grid: true });
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Modified data
  const [modifiedMaps, setModifiedMaps] = useState<Record<number, ArrayBuffer>>({});
  const [modifiedEvents, setModifiedEvents] = useState<Record<number, EventData>>({});

  // ─── Load ROM ──────────────────────────────────
  const loadRom = useCallback(async () => {
    setLoading(true);
    setLoadingMsg("Opening file...");
    try {
      const result = await openRomFile();
      if (!result) { setLoading(false); return; }

      setLoadingMsg("Parsing NDS header...");
      const parsed = parseNDSRom(result.buffer);
      setRom(parsed);
      setRomPath(result.path);
      addToast(`Loaded ${parsed.gameInfo.name} (${parsed.gameInfo.region})`, "success");

      const paths = getGamePaths(parsed.gameInfo.version);
      setLoadingMsg("Extracting map data...");

      const tryExtractNarc = (path: string): NARC | null => {
        const alts = [path, path.replace("_release", ""), path.replace(".narc", "_release.narc")];
        for (const p of alts) {
          const node = findFile(parsed.fileTree, p);
          if (node && node.type === "file") {
            try {
              return parseNARC(extractFile(parsed.buffer, node));
            } catch (e) {
              console.warn(`Failed to parse NARC at ${p}:`, e);
            }
          }
        }
        return null;
      };

      const land = tryExtractNarc(paths.landData);
      const events = tryExtractNarc(paths.eventData);
      const matrix = tryExtractNarc(paths.mapMatrix);
      const encounters = tryExtractNarc(paths.encounterData);
      const mapTex = tryExtractNarc(paths.mapTex);
      const areaData = tryExtractNarc(paths.areaData);

      setLandNarc(land);
      setEventNarc(events);
      setMatrixNarc(matrix);
      setEncounterNarc(encounters);
      setMapTexNarc(mapTex);
      setAreaDataNarc(areaData);
      // Log ARM9 info and dump first header bytes to verify table location
      console.log(`[ROM] Game code: ${parsed.gameCode}, ARM9 offset: 0x${parsed.arm9Offset.toString(16)}, ARM9 size: 0x${parsed.arm9Size.toString(16)}`);
      {
        // Dump first 3 map header raw bytes (24 bytes each) for verification
        const dv = new DataView(parsed.buffer);
        for (let i = 0; i < Math.min(5, land?.fileCount ?? 0); i++) {
          const areaId = getAreaDataIdFromArm9(parsed.buffer, parsed.arm9Offset, parsed.arm9Size, parsed.gameCode, i);
          // Also dump raw header bytes for verification
          const HEADER_OFFSETS: Record<string, number> = { CPUS: 0xE60B0, CPUE: 0xE601C, ADAE: 0xEEDBC, APAE: 0xEEDBC };
          const tableOff = HEADER_OFFSETS[parsed.gameCode];
          if (tableOff !== undefined) {
            const absOff = parsed.arm9Offset + tableOff + 24 * i;
            if (absOff + 24 <= parsed.buffer.byteLength) {
              const bytes: string[] = [];
              for (let b = 0; b < 24; b++) bytes.push(dv.getUint8(absOff + b).toString(16).padStart(2, "0"));
              const matrixNum = dv.getUint16(absOff + 2, true);
              const scriptNum = dv.getUint16(absOff + 4, true);
              console.log(`[ROM] Header[${i}]: areaDataID=${areaId}, matrix=${matrixNum}, script=${scriptNum}, raw=[${bytes.join(" ")}]`);
            }
          }
        }
      }

      if (mapTex) console.log(`[ROM] Map texture NARC: ${mapTex.fileCount} texture sets`);
      if (areaData) {
        // Dump first few entries to understand format
        const sizes = new Set<number>();
        for (let i = 0; i < Math.min(10, areaData.fileCount); i++) {
          sizes.add(areaData.files[i].data.byteLength);
        }
        console.log(`[ROM] Area data NARC: ${areaData.fileCount} entries, sizes: ${[...sizes].join(",")}`);
        // Hex dump first 3 entries
        for (let i = 0; i < Math.min(3, areaData.fileCount); i++) {
          const dv = new DataView(areaData.files[i].data);
          const hex: string[] = [];
          for (let b = 0; b < Math.min(16, areaData.files[i].data.byteLength); b++) {
            hex.push(dv.getUint8(b).toString(16).padStart(2, "0"));
          }
          const u16s: string[] = [];
          for (let b = 0; b + 1 < areaData.files[i].data.byteLength; b += 2) {
            u16s.push(dv.getUint16(b, true).toString());
          }
          console.log(`[ROM] AreaData[${i}]: hex=${hex.join(" ")}, u16s=[${u16s.join(",")}]`);
        }
      }

      if (land) addToast(`Found ${land.fileCount} maps`, "success");
      if (matrix?.files[0]) setMatrixData(parseMapMatrix(matrix.files[0].data));

      if (land && land.fileCount > 0) {
        loadMapInternal(0, land, events, encounters, mapTex, areaData, parsed);
      }
    } catch (err) {
      addToast(`Error: ${(err as Error).message}`, "error");
      console.error(err);
    }
    setLoading(false);
  }, [addToast]);

  // ─── Load map ──────────────────────────────────
  const loadMapInternal = useCallback(
    (idx: number, ln: NARC | null, en: NARC | null, ec: NARC | null,
     mt: NARC | null = null, ad: NARC | null = null, romRef: NDSRom | null = null) => {
      if (!ln || idx >= ln.fileCount) return;
      const md = modifiedMaps[idx]
        ? parseMapData(modifiedMaps[idx])
        : parseMapData(ln.files[idx].data);
      setMapData(md);

      // Parse BDHC from the map data's extracted bdhcData
      if (md?.bdhcData && md.bdhcData.byteLength > 8) {
        const bdhc = parseBDHC(md.bdhcData);
        setBdhcData(bdhc);
      } else {
        setBdhcData(null);
      }

      if (en && idx < en.fileCount) {
        setEventData(modifiedEvents[idx] ?? parseEventData(en.files[idx].data));
      } else {
        setEventData({ spawnables: [], overworlds: [], warps: [], triggers: [] });
      }

      if (ec && idx < ec.fileCount) {
        setEncounterData(parseEncounterData(ec.files[idx].data));
      } else {
        setEncounterData(null);
      }

      // ── Two-level indirection for texture set lookup ──
      // Step 1: Read map header from ARM9 → get areaDataID
      // Step 2: Use areaDataID to index into area_data NARC → get mapTileset
      // Step 3: Use mapTileset to index into map_tex NARC
      let texSetIdx = 0; // fallback
      let areaDataID: number | null = null;

      if (romRef) {
        areaDataID = getAreaDataIdFromArm9(
          romRef.buffer, romRef.arm9Offset, romRef.arm9Size,
          romRef.gameCode, idx
        );
        if (areaDataID !== null) {
          console.log(`[ROM] Map ${idx} → ARM9 header → areaDataID=${areaDataID}`);
        }
      }

      if (areaDataID !== null && ad && areaDataID < ad.fileCount) {
        // Read area_data entry: [buildingsTileset u16, mapTileset u16, unknown u16, lightType u16]
        const adData = new DataView(ad.files[areaDataID].data);
        if (adData.byteLength >= 4) {
          const buildingsTileset = adData.getUint16(0, true);
          const mapTileset = adData.getUint16(2, true);
          console.log(`[ROM] AreaData[${areaDataID}]: buildingsTileset=${buildingsTileset}, mapTileset=${mapTileset}`);
          if (mt && mapTileset < mt.fileCount) {
            texSetIdx = mapTileset;
          } else if (mt && buildingsTileset < mt.fileCount) {
            texSetIdx = buildingsTileset;
          }
        }
      } else {
        // Fallback: use map index directly as area_data index (old behavior)
        console.warn(`[ROM] No ARM9 header lookup for map ${idx}, falling back to direct index`);
        if (ad && idx < ad.fileCount) {
          const adData = new DataView(ad.files[idx].data);
          if (adData.byteLength >= 4) {
            const field0 = adData.getUint16(0, true);
            const field1 = adData.getUint16(2, true);
            if (mt && field1 < mt.fileCount) texSetIdx = field1;
            else if (mt && field0 < mt.fileCount) texSetIdx = field0;
          }
        }
      }

      if (mt && texSetIdx < mt.fileCount && mt.files[texSetIdx].data.byteLength > 16) {
        setMapTexData(mt.files[texSetIdx].data);
        console.log(`[ROM] Loaded map texture set #${texSetIdx}: ${mt.files[texSetIdx].data.byteLength} bytes`);
      } else {
        setMapTexData(null);
      }

      setCurrentMapIdx(idx);
      setSelectedEvent(null);
    },
    [modifiedMaps, modifiedEvents]
  );

  const loadMap = useCallback(
    (idx: number) => loadMapInternal(idx, landNarc, eventNarc, encounterNarc, mapTexNarc, areaDataNarc, rom),
    [landNarc, eventNarc, encounterNarc, mapTexNarc, areaDataNarc, rom, loadMapInternal]
  );

  // ─── Permission editing ────────────────────────
  const handlePermChange = useCallback((x: number, y: number, value: number) => {
    if (!mapData || currentMapIdx === null) return;
    const perms = mapData.permissions;
    const newTiles = new Uint16Array(perms.tiles);
    newTiles[y * perms.width + x] = value;
    const newPerms = { ...perms, tiles: newTiles };
    const newMapData = { ...mapData, permissions: newPerms };
    setMapData(newMapData);
    setHasUnsavedChanges(true);
    setModifiedMaps(prev => ({
      ...prev,
      [currentMapIdx]: rebuildMapBuffer(mapData, serializePermissions(newPerms)),
    }));
  }, [mapData, currentMapIdx]);

  // ─── Event editing ─────────────────────────────
  const handleEventUpdate = useCallback((type: EventType, index: number, field: string, value: number) => {
    if (!eventData || currentMapIdx === null) return;
    const newEvents = { ...eventData };
    const list = [...newEvents[type]] as any[];
    list[index] = { ...list[index], [field]: value };
    (newEvents as any)[type] = list;
    setEventData(newEvents);
    setHasUnsavedChanges(true);
    setModifiedEvents(prev => ({ ...prev, [currentMapIdx]: newEvents }));
  }, [eventData, currentMapIdx]);

  const addEvent = useCallback((type: EventType) => {
    if (!eventData || currentMapIdx === null) return;
    const newEvents = { ...eventData };
    const templates: Record<EventType, unknown> = {
      spawnables: createDefaultSpawnable(),
      overworlds: createDefaultOverworld(newEvents.overworlds.length),
      warps: createDefaultWarp(),
      triggers: createDefaultTrigger(),
    };
    (newEvents[type] as unknown[]) = [...newEvents[type], templates[type]];
    setEventData(newEvents as EventData);
    setHasUnsavedChanges(true);
    setModifiedEvents(prev => ({ ...prev, [currentMapIdx]: newEvents as EventData }));
    addToast(`Added ${type.slice(0, -1)}`, "success");
  }, [eventData, currentMapIdx, addToast]);

  const deleteEvent = useCallback((type: EventType, index: number) => {
    if (!eventData || currentMapIdx === null) return;
    const newEvents = { ...eventData };
    (newEvents[type] as unknown[]) = newEvents[type].filter((_, i) => i !== index);
    setEventData(newEvents as EventData);
    setSelectedEvent(null);
    setHasUnsavedChanges(true);
    setModifiedEvents(prev => ({ ...prev, [currentMapIdx]: newEvents as EventData }));
    addToast(`Deleted ${type.slice(0, -1)}`, "info");
  }, [eventData, currentMapIdx, addToast]);

  // ─── Save ROM ──────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!rom || !landNarc || !eventNarc) return;
    try {
      const newRom = rom.buffer.slice(0);
      const paths = getGamePaths(rom.gameInfo.version);

      if (Object.keys(modifiedMaps).length > 0) {
        const narcFiles = landNarc.files.map((f, i) => modifiedMaps[i] ?? f.data);
        const newNarc = rebuildNARC(narcFiles);
        const landFile = findFile(rom.fileTree, paths.landData) ??
                         findFile(rom.fileTree, paths.landData.replace("_release", ""));
        if (landFile?.type === "file") {
          patchFile(newRom, rom.fat, landFile.fileId, newNarc);
        }
      }

      if (Object.keys(modifiedEvents).length > 0) {
        const narcFiles = eventNarc.files.map((f, i) =>
          modifiedEvents[i] ? serializeEventData(modifiedEvents[i]) : f.data
        );
        const newNarc = rebuildNARC(narcFiles);
        const evFile = findFile(rom.fileTree, paths.eventData) ??
                       findFile(rom.fileTree, paths.eventData.replace("_release", ""));
        if (evFile?.type === "file") {
          patchFile(newRom, rom.fat, evFile.fileId, newNarc);
        }
      }

      const saved = await saveRomFile(newRom, romPath);
      if (saved) {
        setHasUnsavedChanges(false);
        addToast("ROM saved successfully!", "success");
      }
    } catch (err) {
      addToast(`Save error: ${(err as Error).message}`, "error");
    }
  }, [rom, landNarc, eventNarc, modifiedMaps, modifiedEvents, romPath, addToast]);

  // ─── Keyboard shortcuts ────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
        return;
      }
      switch (e.key.toLowerCase()) {
        case "p": setActiveTool("paint"); setViewMode("2d"); break;
        case "f": setActiveTool("fill"); setViewMode("2d"); break;
        case "i": setActiveTool("pick"); setViewMode("2d"); break;
        case "e": setActiveTool("event"); setViewMode("2d"); break;
        case "3": setViewMode(prev => prev === "3d" ? "2d" : "3d"); break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave]);

  const badgeClass = rom ? `badge badge-${rom.gameInfo.version}` : "";

  return (
    <div className="app">
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.type}`}>{t.msg}</div>
        ))}
      </div>

      {loading && (
        <div className="loading-overlay">
          <div className="loading-box">
            <div className="loading-spinner" />
            <div>{loadingMsg}</div>
          </div>
        </div>
      )}

      {showFileTree && rom && (
        <FileTreeModal tree={rom.fileTree} onClose={() => setShowFileTree(false)} />
      )}

      <div className="header">
        <h1><span>&#9670;</span> Pokemon DPPt Map Editor</h1>
        <div className="header-info">
          {rom ? (
            <>
              <span className={badgeClass}>{rom.gameInfo.name} ({rom.gameInfo.region})</span>
              <span>{rom.title}</span>
              <span>{(rom.romSize / 1024 / 1024).toFixed(1)} MB</span>
              {hasUnsavedChanges && <span style={{ color: "var(--accent)" }}>Unsaved</span>}
              <button className="tool-btn" onClick={() => setShowFileTree(true)}>Files</button>
              <button className="tool-btn" onClick={loadRom}>Open ROM</button>
              {hasUnsavedChanges && (
                <button className="tool-btn" onClick={handleSave} style={{ color: "var(--accent2)" }}>Save ROM</button>
              )}
            </>
          ) : (
            <button className="tool-btn" onClick={loadRom} style={{ color: "var(--accent2)" }}>Open ROM</button>
          )}
        </div>
      </div>

      <div className="main">
        {!rom ? (
          <div className="landing">
            <div className="landing-logo">&#9670;</div>
            <h2>Pokemon DPPt Map Editor</h2>
            <p>
              A map editor for Pokemon Diamond, Pearl, and Platinum.
              Load your NDS ROM to begin editing maps, events, permissions, and encounters.
            </p>
            <div className="file-drop" onClick={loadRom}>
              <div className="drop-icon">&#128190;</div>
              <div className="drop-text">Click to open a .nds ROM file</div>
              <div className="drop-hint">Supports Diamond, Pearl, and Platinum (US/EU/JP)</div>
            </div>
          </div>
        ) : (
          <>
            <Sidebar
              mapCount={landNarc?.fileCount ?? 0}
              currentMapIdx={currentMapIdx}
              matrixData={matrixData}
              currentMatrixIdx={currentMatrixIdx}
              onSelectMap={loadMap}
              matrixNarc={matrixNarc}
              onMatrixChange={(idx) => {
                setCurrentMatrixIdx(idx);
                if (matrixNarc && idx < matrixNarc.fileCount) {
                  setMatrixData(parseMapMatrix(matrixNarc.files[idx].data));
                }
              }}
            />
            <div className="content">
              <div className="toolbar">
                <div className="tool-group">
                  <button
                    className={`tool-btn ${viewMode === "2d" ? "active" : ""}`}
                    onClick={() => setViewMode("2d")}
                  >2D</button>
                  <button
                    className={`tool-btn ${viewMode === "3d" ? "active" : ""}`}
                    onClick={() => setViewMode("3d")}
                    title={bdhcData ? `${bdhcData.plates.length} plates` : "No BDHC data"}
                  >3D{mapData?.modelData ? "" : " (flat)"}</button>
                </div>
                {viewMode === "2d" && (
                  <div className="tool-group">
                    {[
                      { id: "paint", label: "Paint" },
                      { id: "fill", label: "Fill" },
                      { id: "pick", label: "Pick" },
                      { id: "event", label: "Events" },
                    ].map(t => (
                      <button
                        key={t.id}
                        className={`tool-btn ${activeTool === t.id ? "active" : ""}`}
                        onClick={() => setActiveTool(t.id)}
                      >{t.label}</button>
                    ))}
                  </div>
                )}
                <div className="tool-group">
                  {(["perms", "events", "grid"] as const).map(k => (
                    <button
                      key={k}
                      className={`tool-btn ${showLayers[k] ? "active" : ""}`}
                      onClick={() => setShowLayers(prev => ({ ...prev, [k]: !prev[k] }))}
                    >{{ perms: "Perms", events: "Events", grid: "Grid" }[k]}</button>
                  ))}
                </div>
                {hasUnsavedChanges && (
                  <div className="tool-group">
                    <button className="tool-btn" onClick={handleSave} style={{ color: "var(--accent2)", fontWeight: 600 }}>
                      Save ROM
                    </button>
                  </div>
                )}
              </div>
              <div className="workspace">
                {viewMode === "2d" ? (
                  <MapCanvas
                    mapData={mapData}
                    eventData={eventData}
                    activeTool={activeTool}
                    selectedPerm={selectedPerm}
                    showLayers={showLayers}
                    selectedEvent={selectedEvent}
                    onPermChange={handlePermChange}
                    onSelectEvent={setSelectedEvent}
                    onPickPerm={setSelectedPerm}
                  />
                ) : (
                  <MapView3D
                    bdhc={bdhcData}
                    permissions={mapData?.permissions ?? null}
                    eventData={eventData}
                    showEvents={showLayers.events}
                    mapData={mapData}
                    mapTexData={mapTexData}
                  />
                )}
                <RightPanel
                  mapData={mapData}
                  eventData={eventData}
                  encounterData={encounterData}
                  selectedPerm={selectedPerm}
                  onPermSelect={setSelectedPerm}
                  selectedEvent={selectedEvent}
                  onSelectEvent={setSelectedEvent}
                  onEventUpdate={handleEventUpdate}
                  onAddEvent={addEvent}
                  onDeleteEvent={deleteEvent}
                  currentMapIdx={currentMapIdx}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
