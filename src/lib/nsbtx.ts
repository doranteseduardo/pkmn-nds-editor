/**
 * NSBTX / TEX0 parser for NDS 3D textures.
 *
 * Architecture: two-phase pipeline matching DSPRE + Java reference (Pokemon-DS-Map-Studio):
 *   Phase 1: parseTEX0() extracts RAW texture data (bytes) and RAW palette data (RGBA) SEPARATELY
 *   Phase 2: makeTexture() decodes one raw texture + palette pair into an RGBA image
 *
 * Dict parsing uses the SKIP-BASED approach from DSPRE:
 *   - Skips 14 + count*4 bytes after dummy+count to reach data entries
 *   - The u16 at dict+2 is sizeUnit (bytes per entry), NOT an offset
 *
 * NDS texture formats:
 *   0 = None, 1 = A3I5, 2 = Pal4, 3 = Pal16, 4 = Pal256, 5 = 4x4 Compressed, 6 = A5I3, 7 = Direct
 */

import { BinaryReader } from "./binary";

// ─── Types matching DSPRE's NSBMDTexture / NSBMDPalette ──────

export interface RawNdsTexture {
  texname: string;
  format: number;
  width: number;
  height: number;
  color0: number;       // color0 transparent flag
  texdata: Uint8Array;  // raw indexed pixel data (NOT decoded)
  texsize: number;
  texoffset: number;
  spdata: Uint8Array | null;  // format 5 only: compressed palette info
}

export interface RGBA {
  R: number;
  G: number;
  B: number;
  A: number;
}

export interface RawNdsPalette {
  palname: string;
  paldata: RGBA[];      // palette colors (BGR555 → RGBA, matching DSPRE)
  paloffset: number;
  palsize: number;
}

export interface TEX0RawData {
  textures: RawNdsTexture[];
  palettes: RawNdsPalette[];
}

/** Decoded texture ready for rendering */
export interface NdsTexture {
  name: string;
  width: number;
  height: number;
  format: number;
  rgba: Uint8Array;
}

// ─── TEX0 Block Parser ─────────────────────────────────────────
// Uses skip-based dict reading from DSPRE (NSBTXLoader.cs)

const TEX0_MAGIC = 0x30584554; // "TEX0"

/**
 * Parse a TEX0 block and extract raw texture data + raw palette data separately.
 * Does NOT decode textures — that happens later via makeTexture().
 *
 * Exact replica of DSPRE's NSBTXLoader.ReadTex0() — sequential reads
 * matching the C# code step by step.
 */
