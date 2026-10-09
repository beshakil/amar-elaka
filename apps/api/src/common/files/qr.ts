/**
 * A QR code encoder (ISO/IEC 18004), just what the shop-counter card needs
 * (ADR 057): byte mode, error correction level M, versions 1–10 (up to 213
 * bytes, far more than a catalog URL). Our own so the API adds no dependency;
 * tested by decoding its output with an independent decoder.
 *
 * Returns the module matrix: `true` = dark, row by row, without the quiet zone.
 */

export class QrCapacityError extends Error {}

interface VersionInfo {
  /** Error-correction codewords per block. */
  ecPerBlock: number;
  /** [blocks, data codewords per block] for each block group. */
  groups: [number, number][];
  /** Alignment pattern centre coordinates. */
  alignment: number[];
}

/** Level M, versions 1–10 (ISO/IEC 18004 tables 9 and E.1). */
const VERSIONS: Record<number, VersionInfo> = {
  1: { ecPerBlock: 10, groups: [[1, 16]], alignment: [] },
  2: { ecPerBlock: 16, groups: [[1, 28]], alignment: [6, 18] },
  3: { ecPerBlock: 26, groups: [[1, 44]], alignment: [6, 22] },
  4: { ecPerBlock: 18, groups: [[2, 32]], alignment: [6, 26] },
  5: { ecPerBlock: 24, groups: [[2, 43]], alignment: [6, 30] },
  6: { ecPerBlock: 16, groups: [[4, 27]], alignment: [6, 34] },
  7: { ecPerBlock: 18, groups: [[4, 31]], alignment: [6, 22, 38] },
  8: {
    ecPerBlock: 22,
    groups: [
      [2, 38],
      [2, 39],
    ],
    alignment: [6, 24, 42],
  },
  9: {
    ecPerBlock: 22,
    groups: [
      [3, 36],
      [2, 37],
    ],
    alignment: [6, 26, 46],
  },
  10: {
    ecPerBlock: 26,
    groups: [
      [4, 43],
      [1, 44],
    ],
    alignment: [6, 28, 50],
  },
};
const MAX_VERSION = 10;
/** Level M's two format bits. */
const EC_LEVEL_M = 0b00;
const MODE_BYTE = 0b0100;
const FORMAT_GENERATOR = 0x537;
const FORMAT_MASK = 0x5412;
const VERSION_GENERATOR = 0x1f25;
const PAD_BYTES = [0xec, 0x11];
const GF_POLY = 0x11d;

const dataCodewords = (v: VersionInfo) =>
  v.groups.reduce((n, [blocks, size]) => n + blocks * size, 0);
const countBits = (version: number) => (version <= 9 ? 8 : 16);

// ---- Reed–Solomon over GF(256) ------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= GF_POLY;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

/** The generator polynomial of degree n, highest coefficient first (leading 1 dropped). */
function generator(n: number): number[] {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] = next[j]! ^ poly[j]!;
      next[j + 1] = next[j + 1]! ^ mul(poly[j]!, EXP[i]!);
    }
    poly = next;
  }
  return poly.slice(1);
}

function errorCorrection(data: number[], n: number): number[] {
  const gen = generator(n);
  const rem = new Array<number>(n).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift()!;
    rem.push(0);
    for (let i = 0; i < n; i++) rem[i] = rem[i]! ^ mul(gen[i]!, factor);
  }
  return rem;
}

// ---- codewords ---------------------------------------------------------------------

function codewords(bytes: Buffer, version: number): number[] {
  const info = VERSIONS[version]!;
  const capacity = dataCodewords(info);
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(MODE_BYTE, 4);
  push(bytes.length, countBits(version));
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity * 8 - bits.length)); // terminator
  while (bits.length % 8 !== 0) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let i = 0; data.length < capacity; i++) data.push(PAD_BYTES[i % 2]!);

  // Split into blocks, add each block's error correction, interleave.
  const blocks: { data: number[]; ec: number[] }[] = [];
  let offset = 0;
  for (const [count, size] of info.groups) {
    for (let i = 0; i < count; i++) {
      const chunk = data.slice(offset, offset + size);
      offset += size;
      blocks.push({ data: chunk, ec: errorCorrection(chunk, info.ecPerBlock) });
    }
  }
  const out: number[] = [];
  const longest = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < longest; i++)
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]!);
  for (let i = 0; i < info.ecPerBlock; i++) for (const b of blocks) out.push(b.ec[i]!);
  return out;
}

// ---- the matrix ----------------------------------------------------------------------

