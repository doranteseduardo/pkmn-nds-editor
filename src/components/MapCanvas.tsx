import { useRef, useState, useCallback, useEffect } from "react";
import type { MapData } from "../lib/map-data";
import type { EventData } from "../lib/events";
import { getPermColor, getPermLabel } from "../lib/map-data";

interface Props {
  mapData: MapData | null;
  eventData: EventData | null;
  activeTool: string;
  selectedPerm: number;
  showLayers: { perms: boolean; events: boolean; grid: boolean };
  selectedEvent: { type: string; index: number } | null;
  onPermChange: (x: number, y: number, value: number) => void;
  onSelectEvent: (ev: { type: string; index: number } | null) => void;
  onPickPerm: (value: number) => void;
}

export default function MapCanvas({
  mapData, eventData, activeTool, selectedPerm, showLayers,
  selectedEvent, onPermChange, onSelectEvent, onPickPerm,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(16);
  const [pan, setPan] = useState({ x: 20, y: 20 });
  const [hoverTile, setHoverTile] = useState<{ x: number; y: number } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const panStart = useRef<{ x: number; y: number } | null>(null);

  const TILE = zoom;

  // ─── Render ──────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !mapData) return;
    const ctx = canvas.getContext("2d")!;
    const perms = mapData.permissions;
    const W = perms.width * TILE;
    const H = perms.height * TILE;
    canvas.width = W;
    canvas.height = H;
    canvas.style.left = `${pan.x}px`;
    canvas.style.top = `${pan.y}px`;

    ctx.clearRect(0, 0, W, H);

    // Permission tiles
    if (showLayers.perms) {
      for (let y = 0; y < perms.height; y++) {
        for (let x = 0; x < perms.width; x++) {
          ctx.fillStyle = getPermColor(perms.tiles[y * perms.width + x]);
          ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
        }
      }
    } else {
      ctx.fillStyle = "#1e1f3a";
      ctx.fillRect(0, 0, W, H);
    }

    // Grid
    if (showLayers.grid) {
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 0.5;
      for (let x = 0; x <= perms.width; x++) {
        ctx.beginPath(); ctx.moveTo(x * TILE, 0); ctx.lineTo(x * TILE, H); ctx.stroke();
      }
      for (let y = 0; y <= perms.height; y++) {
        ctx.beginPath(); ctx.moveTo(0, y * TILE); ctx.lineTo(W, y * TILE); ctx.stroke();
      }
    }

    // Events
    if (showLayers.events && eventData) {
      drawTriggers(ctx, eventData, TILE);
      drawWarps(ctx, eventData, TILE);
      drawSpawnables(ctx, eventData, TILE);
      drawOverworlds(ctx, eventData, TILE);
    }

    // Hover highlight
    if (hoverTile) {
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.lineWidth = 2;
      ctx.strokeRect(hoverTile.x * TILE + 1, hoverTile.y * TILE + 1, TILE - 2, TILE - 2);
    }
  }, [mapData, eventData, zoom, pan, showLayers, hoverTile, selectedEvent, TILE]);

  // ─── Tile from mouse event ────────────────────
  const getTile = useCallback((e: React.MouseEvent) => {
    if (!mapData || !containerRef.current) return null;
    const rect = containerRef.current.getBoundingClientRect();
    const tx = Math.floor((e.clientX - rect.left - pan.x) / TILE);
    const ty = Math.floor((e.clientY - rect.top - pan.y) / TILE);
    const { width, height } = mapData.permissions;
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) return null;
    return { x: tx, y: ty };
  }, [mapData, pan, TILE]);

  // ─── Mouse handlers ──────────────────────────
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      setIsPanning(true);
      panStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;

    const tile = getTile(e);
    if (!tile) return;

    if (activeTool === "event") {
      if (eventData) {
        for (let i = eventData.overworlds.length - 1; i >= 0; i--) {
          if (eventData.overworlds[i].x === tile.x && eventData.overworlds[i].y === tile.y) {
            onSelectEvent({ type: "overworlds", index: i }); return;
          }
        }
        for (let i = eventData.warps.length - 1; i >= 0; i--) {
          if (eventData.warps[i].x === tile.x && eventData.warps[i].y === tile.y) {
            onSelectEvent({ type: "warps", index: i }); return;
          }
        }
        for (let i = eventData.triggers.length - 1; i >= 0; i--) {
          const t = eventData.triggers[i];
          if (tile.x >= t.x && tile.x < t.x + (t.width || 1) &&
              tile.y >= t.y && tile.y < t.y + (t.height || 1)) {
            onSelectEvent({ type: "triggers", index: i }); return;
          }
        }
        for (let i = eventData.spawnables.length - 1; i >= 0; i--) {
          if (eventData.spawnables[i].x === tile.x && eventData.spawnables[i].y === tile.y) {
            onSelectEvent({ type: "spawnables", index: i }); return;
          }
        }
      }
      onSelectEvent(null);
      return;
    }

    if (activeTool === "paint") {
      setIsDrawing(true);
      onPermChange(tile.x, tile.y, selectedPerm);
    } else if (activeTool === "fill") {
      floodFill(tile.x, tile.y, selectedPerm);
    } else if (activeTool === "pick" && mapData) {
      onPickPerm(mapData.permissions.tiles[tile.y * mapData.permissions.width + tile.x]);
    }
  }, [activeTool, selectedPerm, pan, getTile, onPermChange, eventData, onSelectEvent, mapData, onPickPerm]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isPanning && panStart.current) {
      setPan({ x: e.clientX - panStart.current.x, y: e.clientY - panStart.current.y });
      return;
    }
    const tile = getTile(e);
    setHoverTile(tile);
    if (isDrawing && tile && activeTool === "paint") {
      onPermChange(tile.x, tile.y, selectedPerm);
    }
  }, [isPanning, isDrawing, activeTool, selectedPerm, getTile, onPermChange]);

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
    setIsDrawing(false);
    panStart.current = null;
  }, []);

  const floodFill = useCallback((startX: number, startY: number, newVal: number) => {
    if (!mapData) return;
    const { width: w, height: h, tiles } = mapData.permissions;
    const target = tiles[startY * w + startX];
    if (target === newVal) return;
    const stack = [[startX, startY]];
    const visited = new Set<number>();
    while (stack.length > 0) {
      const [x, y] = stack.pop()!;
      const key = y * w + x;
      if (x < 0 || y < 0 || x >= w || y >= h || visited.has(key) || tiles[key] !== target) continue;
      visited.add(key);
      onPermChange(x, y, newVal);
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
  }, [mapData, onPermChange]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      setZoom(prev => Math.max(4, Math.min(48, prev + (e.deltaY > 0 ? -2 : 2))));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  const hoverVal = hoverTile && mapData
    ? mapData.permissions.tiles[hoverTile.y * mapData.permissions.width + hoverTile.x]
    : null;

  return (
    <div
      className="canvas-area"
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onContextMenu={e => e.preventDefault()}
    >
      <canvas ref={canvasRef} />
      <div className="canvas-info">
        {hoverTile
          ? `(${hoverTile.x}, ${hoverTile.y}) = ${getPermLabel(hoverVal!)} [0x${hoverVal!.toString(16).toUpperCase().padStart(4, "0")}]`
          : mapData
          ? `${mapData.permissions.width}×${mapData.permissions.height} tiles`
          : "No map loaded"}
        {" | Zoom: " + TILE + "px"}
      </div>
      <div className="zoom-controls">
        <button className="zoom-btn" onClick={() => setZoom(z => Math.min(48, z + 4))}>+</button>
        <button className="zoom-btn" onClick={() => setZoom(z => Math.max(4, z - 4))}>&minus;</button>
        <button className="zoom-btn" onClick={() => { setZoom(16); setPan({ x: 20, y: 20 }); }}>&#8634;</button>
      </div>
    </div>
  );
}

// ─── Drawing helpers ──────────────────────────────────────────

function drawOverworlds(ctx: CanvasRenderingContext2D, ev: EventData, T: number) {
  for (let i = 0; i < ev.overworlds.length; i++) {
    const ow = ev.overworlds[i];
    const cx = ow.x * T + T / 2;
    const cy = ow.y * T + T / 2;
    const r = T * 0.38;
    ctx.fillStyle = "rgba(238,90,36,0.6)";
    ctx.strokeStyle = "#ee5a24";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${Math.max(7, T / 3.5)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(`${ow.id}`, cx, cy + T / 6);
    ctx.textAlign = "start";
  }
}

function drawWarps(ctx: CanvasRenderingContext2D, ev: EventData, T: number) {
  for (let i = 0; i < ev.warps.length; i++) {
    const w = ev.warps[i];
    const cx = w.x * T + T / 2;
    const cy = w.y * T + T / 2;
    const s = T * 0.4;
    ctx.fillStyle = "rgba(255,159,67,0.5)";
    ctx.strokeStyle = "#ff9f43";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy - s); ctx.lineTo(cx + s, cy);
    ctx.lineTo(cx, cy + s); ctx.lineTo(cx - s, cy);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${Math.max(8, T / 3)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(`W${i}`, cx, cy + T / 6);
    ctx.textAlign = "start";
  }
}

function drawTriggers(ctx: CanvasRenderingContext2D, ev: EventData, T: number) {
  for (let i = 0; i < ev.triggers.length; i++) {
    const t = ev.triggers[i];
    ctx.fillStyle = "rgba(84,160,255,0.25)";
    ctx.strokeStyle = "#54a0ff";
    ctx.lineWidth = 1.5;
    ctx.fillRect(t.x * T, t.y * T, (t.width || 1) * T, (t.height || 1) * T);
    ctx.strokeRect(t.x * T, t.y * T, (t.width || 1) * T, (t.height || 1) * T);
    ctx.fillStyle = "#54a0ff";
    ctx.font = `${Math.max(8, T / 3)}px monospace`;
    ctx.fillText(`T${i}`, t.x * T + 2, t.y * T + T / 2);
  }
}

function drawSpawnables(ctx: CanvasRenderingContext2D, ev: EventData, T: number) {
  for (let i = 0; i < ev.spawnables.length; i++) {
    const s = ev.spawnables[i];
    const pad = T * 0.15;
    ctx.fillStyle = "rgba(95,39,205,0.5)";
    ctx.strokeStyle = "#5f27cd";
    ctx.lineWidth = 1.5;
    ctx.fillRect(s.x * T + pad, s.y * T + pad, T - pad * 2, T - pad * 2);
    ctx.strokeRect(s.x * T + pad, s.y * T + pad, T - pad * 2, T - pad * 2);
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${Math.max(7, T / 3.5)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(`S${i}`, s.x * T + T / 2, s.y * T + T / 2 + T / 6);
    ctx.textAlign = "start";
  }
}
