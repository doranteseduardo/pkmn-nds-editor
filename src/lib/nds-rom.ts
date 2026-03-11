/**
 * NDS ROM file parser.
 * Parses the NDS header, FAT (File Allocation Table), and FNT (File Name Table)
 * to build a virtual filesystem tree.
 */

import { BinaryReader } from "./binary";

// ─── Types ───────────────────────────────────────────────────

export interface FATEntry {
  start: number;
  end: number;
}

export interface FileNode {
  name: string;
  type: "file";
  fileId: number;
  start: number;
  end: number;
}

export interface DirNode {
  name: string;
  type: "dir";
  dirId: number;
  children: (FileNode | DirNode)[];
}

export type FSNode = FileNode | DirNode;

export interface GameInfo {
  name: string;
  region: string;
  version: "diamond" | "pearl" | "platinum";
}

export interface NDSRom {
  buffer: ArrayBuffer;
  title: string;
  gameCode: string;
  makerCode: string;
  gameInfo: GameInfo;
  fat: FATEntry[];
  fntOffset: number;
  fntSize: number;
  fatOffset: number;
  fatSize: number;
  arm9Offset: number;
  arm9Size: number;
  fileTree: DirNode;
  romSize: number;
}

// ─── Game Code Lookup ────────────────────────────────────────

const GAME_CODES: Record<string, GameInfo> = {
  ADAE: { name: "Diamond", region: "US", version: "diamond" },
  ADAJ: { name: "Diamond", region: "JP", version: "diamond" },
  ADAP: { name: "Diamond", region: "EU", version: "diamond" },
  ADAD: { name: "Diamond", region: "DE", version: "diamond" },
  ADAF: { name: "Diamond", region: "FR", version: "diamond" },
  ADAI: { name: "Diamond", region: "IT", version: "diamond" },
  ADAS: { name: "Diamond", region: "ES", version: "diamond" },
  ADAK: { name: "Diamond", region: "KR", version: "diamond" },
  APAE: { name: "Pearl", region: "US", version: "pearl" },
  APAJ: { name: "Pearl", region: "JP", version: "pearl" },
  APAP: { name: "Pearl", region: "EU", version: "pearl" },
  APAD: { name: "Pearl", region: "DE", version: "pearl" },
  APAF: { name: "Pearl", region: "FR", version: "pearl" },
  APAI: { name: "Pearl", region: "IT", version: "pearl" },
  APAS: { name: "Pearl", region: "ES", version: "pearl" },
  APAK: { name: "Pearl", region: "KR", version: "pearl" },
  CPUE: { name: "Platinum", region: "US", version: "platinum" },
  CPUJ: { name: "Platinum", region: "JP", version: "platinum" },
  CPUP: { name: "Platinum", region: "EU", version: "platinum" },
  CPUD: { name: "Platinum", region: "DE", version: "platinum" },
  CPUF: { name: "Platinum", region: "FR", version: "platinum" },
  CPUI: { name: "Platinum", region: "IT", version: "platinum" },
  CPUS: { name: "Platinum", region: "ES", version: "platinum" },
  CPUK: { name: "Platinum", region: "KR", version: "platinum" },
};

export function identifyGame(gameCode: string): GameInfo | null {
  return GAME_CODES[gameCode] ?? null;
}

// ─── ROM Parser ──────────────────────────────────────────────

