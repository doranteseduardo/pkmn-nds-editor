/**
 * NSBMD (Nitro System Binary Model) parser.
 * Decodes NDS 3D models from GPU display list commands into triangle meshes
 * suitable for Three.js rendering.
 *
 * Based on DSPRE's NSBMD.cs exact byte-level layout.
 *
 * Key offset rules (from DSPRE):
 *   - MDL0 model dict entries (modoffset) are used directly (NOT added to blockOffset)
 *   - polyoffset = polyoffset_base + modoffset  (absolute in buffer)
 *   - polyOffsets[j] = dictEntry + polyoffset    (absolute in buffer)
 *   - dlAbsOffset = polyOffsets[j] + headerDataOffset
 *   - Model header is read SEQUENTIALLY after the dict, not by seeking to modoffset
 */

import { BinaryReader } from "./binary";

// ─── Types ───────────────────────────────────────────────────

export interface NSBMDMesh {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

export interface NSBMDModel {
  name: string;
  meshes: NSBMDMesh[];
  scale: number;
}

export interface NSBMDFile {
  models: NSBMDModel[];
}

// ─── Constants ───────────────────────────────────────────────

const BMD0_MAGIC = 0x30444D42; // "BMD0"
const MDL0_MAGIC = 0x304C444D; // "MDL0"

// ─── Sign extension ──────────────────────────────────────────

function sign(value: number, bits: number): number {
  if (value & (1 << (bits - 1))) return value | (-1 << bits);
  return value;
}

// ─── NDS Dictionary Parser ──────────────────────────────────
// Uses dictSize field at +0x02 to reliably locate data entries and names
// at the end of the dict, regardless of tree structure internals.

interface DictResult {
  offsets: number[];
  names: string[];
  dictEnd: number;
}

function parseDict(r: BinaryReader, entryDataSize: number = 4): DictResult {
  const dictStart = r.offset;
  const dummy = r.u8();
  const count = r.u8();
  const dictSize = r.u16();

  console.log(`[NSBMD dict] @0x${dictStart.toString(16)}: count=${count}, dictSize=${dictSize}`);

  if (count === 0 || dictSize < 8) {
    const end = dictStart + Math.max(dictSize, 4);
    r.seek(end);
    return { offsets: [], names: [], dictEnd: end };
  }

  const dictEnd = dictStart + dictSize;
  const namesStart = dictEnd - count * 16;
  const dataStart = namesStart - count * entryDataSize;

  if (dataStart < dictStart + 4 || namesStart < dataStart || dictEnd > r.length) {
    console.warn(`[NSBMD dict] Invalid layout`);
    r.seek(Math.min(dictEnd, r.length));
    return { offsets: [], names: [], dictEnd };
  }

  r.seek(dataStart);
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) {
    offsets.push(r.u32());
    if (entryDataSize > 4) r.skip(entryDataSize - 4);
  }

  r.seek(namesStart);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    names.push(r.str(16).replace(/\0/g, "").trim());
  }

  r.seek(dictEnd);
  console.log(`[NSBMD dict] offsets=[${offsets.map(o => "0x" + o.toString(16)).join(",")}], names=[${names.join(",")}]`);

  return { offsets, names, dictEnd };
}

// ─── Main Parser ─────────────────────────────────────────────

export function parseNSBMD(buffer: ArrayBuffer): NSBMDFile | null {
  if (buffer.byteLength < 16) return null;
  const r = new BinaryReader(buffer);

  const magic = r.u32();
  if (magic !== BMD0_MAGIC) {
    console.warn(`[NSBMD] Not BMD0 (magic=0x${magic.toString(16)})`);
    return null;
  }

  r.skip(2); // BOM
  r.skip(2); // version
  const fileSize = r.u32();
  const headerSize = r.u16();
  const numBlocks = r.u16();

  console.log(`[NSBMD] BMD0: fileSize=${fileSize}, headerSize=${headerSize}, numBlocks=${numBlocks}, bufferSize=${buffer.byteLength}`);

  if (numBlocks === 0) return null;

  const blockOffsets: number[] = [];
  for (let i = 0; i < numBlocks; i++) {
    blockOffsets.push(r.u32());
  }

  // Find MDL0 block
  for (const blockOffset of blockOffsets) {
    if (blockOffset + 8 >= buffer.byteLength) continue;
    r.seek(blockOffset);
    const blockMagic = r.u32();
    if (blockMagic === MDL0_MAGIC) {
      console.log(`[NSBMD] Found MDL0 at 0x${blockOffset.toString(16)}`);
      const blockSize = r.u32();
      return parseMDL0(r, buffer, blockOffset);
    }
  }

  console.warn("[NSBMD] No valid MDL0 block found");
  return null;
}

