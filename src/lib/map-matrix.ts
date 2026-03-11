/**
 * DPPt map matrix parser.
 *
 * Based on DSPRE's GameMatrix format:
 *   [0x00] width (u8)
 *   [0x01] height (u8)
 *   [0x02] hasHeaders (u8) — bool
 *   [0x03] hasHeights (u8) — bool
 *   [0x04] nameLength (u8)
 *   [0x05] name (nameLength bytes, UTF-8)
 *   [if hasHeaders] headers section: u16[height][width]
 *   [if hasHeights] altitudes section: u8[height][width]
 *   mapIds section: u16[height][width]
 */

import { BinaryReader } from "./binary";

// ─── Types ───────────────────────────────────────────────────

export interface MapMatrix {
  width: number;
  height: number;
  hasHeaders: boolean;
  hasHeights: boolean;
  name: string;
  headers: Uint16Array | null;
  altitudes: Uint8Array | null;
  mapIds: Uint16Array;
}

// ─── Parser ──────────────────────────────────────────────────

export function parseMapMatrix(buffer: ArrayBuffer): MapMatrix | null {
  if (!buffer || buffer.byteLength < 5) return null;
  const r = new BinaryReader(buffer);

  const width = r.u8();
  const height = r.u8();
  const hasHeaders = r.u8() !== 0;
  const hasHeights = r.u8() !== 0;
  const nameLength = r.u8();

  // Read name string
  let name = "";
  if (nameLength > 0 && r.canRead(nameLength)) {
    name = r.str(nameLength);
  }

  const gridSize = width * height;
  if (gridSize === 0 || gridSize > 4096) {
    console.warn(`Invalid matrix dimensions: ${width}x${height}`);
    return null;
  }

  // Optional headers section (u16 per cell)
  let headers: Uint16Array | null = null;
  if (hasHeaders && r.canRead(gridSize * 2)) {
    headers = new Uint16Array(gridSize);
    for (let i = 0; i < gridSize; i++) {
      headers[i] = r.u16();
    }
  }

  // Optional altitudes section (u8 per cell)
  let altitudes: Uint8Array | null = null;
  if (hasHeights && r.canRead(gridSize)) {
    altitudes = new Uint8Array(gridSize);
    for (let i = 0; i < gridSize; i++) {
      altitudes[i] = r.u8();
    }
  }

  // Map IDs section (u16 per cell)
  const mapIds = new Uint16Array(gridSize);
  for (let i = 0; i < gridSize && r.canRead(2); i++) {
    mapIds[i] = r.u16();
  }

  return { width, height, hasHeaders, hasHeights, name, headers, altitudes, mapIds };
}
