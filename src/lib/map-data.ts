/**
 * DPPt map data parser and serializer.
 *
 * Based on DSPRE's MapFile format:
 *   [0x00] permission_size (u32) — always 2048 (32×32×2 bytes)
 *   [0x04] building_size (u32)   — buildingCount * 48
 *   [0x08] model_size (u32)      — NSBMD 3D model
 *   [0x0C] bdhc_size (u32)       — height/collision
 *
 * Permissions: byte pairs (type_byte, collision_byte) per tile.
 *   - type: terrain type (grass, water, sand, etc.)
 *   - collision: 0x00=walkable, 0x80=blocked
 *
 * Buildings: 48 bytes each, NO count prefix (count = buildingSize / 48).
 *   Layout per DSPRE source:
 *     0x00 modelID (u32)
 *     0x04 xFrac(u16) xPos(i16) yFrac(u16) yPos(i16) zFrac(u16) zPos(i16)
 *     0x10 xRot(u16+skip2) yRot(u16+skip2) zRot(u16+skip2)
 *     0x1C skip(1)
 *     0x1D width(u16+skip2) height(u16+skip2) length(u16+skip2)
 *     0x29 padding(7 bytes)
 *     Total: 48 bytes
 */

import { BinaryReader, BinaryWriter } from "./binary";

// ─── Types ───────────────────────────────────────────────────

export interface PermissionGrid {
  width: number;
  height: number;
  tiles: Uint16Array;  // u16 per tile: low byte=type, high byte=collision
}

export interface Building {
  modelId: number;
  xFraction: number;
  xPosition: number;
  yFraction: number;
  yPosition: number;
  zFraction: number;
  zPosition: number;
  xRotation: number;
  yRotation: number;
  zRotation: number;
  width: number;
  height: number;
  length: number;
}

export interface MapData {
  permissionSize: number;
  buildingSize: number;
  modelSize: number;
  bdhcSize: number;
  permissions: PermissionGrid;
  buildings: Building[];
  /** Raw model data (NSBMD) */
  modelData: ArrayBuffer | null;
  /** Raw BDHC data */
  bdhcData: ArrayBuffer | null;
  /** Keep the raw buffer for rebuilding */
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
  { value: 0x80, label: "Blocked", color: "#8b2252", shortLabel: "B" },
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
  { value: 0x01, label: "Wall / Impassable", color: "#374151", shortLabel: "X" },
];

export function getPermColor(value: number): string {
  // Low byte = type, high byte = collision
  const type = value & 0xFF;
  const collision = (value >> 8) & 0xFF;
  const match = PERM_TYPES.find(p => p.value === type);
  if (match) return match.color;
  // If collision byte set (0x80), show as blocked
  if (collision === 0x80) return "#8b2252";
  if (type & 0x04) return "#2563eb";
  if (type & 0x08) return "#16a34a";
  return "#3a5c3e";
}

export function getPermLabel(value: number): string {
  const type = value & 0xFF;
  const collision = (value >> 8) & 0xFF;
  const match = PERM_TYPES.find(p => p.value === type);
  const typeName = match ? match.label : `Type 0x${type.toString(16).toUpperCase().padStart(2, "0")}`;
  const collName = collision === 0x80 ? " [Blocked]" : collision > 0 ? ` [Col 0x${collision.toString(16).toUpperCase()}]` : "";
  return typeName + collName;
}

/** Get the terrain type byte (low byte) */
export function getPermType(value: number): number { return value & 0xFF; }

/** Get the collision byte (high byte) */
export function getPermCollision(value: number): number { return (value >> 8) & 0xFF; }

/** Compose a permission value from type + collision */
export function makePermValue(type: number, collision: number): number {
  return (type & 0xFF) | ((collision & 0xFF) << 8);
}

// ─── Parser ──────────────────────────────────────────────────