export function parseTEX0(buffer: ArrayBuffer, blockOffset: number): TEX0RawData | null {
  // ──────────────────────────────────────────────────────────────
  // Exact replica of DSPRE's NSBTXLoader.ReadTex0() — sequential reads
  // matching lines 83-351 of NSBTXLoader.cs step by step.
  // ──────────────────────────────────────────────────────────────
  const r = new BinaryReader(buffer);
  const view = new DataView(buffer);

  // DSPRE line 102: blockptr = blockoffset + 4 (already read block ID)
  r.seek(blockOffset);
  const magic = r.u32();
  if (magic !== TEX0_MAGIC) return null;

  // DSPRE line 103-104: blocksize, blocklimit
  const blockSize = r.u32();
  const blockLimit = blockSize + blockOffset;

  // DSPRE line 107: skip(4) padding
  r.skip(4);

  // DSPRE line 108: texdatasize = ReadUInt16() << 3
  const texDataSize = r.u16() << 3;

  // DSPRE line 109: skip(6) — includes the texInfoOffset u16 that we DON'T use
  r.skip(6);

  // DSPRE line 110: texdataoffset = ReadUInt32() + blockoffset
  const texDataOffset = r.u32() + blockOffset;

  // DSPRE line 112: skip(4) padding
  r.skip(4);

  // DSPRE line 113: sptexsize = ReadUInt16() << 3
  const spTexSize = r.u16() << 3;

  // DSPRE line 114: skip(6)
  r.skip(6);

  // DSPRE line 115-116: sptexoffset, spdataoffset
  const spTexOffset = r.u32() + blockOffset;
  const spDataOffset = r.u32() + blockOffset;

  // DSPRE line 118: skip(4)
  r.skip(4);

  // DSPRE line 119: paldatasize = ReadUInt16() << 3
  const palDataSize = r.u16() << 3;

  // DSPRE line 120: skip(2)
  r.skip(2);

  // DSPRE line 121-122: paldefoffset, paldataoffset
  const palDefOffset = r.u32() + blockOffset;
  const palDataOffset = r.u32() + blockOffset;

  console.log(`[TEX0] Header: texDataOff=0x${(texDataOffset - blockOffset).toString(16)}, palDefOff=0x${(palDefOffset - blockOffset).toString(16)}, palDataOff=0x${(palDataOffset - blockOffset).toString(16)}`);
  console.log(`[TEX0] Header: spTexOff=0x${(spTexOffset - blockOffset).toString(16)}, spDataOff=0x${(spDataOffset - blockOffset).toString(16)}`);

  // Stream is now at the texture definition dict
  // DSPRE line 131: skip(1) dummy
  r.skip(1);
  // DSPRE line 132: texnum = ReadByte()
  const texNum = r.u8();

  // DSPRE line 133-137: save position, seek to paldefoffset to read palnum, seek back
  const savedPos = r.offset;
  r.seek(palDefOffset);
  r.skip(1); // dummy
  const palNum = r.u8();
  r.seek(savedPos);

  console.log(`[TEX0] texNum=${texNum}, palNum=${palNum}`);

  // DSPRE line 147: skip(14 + texnum*4) — go straight to texture info
  r.skip(14 + texNum * 4);

  // ─── DSPRE lines 149-182: Read texture info entries (8 bytes each) ───
  const textures: RawNdsTexture[] = [];
  for (let i = 0; i < texNum; i++) {
    const texOff = r.u16() << 3;      // DSPRE: offset = ReadUInt16() << 3
    const param = r.u16();             // DSPRE: param = ReadUInt16()
    r.skip(4);                         // DSPRE: skip(4)

    const format = (param >> 10) & 7;
    const width = 8 << ((param >> 4) & 7);
    const height = 8 << ((param >> 7) & 7);
    const color0 = (param >> 13) & 1;

    const texoffset = format === 5
      ? texOff + spTexOffset
      : texOff + texDataOffset;

    const bpp = [0, 8, 2, 4, 8, 2, 8, 16];
    const texsize = (width * height * bpp[format]) / 8;

    textures.push({
      texname: "",
      format, width, height, color0,
      texdata: new Uint8Array(0),
      texsize, texoffset,
      spdata: null,
    });
  }

  // ─── DSPRE lines 186-191: Read texture names (16 bytes each) ───
  for (let i = 0; i < texNum; i++) {
    textures[i].texname = readNdsString16(r);
  }

  // ─── DSPRE lines 208-218: Palette definition dict ───
  // DSPRE: stream.Seek(paldefoffset + 2) then skip(14 + palnum*4)
  r.seek(palDefOffset + 2);
  r.skip(14 + palNum * 4);

  const palettes: RawNdsPalette[] = [];
  for (let i = 0; i < palNum; i++) {
    const curOffset = (r.u16() << 3) + palDataOffset;  // DSPRE: (ReadUInt16() << 3) + paldataoffset
    r.skip(2);                                           // DSPRE: Seek(2, Current)

    palettes.push({
      palname: "",
      paldata: [],
      paloffset: curOffset,
      palsize: 0,
    });
  }

  // ─── DSPRE lines 222-228: Read palette names (16 bytes each) ───
  for (let i = 0; i < palNum; i++) {
    palettes[i].palname = readNdsString16(r);
  }

  // ─── DSPRE lines 256-282: Calculate palette sizes ───
  const offsets: number[] = [];
  for (const p of palettes) {
    if (!offsets.includes(p.paloffset)) offsets.push(p.paloffset);
  }
  offsets.push(blockLimit);
  offsets.sort((a, b) => a - b);

  for (const pal of palettes) {
    let l = -1;
    do { l++; } while (l < offsets.length && offsets[l] - pal.paloffset <= 0);
    if (l < offsets.length) {
      pal.palsize = offsets[l] - pal.paloffset;
    }
  }

  // ─── DSPRE lines 286-313: Read raw texture data ───
  for (let i = 0; i < texNum; i++) {
    const tex = textures[i];
    if (tex.texoffset + tex.texsize > buffer.byteLength) {
      console.warn(`[TEX0] Texture "${tex.texname}" data out of bounds: off=0x${tex.texoffset.toString(16)}, size=${tex.texsize}`);
      tex.texdata = new Uint8Array(tex.texsize);
      continue;
    }
    r.seek(tex.texoffset);
    tex.texdata = new Uint8Array(buffer.slice(tex.texoffset, tex.texoffset + tex.texsize));

    // Format 5: additional compressed palette info data
    if (tex.format === 5) {
      const spSize = tex.texsize / 2;
      const spOff = spDataOffset + (tex.texoffset - spTexOffset) / 2;
      if (spOff + spSize <= buffer.byteLength) {
        tex.spdata = new Uint8Array(buffer.slice(spOff, spOff + spSize));
      }
    }
  }

  // ─── DSPRE lines 318-345: Read palette data BGR555 → RGBA ───
  for (let i = 0; i < palNum; i++) {
    const pal = palettes[i];
    const palEntryCount = pal.palsize >> 1;
    const rgbq: RGBA[] = new Array(palEntryCount);

    try {
      r.seek(pal.paloffset);
      for (let j = 0; j < palEntryCount; j++) {
        const p = r.u16();
        rgbq[j] = {
          R: ((p >>> 0) & 0x1F) << 3,
          G: ((p >>> 5) & 0x1F) << 3,
          B: ((p >>> 10) & 0x1F) << 3,
          A: (p & 0x8000) === 0 ? 0xFF : 0,
        };
      }
    } catch {
      for (let j = 0; j < palEntryCount; j++) {
        if (!rgbq[j]) rgbq[j] = { R: 0, G: 0, B: 0, A: 255 };
      }
    }

    pal.paldata = rgbq;
  }

  // ─── Diagnostic output ───
  if (textures.length > 0) {
    const t0 = textures[0];
    const hex = Array.from(t0.texdata.slice(0, 32)).map(b => b.toString(16).padStart(2, "0")).join(" ");
    console.log(`[TEX0] First tex "${t0.texname}" fmt=${t0.format} ${t0.width}x${t0.height} off=0x${t0.texoffset.toString(16)} data[0:32]=${hex}`);
  }
  if (palettes.length > 0) {
    const p0 = palettes[0];
    const first4 = p0.paldata.slice(0, 4).map(c => `rgb(${c.R},${c.G},${c.B},${c.A})`).join(", ");
    console.log(`[TEX0] First pal "${p0.palname}" size=${p0.palsize} colors[0:4]=${first4}`);
  }

  console.log(`[TEX0] Textures: ${textures.map(t => `"${t.texname}" fmt=${t.format} ${t.width}x${t.height}`).join(", ")}`);
  console.log(`[TEX0] Palettes: ${palettes.map(p => `"${p.palname}" size=${p.palsize} colors=${p.paldata.length}`).join(", ")}`);

  return { textures, palettes };
}