class Matrix {
  readonly size: number;
  readonly dark: boolean[][];
  readonly reserved: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.dark = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
  }

  set(x: number, y: number, dark: boolean): void {
    this.dark[y]![x] = dark;
    this.reserved[y]![x] = true;
  }

  clone(): Matrix {
    const copy = new Matrix(this.version);
    for (let y = 0; y < this.size; y++) {
      copy.dark[y] = [...this.dark[y]!];
      copy.reserved[y] = [...this.reserved[y]!];
    }
    return copy;
  }
}

function drawFunctionPatterns(m: Matrix): void {
  const { size } = m;
  // Timing patterns.
  for (let i = 0; i < size; i++) {
    m.set(6, i, i % 2 === 0);
    m.set(i, 6, i % 2 === 0);
  }
  // Finders with their separators.
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        m.set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  // Alignment patterns, except where they would overlap a finder.
  const positions = VERSIONS[m.version]!.alignment;
  const last = positions.length - 1;
  positions.forEach((cy, i) =>
    positions.forEach((cx, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++)
          m.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }),
  );
  drawFormat(m, 0); // reserves the format areas; redrawn with the chosen mask
  if (m.version >= 7) drawVersion(m);
}

function drawFormat(m: Matrix, mask: number): void {
  const data = (EC_LEVEL_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * FORMAT_GENERATOR);
  const bits = ((data << 10) | rem) ^ FORMAT_MASK;
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  const { size } = m;
  for (let i = 0; i <= 5; i++) m.set(8, i, bit(i));
  m.set(8, 7, bit(6));
  m.set(8, 8, bit(7));
  m.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) m.set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) m.set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) m.set(8, size - 15 + i, bit(i));
  m.set(8, size - 8, true); // the dark module
}

function drawVersion(m: Matrix): void {
  let rem = m.version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * VERSION_GENERATOR);
  const bits = (m.version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = m.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    m.set(a, b, dark);
    m.set(b, a, dark);
  }
}

function drawData(m: Matrix, data: number[]): void {
  const { size } = m;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing column
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (m.reserved[y]![x]) continue;
        // Past the last codeword the remainder bits stay light.
        m.dark[y]![x] = i < data.length * 8 && ((data[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(m: Matrix, mask: number): void {
  const flip = MASKS[mask]!;
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++)
      if (!m.reserved[y]![x] && flip(x, y)) m.dark[y]![x] = !m.dark[y]![x];
  }
}

/** ISO/IEC 18004 §7.8.3 penalty: runs, 2×2 blocks, finder look-alikes, dark balance. */
function penalty(m: Matrix): number {
  const { size, dark } = m;
  let score = 0;
  const line = (get: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && get(i) === get(i - 1)) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    const pattern = [true, false, true, true, true, false, true];
    for (let i = 0; i + 7 <= size; i++) {
      if (!pattern.every((p, k) => get(i + k) === p)) continue;
      const lightBefore = i >= 4 && [1, 2, 3, 4].every((k) => !get(i - k));
      const lightAfter = i + 11 <= size && [7, 8, 9, 10].every((k) => !get(i + k));
      if (lightBefore || lightAfter) score += 40;
    }
  };
  for (let y = 0; y < size; y++) line((x) => dark[y]![x]!);
  for (let x = 0; x < size; x++) line((y) => dark[y]![x]!);
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const c = dark[y]![x];
      if (c === dark[y]![x + 1] && c === dark[y + 1]![x] && c === dark[y + 1]![x + 1]) score += 3;
    }
  }
  const darkCount = dark.reduce((n, row) => n + row.filter(Boolean).length, 0);
  score += Math.floor(Math.abs((darkCount * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/** The smallest level-M QR code that holds `text` (UTF-8). */
export function encodeQr(text: string): boolean[][] {
  const bytes = Buffer.from(text, 'utf8');
  let version = 1;
  while (
    version <= MAX_VERSION &&
    4 + countBits(version) + bytes.length * 8 > dataCodewords(VERSIONS[version]!) * 8
  ) {
    version++;
  }
  if (version > MAX_VERSION)
    throw new QrCapacityError(`${bytes.length} bytes don't fit a version ${MAX_VERSION} QR code`);

  const base = new Matrix(version);
  drawFunctionPatterns(base);
  drawData(base, codewords(bytes, version));
  let best: { matrix: Matrix; score: number } | undefined;
  for (let mask = 0; mask < MASKS.length; mask++) {
    const candidate = base.clone();
    applyMask(candidate, mask);
    drawFormat(candidate, mask);
    const score = penalty(candidate);
    if (!best || score < best.score) best = { matrix: candidate, score };
  }
  return best!.matrix.dark;
}
