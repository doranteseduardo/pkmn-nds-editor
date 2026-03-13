/**
 * NSBMD (Nitro System Binary Model) parser.
 * Decodes NDS 3D models from GPU display list commands into triangle meshes
 * suitable for Three.js rendering, including texture UV coordinates.
 *
 * Architecture matches DSPRE's approach:
 *   - MDL0 material section contains texture and palette definition dicts
 *   - Each texture/palette entry lists which material IDs use it
 *   - This creates a textureName → paletteName mapping per material
 *   - The mapping is passed to parseTEX0 for exact palette lookup
 */

import { BinaryReader } from "./binary";
import { parseTEX0, type TEX0RawData } from "./nsbtx";

// ─── Types ───────────────────────────────────────────────────

export interface NSBMDMesh {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  textureName: string;   // material's texture name (empty if none)
  paletteName: string;   // material's palette name (empty if none)
  matId: number;         // material ID from code section (-1 if unknown)
  uvProps: MaterialUVProps; // material UV properties (repeat, flip, scale)
}

export interface NSBMDModel {
  name: string;
  meshes: NSBMDMesh[];
  scale: number;
}

export interface NSBMDFile {
  models: NSBMDModel[];
  texData: TEX0RawData | null;
  /** Mapping from texture name → palette name, extracted from MDL0 material section.
   *  Used to pair raw textures with their correct palettes for decoding. */
  texturePaletteMap: Map<string, string>;
  /** Per-matId mappings for DSPRE-style MatchTextures (polygon→matId→texName/palName) */
  matIdToTexName: Map<number, string>;
  matIdToPalName: Map<number, string>;
}

// ─── Constants ───────────────────────────────────────────────

const BMD0_MAGIC = 0x30444D42; // "BMD0"
const MDL0_MAGIC = 0x304C444D; // "MDL0"
const TEX0_MAGIC = 0x30584554; // "TEX0"

function sign(value: number, bits: number): number {
  if (value & (1 << (bits - 1))) return value | (-1 << bits);
  return value;
}

function readNdsString(r: BinaryReader): string {
  return r.str(16).replace(/\0/g, "").trim();
}

// ─── Main Parser ─────────────────────────────────────────────

export function parseNSBMD(buffer: ArrayBuffer): NSBMDFile | null {
  if (buffer.byteLength < 16) return null;
  const r = new BinaryReader(buffer);

  const magic = r.u32();
  if (magic !== BMD0_MAGIC) return null;

  r.skip(2); // BOM
  r.skip(2); // version
  r.u32();   // fileSize
  r.u16();   // headerSize
  const numBlocks = r.u16();

  if (numBlocks === 0) return null;

  const blockOffsets: number[] = [];
  for (let i = 0; i < numBlocks; i++) blockOffsets.push(r.u32());

  // Find MDL0 and TEX0 blocks
  let mdl0Offset = -1;
  let tex0Offset = -1;

  for (const blockOffset of blockOffsets) {
    if (blockOffset + 8 >= buffer.byteLength) continue;
    r.seek(blockOffset);
    const blockMagic = r.u32();
    if (blockMagic === MDL0_MAGIC && mdl0Offset < 0) mdl0Offset = blockOffset;
    else if (blockMagic === TEX0_MAGIC && tex0Offset < 0) tex0Offset = blockOffset;
  }

  if (mdl0Offset < 0) return null;

  // Parse MDL0 — returns models AND texture/palette mapping
  r.seek(mdl0Offset);
  r.u32(); // MDL0 magic (already verified)
  r.u32(); // blockSize

  const { models, texturePaletteMap, matIdToTexName, matIdToPalName } = parseMDL0(r, buffer, mdl0Offset);

  // Parse embedded TEX0 if present — returns raw data (no decoding)
  let texData: TEX0RawData | null = null;
  if (tex0Offset >= 0) {
    try {
      texData = parseTEX0(buffer, tex0Offset);
      console.log(`[NSBMD] Found TEX0 block at 0x${tex0Offset.toString(16)} with ${texData?.textures.length ?? 0} textures, ${texData?.palettes.length ?? 0} palettes`);
    } catch (e) {
      console.warn("[NSBMD] TEX0 parse error:", e);
    }
  } else {
    console.log("[NSBMD] No TEX0 block found in BMD0 file");
  }

  return { models, texData, texturePaletteMap, matIdToTexName, matIdToPalName };
}

// ─── MDL0 Block Parser ──────────────────────────────────────

interface MDL0Result {
  models: NSBMDModel[];
  texturePaletteMap: Map<string, string>;
  matIdToTexName: Map<number, string>;
  matIdToPalName: Map<number, string>;
}