// ─── MakeTexture: Decode raw texture + palette → RGBA ────────
// Matches DSPRE's NSBMDGlRenderer.MakeTexture() exactly

/**
 * Decode a raw texture using its matched palette to produce an RGBA image.
 * This is the equivalent of DSPRE's MakeTexture() — called per-material at render time.
 */
export function makeTexture(tex: RawNdsTexture, pal: RawNdsPalette | null): Uint8Array | null {
  if (tex.format === 0) return null;
  if (!pal && tex.format !== 7) return null;

  const pixelNum = tex.width * tex.height;
  const image: RGBA[] = new Array(pixelNum);
  for (let j = 0; j < pixelNum; j++) {
    image[j] = { R: 0, G: 0, B: 0, A: 255 };
  }

  const paldata = pal?.paldata ?? [];

  try {
    switch (tex.format) {
      case 0:
        return null;

      // A3I5 Translucent Texture (3bit Alpha, 5bit Color Index)
      // DSPRE: alpha = ((alpha * 4) + (alpha / 2)) * 8
      case 1:
        for (let j = 0; j < pixelNum; j++) {
          const index = tex.texdata[j] & 0x1F;
          let alpha = (tex.texdata[j] >> 5); // & 7
          alpha = ((alpha * 4) + (alpha / 2 | 0)) * 8;
          if (index < paldata.length) {
            image[j] = { ...paldata[index] };
          }
          image[j].A = Math.min(alpha, 255);
        }
        break;

      // 4-Color Palette Texture
      case 2: {
        // DSPRE: if color0 != 0, make palette entry 0 transparent
        const pd = paldata.slice();
        if (tex.color0 !== 0 && pd.length > 0) {
          pd[0] = { R: 0, G: 0, B: 0, A: 0 };
        }
        for (let j = 0; j < pixelNum; j++) {
          let index = tex.texdata[j / 4 | 0];
          index = (index >> ((j % 4) << 1)) & 3;
          if (index < pd.length) {
            image[j] = { ...pd[index] };
          }
        }
        break;
      }

      // 16-Color Palette Texture
      case 3: {
        const pd = paldata.slice();
        if (tex.color0 !== 0 && pd.length > 0) {
          pd[0] = { R: 0, G: 0, B: 0, A: 0 };
        }
        for (let j = 0; j < pixelNum; j++) {
          const matindex = j / 2 | 0;
          if (matindex >= tex.texdata.length) continue;
          let index = tex.texdata[matindex];
          index = (index >> ((j % 2) << 2)) & 0x0F;
          if (index < 0 || index >= pd.length) continue;
          image[j] = { ...pd[index] };
        }
        break;
      }

      // 256-Color Palette Texture
      case 4: {
        const pd = paldata.slice();
        if (tex.color0 !== 0 && pd.length > 0) {
          pd[0] = { R: 0, G: 0, B: 0, A: 0 };
        }
        for (let j = 0; j < pixelNum; j++) {
          const idx = tex.texdata[j];
          if (idx < pd.length) {
            image[j] = { ...pd[idx] };
          }
        }
        break;
      }

      // 4x4-Texel Compressed Texture (matching DSPRE's convert_4x4texel exactly)
      case 5: {
        if (!tex.spdata) {
          console.warn(`[makeTexture] Format 5 texture "${tex.texname}" missing spdata`);
          return null;
        }
        convert4x4Texel(tex.texdata, tex.width, tex.height, tex.spdata, paldata, image);
        break;
      }

      // A5I3 Translucent Texture (5bit Alpha, 3bit Color Index)
      // DSPRE: alpha *= 8
      case 6:
        for (let j = 0; j < pixelNum; j++) {
          const index = tex.texdata[j] & 0x7;
          let alpha = (tex.texdata[j] >> 3);
          alpha *= 8;
          if (index < paldata.length) {
            image[j] = { ...paldata[index] };
          }
          image[j].A = Math.min(alpha, 255);
        }
        break;

      // Direct Color Texture
      case 7:
        for (let j = 0; j < pixelNum; j++) {
          const lo = tex.texdata[j * 2];
          const hi = tex.texdata[j * 2 + 1];
          const p = lo | (hi << 8);
          image[j] = {
            R: ((p >>> 0) & 0x1F) << 3,
            G: ((p >>> 5) & 0x1F) << 3,
            B: ((p >>> 10) & 0x1F) << 3,
            A: (p & 0x8000) !== 0 ? 0xFF : 0,
          };
        }
        break;

      default:
        return null;
    }
  } catch (e) {
    console.warn(`[makeTexture] Error decoding "${tex.texname}" format ${tex.format}:`, e);
    return null;
  }

  // Convert RGBA struct array to Uint8Array
  const rgba = new Uint8Array(pixelNum * 4);
  for (let j = 0; j < pixelNum; j++) {
    const px = image[j];
    const off = j * 4;
    rgba[off] = px.R;
    rgba[off + 1] = px.G;
    rgba[off + 2] = px.B;
    rgba[off + 3] = px.A;
  }

  return rgba;
}

