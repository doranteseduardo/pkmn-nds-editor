/**
 * NSBTX / TEX0 parser for NDS 3D textures.
 * Decodes texture and palette data from TEX0 blocks found in BMD0/BTX0 files.
 *
 * NDS texture formats:
 *   0 = None
 *   1 = A3I5 (3-bit alpha, 5-bit palette index)
 *   2 = Palette4 (2 bpp, 4 colors)
 *   3 = Palette16 (4 bpp, 16 colors)
 *   4 = Palette256 (8 bpp, 256 colors)
 *   5 = 4x4 Compressed (similar to S3TC)
 *   6 = A5I3 (5-bit alpha, 3-bit palette index)
 *   7 = Direct Color (16 bpp, RGBA5551)
 *
 * Texture params word (TEXIMAGE_PARAM):
 *   Bits 0-15:  VRAM offset (<<3 for byte offset)
 *   Bit  16:    Repeat S
 *   Bit  17:    Repeat T
 *   Bit  18:    Flip S
 *   Bit  19:    Flip T
 *   Bits 20-22: Width  (8 << n)
 *   Bits 23-25: Height (8 << n)
 *   Bits 26-28: Format (0-7)
 *   Bit  29:    Color0 transparent
 */

import { BinaryReader } from "./binary";

// ─── Types ───────────────────────────────────────────────────

export interface NdsTexture {
  name: string;
  width: number;
  height: number;
  format: number;
  rgba: Uint8Array; // width * height * 4 RGBA bytes
}

export interface TEX0Data {
  textures: NdsTexture[];
  /** Map from texture name → index in textures[] */
  textureMap: Map<string, number>;
}

// ─── TEX0 Block Parser ──────────────────────────────────────

const TEX0_MAGIC = 0x30584554; // "TEX0"

export function parseTEX0(buffer: ArrayBuffer, blockOffset: number): TEX0Data | null {
  const r = new BinaryReader(buffer);
  r.seek(blockOffset);

  const magic = r.u32();
  if (magic !== TEX0_MAGIC) return null;

  r.u32(); // blockSize
  r.skip(4); // padding

  // Texture section header
  r.u16();                              // texDataSize >> 3
  const texInfoOffset = r.u16();       // relative to TEX0 start
  r.skip(4); // padding
  const texDataOffset = r.u32();       // relative to TEX0 start
  r.skip(4); // padding

  // Compressed texture section (read but not yet used)
  r.u16();  // compTexDataSize >> 3
  r.u16();  // compTexInfoOffset
  r.skip(4); // padding
  r.u32();  // compTexDataOffset
  r.u32();  // compTexInfoDataOffset
  r.skip(4); // padding

  // Palette section
  r.u32();                              // palDataSize >> 3
  const palInfoOffset = r.u32();       // relative to TEX0 start
  const palDataOffset = r.u32();       // relative to TEX0 start

  const texDataAbsolute = blockOffset + texDataOffset;
  const palDataAbsolute = blockOffset + palDataOffset;

  console.log(`[TEX0] texData=0x${texDataAbsolute.toString(16)}, palData=0x${palDataAbsolute.toString(16)}, texInfo=0x${texInfoOffset.toString(16)}, palInfo=0x${palInfoOffset.toString(16)}`);

  // ─── Parse texture info dictionary ───
  // texInfoOffset is relative to TEX0 block start (same as palInfoOffset)
  const texInfoAbsolute = blockOffset + texInfoOffset;
  const texEntries = parseTexInfoDict(r, buffer, texInfoAbsolute);

  // ─── Parse palette info dictionary ───
  const palInfoAbsolute = blockOffset + palInfoOffset;
  const palEntries = parsePalInfoDict(r, buffer, palInfoAbsolute);

  console.log(`[TEX0] ${texEntries.length} textures, ${palEntries.length} palettes`);

  // ─── Decode textures ───
  const textures: NdsTexture[] = [];
  const textureMap = new Map<string, number>();

  for (let i = 0; i < texEntries.length; i++) {
    const tex = texEntries[i];
    const format = (tex.params >>> 26) & 7;
    const widthShift = (tex.params >>> 20) & 7;
    const heightShift = (tex.params >>> 23) & 7;
    const width = 8 << widthShift;
    const height = 8 << heightShift;
    const vramOffset = (tex.params & 0xFFFF) << 3;
    const color0Transparent = (tex.params >>> 29) & 1;

    const texDataStart = texDataAbsolute + vramOffset;

    // Find matching palette: first try same-name, then first available
    let palDataStart = palDataAbsolute;
    const matchingPal = palEntries.find(p => p.name === tex.name);
    if (matchingPal) {
      palDataStart = palDataAbsolute + matchingPal.offset;
    } else if (palEntries.length > 0) {
      // For palette4, each texture's palette index might be tex index * 4 colors * 2 bytes
      // For palette16, each palette is 16 colors * 2 bytes = 32 bytes
      // For palette256, each palette is 256 colors * 2 bytes = 512 bytes
      // Use palette index i if available, else first palette
      if (i < palEntries.length) {
        palDataStart = palDataAbsolute + palEntries[i].offset;
      } else {
        palDataStart = palDataAbsolute + palEntries[0].offset;
      }
    }

    console.log(`[TEX0] Decoding "${tex.name}": ${width}x${height} fmt=${format} texData=0x${texDataStart.toString(16)} palData=0x${palDataStart.toString(16)} bufLen=${buffer.byteLength}`);

    // Bounds check before decode
    if (texDataStart >= buffer.byteLength) {
      console.warn(`[TEX0]   texDataStart 0x${texDataStart.toString(16)} out of bounds`);
      continue;
    }

    const rgba = decodeTexture(
      buffer, texDataStart, palDataStart,
      width, height, format, color0Transparent !== 0
    );

    if (rgba) {
      textureMap.set(tex.name, textures.length);
      textures.push({ name: tex.name, width, height, format, rgba });
      console.log(`[TEX0]   OK: "${tex.name}" decoded ${width}x${height}`);
    } else {
      console.warn(`[TEX0]   FAILED to decode "${tex.name}" ${width}x${height} fmt=${format}`);
    }
  }

  return { textures, textureMap };
}

