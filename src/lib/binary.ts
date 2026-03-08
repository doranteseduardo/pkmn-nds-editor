/**
 * Low-level binary read/write utilities for parsing NDS ROM data.
 */

export class BinaryReader {
  private view: DataView;
  private _offset: number;
  readonly buffer: ArrayBuffer;

  constructor(buffer: ArrayBuffer, offset = 0) {
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this._offset = offset;
  }

  get offset() { return this._offset; }
  get length() { return this.buffer.byteLength; }

  seek(pos: number) { this._offset = Math.max(0, Math.min(pos, this.buffer.byteLength)); }
  skip(n: number) { this._offset = Math.max(0, Math.min(this._offset + n, this.buffer.byteLength)); }
  tell() { return this._offset; }

  /** Check if at least `n` bytes remain to read. */
  canRead(n: number): boolean {
    return this._offset + n <= this.buffer.byteLength;
  }

  u8(): number {
    if (!this.canRead(1)) return 0;
    const v = this.view.getUint8(this._offset); this._offset += 1; return v;
  }
  u16(): number {
    if (!this.canRead(2)) return 0;
    const v = this.view.getUint16(this._offset, true); this._offset += 2; return v;
  }
  u32(): number {
    if (!this.canRead(4)) return 0;
    const v = this.view.getUint32(this._offset, true); this._offset += 4; return v;
  }
  i8(): number {
    if (!this.canRead(1)) return 0;
    const v = this.view.getInt8(this._offset); this._offset += 1; return v;
  }
  i16(): number {
    if (!this.canRead(2)) return 0;
    const v = this.view.getInt16(this._offset, true); this._offset += 2; return v;
  }
  i32(): number {
    if (!this.canRead(4)) return 0;
    const v = this.view.getInt32(this._offset, true); this._offset += 4; return v;
  }

  str(len: number): string {
    let s = '';
    const remaining = Math.max(0, this.buffer.byteLength - this._offset);
    const safeLen = Math.min(len, remaining);
    for (let i = 0; i < safeLen; i++) {
      const c = this.view.getUint8(this._offset + i);
      if (c === 0) { this._offset = Math.min(this._offset + len, this.buffer.byteLength); return s; }
      s += String.fromCharCode(c);
    }
    this._offset = Math.min(this._offset + len, this.buffer.byteLength);
    return s;
  }

  bytes(len: number): Uint8Array {
    const remaining = Math.max(0, this.buffer.byteLength - this._offset);
    const safeLen = Math.min(len, remaining);
    if (safeLen <= 0) { this._offset = Math.min(this._offset + len, this.buffer.byteLength); return new Uint8Array(0); }
    const b = new Uint8Array(this.buffer, this._offset, safeLen);
    this._offset = Math.min(this._offset + len, this.buffer.byteLength);
    return b.slice(); // Return a copy
  }

  slice(offset: number, length: number): ArrayBuffer {
    const safeEnd = Math.min(offset + length, this.buffer.byteLength);
    return this.buffer.slice(offset, safeEnd);
  }

  remaining(): number {
    return Math.max(0, this.buffer.byteLength - this._offset);
  }
}

export class BinaryWriter {
  private view: DataView;
  private _offset: number;
  readonly buffer: ArrayBuffer;

  constructor(size: number) {
    this.buffer = new ArrayBuffer(size);
    this.view = new DataView(this.buffer);
    this._offset = 0;
  }

  get offset() { return this._offset; }

  seek(pos: number) { this._offset = pos; }
  tell() { return this._offset; }

  writeU8(v: number) { this.view.setUint8(this._offset, v); this._offset += 1; }
  writeU16(v: number) { this.view.setUint16(this._offset, v, true); this._offset += 2; }
  writeU32(v: number) { this.view.setUint32(this._offset, v, true); this._offset += 4; }
  writeI16(v: number) { this.view.setInt16(this._offset, v, true); this._offset += 2; }
  writeI32(v: number) { this.view.setInt32(this._offset, v, true); this._offset += 4; }

  writeBytes(arr: Uint8Array | ArrayBuffer) {
    const u8src = arr instanceof ArrayBuffer ? new Uint8Array(arr) : arr;
    const u8dst = new Uint8Array(this.buffer);
    u8dst.set(u8src, this._offset);
    this._offset += u8src.length;
  }

  writeStr(s: string) {
    const enc = new TextEncoder();
    this.writeBytes(enc.encode(s));
  }

  toArrayBuffer(): ArrayBuffer {
    return this.buffer.slice(0, this._offset);
  }
}

/** Align a value up to the next multiple of `align`. */
export function alignUp(value: number, align: number): number {
  return (value + align - 1) & ~(align - 1);
}