// ─── MDL0 Block Parser ──────────────────────────────────────
// DSPRE flow:
//   1. Parse model dict → get modoffset values + model names
//   2. Read model header SEQUENTIALLY (right after dict)
//   3. Compute sub-section positions: polyoffset = polyoffset_base + modoffset

function parseMDL0(r: BinaryReader, buffer: ArrayBuffer, blockOffset: number): NSBMDFile {
  // r is now at blockOffset + 8 (after magic + blockSize)
  // Parse model dictionary
  const modelDict = parseDict(r);

  if (modelDict.offsets.length === 0) {
    console.warn("[NSBMD MDL0] No models in dictionary");
    return { models: [] };
  }

  // Model header is read SEQUENTIALLY from current position (right after dict)
  // This matches DSPRE's behavior exactly
  const modelHeaderPos = r.offset;
  console.log(`[NSBMD MDL0] Model header at 0x${modelHeaderPos.toString(16)}, modoffset=0x${modelDict.offsets[0].toString(16)}`);

  // For DPPt maps, typically just 1 model
  const models: NSBMDModel[] = [];
  for (let i = 0; i < modelDict.offsets.length; i++) {
    const modoffset = modelDict.offsets[i];
    const model = parseModelData(r, buffer, modoffset, modelDict.names[i]);
    if (model) models.push(model);
  }

  return { models };
}

// ─── Model Data Parser ──────────────────────────────────────
// DSPRE model header layout (0x38 bytes):
//   +0x00  u32  totalsize_base
//   +0x04  u32  codeoffset_base
//   +0x08  u32  texpaloffset_base
//   +0x0C  u32  polyoffset_base
//   +0x10  u32  polyend_base
//   +0x14  u32  (reserved)
//   +0x18  u8   matnum
//   +0x19  u8   polynum
//   +0x1A  u8   laststack
//   +0x1B  u8   unknown
//   +0x1C  i32  modelScale (fp /4096)
//   +0x20  ...  (bounding box, vertex/triangle counts, etc.)

