/**
 * DPPt encounter data parser.
 * Handles grass, surf, and special encounter slots.
 */

import { BinaryReader } from "./binary";

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
  if (r.remaining() >= 44) {
    r.skip(8); // padding / form data
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
    surfRate,
    waterSlots,
  };
}
