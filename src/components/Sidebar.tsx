import { useState, useMemo } from "react";
import type { MapMatrix } from "../lib/map-matrix";
import type { NARC } from "../lib/narc";

interface Props {
  mapCount: number;
  currentMapIdx: number | null;
  matrixData: MapMatrix | null;
  currentMatrixIdx: number;
  onSelectMap: (idx: number) => void;
  matrixNarc: NARC | null;
  onMatrixChange: (idx: number) => void;
}

export default function Sidebar({
  mapCount, currentMapIdx, matrixData, currentMatrixIdx,
  onSelectMap, matrixNarc, onMatrixChange,
}: Props) {
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"list" | "matrix">("list");

  const filteredMaps = useMemo(() => {
    const maps = [];
    for (let i = 0; i < mapCount; i++) {
      const label = `Map ${i}`;
      if (!search || label.toLowerCase().includes(search.toLowerCase()) || String(i).includes(search)) {
        maps.push({ idx: i, label });
      }
    }
    return maps;
  }, [mapCount, search]);

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span>Maps ({mapCount})</span>
        <div style={{ display: "flex", gap: "2px" }}>
          <button
            className={`tool-btn ${viewMode === "list" ? "active" : ""}`}
            onClick={() => setViewMode("list")}
            style={{ padding: "2px 6px", fontSize: "10px" }}
          >List</button>
          <button
            className={`tool-btn ${viewMode === "matrix" ? "active" : ""}`}
            onClick={() => setViewMode("matrix")}
            style={{ padding: "2px 6px", fontSize: "10px" }}
          >Matrix</button>
        </div>
      </div>

      <div className="sidebar-search">
        <input
          placeholder="Search maps..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {viewMode === "matrix" && matrixData && (
        <div style={{ padding: "8px" }}>
          {matrixNarc && (
            <select
              className="prop-input"
              style={{ marginBottom: "6px", width: "100%" }}
              value={currentMatrixIdx}
              onChange={e => onMatrixChange(Number(e.target.value))}
            >
              {Array.from({ length: matrixNarc.fileCount }, (_, i) => (
                <option key={i} value={i}>Matrix {i}</option>
              ))}
            </select>
          )}
          <div
            className="matrix-grid"
            style={{ gridTemplateColumns: `repeat(${matrixData.width}, 14px)` }}
          >
            {Array.from({ length: matrixData.width * matrixData.height }, (_, i) => {
              const mapId = matrixData.mapIds[i];
              const isEmpty = mapId === 0xFFFF || mapId === 0;
              return (
                <div
                  key={i}
                  className={`matrix-cell ${isEmpty ? "empty" : ""} ${mapId === currentMapIdx ? "active" : ""}`}
                  title={isEmpty ? "Empty" : `Map ${mapId}`}
                  onClick={() => !isEmpty && onSelectMap(mapId)}
                />
              );
            })}
          </div>
        </div>
      )}

      <div className="map-list">
        {filteredMaps.map(m => (
          <div
            key={m.idx}
            className={`map-item ${m.idx === currentMapIdx ? "active" : ""}`}
            onClick={() => onSelectMap(m.idx)}
          >
            <span>{m.label}</span>
            <span className="map-id">#{m.idx}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