// ─── Dictionary Parsers ──────────────────────────────────────

interface TexInfoEntry {
  name: string;
  params: number;   // TEXIMAGE_PARAM
  extra: number;
}

interface PalInfoEntry {
  name: string;
  offset: number;   // relative to palette data start (already <<3)
}

function parseTexInfoDict(r: BinaryReader, buffer: ArrayBuffer, dictOffset: number): TexInfoEntry[] {
  if (dictOffset + 4 > buffer.byteLength) return [];
  r.seek(dictOffset);

  const dummy = r.u8();
  const count = r.u8();
  if (count === 0 || count > 256) return [];

  console.log(`[TEX0] TexInfoDict at 0x${dictOffset.toString(16)}: dummy=${dummy}, count=${count}`);

  // Use DSPRE-verified hardcoded skip: 14 + count*4 bytes for the dict tree
  // (same formula that works for MDL0 polygon/model dicts)
  r.skip(14 + count * 4);

  // Each texture info entry: 8 bytes (u32 params + u32 extra)
  const entries: TexInfoEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (!r.canRead(8)) break;
    const params = r.u32();
    const extra = r.u32();
    entries.push({ name: "", params, extra });

    const format = (params >>> 26) & 7;
    const wShift = (params >>> 20) & 7;
    const hShift = (params >>> 23) & 7;
    const vram = (params & 0xFFFF) << 3;
    console.log(`[TEX0]   texEntry[${i}]: params=0x${params.toString(16)}, fmt=${format}, ${8 << wShift}x${8 << hShift}, vram=0x${vram.toString(16)}`);
  }

  // Names: 16 bytes each
  for (let i = 0; i < count && i < entries.length; i++) {
    entries[i].name = readNdsString16(r);
    console.log(`[TEX0]   texName[${i}]: "${entries[i].name}"`);
  }

  return entries;
}

function parsePalInfoDict(r: BinaryReader, buffer: ArrayBuffer, dictOffset: number): PalInfoEntry[] {
  if (dictOffset + 4 > buffer.byteLength) return [];
  r.seek(dictOffset);

  const dummy = r.u8();
  const count = r.u8();
  if (count === 0 || count > 256) return [];

  console.log(`[TEX0] PalInfoDict at 0x${dictOffset.toString(16)}: dummy=${dummy}, count=${count}`);

  // Use hardcoded skip for dict tree
  r.skip(14 + count * 4);

  // Each palette info entry: 4 bytes (u16 offset<<3 + u16 unknown)
  const entries: PalInfoEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (!r.canRead(4)) break;
    const offsetShifted = r.u16();
    r.u16(); // unknown/flags
    entries.push({ name: "", offset: offsetShifted << 3 });
  }

  // Names
  for (let i = 0; i < count && i < entries.length; i++) {
    entries[i].name = readNdsString16(r);
  }

  return entries;
}

function readNdsString16(r: BinaryReader): string {
  if (!r.canRead(16)) return "";
  return r.str(16).replace(/\0/g, "").trim();
}

