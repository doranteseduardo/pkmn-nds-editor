/**
 * DPPt map matrix parser.
 * Map matrices define the spatial layout of the overworld,
 * mapping grid cells to individual map IDs.
 */

import { BinaryReader } from "./binary";

// ─── Types ───────────────────────────────────────────────────

export interface MapMatrix {
  width: number;
  height: number;
  hasHeaders: boolean;
  hasHeights: boolean;
  mapIds: Uint16Array;
}

// ─── Parser ──────────────────────────────────────────────────

export function parseMapMatrix(buffer: ArrayBuffer): MapMatrix | null {
  if (!buffer || buffer.byteLength < 8) return null;
  const r = new BinaryReader(buffer);

  const width = r.u8();
  const height = r.u8();
  const hasHeaders = r.u8() !== 0;
  const hasHeights = r.u8() !== 0;

  // Skip to data (offset varies slightly; common start is byte 8)
  r.seek(8);

  const gridSize = width * height;
  const mapIds = new Uint16Array(gridSize);

  for (let i = 0; i < gridSize && r.remaining() >= 2; i++) {
    mapIds[i] = r.u16();
  }

  return { width, height, hasHeaders, hasHeights, mapIds };
}
