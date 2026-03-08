import { useState, useCallback, useEffect } from "react";
import {
  parseNDSRom, findFile, extractFile, getGamePaths, patchFile,
  type NDSRom, type FileNode,
} from "./lib/nds-rom";
import { parseNARC, rebuildNARC, type NARC } from "./lib/narc";
import {
  parseMapData, serializePermissions, rebuildMapBuffer,
  type MapData,
} from "./lib/map-data";
import {
  parseEventData, serializeEventData,
  createDefaultOverworld, createDefaultWarp, createDefaultTrigger, createDefaultSign,
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
    setLoadingMsg("Opening file…");
    try {
      const result = await openRomFile();
      if (!result) { setLoading(false); return; }

      setLoadingMsg("Parsing NDS header…");
      const parsed = parseNDSRom(result.buffer);
      setRom(parsed);
      setRomPath(result.path);
      addToast(`Loaded ${parsed.gameInfo.name} (${parsed.gameInfo.region})`, "success");

      // Extract NARCs
      const paths = getGamePaths(parsed.gameInfo.version);
      setLoadingMsg("Extracting map data…");

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

      setLandNarc(land);
      setEventNarc(events);
      setMatrixNarc(matrix);
      setEncounterNarc(encounters);

      if (land) addToast(`Found ${land.fileCount} maps`, "success");
      if (matrix?.files[0]) setMatrixData(parseMapMatrix(matrix.files[0].data));

      // Auto-load first map
      if (land && land.fileCount > 0) {
        loadMapInternal(0, land, events, encounters);
      }
    } catch (err) {
      addToast(`Error: ${(err as Error).message}`, "error");
      console.error(err);
    }
    setLoading(false);
  }, [addToast]);

  // ─── Load map ──────────────────────────────────
  const loadMapInternal = useCallback(
    (idx: number, ln: NARC | null, en: NARC | null, ec: NARC | null) => {
      if (!ln || idx >= ln.fileCount) return;
      const md = modifiedMaps[idx]
        ? parseMapData(modifiedMaps[idx])
        : parseMapData(ln.files[idx].data);
      setMapData(md);

      // Parse BDHC from the map's raw buffer
      if (md && md.rawBuffer) {
        const bdhcOffset = 16 + md.permissionSize + md.buildingSize + md.modelSize;
        if (md.bdhcSize > 8 && bdhcOffset + md.bdhcSize <= md.rawBuffer.byteLength) {
          const bdhcBuf = md.rawBuffer.slice(bdhcOffset, bdhcOffset + md.bdhcSize);
          const bdhc = parseBDHC(bdhcBuf);
          setBdhcData(bdhc);
        } else {
          setBdhcData(null);
        }
      } else {
        setBdhcData(null);
      }

      if (en && idx < en.fileCount) {
        setEventData(modifiedEvents[idx] ?? parseEventData(en.files[idx].data));
      } else {
        setEventData({ overworlds: [], warps: [], triggers: [], signs: [] });
      }

      if (ec && idx < ec.fileCount) {
        setEncounterData(parseEncounterData(ec.files[idx].data));
      } else {
        setEncounterData(null);
      }

      setCurrentMapIdx(idx);
      setSelectedEvent(null);
    },
    [modifiedMaps, modifiedEvents]
  );

  const loadMap = useCallback(
    (idx: number) => loadMapInternal(idx, landNarc, eventNarc, encounterNarc),
    [landNarc, eventNarc, encounterNarc, loadMapInternal]
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
      overworlds: createDefaultOverworld(newEvents.overworlds.length),
      warps: createDefaultWarp(),
      triggers: createDefaultTrigger(),
      signs: createDefaultSign(),
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

      // Patch map data
      if (Object.keys(modifiedMaps).length > 0) {
        const narcFiles = landNarc.files.map((f, i) => modifiedMaps[i] ?? f.data);
        const newNarc = rebuildNARC(narcFiles);
        const landFile = findFile(rom.fileTree, paths.landData) ??
                         findFile(rom.fileTree, paths.landData.replace("_release", ""));
        if (landFile?.type === "file") {
          patchFile(newRom, rom.fat, landFile.fileId, newNarc);
        }
      }

      // Patch event data
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
      {/* Toast container */}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.type}`}>{t.msg}</div>
        ))}
      </div>

      {/* Loading overlay */}
      {loading && (
        <div className="loading-overlay">
          <div className="loading-box">
            <div className="loading-spinner" />
            <div>{loadingMsg}</div>
          </div>
        </div>
      )}

      {/* File tree modal */}
      {showFileTree && rom && (
        <FileTreeModal tree={rom.fileTree} onClose={() => setShowFileTree(false)} />
      )}

      {/* Header */}
      <div className="header">
        <h1><span>◆</span> Pokémon DPPt Map Editor</h1>
        <div className="header-info">
          {rom ? (
            <>
              <span className={badgeClass}>{rom.gameInfo.name} ({rom.gameInfo.region})</span>
              <span>{rom.title}</span>
              <span>{(rom.romSize / 1024 / 1024).toFixed(1)} MB</span>
              {hasUnsavedChanges && <span style={{ color: "var(--accent)" }}>● Unsaved</span>}
              <button className="tool-btn" onClick={() => setShowFileTree(true)}>📁 Files</button>
              <button className="tool-btn" onClick={loadRom}>📂 Open ROM</button>
              {hasUnsavedChanges && (
                <button className="tool-btn" onClick={handleSave} style={{ color: "var(--accent2)" }}>💾 Save ROM</button>
              )}
            </>
          ) : (
            <button className="tool-btn" onClick={loadRom} style={{ color: "var(--accent2)" }}>📂 Open ROM</button>
          )}
        </div>
      </div>

      {/* Main layout */}
      <div className="main">
        {!rom ? (
          /* Landing screen */
          <div className="landing">
            <div className="landing-logo">◆</div>
            <h2>Pokémon DPPt Map Editor</h2>
            <p>
              A map editor for Pokémon Diamond, Pearl, and Platinum.
              Load your NDS ROM to begin editing maps, events, permissions, and encounters.
            </p>
            <div className="file-drop" onClick={loadRom}>
              <div className="drop-icon">💾</div>
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
              {/* Toolbar */}
              <div className="toolbar">
                <div className="tool-group">
                  <button
                    className={`tool-btn ${viewMode === "2d" ? "active" : ""}`}
                    onClick={() => setViewMode("2d")}
                  >2D</button>
                  <button
                    className={`tool-btn ${viewMode === "3d" ? "active" : ""}`}
                    onClick={() => setViewMode("3d")}
                    title={bdhcData ? `${bdhcData.plates.length} plates` : "No BDHC data (flat view)"}
                  >3D{bdhcData ? "" : " ○"}</button>
                </div>
                {viewMode === "2d" && (
                  <div className="tool-group">
                    {[
                      { id: "paint", label: "✏ Paint" },
                      { id: "fill", label: "■ Fill" },
                      { id: "pick", label: "🔍 Pick" },
                      { id: "event", label: "📍 Events" },
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
                      💾 Save ROM
                    </button>
                  </div>
                )}
              </div>
              {/* Workspace */}
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
