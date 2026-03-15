/**
 * Postcard binary format codec.
 *
 * Postcard is a no_std serde-based binary serialization format used by enody-rs.
 * This module implements the subset needed for the Enody protocol:
 *
 * - bool: 0x00 / 0x01
 * - u8: raw byte
 * - u16, u32: unsigned varint (LEB128)
 * - f32: 4 bytes little-endian
 * - Option<T>: 0x00 (None) or 0x01 + T (Some)
 * - enum variant: varint(index) + payload
 * - struct: sequential fields
 * - bytes/string: varint(len) + data
 * - Vec<T>: varint(len) + elements
 */

export class PostcardEncoder {
  constructor() {
    this.buf = [];
  }

  result() {
    return new Uint8Array(this.buf);
  }

  bool(v) {
    this.buf.push(v ? 1 : 0);
    return this;
  }

  u8(v) {
    this.buf.push(v & 0xff);
    return this;
  }

  u16(v) {
    return this.varint(v);
  }

  u32(v) {
    return this.varint(v);
  }

  varint(value) {
    value = value >>> 0; // ensure unsigned 32-bit
    while (value > 0x7f) {
      this.buf.push((value & 0x7f) | 0x80);
      value >>>= 7;
    }
    this.buf.push(value & 0x7f);
    return this;
  }

  f32(v) {
    const ab = new ArrayBuffer(4);
    new DataView(ab).setFloat32(0, v, true); // little-endian
    const bytes = new Uint8Array(ab);
    for (let i = 0; i < 4; i++) this.buf.push(bytes[i]);
    return this;
  }

  bytes(data) {
    this.varint(data.length);
    for (let i = 0; i < data.length; i++) {
      this.buf.push(data[i]);
    }
    return this;
  }

  string(s) {
    const encoded = new TextEncoder().encode(s);
    return this.bytes(encoded);
  }

  /** UUID serialized as postcard bytes (varint length prefix + 16 raw bytes). */
  uuid(uuidBytes) {
    return this.bytes(uuidBytes);
  }

  option(value, encodeFn) {
    if (value === null || value === undefined) {
      this.buf.push(0);
    } else {
      this.buf.push(1);
      encodeFn(this, value);
    }
    return this;
  }

  enumVariant(index) {
    return this.varint(index);
  }
}

export class PostcardDecoder {
  constructor(data) {
    this.data = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.pos = 0;
  }

  remaining() {
    return this.data.length - this.pos;
  }

  bool() {
    return this.data[this.pos++] !== 0;
  }

  u8() {
    return this.data[this.pos++];
  }

  u16() {
    return this.varint();
  }

  u32() {
    return this.varint();
  }

  varint() {
    let value = 0;
    let shift = 0;
    while (true) {
      const byte = this.data[this.pos++];
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return value >>> 0; // unsigned
  }

  f32() {
    const ab = new ArrayBuffer(4);
    const view = new Uint8Array(ab);
    for (let i = 0; i < 4; i++) view[i] = this.data[this.pos++];
    return new DataView(ab).getFloat32(0, true);
  }

  bytes() {
    const len = this.varint();
    const result = this.data.slice(this.pos, this.pos + len);
    this.pos += len;
    return result;
  }

  string() {
    const raw = this.bytes();
    return new TextDecoder().decode(raw);
  }

  /** UUID: postcard bytes format (varint length prefix + 16 raw bytes). */
  uuid() {
    const raw = this.bytes();
    if (raw.length !== 16) throw new Error(`Expected 16-byte UUID, got ${raw.length}`);
    return raw;
  }

  option(decodeFn) {
    const tag = this.data[this.pos++];
    if (tag === 0) return null;
    return decodeFn(this);
  }

  enumVariant() {
    return this.varint();
  }
}

/** Convert 16-byte UUID array to standard string representation. */
export function uuidToString(bytes) {
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Convert UUID string to 16-byte Uint8Array. */
export function uuidFromString(str) {
  const hex = str.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Generate a random v4 UUID as 16-byte array. */
export function uuidV4() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  return bytes;
}