export function parseNDSRom(buffer: ArrayBuffer): NDSRom {
  if (buffer.byteLength < 0x200) {
    throw new Error(`File too small to be an NDS ROM (${buffer.byteLength} bytes, need at least 512)`);
  }

  const r = new BinaryReader(buffer);

  // --- Header ---
  const title = r.str(12).trim();
  const gameCode = r.str(4);
  const makerCode = r.str(2);
  r.skip(12); // unitcode(1), seed(1), capacity(1), reserved(9) → offset 0x1E

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _romVersion = r.u8();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _autostart = r.u8();

  const arm9Offset = r.u32();
  r.skip(4); // arm9 entry
  r.skip(4); // arm9 ram
  const arm9Size = r.u32();

  r.skip(16); // arm7 offset/entry/ram/size

  const fntOffset = r.u32();
  const fntSize = r.u32();
  const fatOffset = r.u32();
  const fatSize = r.u32();

  // --- Validate header offsets ---
  const bufLen = buffer.byteLength;
  if (fatOffset >= bufLen || fatOffset + fatSize > bufLen) {
    throw new Error(`FAT region out of bounds (offset=0x${fatOffset.toString(16)}, size=0x${fatSize.toString(16)}, ROM=${bufLen})`);
  }
  if (fntOffset >= bufLen) {
    throw new Error(`FNT offset out of bounds (0x${fntOffset.toString(16)})`);
  }

  // --- FAT ---
  const fatCount = Math.floor(fatSize / 8);
  // NDS ROMs typically have <65536 files; guard against corrupt headers
  if (fatCount > 131072) {
    throw new Error(`Suspicious FAT entry count (${fatCount}), ROM may be corrupt`);
  }
  const fat: FATEntry[] = [];
  r.seek(fatOffset);
  for (let i = 0; i < fatCount; i++) {
    if (!r.canRead(8)) break;
    fat.push({ start: r.u32(), end: r.u32() });
  }

  // --- FNT ---
  const fileTree = parseFNT(buffer, fntOffset, fat);

  // --- Game info ---
  const gameInfo: GameInfo = GAME_CODES[gameCode] ?? {
    name: "Unknown",
    region: "?",
    version: "diamond" as const,
  };

  return {
    buffer,
    title,
    gameCode,
    makerCode,
    gameInfo,
    fat,
    fntOffset,
    fntSize,
    fatOffset,
    fatSize,
    arm9Offset,
    arm9Size,
    fileTree,
    romSize: buffer.byteLength,
  };
}

// ─── FNT Parser ──────────────────────────────────────────────

function parseFNT(buffer: ArrayBuffer, fntOffset: number, fat: FATEntry[]): DirNode {
  const r = new BinaryReader(buffer);
  const bufLen = buffer.byteLength;

  // Validate FNT offset is within bounds
  if (fntOffset >= bufLen || fntOffset < 0) {
    console.warn(`FNT offset (0x${fntOffset.toString(16)}) out of bounds`);
    return { name: "/", type: "dir", children: [], dirId: 0 };
  }

  r.seek(fntOffset);

  // Root entry (8 bytes minimum)
  if (!r.canRead(8)) {
    return { name: "/", type: "dir", children: [], dirId: 0 };
  }
  const rootSubOffset = r.u32();
  const rootFirstFileId = r.u16();
  const totalDirs = r.u16();

  // Sanity-check directory count (NDS ROMs rarely have >4096 dirs)
  const safeTotalDirs = Math.min(totalDirs, 4096);
  if (totalDirs > 4096) {
    console.warn(`Suspiciously large FNT dir count (${totalDirs}), clamping to 4096`);
  }

  // Read all directory main table entries
  interface DirEntry { subOffset: number; firstFileId: number; parentId: number; }
  const dirs: DirEntry[] = [{ subOffset: rootSubOffset, firstFileId: rootFirstFileId, parentId: 0 }];
  for (let i = 1; i < safeTotalDirs; i++) {
    if (!r.canRead(8)) break;
    dirs.push({
      subOffset: r.u32(),
      firstFileId: r.u16(),
      parentId: r.u16() & 0xFFF,
    });
  }

  // Create dir nodes
  const root: DirNode = { name: "/", type: "dir", children: [], dirId: 0 };
  const dirNodes: DirNode[] = [root];
  for (let i = 1; i < dirs.length; i++) {
    dirNodes.push({ name: "", type: "dir", children: [], dirId: i });
  }

  // Parse sub-tables
  const MAX_ENTRIES_PER_DIR = 4096; // Safety limit
  for (let d = 0; d < dirs.length; d++) {
    const seekTarget = fntOffset + dirs[d].subOffset;
    // Validate sub-table offset is within buffer
    if (seekTarget >= bufLen || seekTarget < fntOffset) {
      console.warn(`FNT sub-table offset for dir ${d} out of bounds (0x${seekTarget.toString(16)})`);
      continue;
    }
    r.seek(seekTarget);
    let fileId = dirs[d].firstFileId;
    let entryCount = 0;

    while (r.canRead(1) && entryCount < MAX_ENTRIES_PER_DIR) {
      const typeLen = r.u8();
      if (typeLen === 0) break;
      entryCount++;

      const isDir = (typeLen & 0x80) !== 0;
      const nameLen = typeLen & 0x7F;
      if (nameLen === 0 || !r.canRead(nameLen)) break;
      const name = r.str(nameLen);

      if (isDir) {
        if (!r.canRead(2)) break;
        const subDirId = r.u16() & 0xFFF;
        if (subDirId < dirNodes.length) {
          dirNodes[subDirId].name = name;
          dirNodes[d].children.push(dirNodes[subDirId]);
        }
      } else {
        if (fileId < fat.length) {
          const entry = fat[fileId];
          dirNodes[d].children.push({
            name,
            type: "file",
            fileId,
            start: entry?.start ?? 0,
            end: entry?.end ?? 0,
          });
        }
        fileId++;
      }
    }
  }

  return root;
}