function parseMDL0(r: BinaryReader, buffer: ArrayBuffer, blockOffset: number): MDL0Result {
  const dv = new DataView(buffer);

  // Model dictionary — skip-based reading (DSPRE approach)
  const modelDummy = r.u8();
  const num = r.u8(); // model count
  if (num === 0) return { models: [], texturePaletteMap: new Map(), matIdToTexName: new Map(), matIdToPalName: new Map() };

  // Skip dict tree: u16 sizeUnit + tree nodes (12 + count*4 bytes) = 14 + count*4
  r.skip(14 + num * 4);

  // DSPRE: modelOffset[i] = ReadUInt32() + blockoffset (absolute positions)
  const modelOffsets: number[] = [];
  for (let i = 0; i < num; i++) modelOffsets.push(r.u32() + blockOffset);

  const modelNames: string[] = [];
  for (let i = 0; i < num; i++) modelNames.push(readNdsString(r));

  // Model header: DSPRE uses stream.Seek(modelOffset[i]) — already absolute
  r.seek(modelOffsets[0]);
  console.log(`[NSBMD] Model header at 0x${modelOffsets[0].toString(16)}`);

  const _totalsize_base = r.u32();
  const codeoffset_base = r.u32();
  const texpaloffset_base = r.u32();
  const polyoffset_base = r.u32();    // +0x0C
  const _polyend_base = r.u32();
  r.skip(4);                           // reserved
  const matnum = r.u8();              // +0x18
  const polynum = r.u8();             // +0x19
  const laststack = r.u8();           // +0x1A
  r.skip(1);                           // unknown
  const modelScaleRaw = r.i32();      // +0x1C
  const modelScale = modelScaleRaw / 4096;
  r.skip(0x38 - 0x20);                // skip bounding box etc.

  console.log(`[NSBMD] ${modelNames[0]}: ${polynum} polys, ${matnum} mats, scale=${modelScale.toFixed(2)}, texpaloffset_base=0x${texpaloffset_base.toString(16)}`);

  // Base for all section offsets: modelOffset is already absolute
  const modelBase = modelOffsets[0];

  // Parse material section to get texture names and texture→palette mappings
  const { materialTexNames, texturePaletteMap, matIdToTexName, matIdToPalName, matIdToUVProps } = parseTexPalSection(
    r, buffer, modelBase, texpaloffset_base, polyoffset_base, matnum
  );

  // Parse code section to get polygon→material mapping (matching DSPRE's DecodeCode)
  const codeOffset = modelBase + codeoffset_base;
  const codeLimit = modelBase + texpaloffset_base; // code ends where texpal starts
  const polyMatIdMap = decodeCode(buffer, codeOffset, codeLimit, polynum);
  console.log(`[NSBMD] Code section polygon→material: ${Array.from(polyMatIdMap.entries()).map(([p, m]) => `poly${p}→mat${m}`).join(", ")}`);

  // Build polygon→textureName and polygon→paletteName mappings using code section + texDef/palDef
  // This is the DSPRE MatchTextures approach: polygon → matId → texture name / palette name
  const polyTexNames = new Map<number, string>();
  const polyPalNames = new Map<number, string>();
  for (const [polyId, matId] of polyMatIdMap) {
    const texName = matIdToTexName.get(matId);
    if (texName) {
      polyTexNames.set(polyId, texName);
    } else if (matId < materialTexNames.length) {
      polyTexNames.set(polyId, materialTexNames[matId]);
    }
    const palName = matIdToPalName.get(matId);
    if (palName) {
      polyPalNames.set(polyId, palName);
    }
  }
  console.log(`[NSBMD] Polygon→Texture: ${Array.from(polyTexNames.entries()).map(([p, t]) => `poly${p}→"${t}"`).join(", ")}`);
  console.log(`[NSBMD] Polygon→Palette: ${Array.from(polyPalNames.entries()).map(([p, t]) => `poly${p}→"${t}"`).join(", ")}`);

  const models: NSBMDModel[] = [];
  for (let i = 0; i < num; i++) {
    const modelBaseI = modelOffsets[i]; // already absolute
    const model = parseModel(r, buffer, modelBaseI, polyoffset_base, polynum, modelScale, modelNames[i], materialTexNames, polyTexNames, polyPalNames, polyMatIdMap, matIdToUVProps);
    if (model) models.push(model);
  }

  return { models, texturePaletteMap, matIdToTexName, matIdToPalName };
}

// ─── Code Section Parser (DSPRE's DecodeCode) ───────────────
/**
 * Parse the MDL0 code section to extract polygon→material mappings.
 * Matches DSPRE's NSBMD.cs DecodeCode() (lines 226-401).
 *
 * Commands:
 *   0x04/0x24/0x44: Mat — bind material ID
 *   0x05: Shp — draw polygon with current material
 */
