import { useState } from "react";
import type { MapData } from "../lib/map-data";
import type { EventData, EventType } from "../lib/events";
import type { EncounterData } from "../lib/encounters";
import { PERM_TYPES, getBuildingWorldPos, rotU16ToDeg } from "../lib/map-data";
import { GRASS_RATES } from "../lib/encounters";

interface Props {
  mapData: MapData | null;
  eventData: EventData | null;
  encounterData: EncounterData | null;
  selectedPerm: number;
  onPermSelect: (v: number) => void;
  selectedEvent: { type: string; index: number } | null;
  onSelectEvent: (ev: { type: string; index: number } | null) => void;
  onEventUpdate: (type: EventType, index: number, field: string, value: number) => void;
  onAddEvent: (type: EventType) => void;
  onDeleteEvent: (type: EventType, index: number) => void;
  currentMapIdx: number | null;
}

type TabId = "perms" | "events" | "encounters" | "info";

export default function RightPanel(props: Props) {
  const [activeTab, setActiveTab] = useState<TabId>("perms");

  return (
    <div className="right-panel">
      <div className="tabs">
        {(["perms", "events", "encounters", "info"] as TabId[]).map(t => (
          <div
            key={t}
            className={`tab ${activeTab === t ? "active" : ""}`}
            onClick={() => setActiveTab(t)}
          >
            {{ perms: "Permissions", events: "Events", encounters: "Encounters", info: "Info" }[t]}
          </div>
        ))}
      </div>
      <div className="panel-content">
        {activeTab === "perms" && <PermPanel {...props} />}
        {activeTab === "events" && <EventPanel {...props} />}
        {activeTab === "encounters" && <EncounterPanel data={props.encounterData} />}
        {activeTab === "info" && <InfoPanel {...props} />}
      </div>
    </div>
  );
}

// ─── Perm Panel ───────────────────────────────────────────────