// ─── File Utilities ──────────────────────────────────────────

/** Find a file or directory by path (case-insensitive). */
export function findFile(root: DirNode, path: string): FSNode | null {
  const parts = path.split("/").filter(Boolean);
  let current: FSNode = root;

  for (let i = 0; i < parts.length; i++) {
    if (current.type !== "dir") return null;
    const target = parts[i].toLowerCase();
    const child: FSNode | undefined = current.children.find(c => c.name.toLowerCase() === target);
    if (!child) return null;
    current = child;
  }

  return current;
}

/** Extract raw file bytes from ROM. */
export function extractFile(romBuffer: ArrayBuffer, file: FileNode): ArrayBuffer {
  return romBuffer.slice(file.start, file.end);
}

/** Overwrite a file in the ROM buffer (must fit in original space). */
export function patchFile(
  romBuffer: ArrayBuffer,
  fat: FATEntry[],
  fileId: number,
  newData: ArrayBuffer
): { success: boolean; truncated: boolean } {
  const entry = fat[fileId];
  if (!entry) return { success: false, truncated: false };

  const u8rom = new Uint8Array(romBuffer);
  const u8new = new Uint8Array(newData);
  const origSize = entry.end - entry.start;

  if (u8new.length <= origSize) {
    u8rom.set(u8new, entry.start);
    // Pad remainder with 0xFF
    for (let i = u8new.length; i < origSize; i++) {
      u8rom[entry.start + i] = 0xFF;
    }
    return { success: true, truncated: false };
  }

  // Truncate if too large
  u8rom.set(u8new.subarray(0, origSize), entry.start);
  return { success: true, truncated: true };
}

// ─── ARM9 Map Header Table ────────────────────────────────────

/**
 * DPPt map header table offsets within the ARM9 binary.
 * Each entry is 24 bytes (0x18). The areaDataID is at byte offset 0x0.
 * Keyed by 4-character game code.
 * Source: DSPRE RomInfo.cs headerTableOffset values.
 */
const HEADER_TABLE_OFFSETS: Record<string, number> = {
  // Diamond
  ADAE: 0xEEDBC,  // US/EN
  ADAS: 0xEEE08,  // ES
  ADAI: 0xEED70,  // IT
  ADAF: 0xEEDFC,  // FR
  ADAD: 0xEEDCC,  // DE
  ADAP: 0xEEDBC,  // EU (same as US for English-based EU)
  ADAJ: 0xF0D68,  // JP (Diamond)
  ADAK: 0xEEDBC,  // KR (fallback to US)
  // Pearl
  APAE: 0xEEDBC,  // US/EN
  APAS: 0xEEE08,  // ES
  APAI: 0xEED70,  // IT
  APAF: 0xEEDFC,  // FR
  APAD: 0xEEDCC,  // DE
  APAP: 0xEEDBC,  // EU
  APAJ: 0xF0D6C,  // JP (Pearl)
  APAK: 0xEEDBC,  // KR
  // Platinum
  CPUE: 0xE601C,  // US/EN
  CPUS: 0xE60B0,  // ES
  CPUI: 0xE6038,  // IT
  CPUF: 0xE60A4,  // FR
  CPUD: 0xE6074,  // DE
  CPUP: 0xE601C,  // EU
  CPUJ: 0xE56F0,  // JP
  CPUK: 0xE601C,  // KR
};