function decodeCode(
  buffer: ArrayBuffer, codeOffset: number, codeLimit: number, polynum: number
): Map<number, number> {
  const polyMatMap = new Map<number, number>();
  const dv = new DataView(buffer);
  let pos = codeOffset;
  let matId = -1;

  if (codeOffset >= buffer.byteLength || codeLimit > buffer.byteLength) {
    console.warn(`[NSBMD] Code section out of bounds: 0x${codeOffset.toString(16)}`);
    return polyMatMap;
  }

  while (pos < codeLimit && pos < buffer.byteLength) {
    const c = dv.getUint8(pos);
    switch (c) {
      case 0x00: // padding
        pos++;
        break;
      case 0x01: // Ret — end
        pos++;
        return polyMatMap;

      case 0x02: // Node visibility
        pos += 3;
        break;
      case 0x03: // Mtx — stack ID for polygon
        pos += 2;
        break;

      case 0x04: // Mat[000] — bind material
      case 0x24: // Mat[001]
      case 0x44: // Mat[010]
        matId = dv.getUint8(pos + 1);
        pos += 2;
        break;

      case 0x05: // Shp — draw polygon
        {
          const polyId = dv.getUint8(pos + 1);
          if (matId >= 0) {
            polyMatMap.set(polyId, matId);
          }
          matId = -1;
          pos += 2;
        }
        break;

      case 0x06: // NodeDesc[000]
        pos += 4;
        break;
      case 0x26: // NodeDesc[001]
      case 0x46: // NodeDesc[010]
        pos += 5;
        break;
      case 0x66: // NodeDesc[011]
        pos += 6;
        break;

      case 0x07: // NodeDesc_BB[000]
      case 0x08: // NodeDesc_BB Y
        pos += 2;
        break;

      case 0x09: { // NodeMix[000] Weight
        const _stackId = dv.getUint8(pos + 1);
        const numPairs = dv.getUint8(pos + 2);
        pos += 3 + numPairs * 3;
        break;
      }

      case 0x0b: // BEGIN
      case 0x2b: // END
        pos++;
        break;

      case 0x0C: // EnvMap
        pos += 2;
        break;

      default:
        // Unknown command — stop to avoid misalignment
        console.warn(`[NSBMD] DecodeCode: unknown cmd 0x${c.toString(16)} at 0x${pos.toString(16)}`);
        return polyMatMap;
    }
  }

  return polyMatMap;
}

// ─── TexPal Section Parser (DSPRE approach) ─────────────────

/** Material UV properties from DSPRE's material data (texImageParam + SRT) */
export interface MaterialUVProps {
  repeatS: number;
  repeatT: number;
  flipS: number;
  flipT: number;
  scaleS: number;
  scaleT: number;
}

const DEFAULT_UV_PROPS: MaterialUVProps = { repeatS: 1, repeatT: 1, flipS: 0, flipT: 0, scaleS: 1, scaleT: 1 };

interface TexPalResult {
  materialTexNames: string[];
  texturePaletteMap: Map<string, string>;
  matIdToTexName: Map<number, string>;
  matIdToPalName: Map<number, string>;
  matIdToUVProps: Map<number, MaterialUVProps>;
}

/**
 * Parse the texture/palette definition section in MDL0.
 * This follows DSPRE's NSBMD.cs approach (lines 554-748):
 *
 * At texpaloffset:
 *   u16 texDefRelative  → texDefAbsolute = texDefRelative + texpalAbsolute
 *   u16 palDefRelative  → palDefAbsolute = palDefRelative + texpalAbsolute
 *
 * Then material data entries, then material names.
 *
 * At texDefAbsolute: dict with texture entries, each has name + material IDs
 * At palDefAbsolute: dict with palette entries, each has name + material IDs
 *
 * From these we build: textureName → paletteName mapping.
 */
