/**
 * DPPt event data parser and serializer.
 *
 * Based on DSPRE's EventFile format: each event type's count
 * appears immediately before its data (NOT all counts at the start).
 *
 * File layout:
 *   [spawnable_count (u32)] [spawnable_data × count]  (20 bytes each)
 *   [overworld_count (u32)] [overworld_data × count]  (32 bytes each)
 *   [warp_count (u32)]      [warp_data × count]       (12 bytes each)
 *   [trigger_count (u32)]   [trigger_data × count]    (16 bytes each)
 *
 * Event types:
 *   - Spawnables: misc objects, signposts, hidden items (20 bytes)
 *   - Overworlds (NPCs): characters with movement/scripts (32 bytes)
 *   - Warps: tiles that teleport to another map (12 bytes)
 *   - Triggers: invisible rectangles that fire scripts (16 bytes)
 */

import { BinaryReader, BinaryWriter } from "./binary";

// ─── Types ───────────────────────────────────────────────────

export interface Spawnable {
  script: number;
  type: number;      // 0=misc, 1=board/sign, 2=hidden item
  x: number;         // compound coordinate (mapPos + 32*matrixPos)
  _unk1: number;
  y: number;         // compound coordinate
  z: number;         // i32 fixed-point
  _unk2: number;
  direction: number;
  _unk3: number;
}

export interface Overworld {
  id: number;
  spriteId: number;      // overlayTableEntry
  movementType: number;
  type: number;          // 0=normal, 1=trainer, 3=item
  flag: number;
  script: number;
  orientation: number;
  sightRange: number;
  _unk1: number;
  _unk2: number;
  xRange: number;
  yRange: number;
  x: number;             // compound i16
  y: number;             // compound i16
  z: number;             // i32 fixed-point
}

export interface Warp {
  x: number;             // compound i16
  y: number;             // compound i16
  targetHeader: number;  // destination map header
  targetWarp: number;    // destination warp anchor
  height: number;        // u32 (z-height)
}

export interface Trigger {
  script: number;
  x: number;             // compound i16
  y: number;             // compound i16
  width: number;
  height: number;
  z: number;
  valueCheck: number;
  variable: number;
}

export interface EventData {
  spawnables: Spawnable[];
  overworlds: Overworld[];
  warps: Warp[];
  triggers: Trigger[];
}

export type EventType = keyof EventData;

// ─── Default Templates ───────────────────────────────────────

export function createDefaultSpawnable(): Spawnable {
  return {
    script: 0, type: 1, x: 16, _unk1: 0, y: 16,
    z: 0, _unk2: 0, direction: 0, _unk3: 0,
  };
}

export function createDefaultOverworld(id: number): Overworld {
  return {
    id, spriteId: 1, movementType: 0, type: 0,
    flag: 0, script: 0, orientation: 1, sightRange: 0,
    _unk1: 0, _unk2: 0, xRange: 0, yRange: 0,
    x: 16, y: 16, z: 0,
  };
}

export function createDefaultWarp(): Warp {
  return { x: 16, y: 16, targetHeader: 0, targetWarp: 0, height: 0 };
}

export function createDefaultTrigger(): Trigger {
  return { script: 0, x: 16, y: 16, width: 1, height: 1, z: 0, valueCheck: 0, variable: 0 };
}

// ─── Parser ──────────────────────────────────────────────────

