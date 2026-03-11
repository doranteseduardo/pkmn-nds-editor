/**
 * DPPt encounter data parser and serializer.
 * Handles grass, surf, and special encounter slots.
 */

import { BinaryReader, BinaryWriter } from "./binary";

// ─── Types ───────────────────────────────────────────────────

export interface EncounterSlot {
  maxLevel: number;
  minLevel: number;
  species: number;
}

export interface EncounterData {
  walkRate: number;
  grassSlots: EncounterSlot[];
  swarmSpecies: number[];
  daySpecies: number[];
  nightSpecies: number[];
  radarSpecies: number[];
  /** Padding/form data between radar and surf */
  _formData: number[];
  surfRate: number;
  waterSlots: EncounterSlot[];
}

/** Standard grass encounter rate distribution (12 slots). */
export const GRASS_RATES = [20, 20, 10, 10, 10, 10, 5, 5, 4, 4, 1, 1];

// ─── Parser ──────────────────────────────────────────────────

export function parseEncounterData(buffer: ArrayBuffer): EncounterData | null {
  if (!buffer || buffer.byteLength < 4) return null;
  const r = new BinaryReader(buffer);

  const walkRate = r.u32();

  const grassSlots: EncounterSlot[] = [];
  for (let i = 0; i < 12; i++) {
    grassSlots.push({
      maxLevel: r.u32(),
      minLevel: r.u32(),
      species: r.u32() & 0xFFFF,
    });
  }

  // Swarm / day / night / radar replacement species
  const swarmSpecies = [r.u32() & 0xFFFF, r.u32() & 0xFFFF];
  const daySpecies = [r.u32() & 0xFFFF, r.u32() & 0xFFFF];
  const nightSpecies = [r.u32() & 0xFFFF, r.u32() & 0xFFFF];
  const radarSpecies = [
    r.u32() & 0xFFFF, r.u32() & 0xFFFF,
    r.u32() & 0xFFFF, r.u32() & 0xFFFF,
  ];

  // Water encounters
  let waterSlots: EncounterSlot[] = [];
  let surfRate = 0;
  const _formData: number[] = [];

  if (r.remaining() >= 44) {
    // 2 u32 values (padding/form data) before surf rate
    _formData.push(r.u32(), r.u32());
    surfRate = r.u32();
    for (let i = 0; i < 5; i++) {
      waterSlots.push({
        maxLevel: r.u32(),
        minLevel: r.u32(),
        species: r.u32() & 0xFFFF,
      });
    }
  }

  return {
    walkRate,
    grassSlots,
    swarmSpecies,
    daySpecies,
    nightSpecies,
    radarSpecies,
    _formData,
    surfRate,
    waterSlots,
  };
}

// ─── Serializer ──────────────────────────────────────────────

export function serializeEncounterData(data: EncounterData): ArrayBuffer {
  // Base size: walkRate(4) + 12 grass slots(12*12=144) + special(10*4=40) = 188
  // + optional form data(8) + surfRate(4) + 5 water slots(5*12=60) = 72
  const hasWater = data.surfRate > 0 || data.waterSlots.length > 0;
  const size = 188 + (hasWater ? 72 : 0);
  const w = new BinaryWriter(size);

  w.writeU32(data.walkRate);

  // 12 grass slots
  for (let i = 0; i < 12; i++) {
    const slot = data.grassSlots[i] ?? { maxLevel: 0, minLevel: 0, species: 0 };
    w.writeU32(slot.maxLevel);
    w.writeU32(slot.minLevel);
    w.writeU32(slot.species);
  }

  // Special species
  for (let i = 0; i < 2; i++) w.writeU32(data.swarmSpecies[i] ?? 0);
  for (let i = 0; i < 2; i++) w.writeU32(data.daySpecies[i] ?? 0);
  for (let i = 0; i < 2; i++) w.writeU32(data.nightSpecies[i] ?? 0);
  for (let i = 0; i < 4; i++) w.writeU32(data.radarSpecies[i] ?? 0);

  // Water section
  if (hasWater) {
    w.writeU32(data._formData[0] ?? 0);
    w.writeU32(data._formData[1] ?? 0);
    w.writeU32(data.surfRate);
    for (let i = 0; i < 5; i++) {
      const slot = data.waterSlots[i] ?? { maxLevel: 0, minLevel: 0, species: 0 };
      w.writeU32(slot.maxLevel);
      w.writeU32(slot.minLevel);
      w.writeU32(slot.species);
    }
  }

  return w.buffer;
}
