/**
 * NSBMD (Nitro System Binary Model) parser.
 * Decodes NDS 3D models from GPU display list commands into triangle meshes
 * suitable for Three.js rendering.
 *
 * Based on DSPRE's NSBMDLoader/NSBMDGlRenderer and GBATEK documentation.
 *
 * File structure: BMD0 header → MDL0 block → Models → Polygons → GPU commands
 * GPU commands encode vertices using fixed-point arithmetic (1/4096 scale).
 */

import { BinaryReader } from "./binary";

// ─── Types ───────────────────────────────────────────────────

export interface NSBMDVertex {
  x: number; y: number; z: number;   // position
  nx: number; ny: number; nz: number; // normal
  r: number; g: number; b: number;   // color (0-1)
  u: number; v: number;              // texture coords
}

export interface NSBMDMesh {
  vertices: NSBMDVertex[];
  indices: number[];
  materialIndex: number;
}

export interface NSBMDMaterial {
  diffuseR: number; diffuseG: number; diffuseB: number;
  ambientR: number; ambientG: number; ambientB: number;
  alpha: number;
  texWidth: number; texHeight: number;
  texFormat: number;
}

export interface NSBMDModel {
  name: string;
  meshes: NSBMDMesh[];
  materials: NSBMDMaterial[];
  posScale: number;
}

export interface NSBMDFile {
  models: NSBMDModel[];
}

// ─── Constants ───────────────────────────────────────────────

const BMD0_MAGIC = 0x30444D42; // "BMD0"
const MDL0_MAGIC = 0x304C444D; // "MDL0"

// GPU command IDs
const CMD = {
  NOP: 0x00,
  MTX_RESTORE: 0x14,
  MTX_IDENTITY: 0x15,
  MTX_LOAD_4x4: 0x16,
  MTX_MULT_4x4: 0x17,
  MTX_MULT_3x3: 0x18,
  MTX_MULT_4x3: 0x19,
  MTX_SCALE: 0x1B,
  MTX_TRANS: 0x1C,
  COLOR: 0x20,
  NORMAL: 0x21,
  TEXCOORD: 0x22,
  VTX_16: 0x23,
  VTX_10: 0x24,
  VTX_XY: 0x25,
  VTX_XZ: 0x26,
  VTX_YZ: 0x27,
  VTX_DIFF: 0x28,
  DIF_AMB: 0x30,
  BEGIN_VTXS: 0x40,
  END_VTXS: 0x41,
};

// Number of 4-byte parameters per command
const CMD_PARAMS: Record<number, number> = {
  [CMD.NOP]: 0,
  [CMD.MTX_RESTORE]: 1,
  [CMD.MTX_IDENTITY]: 0,
  [CMD.MTX_LOAD_4x4]: 16,
  [CMD.MTX_MULT_4x4]: 16,
  [CMD.MTX_MULT_3x3]: 9,
  [CMD.MTX_MULT_4x3]: 12,
  [CMD.MTX_SCALE]: 3,
  [CMD.MTX_TRANS]: 3,
  [CMD.COLOR]: 1,
  [CMD.NORMAL]: 1,
  [CMD.TEXCOORD]: 1,
  [CMD.VTX_16]: 2,
  [CMD.VTX_10]: 1,
  [CMD.VTX_XY]: 1,
  [CMD.VTX_XZ]: 1,
  [CMD.VTX_YZ]: 1,
  [CMD.VTX_DIFF]: 1,
  [CMD.DIF_AMB]: 1,
  [CMD.BEGIN_VTXS]: 1,
  [CMD.END_VTXS]: 0,
};

// ─── Sign extension helper ───────────────────────────────────

function signExtend(value: number, bits: number): number {
  const mask = 1 << (bits - 1);
  if (value & mask) return value | (-1 << bits);
  return value;
}

// ─── GPU Command Decoder ─────────────────────────────────────

interface DecodedMesh {
  positions: number[];
  normals: number[];
  colors: number[];
  indices: number[];
}