export function parseEventData(buffer: ArrayBuffer): EventData {
  const empty: EventData = { spawnables: [], overworlds: [], warps: [], triggers: [] };
  if (!buffer || buffer.byteLength < 4) return empty;

  const r = new BinaryReader(buffer);

  // Spawnables: count then data (20 bytes each)
  const spawnCount = r.canRead(4) ? r.u32() : 0;
  const spawnables: Spawnable[] = [];
  for (let i = 0; i < spawnCount && i < 64 && r.canRead(20); i++) {
    spawnables.push({
      script: r.u16(),
      type: r.u16(),
      x: r.i16(),
      _unk1: r.u16(),
      y: r.i16(),
      z: r.i32(),
      _unk2: r.u16(),
      direction: r.u16(),
      _unk3: r.u16(),
    });
  }

  // Overworlds: count then data (32 bytes each)
  const owCount = r.canRead(4) ? r.u32() : 0;
  const overworlds: Overworld[] = [];
  for (let i = 0; i < owCount && i < 64 && r.canRead(32); i++) {
    overworlds.push({
      id: r.u16(),
      spriteId: r.u16(),
      movementType: r.u16(),
      type: r.u16(),
      flag: r.u16(),
      script: r.u16(),
      orientation: r.u16(),
      sightRange: r.u16(),
      _unk1: r.u16(),
      _unk2: r.u16(),
      xRange: r.u16(),
      yRange: r.u16(),
      x: r.i16(),
      y: r.i16(),
      z: r.i32(),  // 4 bytes, not i16+pad
    });
  }

  // Warps: count then data (12 bytes each)
  const warpCount = r.canRead(4) ? r.u32() : 0;
  const warps: Warp[] = [];
  for (let i = 0; i < warpCount && i < 64 && r.canRead(12); i++) {
    warps.push({
      x: r.i16(),
      y: r.i16(),
      targetHeader: r.u16(),
      targetWarp: r.u16(),
      height: r.u32(),
    });
  }

  // Triggers: count then data (16 bytes each)
  const trigCount = r.canRead(4) ? r.u32() : 0;
  const triggers: Trigger[] = [];
  for (let i = 0; i < trigCount && i < 64 && r.canRead(16); i++) {
    triggers.push({
      script: r.u16(),
      x: r.i16(),
      y: r.i16(),
      width: r.u16(),
      height: r.u16(),
      z: r.u16(),
      valueCheck: r.u16(),
      variable: r.u16(),
    });
  }

  return { spawnables, overworlds, warps, triggers };
}

// ─── Serializer ──────────────────────────────────────────────

export function serializeEventData(events: EventData): ArrayBuffer {
  const size =
    4 + events.spawnables.length * 20 +
    4 + events.overworlds.length * 32 +
    4 + events.warps.length * 12 +
    4 + events.triggers.length * 16;

  const w = new BinaryWriter(size);

  // Spawnables
  w.writeU32(events.spawnables.length);
  for (const sp of events.spawnables) {
    w.writeU16(sp.script); w.writeU16(sp.type);
    w.writeI16(sp.x); w.writeU16(sp._unk1);
    w.writeI16(sp.y); w.writeI32(sp.z);
    w.writeU16(sp._unk2); w.writeU16(sp.direction);
    w.writeU16(sp._unk3);
  }

  // Overworlds
  w.writeU32(events.overworlds.length);
  for (const ow of events.overworlds) {
    w.writeU16(ow.id); w.writeU16(ow.spriteId);
    w.writeU16(ow.movementType); w.writeU16(ow.type);
    w.writeU16(ow.flag); w.writeU16(ow.script);
    w.writeU16(ow.orientation); w.writeU16(ow.sightRange);
    w.writeU16(ow._unk1); w.writeU16(ow._unk2);
    w.writeU16(ow.xRange); w.writeU16(ow.yRange);
    w.writeI16(ow.x); w.writeI16(ow.y);
    w.writeI32(ow.z);
  }

  // Warps
  w.writeU32(events.warps.length);
  for (const wp of events.warps) {
    w.writeI16(wp.x); w.writeI16(wp.y);
    w.writeU16(wp.targetHeader); w.writeU16(wp.targetWarp);
    w.writeU32(wp.height);
  }

  // Triggers
  w.writeU32(events.triggers.length);
  for (const tr of events.triggers) {
    w.writeU16(tr.script); w.writeI16(tr.x);
    w.writeI16(tr.y); w.writeU16(tr.width);
    w.writeU16(tr.height); w.writeU16(tr.z);
    w.writeU16(tr.valueCheck); w.writeU16(tr.variable);
  }

  return w.buffer;
}
