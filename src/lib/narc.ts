/**
 * NARC (Nitro ARChive) parser and builder.
 * NARC is the archive format used by NDS games to bundle multiple files.
 * Structure: Header → BTAF (file allocation) → BTNF (file names) → GMIF (file data)
 */

import { BinaryReader, BinaryWriter, alignUp } from "./binary";

// ─── Types ───────────────────────────────────────────────────

export interface NARCFile {
  index: number;
  data: ArrayBuffer;
  size: number;
}

export interface NARC {
  fileCount: number;
  files: NARCFile[];
}

// ─── Parser ──────────────────────────────────────────────────

export function parseNARC(buffer: ArrayBuffer): NARC {
  const r = new BinaryReader(buffer);
  const bufLen = buffer.byteLength;

  if (bufLen < 16) {
    throw new Error(`Buffer too small for NARC header (${bufLen} bytes)`);
  }

  // NARC header (16 bytes)
  const magic = r.str(4);
  if (magic !== "NARC") {
    throw new Error(`Not a NARC file (magic: "${magic}")`);
  }

  r.skip(2); // BOM (0xFFFE)
  r.skip(2); // version (0x0100)
  r.skip(4); // file size
  r.skip(2); // header size (0x0010)
  r.skip(2); // chunk count (3)

  // BTAF chunk (File Allocation Table Block)
  if (!r.canRead(12)) {
    throw new Error("NARC truncated before BTAF chunk");
  }
  const btafMagic = r.str(4);
  if (btafMagic !== "BTAF") {
    throw new Error(`Expected BTAF, got "${btafMagic}"`);
  }
  r.skip(4); // chunk size
  const fileCount = r.u16();
  r.skip(2); // reserved

  // Sanity check file count
  if (fileCount > 65535 || !r.canRead(fileCount * 8)) {
    throw new Error(`Invalid NARC file count (${fileCount}) or truncated BTAF entries`);
  }

  const entries: { start: number; end: number }[] = [];
  for (let i = 0; i < fileCount; i++) {
    entries.push({ start: r.u32(), end: r.u32() });
  }

  // BTNF chunk (File Name Table Block)
  if (!r.canRead(8)) {
    throw new Error("NARC truncated before BTNF chunk");
  }
  const btnfMagic = r.str(4);
  if (btnfMagic !== "BTNF") {
    throw new Error(`Expected BTNF, got "${btnfMagic}"`);
  }
  const btnfSize = r.u32();
  if (btnfSize < 8) {
    throw new Error(`Invalid BTNF size: ${btnfSize}`);
  }
  r.skip(btnfSize - 8); // Skip name data

  // GMIF chunk (File Image Block)
  if (!r.canRead(8)) {
    throw new Error("NARC truncated before GMIF chunk");
  }
  const gmifMagic = r.str(4);
  if (gmifMagic !== "GMIF") {
    throw new Error(`Expected GMIF, got "${gmifMagic}"`);
  }
  r.skip(4); // chunk size
  const gmifDataStart = r.tell();

  // Extract files with bounds checking
  const files: NARCFile[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const absStart = gmifDataStart + e.start;
    const absEnd = gmifDataStart + e.end;
    // Clamp to buffer bounds
    const safeStart = Math.min(absStart, bufLen);
    const safeEnd = Math.min(absEnd, bufLen);
    if (safeStart >= safeEnd) {
      files.push({ index: i, data: new ArrayBuffer(0), size: 0 });
    } else {
      files.push({
        index: i,
        data: buffer.slice(safeStart, safeEnd),
        size: safeEnd - safeStart,
      });
    }
  }

  return { fileCount, files };
}

// ─── Builder ─────────────────────────────────────────────────

/** Rebuild a NARC archive from an array of file buffers. */
export function rebuildNARC(fileBuffers: ArrayBuffer[]): ArrayBuffer {
  const fileCount = fileBuffers.length;

  // Calculate aligned file offsets within GMIF
  let gmifDataSize = 0;
  const fileOffsets: { start: number; end: number }[] = [];
  for (const buf of fileBuffers) {
    const size = buf.byteLength;
    fileOffsets.push({ start: gmifDataSize, end: gmifDataSize + size });
    gmifDataSize = alignUp(gmifDataSize + size, 4);
  }

  // Chunk sizes
  const btafChunkSize = 8 + 4 + fileCount * 8; // magic(4) + size(4) + count(2) + reserved(2) + entries
  const btnfChunkSize = 16; // Minimal BTNF
  const gmifChunkSize = 8 + gmifDataSize;
  const totalSize = 16 + btafChunkSize + btnfChunkSize + gmifChunkSize;

  const w = new BinaryWriter(totalSize);

  // NARC header
  w.writeStr("NARC");
  w.writeU16(0xFFFE); // BOM
  w.writeU16(0x0100); // version
  w.writeU32(totalSize);
  w.writeU16(0x0010); // header size
  w.writeU16(3); // chunk count

  // BTAF
  w.writeStr("BTAF");
  w.writeU32(btafChunkSize);
  w.writeU16(fileCount);
  w.writeU16(0); // reserved
  for (const fo of fileOffsets) {
    w.writeU32(fo.start);
    w.writeU32(fo.end);
  }

  // BTNF (minimal)
  w.writeStr("BTNF");
  w.writeU32(btnfChunkSize);
  w.writeU32(4); // sub-table offset
  w.writeU16(0); // first file ID
  w.writeU16(1); // total directories

  // GMIF
  w.writeStr("GMIF");
  w.writeU32(gmifChunkSize);
  for (let i = 0; i < fileBuffers.length; i++) {
    const data = new Uint8Array(fileBuffers[i]);
    w.writeBytes(data);
    // Pad to 4-byte alignment
    const padLen = (4 - (data.length % 4)) % 4;
    for (let p = 0; p < padLen; p++) w.writeU8(0xFF);
  }

  return w.buffer;
}