function parseTexPalSection(
  r: BinaryReader, buffer: ArrayBuffer,
  modelBase: number, texpaloffset_base: number, polyoffset_base: number,
  matnum: number
): TexPalResult {
  const empty: TexPalResult = { materialTexNames: [], texturePaletteMap: new Map(), matIdToTexName: new Map(), matIdToPalName: new Map(), matIdToUVProps: new Map() };
  if (matnum === 0) return empty;

  const dv = new DataView(buffer);

  // texpalAbsolute = modelBase + texpaloffset_base (matching DSPRE: texpaloffset_base + modelOffset[i])
  const texpalAbsolute = modelBase + texpaloffset_base;

  if (texpalAbsolute + 4 > buffer.byteLength) {
    console.warn(`[NSBMD] texpalAbsolute 0x${texpalAbsolute.toString(16)} out of bounds`);
    return empty;
  }

  // Read the two relative offsets
  const texDefRelative = dv.getUint16(texpalAbsolute, true);
  const palDefRelative = dv.getUint16(texpalAbsolute + 2, true);
  const texDefAbsolute = texDefRelative + texpalAbsolute;
  const palDefAbsolute = palDefRelative + texpalAbsolute;

  console.log(`[NSBMD] texpalAbsolute=0x${texpalAbsolute.toString(16)}, texDef=0x${texDefAbsolute.toString(16)}, palDef=0x${palDefAbsolute.toString(16)}`);

  // ─── Material dict ───
  // The material dict starts at texpalAbsolute + 4 (after the 2 u16 offsets).
  // Use offset-based reading for the dict.
  const matDictPos = texpalAbsolute + 4;

  if (matDictPos + 4 > buffer.byteLength) {
    console.warn("[NSBMD] Material dict out of bounds");
    return empty;
  }

  // Skip-based: dummy(1) + count(1) + sizeUnit(2) + tree(12 + count*4) = 16 + count*4
  const matDictDataAbs = matDictPos + 16 + matnum * 4;

  // Data entries are matnum u32 offsets, followed by matnum * 16-byte names
  const matNamesStart = matDictDataAbs + matnum * 4;
  const materialNames: string[] = [];

  if (matNamesStart + matnum * 16 <= buffer.byteLength) {
    for (let j = 0; j < matnum; j++) {
      const nameOff = matNamesStart + j * 16;
      let name = "";
      for (let b = 0; b < 16; b++) {
        const ch = dv.getUint8(nameOff + b);
        if (ch === 0) break;
        if (ch >= 0x20 && ch < 0x7F) name += String.fromCharCode(ch);
        else { name = ""; break; }
      }
      materialNames.push(name);
    }
    console.log(`[NSBMD] Material names: ${materialNames.join(", ")}`);
  }

  // Strip _lm suffixes to get texture names
  const materialTexNames = materialNames.map(n => n.replace(/_lm\d+$/, ""));
  console.log(`[NSBMD] Texture refs: ${materialTexNames.join(", ")}`);

  // ─── Parse material data entries (DSPRE lines 563-668) ───
  // Each material dict data entry is a u32 offset (relative to texpalAbsolute)
  // pointing to the material's data structure which contains texImageParam etc.
  const matIdToUVProps = new Map<number, MaterialUVProps>();
  for (let j = 0; j < matnum; j++) {
    const offsetEntryPos = matDictDataAbs + j * 4;
    if (offsetEntryPos + 4 > buffer.byteLength) break;

    const matDataOffset = dv.getUint32(offsetEntryPos, true) + texpalAbsolute;
    if (matDataOffset + 24 > buffer.byteLength) continue;

    // Material data structure (matching DSPRE lines 575-598):
    // +0x00: i16 dummy
    // +0x02: i16 sectionSize
    // +0x04: i32 DifAmbColors
    // +0x08: i32 SpeEmiColors
    // +0x0C: i32 PolyAttrib
    // +0x10: i32 PolyAttrib Mask
    // +0x14: i16 texVramOffset
    // +0x16: i16 texImageParam
    // +0x18: i32 texImageParam Mask
    // +0x1C: i32 constant4
    // +0x20: i16 matWidth
    // +0x22: i16 matHeight
    const sectionSize = dv.getInt16(matDataOffset + 2, true);
    const texImageParam = dv.getInt16(matDataOffset + 0x16, true);

    const repeatS = texImageParam & 1;
    const repeatT = (texImageParam >> 1) & 1;
    const flipS = (texImageParam >> 2) & 1;
    const flipT = (texImageParam >> 3) & 1;

    let scaleS = 1, scaleT = 1;
    const texGenMode = (texImageParam >> 14) & 3;

    if (texGenMode === 1 && matDataOffset + 0x2C <= buffer.byteLength) {
      // DSPRE lines 622-638: read SRT scales
      // SRT data starts after the base material structure (at +0x28)
      const srtBase = matDataOffset + 0x28;
      if (srtBase + 8 <= buffer.byteLength) {
        const rawScaleS = dv.getInt32(srtBase, true);
        const rawScaleT = dv.getInt32(srtBase + 4, true);
        scaleS = rawScaleS / 4096;
        scaleT = rawScaleT / 4096;
      }
    }

    matIdToUVProps.set(j, { repeatS, repeatT, flipS, flipT, scaleS, scaleT });
  }
  console.log(`[NSBMD] Material UV props: ${Array.from(matIdToUVProps.entries()).map(([id, p]) => `mat${id}:rep=${p.repeatS}/${p.repeatT},flip=${p.flipS}/${p.flipT},scale=${p.scaleS.toFixed(2)}/${p.scaleT.toFixed(2)}`).join(", ")}`);

  // ─── Parse texture definition dict ───
  const texDefs = parseTexPalDefDict(dv, buffer, texDefAbsolute, texpalAbsolute, "tex");

  // ─── Parse palette definition dict ───
  const palDefs = parseTexPalDefDict(dv, buffer, palDefAbsolute, texpalAbsolute, "pal");

  // ─── Build textureName → paletteName mapping ───
  // For each material ID, find which texture and palette reference it.
  // Then map the texture name to the palette name.
  const texturePaletteMap = new Map<string, string>();

  // Build material→texture and material→palette lookups
  const matIdToTexName = new Map<number, string>();
  const matIdToPalName = new Map<number, string>();

  for (const td of texDefs) {
    for (const matId of td.materialIds) {
      matIdToTexName.set(matId, td.name);
    }
  }
  for (const pd of palDefs) {
    for (const matId of pd.materialIds) {
      matIdToPalName.set(matId, pd.name);
    }
  }

  // For each material, map its texture name to its palette name
  for (let m = 0; m < matnum; m++) {
    const texName = matIdToTexName.get(m);
    const palName = matIdToPalName.get(m);
    if (texName && palName) {
      texturePaletteMap.set(texName, palName);
    }
  }

  // Also add mappings from the material dict names (stripped of _lm suffix)
  for (let m = 0; m < matnum && m < materialTexNames.length; m++) {
    const strippedName = materialTexNames[m];
    const palName = matIdToPalName.get(m);
    if (strippedName && palName && !texturePaletteMap.has(strippedName)) {
      texturePaletteMap.set(strippedName, palName);
    }
  }

  console.log(`[NSBMD] Texture→Palette map (${texturePaletteMap.size} entries):`, Object.fromEntries(texturePaletteMap));

  return { materialTexNames, texturePaletteMap, matIdToTexName, matIdToPalName, matIdToUVProps };
}