// ─── Format 5: 4x4 Compressed Texel Decoder ─────────────────
// Matches DSPRE's convert_4x4texel() exactly (NSBMDGlRenderer.cs lines 1053-1122)

function convert4x4Texel(
  texBytes: Uint8Array, width: number, height: number,
  dataBytes: Uint8Array, pal: RGBA[], rgbaOut: RGBA[]
): void {
  // Convert tex bytes to u32 array (matching DSPRE's convert_4x4texel_b)
  const tex: number[] = [];
  for (let i = 0; i < ((texBytes.length + 1) / 4 | 0); i++) {
    tex.push(
      texBytes[i * 4] |
      (texBytes[i * 4 + 1] << 8) |
      (texBytes[i * 4 + 2] << 16) |
      ((texBytes[i * 4 + 3] << 24) >>> 0)
    );
  }

  // Convert data bytes to u16 array
  const data: number[] = [];
  for (let i = 0; i < ((dataBytes.length + 1) / 2 | 0); i++) {
    data.push(dataBytes[i * 2] | (dataBytes[i * 2 + 1] << 8));
  }

  const w = width / 4 | 0;
  const h = height / 4 | 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const index = y * w + x;
      if (index >= tex.length || index >= data.length) continue;

      const t = tex[index] >>> 0;
      const d = data[index];
      const addr = d & 0x3FFF;
      const mode = (d >> 14) & 3;

      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          const texel = (t >> ((r * 4 + c) * 2)) & 3;
          const outIdx = (y * 4 + r) * width + (x * 4 + c);
          if (outIdx >= rgbaOut.length) continue;

          let pixel: RGBA = { R: 0, G: 0, B: 0, A: 0 };

          // DSPRE: pal[(addr << 1) + texel]
          const palIdx0 = (addr << 1);

          switch (mode) {
            case 0:
              if (palIdx0 + texel < pal.length) {
                pixel = { ...pal[palIdx0 + texel] };
              }
              if (texel === 3) {
                pixel = { R: 0, G: 0, B: 0, A: 0 }; // transparent
              }
              break;

            case 2:
              if (palIdx0 + texel < pal.length) {
                pixel = { ...pal[palIdx0 + texel] };
              }
              break;

            case 1:
              switch (texel) {
                case 0:
                case 1:
                  if (palIdx0 + texel < pal.length) {
                    pixel = { ...pal[palIdx0 + texel] };
                  }
                  break;
                case 2: {
                  const c0 = palIdx0 < pal.length ? pal[palIdx0] : { R: 0, G: 0, B: 0, A: 255 };
                  const c1 = palIdx0 + 1 < pal.length ? pal[palIdx0 + 1] : { R: 0, G: 0, B: 0, A: 255 };
                  pixel = {
                    R: (c0.R + c1.R) / 2 | 0,
                    G: (c0.G + c1.G) / 2 | 0,
                    B: (c0.B + c1.B) / 2 | 0,
                    A: 0xFF,
                  };
                  break;
                }
                case 3:
                  pixel = { R: 0, G: 0, B: 0, A: 0 }; // transparent
                  break;
              }
              break;

            case 3:
              switch (texel) {
                case 0:
                case 1:
                  if (palIdx0 + texel < pal.length) {
                    pixel = { ...pal[palIdx0 + texel] };
                  }
                  break;
                case 2: {
                  const c0 = palIdx0 < pal.length ? pal[palIdx0] : { R: 0, G: 0, B: 0, A: 255 };
                  const c1 = palIdx0 + 1 < pal.length ? pal[palIdx0 + 1] : { R: 0, G: 0, B: 0, A: 255 };
                  pixel = {
                    R: (c0.R * 5 + c1.R * 3) / 8 | 0,
                    G: (c0.G * 5 + c1.G * 3) / 8 | 0,
                    B: (c0.B * 5 + c1.B * 3) / 8 | 0,
                    A: 0xFF,
                  };
                  break;
                }
                case 3: {
                  const c0 = palIdx0 < pal.length ? pal[palIdx0] : { R: 0, G: 0, B: 0, A: 255 };
                  const c1 = palIdx0 + 1 < pal.length ? pal[palIdx0 + 1] : { R: 0, G: 0, B: 0, A: 255 };
                  pixel = {
                    R: (c0.R * 3 + c1.R * 5) / 8 | 0,
                    G: (c0.G * 3 + c1.G * 5) / 8 | 0,
                    B: (c0.B * 3 + c1.B * 5) / 8 | 0,
                    A: 0xFF,
                  };
                  break;
                }
              }
              break;
          }

          rgbaOut[outIdx] = pixel;
        }
      }
    }
  }
}

// ─── Utility ─────────────────────────────────────────────────

function readNdsString16FromView(view: DataView, offset: number, bufLen: number): string {
  if (offset + 16 > bufLen) return "";
  let s = "";
  for (let i = 0; i < 16; i++) {
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

// Keep BinaryReader-based version for backward compat
function readNdsString16(r: BinaryReader): string {
  if (!r.canRead(16)) return "";
  return r.str(16).replace(/\0/g, "").trim();
}