function parseModelData(
  r: BinaryReader, buffer: ArrayBuffer,
  modoffset: number, name: string
): NSBMDModel | null {
  // Read model header from CURRENT stream position (sequential after dict)
  // DSPRE does NOT seek to modoffset for the header — it reads sequentially
  const headerPos = r.offset;

  const totalsize_base = r.u32();
  const codeoffset_base = r.u32();
  const texpaloffset_base = r.u32();
  const polyoffset_base = r.u32();
  const polyend_base = r.u32();
  r.skip(4); // reserved
  const matnum = r.u8();
  const polynum = r.u8();
  r.skip(2); // laststack + unknown
  const modelScaleRaw = r.i32();
  const modelScale = modelScaleRaw / 4096;
  r.skip(0x38 - 0x20); // skip rest of header

  // Compute polygon dict absolute position: polyoffset_base + modoffset
  // This matches DSPRE exactly
  const polyoffset = polyoffset_base + modoffset;

  console.log(`[NSBMD model] "${name}" @header=0x${headerPos.toString(16)}: polyoffset_base=0x${polyoffset_base.toString(16)}, modoffset=0x${modoffset.toString(16)}, polyoffset=0x${polyoffset.toString(16)}, matnum=${matnum}, polynum=${polynum}, scale=${modelScale.toFixed(4)}`);

  if (polynum === 0) {
    return { name, meshes: [], scale: modelScale || 1 };
  }

  if (polyoffset + 4 > buffer.byteLength) {
    console.warn(`[NSBMD model] Polygon dict out of bounds: 0x${polyoffset.toString(16)}`);
    return { name, meshes: [], scale: modelScale || 1 };
  }

  // ─── Parse Polygon Dictionary ───
  // DSPRE navigates here with: stream.Seek(polyoffset, SeekOrigin.Begin)
  r.seek(polyoffset);

  // DSPRE's polygon dict parsing uses HARDCODED skip:
  //   skip(1) dummy, read byte count, skip(14 + polynum*4), then read offsets
  // We use dictSize approach for reliability, but let's also try DSPRE's hardcoded way as fallback

  const polyDictStart = r.offset;
  const polyDict = parseDict(r);

  let polyOffsets: number[];
  let polyNames: string[];

  if (polyDict.offsets.length > 0) {
    // dictSize approach worked
    polyOffsets = polyDict.offsets;
    polyNames = polyDict.names;
  } else {
    // Fallback: try DSPRE's hardcoded skip approach
    console.log("[NSBMD] Trying DSPRE hardcoded skip approach for polygon dict");
    r.seek(polyDictStart);
    r.skip(1); // dummy
    const pcount = r.u8();
    if (pcount === 0) return { name, meshes: [], scale: modelScale || 1 };
    r.skip(14 + pcount * 4);

    polyOffsets = [];
    for (let j = 0; j < pcount; j++) {
      polyOffsets.push(r.u32());
    }

    polyNames = [];
    for (let j = 0; j < pcount; j++) {
      polyNames.push(r.str(16).replace(/\0/g, "").trim());
    }
    console.log(`[NSBMD] Fallback offsets=[${polyOffsets.map(o => "0x" + o.toString(16)).join(",")}]`);
  }

  const numPolys = polyOffsets.length;
  if (numPolys === 0) {
    return { name, meshes: [], scale: modelScale || 1 };
  }

  // ─── Polygon offsets: add polyoffset (absolute base) ───
  // DSPRE: polyOffsets[j] = reader.ReadUInt32() + polyoffset
  const absPolyOffsets = polyOffsets.map(off => off + polyoffset);

  // ─── Read polygon headers SEQUENTIALLY (right after dict names) ───
  // Each header: 16 bytes
  //   +0x00  i16  dummy
  //   +0x02  i16  headerSize
  //   +0x04  i32  unknown2
  //   +0x08  u32  dataOffset (ADDED to absPolyOffsets[j] by DSPRE)
  //   +0x0C  u32  dataSize

  const headerDataOffsets: number[] = [];
  const dataSizes: number[] = [];

  for (let j = 0; j < numPolys; j++) {
    if (!r.canRead(16)) {
      console.warn(`[NSBMD] Not enough data for poly header ${j} at 0x${r.offset.toString(16)}`);
      break;
    }
    const hdummy = r.i16();
    const hsize = r.i16();
    const hunknown = r.i32();
    const hDataOffset = r.u32(); // DSPRE: polyOffsets[j] += this value
    const hDataSize = r.u32();

    headerDataOffsets.push(hDataOffset);
    dataSizes.push(hDataSize);

    console.log(`[NSBMD poly hdr ${j}] dummy=${hdummy}, size=${hsize}, dataOff=0x${hDataOffset.toString(16)}, dataSize=${hDataSize}`);
  }

  // ─── Decode display lists ───
  const meshes: NSBMDMesh[] = [];
  const scale = modelScale || 1;

  for (let j = 0; j < numPolys && j < headerDataOffsets.length; j++) {
    // DSPRE: polyOffsets[j] += headerDataOffset → then seek to polyOffsets[j]
    const dlAbsOffset = absPolyOffsets[j] + headerDataOffsets[j];
    const dlSize = dataSizes[j];

    console.log(`[NSBMD poly ${j}] dlAbsOffset=0x${dlAbsOffset.toString(16)}, dlSize=${dlSize} (absPolyOff=0x${absPolyOffsets[j].toString(16)} + hdrOff=0x${headerDataOffsets[j].toString(16)})`);

    if (dlSize === 0 || dlSize > 500000) {
      console.warn(`[NSBMD poly ${j}] Invalid DL size: ${dlSize}`);
      continue;
    }
    if (dlAbsOffset + dlSize > buffer.byteLength) {
      console.warn(`[NSBMD poly ${j}] DL out of bounds: 0x${dlAbsOffset.toString(16)}+${dlSize} > ${buffer.byteLength}`);
      continue;
    }

    const displayListData = new Uint8Array(buffer, dlAbsOffset, dlSize);
    const decoded = decodeDisplayList(displayListData, scale);

    for (const dm of decoded) {
      if (dm.indices.length > 0) {
        meshes.push({
          positions: new Float32Array(dm.positions),
          normals: new Float32Array(dm.normals),
          colors: new Float32Array(dm.colors),
          indices: new Uint32Array(dm.indices),
        });
      }
    }
  }

  console.log(`[NSBMD model] "${name}": ${meshes.length} meshes, ${meshes.reduce((s, m) => s + m.positions.length / 3, 0)} total verts`);
  return { name, meshes, scale };
}

// ─── GPU Command Decoder ─────────────────────────────────────

interface DecodedPoly {
  positions: number[];
  normals: number[];
  colors: number[];
  indices: number[];
}