// ─── TexPal Definition Dict Parser ──────────────────────────

interface TexPalDefEntry {
  name: string;
  materialIds: number[];
}

/**
 * Parse a texture or palette definition dict in the MDL0 material section.
 * Structure (matching DSPRE NSBMD.cs lines 674-748):
 *   u8 dummy (0)
 *   u8 count
 *   skip(14 + count*4)  — dict tree
 *   count * u32 flags:
 *     bits 0-15: offset to material ID list (relative to texpalAbsolute)
 *     bits 16-19: numPairs (number of material IDs)
 *   count * 16-byte names
 */
function parseTexPalDefDict(
  dv: DataView, buffer: ArrayBuffer,
  dictOffset: number, texpalAbsolute: number,
  label: string
): TexPalDefEntry[] {
  if (dictOffset + 2 > buffer.byteLength) return [];

  const dummy = dv.getUint8(dictOffset);
  const count = dv.getUint8(dictOffset + 1);

  if (count === 0 || count > 64) {
    console.warn(`[NSBMD] ${label}Def dict: invalid count=${count} at 0x${dictOffset.toString(16)}`);
    return [];
  }

  console.log(`[NSBMD] ${label}Def dict at 0x${dictOffset.toString(16)}: dummy=${dummy}, count=${count}`);

  // Skip-based: dummy(1) + count(1) + sizeUnit(2) + tree(12 + count*4) = 16 + count*4
  const flagsStart = dictOffset + 16 + count * 4;

  if (flagsStart + count * 4 > buffer.byteLength) return [];

  const entries: TexPalDefEntry[] = [];

  // Read flags and material IDs
  for (let j = 0; j < count; j++) {
    const flags = dv.getInt32(flagsStart + j * 4, true);
    const numPairs = (flags >>> 16) & 0xf;
    const matIdListOffset = (flags & 0xffff) + texpalAbsolute;

    const materialIds: number[] = [];
    if (matIdListOffset + numPairs <= buffer.byteLength) {
      for (let k = 0; k < numPairs; k++) {
        materialIds.push(dv.getUint8(matIdListOffset + k));
      }
    }

    entries.push({ name: "", materialIds });
  }

  // Read names: after data entries
  const namesStart = flagsStart + count * 4;
  for (let j = 0; j < count; j++) {
    const nameOff = namesStart + j * 16;
    if (nameOff + 16 > buffer.byteLength) break;
    let name = "";
    for (let b = 0; b < 16; b++) {
      const ch = dv.getUint8(nameOff + b);
      if (ch === 0) break;
      if (ch >= 0x20 && ch < 0x7F) name += String.fromCharCode(ch);
      else { name = ""; break; }
    }
    entries[j].name = name;
  }

  console.log(`[NSBMD] ${label}Def entries: ${entries.map(e => `"${e.name}" → mats[${e.materialIds.join(",")}]`).join(", ")}`);

  return entries;
}

// ─── Fallback Material Scanner ──────────────────────────────

