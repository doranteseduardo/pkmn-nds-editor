/**
 * DPPt map data parser and serializer.
 *
 * Each map file in land_data NARC has 4 sections:
 *   [0x00] permission_size (u32)
 *   [0x04] building_size (u32)
 *   [0x08] model_size (u32)  — NSBMD 3D model
 *   [0x0C] bdhc_size (u32)   — height/collision
 *
 * Then the raw data for each section follows sequentially.
 */

import { BinaryReader, BinaryWriter } from "./binary";

// ─── Types ───────────────────────────────────────────────────

export interface PermissionGrid {
  width: number;
  height: number;
  tiles: Uint16Array;
}

export interface Building {
  modelId: number;
  x: number;
  y: number;
  z: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  rotX: number;
  rotY: number;
  rotZ: number;
}

export interface MapData {
  permissionSize: number;
  buildingSize: number;
  modelSize: number;
  bdhcSize: number;
  permissions: PermissionGrid;
  buildings: Building[];
  /** Keep the raw buffer for sections we don't modify (model, bdhc) */
  rawBuffer: ArrayBuffer;
}

// ─── Permission Types ────────────────────────────────────────

export interface PermType {
  value: number;
  label: string;
  color: string;
  shortLabel: string;
}

export const PERM_TYPES: PermType[] = [
  { value: 0x00, label: "Walkable", color: "#4a7c4e", shortLabel: "W" },
  { value: 0x01, label: "Blocked", color: "#8b2252", shortLabel: "B" },
  { value: 0x04, label: "Surf", color: "#2563eb", shortLabel: "S" },
  { value: 0x08, label: "Tall Grass", color: "#16a34a", shortLabel: "G" },
  { value: 0x0C, label: "Sand", color: "#ca8a04", shortLabel: "Sa" },
  { value: 0x10, label: "Ice / Slide", color: "#67e8f9", shortLabel: "I" },
  { value: 0x18, label: "Bridge", color: "#a0522d", shortLabel: "Br" },
  { value: 0x20, label: "Ledge ↓", color: "#dc2626", shortLabel: "L↓" },
  { value: 0x21, label: "Ledge ↑", color: "#dc4444", shortLabel: "L↑" },
  { value: 0x22, label: "Ledge ←", color: "#dc6666", shortLabel: "L←" },
  { value: 0x23, label: "Ledge →", color: "#dc8888", shortLabel: "L→" },
  { value: 0x24, label: "Stairs", color: "#f59e0b", shortLabel: "St" },
  { value: 0x3C, label: "Door / Warp Tile", color: "#7c3aed", shortLabel: "D" },
  { value: 0x80, label: "Wall / Impassable", color: "#374151", shortLabel: "X" },
];

export function getPermColor(value: number): string {
  const low = value & 0xFF;
  const match = PERM_TYPES.find(p => p.value === low);
  if (match) return match.color;
  if ((low & 0x01) || (low & 0x80)) return "#374151";
  if (low & 0x04) return "#2563eb";
  return "#3a5c3e";
}

export function getPermLabel(value: number): string {
  const low = value & 0xFF;
  const match = PERM_TYPES.find(p => p.value === low);
  return match ? match.label : `0x${value.toString(16).toUpperCase().padStart(4, "0")}`;
}

// ─── Parser ──────────────────────────────────────────────────

export function parseMapData(buffer: ArrayBuffer): MapData | null {
  if (buffer.byteLength < 16) return null;
  const r = new BinaryReader(buffer);

  const permissionSize = r.u32();
  const buildingSize = r.u32();
  const modelSize = r.u32();
  const bdhcSize = r.u32();

  // Sanity check: section sizes shouldn't exceed buffer
  const totalClaimed = 16 + permissionSize + buildingSize + modelSize + bdhcSize;
  if (totalClaimed > buffer.byteLength * 2) {
    console.warn(`Map data section sizes seem invalid (total ${totalClaimed} vs buffer ${buffer.byteLength})`);
    return null;
  }

  const dataStart = 16;
  const permissions = parsePermissions(buffer, dataStart, Math.min(permissionSize, buffer.byteLength - dataStart));
  const buildingOffset = dataStart + permissionSize;
  const buildings = buildingOffset < buffer.byteLength
    ? parseBuildings(buffer, buildingOffset, Math.min(buildingSize, buffer.byteLength - buildingOffset))
    : [];

  return {
    permissionSize,
    buildingSize,
    modelSize,
    bdhcSize,
    permissions,
    buildings,
    rawBuffer: buffer,
  };
}

function parsePermissions(buffer: ArrayBuffer, offset: number, size: number): PermissionGrid {
  const width = 32;
  const height = 32;
  const tiles = new Uint16Array(width * height);

  if (size === 0) return { width, height, tiles };

  const r = new BinaryReader(buffer);
  r.seek(offset);

  const tileCount = Math.min(Math.floor(size / 2), width * height);
  for (let i = 0; i < tileCount; i++) {
    tiles[i] = r.u16();
  }

  return { width, height, tiles };
}

function parseBuildings(buffer: ArrayBuffer, offset: number, size: number): Building[] {
  if (size <= 4) return [];
  const r = new BinaryReader(buffer);
  r.seek(offset);

  const count = r.u32();
  const buildings: Building[] = [];

  for (let i = 0; i < count && i < 64; i++) {
    const modelId = r.u32();
    const x = r.i16(); r.skip(2);
    const y = r.i16(); r.skip(2);
    const z = r.i16(); r.skip(2);
    const scaleX = r.u32();
    const scaleY = r.u32();
    const scaleZ = r.u32();
    const rotX = r.u16();
    const rotY = r.u16();
    const rotZ = r.u16();
    r.skip(2); // padding

    buildings.push({ modelId, x, y, z, scaleX, scaleY, scaleZ, rotX, rotY, rotZ });
  }

  return buildings;
}

// ─── Serializers ─────────────────────────────────────────────

export function serializePermissions(perms: PermissionGrid): ArrayBuffer {
  const w = new BinaryWriter(perms.tiles.length * 2);
  for (let i = 0; i < perms.tiles.length; i++) {
    w.writeU16(perms.tiles[i]);
  }
  return w.buffer;
}

/**
 * Rebuild a complete map buffer with new permission data,
 * keeping the building/model/bdhc sections from the original.
 */
export function rebuildMapBuffer(original: MapData, newPermBuf: ArrayBuffer): ArrayBuffer {
  const r = new BinaryReader(original.rawBuffer);
  r.seek(0);
  const origPermSize = r.u32();
  const buildingSize = r.u32();
  const modelSize = r.u32();
  const bdhcSize = r.u32();

  const newPermSize = newPermBuf.byteLength;
  const totalSize = 16 + newPermSize + buildingSize + modelSize + bdhcSize;
  const w = new BinaryWriter(totalSize);

  // Header
  w.writeU32(newPermSize);
  w.writeU32(buildingSize);
  w.writeU32(modelSize);
  w.writeU32(bdhcSize);

  // New permissions
  w.writeBytes(new Uint8Array(newPermBuf));

  // Copy remaining sections from original
  const restStart = 16 + origPermSize;
  const restSize = buildingSize + modelSize + bdhcSize;
  if (restSize > 0 && restStart + restSize <= original.rawBuffer.byteLength) {
    w.writeBytes(new Uint8Array(original.rawBuffer, restStart, restSize));
  }

  return w.buffer;
}
