/**
 * NSBMD (Nitro System Binary Model) parser.
 * Decodes NDS 3D models from GPU display list commands into triangle meshes
 * suitable for Three.js rendering, including texture UV coordinates.
 *
 * Offset rules (verified against real DPPt map data):
 *   - Dict navigation: skip(1) + readByte(count) + skip(14 + count*4) + offsets + names
 *   - Model header: 0x38 bytes, polyoffset_base at +0x0C
 *   - polyoffset = blockOffset + polyoffset_base + modoffset  (all three summed)
 *   - Polygon dict: skip(1) + readByte() + skip(14 + polynum*4) + offsets + names + headers
 *   - polyOffsets[j] = dictEntry + polyoffset
 *   - dlOffset = polyOffsets[j] + headerDataOffset
 */

import { BinaryReader } from "./binary";
import { parseTEX0, type TEX0Data } from "./nsbtx";

// ─── Types ───────────────────────────────────────────────────

export interface NSBMDMesh {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  textureName: string;   // material's texture name (empty if none)
}

export interface NSBMDModel {
  name: string;
  meshes: NSBMDMesh[];
  scale: number;
}

export interface NSBMDFile {
  models: NSBMDModel[];
  textures: TEX0Data | null;
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

  // Parse TEX0 if present
  let textures: TEX0Data | null = null;
  if (tex0Offset >= 0) {
    try {
      textures = parseTEX0(buffer, tex0Offset);
      console.log(`[NSBMD] Found TEX0 block at 0x${tex0Offset.toString(16)} with ${textures?.textures.length ?? 0} textures`);
    } catch (e) {
      console.warn("[NSBMD] TEX0 parse error:", e);
    }
  } else {
    console.log("[NSBMD] No TEX0 block found in BMD0 file");
  }

  // Parse MDL0
  r.seek(mdl0Offset);
  r.u32(); // MDL0 magic (already verified)
  r.u32(); // blockSize

  const models = parseMDL0(r, buffer, mdl0Offset);

  return { models, textures };
}

// ─── MDL0 Block Parser ──────────────────────────────────────

function parseMDL0(r: BinaryReader, buffer: ArrayBuffer, blockOffset: number): NSBMDModel[] {
  // Model dictionary
  r.skip(1); // dummy
  const num = r.u8(); // model count
  if (num === 0) return [];

  // Skip dictionary tree (DSPRE: 14 + num*4)
  r.skip(14 + num * 4);

  // Read model offsets and names
  const modelOffsets: number[] = [];
  for (let i = 0; i < num; i++) modelOffsets.push(r.u32());

  const modelNames: string[] = [];
  for (let i = 0; i < num; i++) modelNames.push(readNdsString(r));

  // Model header (0x38 bytes, read sequentially after dict)
  const _totalsize_base = r.u32();
  const _codeoffset_base = r.u32();
  const texpaloffset_base = r.u32();
  const polyoffset_base = r.u32();    // +0x0C
  const _polyend_base = r.u32();
  r.skip(4);                           // reserved
  const matnum = r.u8();              // +0x18
  const polynum = r.u8();             // +0x19
  r.skip(2);                           // laststack + unknown
  const modelScaleRaw = r.i32();      // +0x1C
  const modelScale = modelScaleRaw / 4096;
  r.skip(0x38 - 0x20);                // skip bounding box etc.

  console.log(`[NSBMD] ${modelNames[0]}: ${polynum} polys, ${matnum} mats, scale=${modelScale.toFixed(2)}`);

  // Parse material dictionary to get texture names per material
  const materialTexNames = parseMaterialDict(r, buffer, blockOffset, texpaloffset_base, modelOffsets[0], matnum);

  const models: NSBMDModel[] = [];
  for (let i = 0; i < num; i++) {
    const model = parseModel(r, buffer, modelOffsets[i], polyoffset_base, blockOffset, polynum, modelScale, modelNames[i], materialTexNames);
    if (model) models.push(model);
  }

  return models;
}

// ─── Material Dictionary Parser ──────────────────────────────

