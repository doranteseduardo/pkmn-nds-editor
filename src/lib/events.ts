/**
 * DPPt event data parser and serializer.
 *
 * Each event file contains 4 event types:
 *   - Overworlds (NPCs): characters that walk around the map
 *   - Warps: tiles that teleport the player to another map
 *   - Triggers: invisible rectangles that fire scripts when stepped on
 *   - Signs: interaction points (signposts, bookshelves, etc.)
 *
 * Header: [overworld_count(u32), warp_count(u32), trigger_count(u32), sign_count(u32)]
 * Then each section's entries follow sequentially.
 */

import { BinaryReader, BinaryWriter } from "./binary";

// ─── Types ───────────────────────────────────────────────────

export interface Overworld {
  id: number;
  spriteId: number;
  movementType: number;
  type: number;
  flag: number;
  script: number;
  orientation: number;
  sightRange: number;
  _unk1: number;
  _unk2: number;
  xRange: number;
  yRange: number;
  x: number;
  y: number;
  z: number;
  _pad: number;
}

export interface Warp {
  x: number;
  y: number;
  targetHeader: number;
  targetWarp: number;
  contactDir: number;
  transType: number;
}

export interface Trigger {
  script: number;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  valueCheck: number;
  variable: number;
}

export interface Sign {
  script: number;
  type: number;
  _unk: number;
  x: number;
  y: number;
  z: number;
}

export interface EventData {
  overworlds: Overworld[];
  warps: Warp[];
  triggers: Trigger[];
  signs: Sign[];
}

export type EventType = keyof EventData;

// ─── Default Templates ───────────────────────────────────────

export function createDefaultOverworld(id: number): Overworld {
  return {
    id, spriteId: 0, movementType: 0, type: 1,
    flag: 0, script: 0, orientation: 0, sightRange: 0,
    _unk1: 0, _unk2: 0, xRange: 0, yRange: 0,
    x: 16, y: 16, z: 0, _pad: 0,
  };
}

export function createDefaultWarp(): Warp {
  return { x: 16, y: 16, targetHeader: 0, targetWarp: 0, contactDir: 0, transType: 0 };
}

export function createDefaultTrigger(): Trigger {
  return { script: 0, x: 16, y: 16, width: 1, height: 1, z: 0, valueCheck: 0, variable: 0 };
}

export function createDefaultSign(): Sign {
  return { script: 0, type: 0, _unk: 0, x: 16, y: 16, z: 0 };
}

// ─── Parser ──────────────────────────────────────────────────

export function parseEventData(buffer: ArrayBuffer): EventData {
  const empty: EventData = { overworlds: [], warps: [], triggers: [], signs: [] };
  if (!buffer || buffer.byteLength < 16) return empty;

  const r = new BinaryReader(buffer);

  const owCount = r.u32();
  const warpCount = r.u32();
  const trigCount = r.u32();
  const signCount = r.u32();

  const overworlds: Overworld[] = [];
  for (let i = 0; i < owCount && i < 64; i++) {
    overworlds.push({
      id: r.u16(), spriteId: r.u16(),
      movementType: r.u16(), type: r.u16(),
      flag: r.u16(), script: r.u16(),
      orientation: r.u16(), sightRange: r.u16(),
      _unk1: r.u16(), _unk2: r.u16(),
      xRange: r.u16(), yRange: r.u16(),
      x: r.i16(), y: r.i16(),
      z: r.i16(), _pad: r.u16(),
    });
  }

  const warps: Warp[] = [];
  for (let i = 0; i < warpCount && i < 64; i++) {
    warps.push({
      x: r.i16(), y: r.i16(),
      targetHeader: r.u16(), targetWarp: r.u16(),
      contactDir: r.u16(), transType: r.u16(),
    });
  }

  const triggers: Trigger[] = [];
  for (let i = 0; i < trigCount && i < 64; i++) {
    triggers.push({
      script: r.u16(), x: r.i16(),
      y: r.i16(), width: r.u16(),
      height: r.u16(), z: r.i16(),
      valueCheck: r.u16(), variable: r.u16(),
    });
  }

  const signs: Sign[] = [];
  for (let i = 0; i < signCount && i < 64; i++) {
    signs.push({
      script: r.u16(), type: r.u16(),
      _unk: r.u16(), x: r.i16(),
      y: r.i16(), z: r.i16(),
    });
  }

  return { overworlds, warps, triggers, signs };
}

// ─── Serializer ──────────────────────────────────────────────

export function serializeEventData(events: EventData): ArrayBuffer {
  const size =
    16 +
    events.overworlds.length * 32 +
    events.warps.length * 12 +
    events.triggers.length * 16 +
    events.signs.length * 12;

  const w = new BinaryWriter(size);

  // Header
  w.writeU32(events.overworlds.length);
  w.writeU32(events.warps.length);
  w.writeU32(events.triggers.length);
  w.writeU32(events.signs.length);

  // Overworlds
  for (const ow of events.overworlds) {
    w.writeU16(ow.id); w.writeU16(ow.spriteId);
    w.writeU16(ow.movementType); w.writeU16(ow.type);
    w.writeU16(ow.flag); w.writeU16(ow.script);
    w.writeU16(ow.orientation); w.writeU16(ow.sightRange);
    w.writeU16(ow._unk1); w.writeU16(ow._unk2);
    w.writeU16(ow.xRange); w.writeU16(ow.yRange);
    w.writeI16(ow.x); w.writeI16(ow.y);
    w.writeI16(ow.z); w.writeU16(ow._pad);
  }

  // Warps
  for (const wp of events.warps) {
    w.writeI16(wp.x); w.writeI16(wp.y);
    w.writeU16(wp.targetHeader); w.writeU16(wp.targetWarp);
    w.writeU16(wp.contactDir); w.writeU16(wp.transType);
  }

  // Triggers
  for (const tr of events.triggers) {
    w.writeU16(tr.script); w.writeI16(tr.x);
    w.writeI16(tr.y); w.writeU16(tr.width);
    w.writeU16(tr.height); w.writeI16(tr.z);
    w.writeU16(tr.valueCheck); w.writeU16(tr.variable);
  }

  // Signs
  for (const sg of events.signs) {
    w.writeU16(sg.script); w.writeU16(sg.type);
    w.writeU16(sg._unk); w.writeI16(sg.x);
    w.writeI16(sg.y); w.writeI16(sg.z);
  }

  return w.buffer;
}
