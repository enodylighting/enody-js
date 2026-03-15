/**
 * STX/ETX/DLE frame encoding and decoding.
 *
 * Frame format: [STX] [escaped_payload] [ETX]
 *
 * Any payload byte matching STX, ETX, or DLE is escaped by prefixing with DLE.
 * The receiver unescapes by consuming DLE and taking the next byte literally.
 */

const STX = 0x02;
const ETX = 0x03;
const DLE = 0x10;

/** Escape payload bytes (prefix control chars with DLE). */
function escapeBytes(payload) {
  const result = [];
  for (const byte of payload) {
    if (byte === STX || byte === ETX || byte === DLE) {
      result.push(DLE);
    }
    result.push(byte);
  }
  return result;
}

/** Unescape DLE-escaped bytes. */
function unescapeBytes(escaped) {
  const result = [];
  let isEscaped = false;
  for (const byte of escaped) {
    if (isEscaped) {
      result.push(byte);
      isEscaped = false;
    } else if (byte === DLE) {
      isEscaped = true;
    } else {
      result.push(byte);
    }
  }
  return new Uint8Array(result);
}

/** Wrap payload in STX/ETX frame with DLE escaping. */
export function frameBytes(payload) {
  const escaped = escapeBytes(payload);
  const frame = new Uint8Array(1 + escaped.length + 1);
  frame[0] = STX;
  frame.set(escaped, 1);
  frame[frame.length - 1] = ETX;
  return frame;
}

/** Extract payload from STX/ETX frame, removing DLE escaping. */
export function unframeBytes(frame) {
  if (frame.length < 2) throw new Error('Frame too short');
  if (frame[0] !== STX || frame[frame.length - 1] !== ETX) {
    throw new Error('Invalid frame delimiters');
  }
  return unescapeBytes(frame.slice(1, frame.length - 1));
}

/**
 * Accumulator for extracting complete frames from a byte stream.
 * Handles partial reads from serial port.
 */
export class FrameAccumulator {
  constructor() {
    this.buffer = [];
    this.inFrame = false;
    this.escaped = false;
  }

  /**
   * Feed new bytes and return any complete frames found.
   * @param {Uint8Array} data
   * @returns {Uint8Array[]} Complete frames (with STX/ETX included)
   */
  feed(data) {
    const frames = [];
    for (const byte of data) {
      if (!this.inFrame) {
        if (byte === STX) {
          this.buffer = [STX];
          this.inFrame = true;
          this.escaped = false;
        }
        // Discard bytes outside frames
      } else {
        this.buffer.push(byte);
        if (this.escaped) {
          this.escaped = false;
        } else if (byte === DLE) {
          this.escaped = true;
        } else if (byte === ETX) {
          // Complete frame
          frames.push(new Uint8Array(this.buffer));
          this.buffer = [];
          this.inFrame = false;
        }
      }
    }
    return frames;
  }
}