function parseMaterialDict(
  r: BinaryReader, buffer: ArrayBuffer,
  blockOffset: number, texpaloffset_base: number, modoffset: number,
  matnum: number
): string[] {
  // Material dict is at blockOffset + texpaloffset_base + modoffset
  // Similar to polygon dict location
  if (matnum === 0) return [];

  const matDictOffset = blockOffset + texpaloffset_base + modoffset;
  if (matDictOffset + 4 > buffer.byteLength) return [];

  try {
    r.seek(matDictOffset);
    const dummy = r.u8();
    const count = r.u8();
    if (count === 0 || count > 64) return [];

    // Skip dict tree
    r.skip(14 + count * 4);

    // Read material offsets (u32 each, relative to matDictOffset)
    const matOffsets: number[] = [];
    for (let i = 0; i < count; i++) matOffsets.push(r.u32());

    // Read material names (16 bytes each)
    const matNames: string[] = [];
    for (let i = 0; i < count; i++) matNames.push(readNdsString(r));

    // Material headers: each starts with some fields, including texture name index
    // For now, use material names as a proxy — in many NDS models, material name = texture name
    // We'll also try to read the actual texture reference from material data

    // Try reading material data entries to find texture indices
    // Material data structure varies, but typically contains:
    //   - Various rendering parameters
    //   - Texture index (references TEX0 dictionary)
    //   - Palette index
    // The exact structure is complex and model-dependent.
    // For DPPt maps, material names typically match texture names.

    console.log(`[NSBMD] Materials: ${matNames.join(", ")}`);
    return matNames;
  } catch (e) {
    console.warn("[NSBMD] Material dict parse error:", e);
    return [];
  }
}

// ─── Model Parser ────────────────────────────────────────────

function parseModel(
  r: BinaryReader, buffer: ArrayBuffer,
  modoffset: number, polyoffset_base: number, blockOffset: number,
  polynum: number, modelScale: number, name: string,
  materialTexNames: string[]
): NSBMDModel | null {
  if (polynum === 0) return { name, meshes: [], scale: modelScale || 1 };

  // Polygon dict location: blockOffset + polyoffset_base + modoffset
  const polyoffset = blockOffset + polyoffset_base + modoffset;

  if (polyoffset + 16 > buffer.byteLength) {
    console.warn(`[NSBMD] Polygon dict out of bounds: 0x${polyoffset.toString(16)}`);
    return { name, meshes: [], scale: modelScale || 1 };
  }

  // Parse polygon dictionary
  r.seek(polyoffset);
  r.skip(1); // dummy
  r.u8();    // dict poly count (read but we use polynum from model header)
  r.skip(14 + polynum * 4); // skip dict tree

  // Read polygon offsets: each becomes absolute via + polyoffset
  const polyOffsets: number[] = [];
  for (let j = 0; j < polynum; j++) {
    polyOffsets.push(r.u32() + polyoffset);
  }

  // Read polygon names
  for (let j = 0; j < polynum; j++) readNdsString(r);

  // Read polygon headers (16 bytes each, sequentially after names)
  const polyDataSizes: number[] = [];
  for (let j = 0; j < polynum; j++) {
    if (!r.canRead(16)) break;
    r.i16();  // dummy
    r.i16();  // headerSize
    r.i32();  // unknown
    polyOffsets[j] += r.u32(); // dataOffset added to base → final DL position
    polyDataSizes.push(r.u32()); // dataSize
  }

  // Decode display lists
  const meshes: NSBMDMesh[] = [];
  const scale = modelScale || 1;

  for (let j = 0; j < polynum && j < polyDataSizes.length; j++) {
    const dlOffset = polyOffsets[j];
    const dlSize = polyDataSizes[j];

    if (dlSize === 0 || dlSize > 500000 || dlOffset + dlSize > buffer.byteLength) continue;

    // Try to find texture name for this polygon
    // In many NDS models, polygon index maps to material index
    const texName = j < materialTexNames.length ? materialTexNames[j] : "";

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
  let colR = 0.7, colG = 0.7, colB = 0.7;
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

        // TEXCOORD — 0x22: S and T are signed 16-bit fixed-point (1.11.4)
        // S = bits 0-15, T = bits 16-31
        // Divide by 16 to get texel coordinates
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
  /** Per-mesh texture names, parallel with mesh boundaries */
  meshTextures: { textureName: string; indexStart: number; indexCount: number }[];
}

export function nsbmdToFlatMesh(nsbmd: NSBMDFile): FlatMeshData | null {
  const allPos: number[] = [];
  const allNrm: number[] = [];
  const allCol: number[] = [];
  const allUvs: number[] = [];
  const allIdx: number[] = [];
  const meshTextures: { textureName: string; indexStart: number; indexCount: number }[] = [];
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