function PermPanel({ selectedPerm, onPermSelect, mapData }: Props) {
  const [customValue, setCustomValue] = useState("");

  return (
    <div>
      <div className="prop-group">
        <div className="prop-group-title">Permission Palette</div>
        <div className="perm-palette">
          {PERM_TYPES.map(p => (
            <div
              key={p.value}
              className={`perm-swatch ${selectedPerm === p.value ? "active" : ""}`}
              style={{ background: p.color }}
              onClick={() => onPermSelect(p.value)}
              title={`${p.label} (0x${p.value.toString(16).toUpperCase()})`}
            >
              {p.shortLabel}
            </div>
          ))}
        </div>
      </div>
      <div className="prop-group">
        <div className="prop-group-title">Custom Value</div>
        <div className="prop-row">
          <span className="prop-label">Hex</span>
          <input
            className="prop-input"
            placeholder="0x00"
            value={customValue}
            onChange={e => setCustomValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") {
                const v = parseInt(customValue, 16);
                if (!isNaN(v) && v >= 0 && v <= 0xFFFF) onPermSelect(v);
              }
            }}
          />
        </div>
        <div style={{ fontSize: "10px", color: "var(--text-dim)", marginTop: "4px" }}>
          Press Enter to set. Current: 0x{selectedPerm.toString(16).toUpperCase().padStart(4, "0")}
          <br />
          Type: 0x{(selectedPerm & 0xFF).toString(16).toUpperCase().padStart(2, "0")}
          {" | "}Col: 0x{((selectedPerm >> 8) & 0xFF).toString(16).toUpperCase().padStart(2, "0")}
        </div>
      </div>
      {mapData && (
        <div className="prop-group">
          <div className="prop-group-title">Map Stats</div>
          <div style={{ fontSize: "11px", color: "var(--text-dim)" }}>
            <div>Size: {mapData.permissions.width}x{mapData.permissions.height}</div>
            <div>Perm data: {mapData.permissionSize} bytes</div>
            <div>Building data: {mapData.buildingSize} bytes</div>
            <div>Model data: {mapData.modelSize} bytes</div>
            <div>BDHC data: {mapData.bdhcSize} bytes</div>
            <div>Buildings: {mapData.buildings.length}</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Event Panel ──────────────────────────────────────────────

const EVENT_SECTIONS: { key: EventType; label: string; color: string; icon: string }[] = [
  { key: "spawnables", label: "Spawnables / Signs", color: "var(--sign-color)", icon: "S" },
  { key: "overworlds", label: "NPCs / Overworlds", color: "var(--npc-color)", icon: "N" },
  { key: "warps", label: "Warps", color: "var(--warp-color)", icon: "W" },
  { key: "triggers", label: "Triggers", color: "var(--trigger-color)", icon: "T" },
];

const EVENT_FIELDS: Record<EventType, { key: string; label: string }[]> = {
  spawnables: [
    { key: "script", label: "Script" }, { key: "type", label: "Type" },
    { key: "direction", label: "Direction" },
    { key: "x", label: "X" }, { key: "y", label: "Y" }, { key: "z", label: "Z" },
  ],
  overworlds: [
    { key: "id", label: "ID" }, { key: "spriteId", label: "Sprite" },
    { key: "movementType", label: "Movement" }, { key: "type", label: "Type" },
    { key: "flag", label: "Flag" }, { key: "script", label: "Script" },
    { key: "orientation", label: "Facing" }, { key: "sightRange", label: "Sight" },
    { key: "xRange", label: "X Range" }, { key: "yRange", label: "Y Range" },
    { key: "x", label: "X" }, { key: "y", label: "Y" }, { key: "z", label: "Z" },
  ],
  warps: [
    { key: "x", label: "X" }, { key: "y", label: "Y" },
    { key: "targetHeader", label: "Target Map" }, { key: "targetWarp", label: "Target Warp" },
    { key: "height", label: "Height" },
  ],
  triggers: [
    { key: "script", label: "Script" },
    { key: "x", label: "X" }, { key: "y", label: "Y" },
    { key: "width", label: "Width" }, { key: "height", label: "Height" },
    { key: "z", label: "Z" },
    { key: "valueCheck", label: "Value" }, { key: "variable", label: "Variable" },
  ],
};

function EventPanel({ eventData, selectedEvent, onSelectEvent, onEventUpdate, onAddEvent, onDeleteEvent }: Props) {
  if (!eventData) return <div style={{ color: "var(--text-dim)", fontSize: 12 }}>No event data</div>;

  return (
    <div>
      {EVENT_SECTIONS.map(sec => (
        <div key={sec.key} className="prop-group">
          <div className="prop-group-title" style={{ color: sec.color }}>
            {sec.label} ({eventData[sec.key].length})
          </div>
          {(eventData[sec.key] as any[]).map((ev: Record<string, number>, i: number) => {
            const isSelected = selectedEvent?.type === sec.key && selectedEvent?.index === i;
            const summary =
              sec.key === "spawnables" ? `Spawnable (Script ${ev.script}, Type ${ev.type})` :
              sec.key === "overworlds" ? `NPC #${ev.id} (Sprite ${ev.spriteId})` :
              sec.key === "warps" ? `Warp -> Map ${ev.targetHeader}` :
              `Trigger (Script ${ev.script})`;
            return (
              <div key={i}>
                <div
                  className={`event-item ${isSelected ? "active" : ""}`}
                  style={{ borderLeftColor: isSelected ? sec.color : "transparent" }}
                  onClick={() => onSelectEvent({ type: sec.key, index: i })}
                >
                  <div className="event-icon" style={{ background: sec.color }}>{sec.icon}</div>
                  <div className="event-info">
                    <div>{summary}</div>
                    <div className="event-pos">({ev.x}, {ev.y})</div>
                  </div>
                </div>
                {isSelected && (
                  <div style={{ padding: "8px 8px 8px 28px", background: "rgba(0,0,0,0.2)", borderRadius: 4, margin: "2px 0 6px" }}>
                    {EVENT_FIELDS[sec.key].map(f => (
                      <div key={f.key} className="prop-row">
                        <span className="prop-label">{f.label}</span>
                        <input
                          className="prop-input"
                          type="number"
                          value={ev[f.key] ?? 0}
                          onChange={e => onEventUpdate(sec.key, i, f.key, parseInt(e.target.value) || 0)}
                        />
                      </div>
                    ))}
                    <button
                      className="tool-btn danger"
                      style={{ marginTop: 6, width: "100%" }}
                      onClick={() => onDeleteEvent(sec.key, i)}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          <button className="add-event-btn" onClick={() => onAddEvent(sec.key)}>
            + Add {sec.label.split("/")[0].trim()}
          </button>
        </div>
      ))}
    </div>
  );
}

// ─── Encounter Panel ──────────────────────────────────────────

function EncounterPanel({ data }: { data: EncounterData | null }) {
  if (!data) return <div style={{ color: "var(--text-dim)", fontSize: 12 }}>No encounter data for this map</div>;

  return (
    <div>
      {data.walkRate > 0 && (
        <div className="encounter-section">
          <div className="encounter-section-title">Grass (Rate: {data.walkRate})</div>
          {data.grassSlots.map((slot, i) => (
            <div key={i} className="encounter-slot">
              <div className="slot-rate">{GRASS_RATES[i]}%</div>
              <div style={{ flex: 1, fontSize: 12 }}>Species #{slot.species}</div>
              <div style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "monospace" }}>
                Lv.{slot.minLevel}-{slot.maxLevel}
              </div>
            </div>
          ))}
        </div>
      )}
      {data.surfRate > 0 && data.waterSlots.length > 0 && (
        <div className="encounter-section">
          <div className="encounter-section-title">Surf (Rate: {data.surfRate})</div>
          {data.waterSlots.map((slot, i) => (
            <div key={i} className="encounter-slot">
              <div className="slot-rate">#{i}</div>
              <div style={{ flex: 1, fontSize: 12 }}>Species #{slot.species}</div>
              <div style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "monospace" }}>
                Lv.{slot.minLevel}-{slot.maxLevel}
              </div>
            </div>
          ))}
        </div>
      )}
      {data.swarmSpecies?.[0] > 0 && (
        <div className="encounter-section">
          <div className="encounter-section-title">Special Encounters</div>
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
            <div>Swarm: #{data.swarmSpecies.filter(s => s > 0).join(", #")}</div>
            <div>Day: #{data.daySpecies.filter(s => s > 0).join(", #")}</div>
            <div>Night: #{data.nightSpecies.filter(s => s > 0).join(", #")}</div>
            <div>Radar: #{data.radarSpecies.filter(s => s > 0).join(", #")}</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Info Panel ───────────────────────────────────────────────

function InfoPanel({ mapData, eventData, currentMapIdx }: Props) {
  return (
    <div>
      <div className="prop-group">
        <div className="prop-group-title">Current Map</div>
        <div style={{ fontSize: 12 }}>
          <div className="prop-row">
            <span className="prop-label">Map Index</span>
            <span style={{ fontFamily: "monospace" }}>#{currentMapIdx}</span>
          </div>
          {mapData && (
            <>
              <div className="prop-row"><span className="prop-label">Grid Size</span><span>{mapData.permissions.width} x {mapData.permissions.height}</span></div>
              <div className="prop-row"><span className="prop-label">Perm Size</span><span style={{ fontFamily: "monospace" }}>{mapData.permissionSize} bytes</span></div>
              <div className="prop-row"><span className="prop-label">Model Size</span><span style={{ fontFamily: "monospace" }}>{mapData.modelSize} bytes</span></div>
              <div className="prop-row"><span className="prop-label">Buildings</span><span>{mapData.buildings.length}</span></div>
            </>
          )}
          {eventData && (
            <>
              <div className="prop-row"><span className="prop-label">Spawnables</span><span>{eventData.spawnables.length}</span></div>
              <div className="prop-row"><span className="prop-label">NPCs</span><span>{eventData.overworlds.length}</span></div>
              <div className="prop-row"><span className="prop-label">Warps</span><span>{eventData.warps.length}</span></div>
              <div className="prop-row"><span className="prop-label">Triggers</span><span>{eventData.triggers.length}</span></div>
            </>
          )}
        </div>
      </div>
      <div className="prop-group">
        <div className="prop-group-title">Keyboard Shortcuts</div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.8 }}>
          <div><b>P</b> — Paint tool</div>
          <div><b>F</b> — Fill tool</div>
          <div><b>I</b> — Pick tool</div>
          <div><b>E</b> — Event tool</div>
          <div><b>Alt+Drag</b> — Pan view</div>
          <div><b>Scroll</b> — Zoom in/out</div>
          <div><b>Ctrl/Cmd+S</b> — Save ROM</div>
          <div><b>3</b> — Toggle 2D / 3D view</div>
        </div>
      </div>
      {mapData && mapData.buildings.length > 0 && (
        <div className="prop-group">
          <div className="prop-group-title">Building List</div>
          <div style={{ fontSize: 11 }}>
            {mapData.buildings.map((b, i) => {
              const pos = getBuildingWorldPos(b);
              return (
                <div key={i} style={{ padding: "3px 0", borderBottom: "1px solid var(--border)" }}>
                  <span style={{ color: "var(--accent3)" }}>#{i}</span> Model {b.modelId}
                  <span style={{ color: "var(--text-dim)", marginLeft: 8 }}>
                    ({pos.x.toFixed(1)}, {pos.y.toFixed(1)}, {pos.z.toFixed(1)})
                  </span>
                  {b.yRotation !== 0 && (
                    <span style={{ color: "var(--text-dim)", marginLeft: 4 }}>
                      rot:{rotU16ToDeg(b.yRotation).toFixed(0)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