function decodeDisplayList(data: Uint8Array, scale: number): DecodedPoly[] {
  const results: DecodedPoly[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let ptr = 0;

  let vtxX = 0, vtxY = 0, vtxZ = 0;
  let nrmX = 0, nrmY = 0, nrmZ = 1;
  let colR = 0.7, colG = 0.7, colB = 0.7;

  let polyMode = -1;
  let batchPositions: number[] = [];
  let batchNormals: number[] = [];
  let batchColors: number[] = [];
  let totalVerts = 0;

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
    totalVerts++;
  }

  function flushBatch() {
    const vertCount = batchPositions.length / 3;
    if (vertCount < 3) {
      batchPositions = []; batchNormals = []; batchColors = [];
      return;
    }

    const mesh: DecodedPoly = { positions: [], normals: [], colors: [], indices: [] };
    mesh.positions = batchPositions.slice();
    mesh.normals = batchNormals.slice();
    mesh.colors = batchColors.slice();

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
    batchPositions = []; batchNormals = []; batchColors = [];
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
          batchPositions = []; batchNormals = []; batchColors = [];
          break;
        }
        case 0x41: { flushBatch(); polyMode = -1; break; }

        case 0x23: { // VTX_16
          const p1 = readU32(), p2 = readU32();
          vtxX = sign(p1 & 0xFFFF, 16) / 4096;
          vtxY = sign((p1 >>> 16) & 0xFFFF, 16) / 4096;
          vtxZ = sign(p2 & 0xFFFF, 16) / 4096;
          emitVertex(); break;
        }
        case 0x24: { // VTX_10
          const p = readU32();
          vtxX = sign(p & 0x3FF, 10) / 64;
          vtxY = sign((p >>> 10) & 0x3FF, 10) / 64;
          vtxZ = sign((p >>> 20) & 0x3FF, 10) / 64;
          emitVertex(); break;
        }
        case 0x25: { // VTX_XY
          const p = readU32();
          vtxX = sign(p & 0xFFFF, 16) / 4096;
          vtxY = sign((p >>> 16) & 0xFFFF, 16) / 4096;
          emitVertex(); break;
        }
        case 0x26: { // VTX_XZ
          const p = readU32();
          vtxX = sign(p & 0xFFFF, 16) / 4096;
          vtxZ = sign((p >>> 16) & 0xFFFF, 16) / 4096;
          emitVertex(); break;
        }
        case 0x27: { // VTX_YZ
          const p = readU32();
          vtxY = sign(p & 0xFFFF, 16) / 4096;
          vtxZ = sign((p >>> 16) & 0xFFFF, 16) / 4096;
          emitVertex(); break;
        }
        case 0x28: { // VTX_DIFF
          const p = readU32();
          vtxX += sign(p & 0x3FF, 10) / 4096;
          vtxY += sign((p >>> 10) & 0x3FF, 10) / 4096;
          vtxZ += sign((p >>> 20) & 0x3FF, 10) / 4096;
          emitVertex(); break;
        }

        case 0x20: { // COLOR
          const p = readU32();
          colR = (p & 0x1F) / 31;
          colG = ((p >>> 5) & 0x1F) / 31;
          colB = ((p >>> 10) & 0x1F) / 31;
          break;
        }
        case 0x21: { // NORMAL
          const p = readU32();
          nrmX = sign(p & 0x3FF, 10) / 512;
          nrmY = sign((p >>> 10) & 0x3FF, 10) / 512;
          nrmZ = sign((p >>> 20) & 0x3FF, 10) / 512;
          break;
        }
        case 0x22: readU32(); break; // TEXCOORD
        case 0x30: { // DIF_AMB
          const p = readU32();
          colR = (p & 0x1F) / 31;
          colG = ((p >>> 5) & 0x1F) / 31;
          colB = ((p >>> 10) & 0x1F) / 31;
          break;
        }

        // Matrix commands
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

        // Other commands with known param counts
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

  if (totalVerts > 0) {
    console.log(`[NSBMD DL] ${totalVerts} vertices, ${results.length} batches`);
  }

  return results;
}

// ─── Utility: Combine all meshes ─────────────────────────────

export interface FlatMeshData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

export function nsbmdToFlatMesh(nsbmd: NSBMDFile): FlatMeshData | null {
  const allPos: number[] = [];
  const allNrm: number[] = [];
  const allCol: number[] = [];
  const allIdx: number[] = [];
  let vOff = 0;

  for (const model of nsbmd.models) {
    for (const mesh of model.meshes) {
      for (let i = 0; i < mesh.positions.length; i++) allPos.push(mesh.positions[i]);
      for (let i = 0; i < mesh.normals.length; i++) allNrm.push(mesh.normals[i]);
      for (let i = 0; i < mesh.colors.length; i++) allCol.push(mesh.colors[i]);
      for (let i = 0; i < mesh.indices.length; i++) allIdx.push(mesh.indices[i] + vOff);
      vOff += mesh.positions.length / 3;
    }
  }

  if (allPos.length === 0) return null;

  return {
    positions: new Float32Array(allPos),
    normals: new Float32Array(allNrm),
    colors: new Float32Array(allCol),
    indices: new Uint32Array(allIdx),
  };
}