function fallbackMaterialScan(
  r: BinaryReader, buffer: ArrayBuffer,
  blockOffset: number, polyoffset_base: number,
  modoffset: number, matnum: number
): TexPalResult {
  if (matnum === 0) return { materialTexNames: [], texturePaletteMap: new Map(), matIdToTexName: new Map(), matIdToPalName: new Map(), matIdToUVProps: new Map() };

  const dv = new DataView(buffer);
  const polyDictOffset = blockOffset + polyoffset_base + modoffset;
  const scanStart = blockOffset + 8;
  const scanEnd = Math.min(polyDictOffset, buffer.byteLength - 4);

  console.log(`[NSBMD] Fallback: scanning for matDict (dummy=0, count=${matnum}) in range 0x${scanStart.toString(16)}..0x${scanEnd.toString(16)}`);

  for (let pos = scanStart; pos < scanEnd; pos++) {
    const d = dv.getUint8(pos);
    const c = dv.getUint8(pos + 1);
    if (d === 0 && c === matnum) {
      const dictSize = 2 + 14 + c * 4 + c * 4 + c * 16;
      if (pos + dictSize > buffer.byteLength) continue;

      const nameStart = pos + 2 + (14 + c * 4) + c * 4;
      let validNames = 0;
      const names: string[] = [];
      for (let i = 0; i < c; i++) {
        const nameOff = nameStart + i * 16;
        let name = "";
        for (let b = 0; b < 16; b++) {
          const ch = dv.getUint8(nameOff + b);
          if (ch === 0) break;
          if (ch >= 0x20 && ch < 0x7F) name += String.fromCharCode(ch);
          else { name = ""; break; }
        }
        if (name.length >= 2) validNames++;
        names.push(name);
      }

      if (validNames >= c * 0.5) {
        const texNames = names.map(n => n.replace(/_lm\d+$/, ""));
        console.log(`[NSBMD] Fallback found matDict at 0x${pos.toString(16)}: ${names.join(", ")}`);
        console.log(`[NSBMD] Fallback texture refs: ${texNames.join(", ")}`);
        return { materialTexNames: texNames, texturePaletteMap: new Map(), matIdToTexName: new Map(), matIdToPalName: new Map(), matIdToUVProps: new Map() };
      }
    }
  }

  console.warn(`[NSBMD] Material dict not found by scanning`);
  return { materialTexNames: [], texturePaletteMap: new Map(), matIdToTexName: new Map(), matIdToPalName: new Map(), matIdToUVProps: new Map() };
}

// ─── Model Parser ────────────────────────────────────────────

function parseModel(
  r: BinaryReader, buffer: ArrayBuffer,
  modelBase: number, polyoffset_base: number,
  polynum: number, modelScale: number, name: string,
  materialTexNames: string[],
  polyTexNames: Map<number, string>,
  polyPalNames: Map<number, string>,
  polyMatIdMap: Map<number, number>,
  matIdToUVProps: Map<number, MaterialUVProps>
): NSBMDModel | null {
  if (polynum === 0) return { name, meshes: [], scale: modelScale || 1 };

  const polyoffset = modelBase + polyoffset_base;

  if (polyoffset + 16 > buffer.byteLength) {
    console.warn(`[NSBMD] Polygon dict out of bounds: 0x${polyoffset.toString(16)}`);
    return { name, meshes: [], scale: modelScale || 1 };
  }

  // Parse polygon dictionary — skip-based reading (DSPRE approach)
  r.seek(polyoffset);
  const polyDummy = r.u8();
  const polyCount = r.u8();
  // Skip dict tree: sizeUnit(2) + tree(12 + count*4) = 14 + count*4
  r.skip(14 + polyCount * 4);

  const polyOffsets: number[] = [];
  for (let j = 0; j < polynum; j++) {
    polyOffsets.push(r.u32() + polyoffset);
  }

  const polyNames: string[] = [];
  for (let j = 0; j < polynum; j++) polyNames.push(readNdsString(r));

  console.log(`[NSBMD] Polygon names: ${polyNames.join(", ")}`);

  // Read polygon headers (16 bytes each)
  const polyDataSizes: number[] = [];
  for (let j = 0; j < polynum; j++) {
    if (!r.canRead(16)) break;
    r.i16();  // dummy
    r.i16();  // headerSize
    r.i32();  // unknown
    polyOffsets[j] += r.u32(); // dataOffset added to base
    polyDataSizes.push(r.u32()); // dataSize
  }

  // Decode display lists
  const meshes: NSBMDMesh[] = [];
  const scale = modelScale || 1;

  for (let j = 0; j < polynum && j < polyDataSizes.length; j++) {
    const dlOffset = polyOffsets[j];
    const dlSize = polyDataSizes[j];

    if (dlSize === 0 || dlSize > 500000 || dlOffset + dlSize > buffer.byteLength) continue;

    // Use code section polygon→material→texture mapping (from DecodeCode)
    // This is the DSPRE approach: polygon → matId → texture name AND palette name
    let texName = polyTexNames.get(j) ?? "";
    let palName = polyPalNames.get(j) ?? "";
    const matId = polyMatIdMap.get(j) ?? -1;
    const uvProps = matId >= 0 ? (matIdToUVProps.get(matId) ?? DEFAULT_UV_PROPS) : DEFAULT_UV_PROPS;

    // Fallback: positional mapping (polygon j → material j) — only for texName
    if (!texName && j < materialTexNames.length) {
      texName = materialTexNames[j];
    }

    const decoded = decodeDisplayList(new Uint8Array(buffer, dlOffset, dlSize), scale);
    for (const dm of decoded) {
      if (dm.indices.length > 0) {
        meshes.push({
          positions: new Float32Array(dm.positions),
          normals: new Float32Array(dm.normals),
          colors: new Float32Array(dm.colors),
          uvs: new Float32Array(dm.uvs),
          indices: new Uint32Array(dm.indices),
          textureName: texName,
          paletteName: palName,
          matId,
          uvProps,
        });
      }
    }
  }

  console.log(`[NSBMD] "${name}": ${meshes.length} meshes, ${meshes.reduce((s, m) => s + m.positions.length / 3, 0)} verts`);
  return { name, meshes, scale };
}