export function parseMapData(buffer: ArrayBuffer): MapData | null {
  if (buffer.byteLength < 16) return null;
  const r = new BinaryReader(buffer);

  const permissionSize = r.u32();
  const buildingSize = r.u32();
  const modelSize = r.u32();
  const bdhcSize = r.u32();

  // Sanity check
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

  // Extract raw model data
  const modelOffset = buildingOffset + buildingSize;
  let modelData: ArrayBuffer | null = null;
  if (modelSize > 0 && modelOffset + modelSize <= buffer.byteLength) {
    modelData = buffer.slice(modelOffset, modelOffset + modelSize);
  }

  // Extract raw BDHC data
  const bdhcOffset = modelOffset + modelSize;
  let bdhcData: ArrayBuffer | null = null;
  if (bdhcSize > 0 && bdhcOffset + bdhcSize <= buffer.byteLength) {
    bdhcData = buffer.slice(bdhcOffset, bdhcOffset + bdhcSize);
  }

  return {
    permissionSize,
    buildingSize,
    modelSize,
    bdhcSize,
    permissions,
    buildings,
    modelData,
    bdhcData,
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

  // Each tile is 2 bytes: type(u8) + collision(u8), read as u16
  const tileCount = Math.min(Math.floor(size / 2), width * height);
  for (let i = 0; i < tileCount; i++) {
    tiles[i] = r.u16();
  }

  return { width, height, tiles };
}

function parseBuildings(buffer: ArrayBuffer, offset: number, size: number): Building[] {
  // No count prefix — count is derived from section size / 48
  if (size < 48) return [];
  const r = new BinaryReader(buffer);
  r.seek(offset);

  const count = Math.floor(size / 48);
  const buildings: Building[] = [];

  for (let i = 0; i < count && i < 64 && r.canRead(48); i++) {
    const modelId = r.u32();         // 0x00 (4)

    const xFraction = r.u16();      // 0x04 (2)
    const xPosition = r.i16();      // 0x06 (2)
    const yFraction = r.u16();      // 0x08 (2)
    const yPosition = r.i16();      // 0x0A (2)
    const zFraction = r.u16();      // 0x0C (2)
    const zPosition = r.i16();      // 0x0E (2)
                                     // subtotal: 16 bytes

    const xRotation = r.u16();      // 0x10 (2)
    r.skip(2);                       // 0x12 (2)
    const yRotation = r.u16();      // 0x14 (2)
    r.skip(2);                       // 0x16 (2)
    const zRotation = r.u16();      // 0x18 (2)
    r.skip(2);                       // 0x1A (2)
                                     // subtotal: 28 bytes

    r.skip(1);                       // 0x1C (1) padding
                                     // subtotal: 29 bytes

    const width = r.u16();          // 0x1D (2)
    r.skip(2);                       // 0x1F (2)
    const height = r.u16();         // 0x21 (2)
    r.skip(2);                       // 0x23 (2)
    const length = r.u16();         // 0x25 (2)
                                     // subtotal: 39 bytes

    r.skip(9);                       // 0x27-0x2F padding to fill 48 bytes

    buildings.push({
      modelId, xFraction, xPosition, yFraction, yPosition,
      zFraction, zPosition, xRotation, yRotation, zRotation,
      width, height, length,
    });
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

export function serializeBuildings(buildings: Building[]): ArrayBuffer {
  const w = new BinaryWriter(buildings.length * 48);
  for (const b of buildings) {
    w.writeU32(b.modelId);           // 0x00

    w.writeU16(b.xFraction);        // 0x04
    w.writeI16(b.xPosition);        // 0x06
    w.writeU16(b.yFraction);        // 0x08
    w.writeI16(b.yPosition);        // 0x0A
    w.writeU16(b.zFraction);        // 0x0C
    w.writeI16(b.zPosition);        // 0x0E

    // Rotations as u16 in 4-byte slots (per DSPRE: written as int)
    w.writeU16(b.xRotation); w.writeU16(0);  // 0x10-0x13
    w.writeU16(b.yRotation); w.writeU16(0);  // 0x14-0x17
    w.writeU16(b.zRotation); w.writeU16(0);  // 0x18-0x1B

    w.writeU8(0);                    // 0x1C padding

    // Scales as u16 in 4-byte slots
    w.writeU16(b.width); w.writeU16(0);      // 0x1D-0x20
    w.writeU16(b.height); w.writeU16(0);     // 0x21-0x24
    w.writeU16(b.length); w.writeU16(0);     // 0x25-0x28

    // Final padding to reach 48 bytes (7 bytes)
    for (let j = 0; j < 7; j++) w.writeU8(0);
  }
  return w.buffer;
}

/**
 * Rebuild a complete map buffer with new permission/building data,
 * keeping the model/bdhc sections from the original.
 */
export function rebuildMapBuffer(original: MapData, newPermBuf: ArrayBuffer, newBuildBuf?: ArrayBuffer): ArrayBuffer {
  const r = new BinaryReader(original.rawBuffer);
  r.seek(0);
  const origPermSize = r.u32();
  const origBuildSize = r.u32();
  const modelSize = r.u32();
  const bdhcSize = r.u32();

  const newPermSize = newPermBuf.byteLength;
  const newBuildSize = newBuildBuf ? newBuildBuf.byteLength : origBuildSize;
  const totalSize = 16 + newPermSize + newBuildSize + modelSize + bdhcSize;
  const w = new BinaryWriter(totalSize);

  // Header
  w.writeU32(newPermSize);
  w.writeU32(newBuildSize);
  w.writeU32(modelSize);
  w.writeU32(bdhcSize);

  // New permissions
  w.writeBytes(new Uint8Array(newPermBuf));

  // Buildings
  if (newBuildBuf) {
    w.writeBytes(new Uint8Array(newBuildBuf));
  } else {
    // Copy original buildings
    const buildStart = 16 + origPermSize;
    if (origBuildSize > 0 && buildStart + origBuildSize <= original.rawBuffer.byteLength) {
      w.writeBytes(new Uint8Array(original.rawBuffer, buildStart, origBuildSize));
    }
  }

  // Copy model + BDHC from original
  const modelStart = 16 + origPermSize + origBuildSize;
  const restSize = modelSize + bdhcSize;
  if (restSize > 0 && modelStart + restSize <= original.rawBuffer.byteLength) {
    w.writeBytes(new Uint8Array(original.rawBuffer, modelStart, restSize));
  }

  return w.buffer;
}

/** Helper: get building world position as floats (fraction / 65536 + position) */
export function getBuildingWorldPos(b: Building): { x: number; y: number; z: number } {
  return {
    x: b.xPosition + b.xFraction / 65536,
    y: b.yPosition + b.yFraction / 65536,
    z: b.zPosition + b.zFraction / 65536,
  };
}

/** Helper: convert u16 rotation to degrees */
export function rotU16ToDeg(u16: number): number {
  return (u16 / 65536) * 360;
}