// ─── Texture Format Decoders ─────────────────────────────────

function decodeTexture(
  buffer: ArrayBuffer, texOffset: number, palOffset: number,
  width: number, height: number, format: number, color0Transparent: boolean
): Uint8Array | null {
  const pixels = width * height;
  const rgba = new Uint8Array(pixels * 4);
  const view = new DataView(buffer);

  try {
    switch (format) {
      case 1: decodeA3I5(view, texOffset, palOffset, width, height, rgba); break;
      case 2: decodePalette4(view, texOffset, palOffset, width, height, rgba, color0Transparent); break;
      case 3: decodePalette16(view, texOffset, palOffset, width, height, rgba, color0Transparent); break;
      case 4: decodePalette256(view, texOffset, palOffset, width, height, rgba, color0Transparent); break;
      case 5: decode4x4Compressed(view, texOffset, palOffset, width, height, rgba); break;
      case 6: decodeA5I3(view, texOffset, palOffset, width, height, rgba); break;
      case 7: decodeDirectColor(view, texOffset, width, height, rgba); break;
      default: return null;
    }
  } catch (e) {
    console.warn(`[TEX0] Decode error format ${format}: ${e}`);
    return null;
  }

  return rgba;
}

/** Read RGB555 palette color → [R8, G8, B8, A8] */
function readPalColor(view: DataView, offset: number): [number, number, number, number] {
  const c = view.getUint16(offset, true);
  const r = (c & 0x1F) * 255 / 31;
  const g = ((c >>> 5) & 0x1F) * 255 / 31;
  const b = ((c >>> 10) & 0x1F) * 255 / 31;
  return [r | 0, g | 0, b | 0, 255];
}

/** Format 1: A3I5 — 8bpp, lower 5 bits = index, upper 3 = alpha */
function decodeA3I5(
  view: DataView, texOff: number, palOff: number,
  w: number, h: number, out: Uint8Array
) {
  for (let i = 0; i < w * h; i++) {
    const byte = view.getUint8(texOff + i);
    const idx = byte & 0x1F;
    const alpha = (byte >>> 5) & 7;
    const [r, g, b] = readPalColor(view, palOff + idx * 2);
    const j = i * 4;
    out[j] = r; out[j + 1] = g; out[j + 2] = b;
    out[j + 3] = (alpha * 255 / 7) | 0;
  }
}

/** Format 6: A5I3 — 8bpp, lower 3 bits = index, upper 5 = alpha */
function decodeA5I3(
  view: DataView, texOff: number, palOff: number,
  w: number, h: number, out: Uint8Array
) {
  for (let i = 0; i < w * h; i++) {
    const byte = view.getUint8(texOff + i);
    const idx = byte & 0x07;
    const alpha = (byte >>> 3) & 0x1F;
    const [r, g, b] = readPalColor(view, palOff + idx * 2);
    const j = i * 4;
    out[j] = r; out[j + 1] = g; out[j + 2] = b;
    out[j + 3] = (alpha * 255 / 31) | 0;
  }
}

/** Format 2: Palette4 — 2bpp, 4-color palette */
function decodePalette4(
  view: DataView, texOff: number, palOff: number,
  w: number, h: number, out: Uint8Array, c0Trans: boolean
) {
  const pixels = w * h;
  for (let i = 0; i < pixels; i++) {
    const byteIdx = i >>> 2;
    const bitShift = (i & 3) * 2;
    const idx = (view.getUint8(texOff + byteIdx) >>> bitShift) & 3;
    const [r, g, b] = readPalColor(view, palOff + idx * 2);
    const j = i * 4;
    out[j] = r; out[j + 1] = g; out[j + 2] = b;
    out[j + 3] = (c0Trans && idx === 0) ? 0 : 255;
  }
}

/** Format 3: Palette16 — 4bpp, 16-color palette */
function decodePalette16(
  view: DataView, texOff: number, palOff: number,
  w: number, h: number, out: Uint8Array, c0Trans: boolean
) {
  const pixels = w * h;
  for (let i = 0; i < pixels; i++) {
    const byteIdx = i >>> 1;
    const nibble = (i & 1) === 0
      ? view.getUint8(texOff + byteIdx) & 0x0F
      : (view.getUint8(texOff + byteIdx) >>> 4) & 0x0F;
    const [r, g, b] = readPalColor(view, palOff + nibble * 2);
    const j = i * 4;
    out[j] = r; out[j + 1] = g; out[j + 2] = b;
    out[j + 3] = (c0Trans && nibble === 0) ? 0 : 255;
  }
}