// ─── GPU Command Decoder ─────────────────────────────────────

interface DecodedPoly {
  positions: number[];
  normals: number[];
  colors: number[];
  uvs: number[];
  indices: number[];
}

function decodeDisplayList(data: Uint8Array, scale: number): DecodedPoly[] {
  const results: DecodedPoly[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let ptr = 0;

  let vtxX = 0, vtxY = 0, vtxZ = 0;
  let nrmX = 0, nrmY = 0, nrmZ = 1;
  // NDS GPU default vertex color is white (31,31,31 in RGB555)
  let colR = 1.0, colG = 1.0, colB = 1.0;
  let uvS = 0, uvT = 0;

  let polyMode = -1;
  let batchPositions: number[] = [];
  let batchNormals: number[] = [];
  let batchColors: number[] = [];
  let batchUvs: number[] = [];

  function readU32(): number {
    if (ptr + 4 > data.length) { ptr += 4; return 0; }
    const v = view.getUint32(ptr, true);
    ptr += 4;
    return v;
  }

  function emitVertex() {
    batchPositions.push(vtxX * scale, vtxY * scale, vtxZ * scale);
    batchNormals.push(nrmX, nrmY, nrmZ);
    batchColors.push(colR, colG, colB);
    batchUvs.push(uvS, uvT);
  }

  function flushBatch() {
    const vertCount = batchPositions.length / 3;
    if (vertCount < 3) {
      batchPositions = []; batchNormals = []; batchColors = []; batchUvs = [];
      return;
    }

    const mesh: DecodedPoly = { positions: [], normals: [], colors: [], uvs: [], indices: [] };
    mesh.positions = batchPositions.slice();
    mesh.normals = batchNormals.slice();
    mesh.colors = batchColors.slice();
    mesh.uvs = batchUvs.slice();

    if (polyMode === 0) {
      for (let i = 0; i + 2 < vertCount; i += 3) mesh.indices.push(i, i + 1, i + 2);
    } else if (polyMode === 1) {
      for (let i = 0; i + 3 < vertCount; i += 4) {
        mesh.indices.push(i, i + 1, i + 2);
        mesh.indices.push(i, i + 2, i + 3);
      }
    } else if (polyMode === 2) {
      for (let i = 0; i + 2 < vertCount; i++) {
        if (i % 2 === 0) mesh.indices.push(i, i + 1, i + 2);
        else mesh.indices.push(i + 1, i, i + 2);
      }
    } else if (polyMode === 3) {
      for (let i = 0; i + 3 < vertCount; i += 2) {
        mesh.indices.push(i, i + 1, i + 2);
        mesh.indices.push(i + 2, i + 1, i + 3);
      }
    }

    if (mesh.indices.length > 0) results.push(mesh);
    batchPositions = []; batchNormals = []; batchColors = []; batchUvs = [];
  }

  while (ptr < data.length) {
    const c0 = ptr < data.length ? data[ptr++] : 0;
    const c1 = ptr < data.length ? data[ptr++] : 0;
    const c2 = ptr < data.length ? data[ptr++] : 0;
    const c3 = ptr < data.length ? data[ptr++] : 0;

    for (const cmd of [c0, c1, c2, c3]) {
      switch (cmd) {
        case 0x00: break;
        case 0x40: {
          if (batchPositions.length >= 9) flushBatch();
          polyMode = readU32() & 3;
          batchPositions = []; batchNormals = []; batchColors = []; batchUvs = [];
          break;
        }
        case 0x41: { flushBatch(); polyMode = -1; break; }

        case 0x22: {
          const p = readU32();
          uvS = sign(p & 0xFFFF, 16) / 16;
          uvT = sign((p >>> 16) & 0xFFFF, 16) / 16;
          break;
        }

        case 0x23: { const p1 = readU32(), p2 = readU32();
          vtxX = sign(p1 & 0xFFFF, 16) / 4096;
          vtxY = sign((p1 >>> 16) & 0xFFFF, 16) / 4096;
          vtxZ = sign(p2 & 0xFFFF, 16) / 4096;
          emitVertex(); break; }
        case 0x24: { const p = readU32();
          vtxX = sign(p & 0x3FF, 10) / 64;
          vtxY = sign((p >>> 10) & 0x3FF, 10) / 64;
          vtxZ = sign((p >>> 20) & 0x3FF, 10) / 64;
          emitVertex(); break; }
        case 0x25: { const p = readU32();
          vtxX = sign(p & 0xFFFF, 16) / 4096;
          vtxY = sign((p >>> 16) & 0xFFFF, 16) / 4096;
          emitVertex(); break; }
        case 0x26: { const p = readU32();
          vtxX = sign(p & 0xFFFF, 16) / 4096;
          vtxZ = sign((p >>> 16) & 0xFFFF, 16) / 4096;
          emitVertex(); break; }
        case 0x27: { const p = readU32();
          vtxY = sign(p & 0xFFFF, 16) / 4096;
          vtxZ = sign((p >>> 16) & 0xFFFF, 16) / 4096;
          emitVertex(); break; }
        case 0x28: { const p = readU32();
          vtxX += sign(p & 0x3FF, 10) / 4096;
          vtxY += sign((p >>> 10) & 0x3FF, 10) / 4096;
          vtxZ += sign((p >>> 20) & 0x3FF, 10) / 4096;
          emitVertex(); break; }

        case 0x20: { const p = readU32();
          colR = (p & 0x1F) / 31; colG = ((p >>> 5) & 0x1F) / 31; colB = ((p >>> 10) & 0x1F) / 31;
          break; }
        case 0x21: { const p = readU32();
          nrmX = sign(p & 0x3FF, 10) / 512; nrmY = sign((p >>> 10) & 0x3FF, 10) / 512; nrmZ = sign((p >>> 20) & 0x3FF, 10) / 512;
          break; }
        case 0x30: { const p = readU32();
          colR = (p & 0x1F) / 31; colG = ((p >>> 5) & 0x1F) / 31; colB = ((p >>> 10) & 0x1F) / 31;
          break; }

        case 0x10: readU32(); break;
        case 0x11: readU32(); break;
        case 0x12: readU32(); break;
        case 0x13: readU32(); break;
        case 0x14: readU32(); break;
        case 0x15: break;
        case 0x16: for (let k = 0; k < 16; k++) readU32(); break;
        case 0x17: for (let k = 0; k < 16; k++) readU32(); break;
        case 0x18: for (let k = 0; k < 9; k++) readU32(); break;
        case 0x19: for (let k = 0; k < 12; k++) readU32(); break;
        case 0x1A: for (let k = 0; k < 16; k++) readU32(); break;
        case 0x1B: for (let k = 0; k < 3; k++) readU32(); break;
        case 0x1C: for (let k = 0; k < 3; k++) readU32(); break;

        case 0x29: readU32(); break;
        case 0x2A: readU32(); break;
        case 0x2B: readU32(); break;
        case 0x31: readU32(); break;
        case 0x32: readU32(); break;
        case 0x33: readU32(); break;
        case 0x34: for (let k = 0; k < 32; k++) readU32(); break;
        case 0x50: readU32(); break;
        case 0x60: readU32(); break;
        case 0x70: for (let k = 0; k < 3; k++) readU32(); break;
        case 0x71: for (let k = 0; k < 2; k++) readU32(); break;
        case 0x72: readU32(); break;

        default: break;
      }
    }
  }

  if (batchPositions.length >= 9) flushBatch();
  return results;
}

// ─── Utility: Combine all meshes ─────────────────────────────

export interface FlatMeshData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  /** Per-mesh texture/palette info, parallel with mesh boundaries */
  meshTextures: { textureName: string; paletteName: string; matId: number; uvProps: MaterialUVProps; indexStart: number; indexCount: number }[];
}