function decodeDisplayList(data: Uint8Array, posScale: number): DecodedMesh[] {
  const meshes: DecodedMesh[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let ptr = 0;

  // Vertex state
  let vtxX = 0, vtxY = 0, vtxZ = 0;
  let nrmX = 0, nrmY = 0, nrmZ = 1;
  let colR = 1, colG = 1, colB = 1;

  // Current batch
  let polyMode = -1;
  let batchVerts: { x: number; y: number; z: number; nx: number; ny: number; nz: number; r: number; g: number; b: number }[] = [];

  const scale = posScale > 0 ? posScale : 1;

  function readU32(): number {
    if (ptr + 4 > data.length) return 0;
    const v = view.getUint32(ptr, true);
    ptr += 4;
    return v;
  }

  function emitVertex() {
    batchVerts.push({
      x: vtxX * scale, y: vtxY * scale, z: vtxZ * scale,
      nx: nrmX, ny: nrmY, nz: nrmZ,
      r: colR, g: colG, b: colB,
    });
  }

  function flushBatch() {
    if (batchVerts.length < 3) { batchVerts = []; return; }

    const mesh: DecodedMesh = { positions: [], normals: [], colors: [], indices: [] };
    let idx = 0;

    const pushVert = (v: typeof batchVerts[0]) => {
      mesh.positions.push(v.x, v.y, v.z);
      mesh.normals.push(v.nx, v.ny, v.nz);
      mesh.colors.push(v.r, v.g, v.b);
      return idx++;
    };

    if (polyMode === 0) {
      // Triangles
      for (let i = 0; i + 2 < batchVerts.length; i += 3) {
        const a = pushVert(batchVerts[i]);
        const b = pushVert(batchVerts[i + 1]);
        const c = pushVert(batchVerts[i + 2]);
        mesh.indices.push(a, b, c);
      }
    } else if (polyMode === 1) {
      // Quads → two triangles
      for (let i = 0; i + 3 < batchVerts.length; i += 4) {
        const a = pushVert(batchVerts[i]);
        const b = pushVert(batchVerts[i + 1]);
        const c = pushVert(batchVerts[i + 2]);
        const d = pushVert(batchVerts[i + 3]);
        mesh.indices.push(a, b, c, a, c, d);
      }
    } else if (polyMode === 2) {
      // Triangle strip
      for (let i = 0; i < batchVerts.length; i++) pushVert(batchVerts[i]);
      for (let i = 0; i + 2 < batchVerts.length; i++) {
        if (i % 2 === 0) {
          mesh.indices.push(i, i + 1, i + 2);
        } else {
          mesh.indices.push(i + 1, i, i + 2);
        }
      }
    } else if (polyMode === 3) {
      // Quad strip → triangle strip variant
      for (let i = 0; i < batchVerts.length; i++) pushVert(batchVerts[i]);
      for (let i = 0; i + 3 < batchVerts.length; i += 2) {
        mesh.indices.push(i, i + 1, i + 2);
        mesh.indices.push(i + 2, i + 1, i + 3);
      }
    }

    if (mesh.indices.length > 0) meshes.push(mesh);
    batchVerts = [];
  }

  // Process packed commands (4 command bytes, then their params)
  while (ptr < data.length) {
    // Read up to 4 command bytes
    const cmdStart = ptr;
    const cmds: number[] = [];
    for (let i = 0; i < 4 && ptr < data.length; i++) {
      cmds.push(data[ptr++]);
    }

    // Process each command's parameters
    for (const cmd of cmds) {
      if (cmd === 0xFF || cmd === 0x00) continue; // NOP/padding

      switch (cmd) {
        case CMD.BEGIN_VTXS: {
          polyMode = readU32() & 3;
          batchVerts = [];
          break;
        }
        case CMD.END_VTXS: {
          flushBatch();
          polyMode = -1;
          break;
        }
        case CMD.VTX_16: {
          const p1 = readU32();
          const p2 = readU32();
          vtxX = signExtend(p1 & 0xFFFF, 16) / 4096;
          vtxY = signExtend((p1 >> 16) & 0xFFFF, 16) / 4096;
          vtxZ = signExtend(p2 & 0xFFFF, 16) / 4096;
          emitVertex();
          break;
        }
        case CMD.VTX_10: {
          const p = readU32();
          vtxX = signExtend(p & 0x3FF, 10) / 64;
          vtxY = signExtend((p >> 10) & 0x3FF, 10) / 64;
          vtxZ = signExtend((p >> 20) & 0x3FF, 10) / 64;
          emitVertex();
          break;
        }
        case CMD.VTX_XY: {
          const p = readU32();
          vtxX = signExtend(p & 0xFFFF, 16) / 4096;
          vtxY = signExtend((p >> 16) & 0xFFFF, 16) / 4096;
          emitVertex();
          break;
        }
        case CMD.VTX_XZ: {
          const p = readU32();
          vtxX = signExtend(p & 0xFFFF, 16) / 4096;
          vtxZ = signExtend((p >> 16) & 0xFFFF, 16) / 4096;
          emitVertex();
          break;
        }
        case CMD.VTX_YZ: {
          const p = readU32();
          vtxY = signExtend(p & 0xFFFF, 16) / 4096;
          vtxZ = signExtend((p >> 16) & 0xFFFF, 16) / 4096;
          emitVertex();
          break;
        }
        case CMD.VTX_DIFF: {
          const p = readU32();
          vtxX += signExtend(p & 0x3FF, 10) / 4096;
          vtxY += signExtend((p >> 10) & 0x3FF, 10) / 4096;
          vtxZ += signExtend((p >> 20) & 0x3FF, 10) / 4096;
          emitVertex();
          break;
        }
        case CMD.NORMAL: {
          const p = readU32();
          nrmX = signExtend(p & 0x3FF, 10) / 512;
          nrmY = signExtend((p >> 10) & 0x3FF, 10) / 512;
          nrmZ = signExtend((p >> 20) & 0x3FF, 10) / 512;
          break;
        }
        case CMD.COLOR: {
          const p = readU32();
          colR = (p & 0x1F) / 31;
          colG = ((p >> 5) & 0x1F) / 31;
          colB = ((p >> 10) & 0x1F) / 31;
          break;
        }
        case CMD.TEXCOORD: {
          readU32(); // Skip texture coords for now (no texture support yet)
          break;
        }
        case CMD.DIF_AMB: {
          const p = readU32();
          colR = (p & 0x1F) / 31;
          colG = ((p >> 5) & 0x1F) / 31;
          colB = ((p >> 10) & 0x1F) / 31;
          break;
        }
        case CMD.MTX_RESTORE: { readU32(); break; }
        case CMD.MTX_IDENTITY: { break; }
        case CMD.MTX_SCALE: { readU32(); readU32(); readU32(); break; }
        case CMD.MTX_TRANS: { readU32(); readU32(); readU32(); break; }
        case CMD.MTX_LOAD_4x4:
        case CMD.MTX_MULT_4x4: {
          for (let i = 0; i < 16; i++) readU32();
          break;
        }
        case CMD.MTX_MULT_3x3: {
          for (let i = 0; i < 9; i++) readU32();
          break;
        }
        case CMD.MTX_MULT_4x3: {
          for (let i = 0; i < 12; i++) readU32();
          break;
        }
        default: {
          // Unknown command — try to skip its params
          const params = CMD_PARAMS[cmd];
          if (params !== undefined) {
            for (let i = 0; i < params; i++) readU32();
          }
          break;
        }
      }
    }
  }

  // Flush any remaining batch
  if (batchVerts.length >= 3) flushBatch();

  return meshes;
}

// ─── NSBMD File Parser ────────────────────────────────────────

export function parseNSBMD(buffer: ArrayBuffer): NSBMDFile | null {
  if (buffer.byteLength < 16) return null;
  const r = new BinaryReader(buffer);

  // Check BMD0 header
  const magic = r.u32();
  if (magic !== BMD0_MAGIC) {
    console.warn(`Not a BMD0 file (magic=0x${magic.toString(16)})`);
    return null;
  }

  const bom = r.u16(); // byte order (0xFEFF)
  const version = r.u16();
  const fileSize = r.u32();
  const headerSize = r.u16();
  const numSections = r.u16();

  // Read section offsets
  const sectionOffsets: number[] = [];
  for (let i = 0; i < numSections; i++) {
    sectionOffsets.push(r.u32());
  }

  // Find MDL0 section
  let mdl0Offset = -1;
  for (const off of sectionOffsets) {
    r.seek(off);
    const sectionMagic = r.u32();
    if (sectionMagic === MDL0_MAGIC) {
      mdl0Offset = off;
      break;
    }
  }

  if (mdl0Offset < 0) {
    console.warn("No MDL0 section found in NSBMD");
    return null;
  }

  return parseMDL0(buffer, mdl0Offset);
}

function parseMDL0(buffer: ArrayBuffer, mdl0Offset: number): NSBMDFile {
  const r = new BinaryReader(buffer);
  r.seek(mdl0Offset);

  const magic = r.u32(); // MDL0
  const sectionSize = r.u32();

  // Read model list (NNS G3D dictionary format)
  // Dictionary header
  const dummy = r.u8();
  const modelCount = r.u8();
  const dictSize = r.u16();

  // Skip dictionary tree nodes
  // Each node: ref(u8), left(u8), right(u8), idxData(u8), param(u32), nameOffset(u32)
  // There's a dummy node first, then modelCount entries
  // Total size of dictionary (after header): depends on entry count

  // The dictionary is complex — use a simpler approach:
  // Seek past the dictionary and read model offsets from the offset table
  // Dictionary has (modelCount + 1) entries * 8 bytes after initial 4-byte block

  const models: NSBMDModel[] = [];

  // Read the offset/name list
  // Standard NNS dictionary: after 4-byte header, skip (count+1)*8 entries + names
  // Instead, let's scan for polygon data directly

  // Practical approach: scan for model data using the dictionary offsets
  r.seek(mdl0Offset + 8); // after MDL0 magic + size
  r.skip(4); // dictionary header (dummy, count, size already read — re-read)

  // Actually, let's use the known NDS G3D dict format:
  // After the 4-byte header (dummy, count, dictSize):
  // Unused entry (8 bytes)
  // Then count entries of 8 bytes each (ref, leftIdx, rightIdx, nameOffs[4 bytes], dataOffs[4 bytes])
  // Wait, the format may vary. Let me use a robust approach.

  // Re-read dictionary properly
  r.seek(mdl0Offset + 8); // past MDL0 magic + section size
  const dummyByte = r.u8();
  const numModels = r.u8();
  const dSize = r.u16();

  if (numModels === 0) return { models: [] };

  // Dictionary consists of:
  // - Unused entry (dummy): 4 bytes (ref, left, right, count/id)
  // - For each entry: 4 bytes (ref, left, right, id)
  // Total tree node data: (numModels + 1) * 4 bytes
  // Then entries section: numModels * { 4 bytes name offset, 4 bytes data offset }

  // Skip tree nodes (numModels + 1) * 4 bytes
  r.skip((numModels + 1) * 4);

  // Read entry offsets and names
  interface DictEntry { dataOffset: number; name: string; }
  const entries: DictEntry[] = [];

  // Read data offsets and name offsets
  const entryData: { nameOff: number; dataOff: number }[] = [];
  for (let i = 0; i < numModels; i++) {
    const nameOff = r.u32();
    const dataOff = r.u32();
    entryData.push({ nameOff, dataOff });
  }

  // Read names (they follow the dictionary)
  const namesBaseOffset = r.tell();
  for (let i = 0; i < numModels; i++) {
    // Names are typically 16-char null-terminated strings at fixed positions
    // The nameOff is relative to dictionary start
    const namePos = mdl0Offset + 8 + entryData[i].nameOff;
    if (namePos < buffer.byteLength) {
      r.seek(namePos);
      const name = r.str(16).replace(/\0/g, "").trim();
      entries.push({ dataOffset: entryData[i].dataOff, name });
    } else {
      entries.push({ dataOffset: entryData[i].dataOff, name: `model_${i}` });
    }
  }

  // Parse each model
  for (const entry of entries) {
    const modelOffset = mdl0Offset + entry.dataOffset;
    const model = parseModel(buffer, modelOffset, entry.name);
    if (model) models.push(model);
  }

  return { models };
}

function parseModel(buffer: ArrayBuffer, modelOffset: number, name: string): NSBMDModel | null {
  if (modelOffset >= buffer.byteLength - 4) return null;
  const r = new BinaryReader(buffer);
  r.seek(modelOffset);

  // Model header (varies by structure)
  // Try to find polygon data by scanning for known patterns
  // The model block typically contains:
  // - Model info (size, various offsets)
  // - Object list
  // - Material list
  // - Polygon list with display list data

  // Read model info header
  const modelSize = r.u32();
  const modelInfoOffset = r.u32(); // relative to model start

  // Read model info
  r.seek(modelOffset + modelInfoOffset);

  // Skip SBC (script bytecode) length and material/polygon info
  const sbcOffset = r.u32();
  const materialOffset = r.u32();
  const polygonOffset = r.u32();
  const inverseBindOffset = r.u32(); // inverse bind matrices

  // Skip misc model data
  r.skip(3); // unknown bytes
  const numObjects = r.u8();
  const numMaterials = r.u8();
  const numPolygons = r.u8();

  // Read position scale
  r.skip(2); // unknown
  const posScaleRaw = r.u32();
  // Fixed-point scale: 1 << posScale (or use raw value / 4096)
  const posScale = posScaleRaw === 0 ? 1 : (posScaleRaw >>> 0) / 4096;

  // We need to find the display list data for polygons.
  // Navigate to the polygon section
  const polyListOffset = modelOffset + modelInfoOffset + polygonOffset;

  // Parse polygon dictionary
  r.seek(polyListOffset);
  const polyDummy = r.u8();
  const polyCount = r.u8();
  const polyDictSize = r.u16();

  if (polyCount === 0) {
    return { name, meshes: [], materials: [], posScale: 1 };
  }

  // Skip tree nodes
  r.skip((polyCount + 1) * 4);

  // Read polygon entries
  const polyEntries: { nameOff: number; dataOff: number }[] = [];
  for (let i = 0; i < polyCount; i++) {
    polyEntries.push({ nameOff: r.u32(), dataOff: r.u32() });
  }

  const meshes: NSBMDMesh[] = [];

  // Process each polygon
  for (const pe of polyEntries) {
    const polyDataOffset = polyListOffset + pe.dataOff;
    if (polyDataOffset >= buffer.byteLength - 8) continue;

    r.seek(polyDataOffset);

    // Polygon header
    r.skip(4); // unknown/flags
    const displayListOffset = r.u32(); // relative to poly start
    const displayListSize = r.u32();

    if (displayListSize === 0 || displayListSize > 1000000) continue;

    const dlStart = polyDataOffset + displayListOffset;
    if (dlStart + displayListSize > buffer.byteLength) continue;

    const displayListData = new Uint8Array(buffer, dlStart, displayListSize);
    const decoded = decodeDisplayList(displayListData, posScale);

    for (const dm of decoded) {
      if (dm.indices.length === 0) continue;
      const vertices: NSBMDVertex[] = [];
      for (let i = 0; i < dm.positions.length / 3; i++) {
        vertices.push({
          x: dm.positions[i * 3],
          y: dm.positions[i * 3 + 1],
          z: dm.positions[i * 3 + 2],
          nx: dm.normals[i * 3],
          ny: dm.normals[i * 3 + 1],
          nz: dm.normals[i * 3 + 2],
          r: dm.colors[i * 3],
          g: dm.colors[i * 3 + 1],
          b: dm.colors[i * 3 + 2],
          u: 0, v: 0,
        });
      }
      meshes.push({ vertices, indices: dm.indices, materialIndex: 0 });
    }
  }

  return { name, meshes, materials: [], posScale };
}

// ─── Utility: Convert NSBMD to flat arrays for Three.js ──────

export interface FlatMeshData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

export function nsbmdToFlatMesh(nsbmd: NSBMDFile): FlatMeshData | null {
  // Combine all meshes from all models into one flat mesh
  const allPositions: number[] = [];
  const allNormals: number[] = [];
  const allColors: number[] = [];
  const allIndices: number[] = [];
  let vertexOffset = 0;

  for (const model of nsbmd.models) {
    for (const mesh of model.meshes) {
      for (const v of mesh.vertices) {
        allPositions.push(v.x, v.y, v.z);
        allNormals.push(v.nx, v.ny, v.nz);
        allColors.push(v.r, v.g, v.b);
      }
      for (const idx of mesh.indices) {
        allIndices.push(idx + vertexOffset);
      }
      vertexOffset += mesh.vertices.length;
    }
  }

  if (allPositions.length === 0) return null;

  return {
    positions: new Float32Array(allPositions),
    normals: new Float32Array(allNormals),
    colors: new Float32Array(allColors),
    indices: new Uint32Array(allIndices),
  };
}