/** Format 4: Palette256 — 8bpp, 256-color palette */
function decodePalette256(
  view: DataView, texOff: number, palOff: number,
  w: number, h: number, out: Uint8Array, c0Trans: boolean
) {
  for (let i = 0; i < w * h; i++) {
    const idx = view.getUint8(texOff + i);
    const [r, g, b] = readPalColor(view, palOff + idx * 2);
    const j = i * 4;
    out[j] = r; out[j + 1] = g; out[j + 2] = b;
    out[j + 3] = (c0Trans && idx === 0) ? 0 : 255;
  }
}

/** Format 7: Direct Color — 16bpp RGBA5551 */
function decodeDirectColor(
  view: DataView, texOff: number,
  w: number, h: number, out: Uint8Array
) {
  for (let i = 0; i < w * h; i++) {
    const c = view.getUint16(texOff + i * 2, true);
    const r = (c & 0x1F) * 255 / 31;
    const g = ((c >>> 5) & 0x1F) * 255 / 31;
    const b = ((c >>> 10) & 0x1F) * 255 / 31;
    const a = (c & 0x8000) ? 255 : 0;
    const j = i * 4;
    out[j] = r | 0; out[j + 1] = g | 0; out[j + 2] = b | 0;
    out[j + 3] = a;
  }
}

/** Format 5: 4x4 Compressed (block compression) */
function decode4x4Compressed(
  view: DataView, texOff: number, palOff: number,
  w: number, h: number, out: Uint8Array
) {
  // 4x4 compressed: each 4x4 block is 32 bits of texel data + 16 bits of palette info
  // The texel data and palette info are in separate sections
  // texel data: w/4 * h/4 * 4 bytes (32 bits per block)
  // palette info: w/4 * h/4 * 2 bytes (16 bits per block) follows texel data
  const bw = w >>> 2;
  const bh = h >>> 2;
  const texelSize = bw * bh * 4;
  const palInfoOff = texOff + texelSize;

  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const blockIdx = by * bw + bx;
      const texelData = view.getUint32(texOff + blockIdx * 4, true);
      const palInfo = view.getUint16(palInfoOff + blockIdx * 2, true);

      const palBase = (palInfo & 0x3FFF) << 2; // palette offset (in 2-byte color units)
      const mode = (palInfo >>> 14) & 3;

      // Read 4 palette colors
      const c: [number, number, number, number][] = [];
      c[0] = readPalColor(view, palOff + palBase * 2);
      c[1] = readPalColor(view, palOff + (palBase + 1) * 2);

      if (mode === 0) {
        c[2] = readPalColor(view, palOff + (palBase + 2) * 2);
        c[3] = [0, 0, 0, 0]; // transparent
      } else if (mode === 1) {
        // c[2] = (c[0] + c[1]) / 2
        c[2] = [
          (c[0][0] + c[1][0]) >>> 1,
          (c[0][1] + c[1][1]) >>> 1,
          (c[0][2] + c[1][2]) >>> 1,
          255
        ];
        c[3] = [0, 0, 0, 0]; // transparent
      } else if (mode === 2) {
        c[2] = readPalColor(view, palOff + (palBase + 2) * 2);
        c[3] = readPalColor(view, palOff + (palBase + 3) * 2);
      } else { // mode === 3
        // c[2] = (5*c[0] + 3*c[1]) / 8
        // c[3] = (3*c[0] + 5*c[1]) / 8
        c[2] = [
          (5 * c[0][0] + 3 * c[1][0]) >>> 3,
          (5 * c[0][1] + 3 * c[1][1]) >>> 3,
          (5 * c[0][2] + 3 * c[1][2]) >>> 3,
          255
        ];
        c[3] = [
          (3 * c[0][0] + 5 * c[1][0]) >>> 3,
          (3 * c[0][1] + 5 * c[1][1]) >>> 3,
          (3 * c[0][2] + 5 * c[1][2]) >>> 3,
          255
        ];
      }

      // Decode 4x4 texels (2 bits each, packed in u32)
      for (let ty = 0; ty < 4; ty++) {
        for (let tx = 0; tx < 4; tx++) {
          const px = bx * 4 + tx;
          const py = by * 4 + ty;
          if (px >= w || py >= h) continue;

          const bitIdx = (ty * 4 + tx) * 2;
          const idx = (texelData >>> bitIdx) & 3;
          const col = c[idx];
          const j = (py * w + px) * 4;
          out[j] = col[0]; out[j + 1] = col[1]; out[j + 2] = col[2]; out[j + 3] = col[3];
        }
      }
    }
  }
}