export function nsbmdToFlatMesh(nsbmd: NSBMDFile): FlatMeshData | null {
  const allPos: number[] = [];
  const allNrm: number[] = [];
  const allCol: number[] = [];
  const allUvs: number[] = [];
  const allIdx: number[] = [];
  const meshTextures: { textureName: string; paletteName: string; matId: number; uvProps: MaterialUVProps; indexStart: number; indexCount: number }[] = [];
  let vOff = 0;

  for (const model of nsbmd.models) {
    for (const mesh of model.meshes) {
      const indexStart = allIdx.length;
      for (let i = 0; i < mesh.positions.length; i++) allPos.push(mesh.positions[i]);
      for (let i = 0; i < mesh.normals.length; i++) allNrm.push(mesh.normals[i]);
      for (let i = 0; i < mesh.colors.length; i++) allCol.push(mesh.colors[i]);
      for (let i = 0; i < mesh.uvs.length; i++) allUvs.push(mesh.uvs[i]);
      for (let i = 0; i < mesh.indices.length; i++) allIdx.push(mesh.indices[i] + vOff);
      meshTextures.push({
        textureName: mesh.textureName,
        paletteName: mesh.paletteName,
        matId: mesh.matId,
        uvProps: mesh.uvProps,
        indexStart,
        indexCount: mesh.indices.length,
      });
      vOff += mesh.positions.length / 3;
    }
  }

  if (allPos.length === 0) return null;

  return {
    positions: new Float32Array(allPos),
    normals: new Float32Array(allNrm),
    colors: new Float32Array(allCol),
    uvs: new Float32Array(allUvs),
    indices: new Uint32Array(allIdx),
    meshTextures,
  };
}