const MAP_HEADER_SIZE = 24; // 0x18 bytes per header

/**
 * Read a map header entry from the ARM9 binary embedded in the ROM.
 * Returns the areaDataID (byte at offset 0x0 of the 24-byte header).
 * Returns null if the offset can't be resolved.
 */
export function getAreaDataIdFromArm9(
  romBuffer: ArrayBuffer,
  arm9Offset: number,
  arm9Size: number,
  gameCode: string,
  mapHeaderIndex: number
): number | null {
  const tableOffset = HEADER_TABLE_OFFSETS[gameCode];
  if (tableOffset === undefined) {
    console.warn(`[ARM9] No header table offset for game code: ${gameCode}`);
    return null;
  }

  const entryOffset = tableOffset + MAP_HEADER_SIZE * mapHeaderIndex;

  // Bounds check within ARM9
  if (entryOffset + MAP_HEADER_SIZE > arm9Size) {
    console.warn(`[ARM9] Header entry ${mapHeaderIndex} at 0x${entryOffset.toString(16)} exceeds ARM9 size 0x${arm9Size.toString(16)}`);
    return null;
  }

  const absoluteOffset = arm9Offset + entryOffset;
  if (absoluteOffset + MAP_HEADER_SIZE > romBuffer.byteLength) {
    console.warn(`[ARM9] Absolute offset 0x${absoluteOffset.toString(16)} exceeds ROM size`);
    return null;
  }

  const dv = new DataView(romBuffer);
  const areaDataID = dv.getUint8(absoluteOffset); // byte at offset 0x0
  return areaDataID;
}

/**
 * Read ALL map headers from ARM9, returning an array of areaDataIDs.
 * Reads headers until we hit obviously invalid data or reach ARM9 bounds.
 */
export function getAllAreaDataIds(
  romBuffer: ArrayBuffer,
  arm9Offset: number,
  arm9Size: number,
  gameCode: string,
  maxHeaders: number = 600
): number[] {
  const tableOffset = HEADER_TABLE_OFFSETS[gameCode];
  if (tableOffset === undefined) return [];

  const result: number[] = [];
  const dv = new DataView(romBuffer);

  for (let i = 0; i < maxHeaders; i++) {
    const entryOffset = tableOffset + MAP_HEADER_SIZE * i;
    if (entryOffset + MAP_HEADER_SIZE > arm9Size) break;

    const absoluteOffset = arm9Offset + entryOffset;
    if (absoluteOffset + MAP_HEADER_SIZE > romBuffer.byteLength) break;

    const areaDataID = dv.getUint8(absoluteOffset);
    result.push(areaDataID);
  }

  return result;
}

/** Get NARC paths for a given game version. */
export function getGamePaths(version: GameInfo["version"]) {
  const isDPt = version === "diamond" || version === "pearl";
  return {
    landData: isDPt
      ? "fielddata/land_data/land_data_release.narc"
      : "fielddata/land_data/land_data.narc",
    mapMatrix: "fielddata/mapmatrix/map_matrix.narc",
    eventData: isDPt
      ? "fielddata/eventdata/zone_event_release.narc"
      : "fielddata/eventdata/zone_event.narc",
    encounterData:
      version === "diamond"
        ? "fielddata/encountdata/d_enc_data.narc"
        : version === "pearl"
        ? "fielddata/encountdata/p_enc_data.narc"
        : "fielddata/encountdata/pl_enc_data.narc",
    /** Map texture NARC — NSBTX files indexed by area_data's map_tex_set ID */
    mapTex: "fielddata/areadata/area_map_tex/map_tex_set.narc",
    /** Area data NARC — maps zone headers to texture set indices */
    areaData: isDPt
      ? "fielddata/areadata/area_data.narc"
      : "fielddata/areadata/area_data_release.narc",
  };
}
