/**
 * A self-contained QR-code matrix generator, used by the Raccoon tab to draw
 * the WeChat scan-to-login code in-panel (no external dependency; `client.js`
 * bundles this and the browser renders the SVG).
 *
 * Scope is deliberately minimal — the only payload this plugin ever encodes is
 * a fixed-shape login URL (~144 bytes):
 *   - BYTE mode (UTF-8)
 *   - error-correction level M
 *   - versions 1–10 (byte capacity at M up to 213 bytes)
 *
 * Longer payloads THROW rather than emit an unscannable code. The algorithm
 * follows ISO/IEC 18004 (Reed–Solomon over GF(256), the 8 mask patterns, the
 * format/version information BCH codes); it is a clean re-implementation, not
 * a port of any upstream library.
 *
 * The client bundle targets es2020, which does not allow a `readonly` type
 * modifier on object/array LITERAL types — so every table below is a plain
 * value. The discipline that matters is the ALGORITHM, not a frozen shape.
 *
 * @module dsh-connect-sensenova-token-plan/client/qr
 */

/** The matrix the QR holds: `size` is the module count, `modules` a square of dark flags. */
export interface QrMatrix {
  size: number;
  modules: boolean[][];
}

/** The byte-mode data-codeword capacities at EC level M for versions 1–10. */
const DATA_CODEWORDS = [0, 16, 28, 44, 64, 86, 108, 124, 154, 182, 216];

/** The EC block structure at level M (ISO/IEC 18004 Table 9, versions 1–10). */
const EC_BLOCKS_M: { ecPerBlock: number; groups: [number, number][] }[] = [
  { ecPerBlock: 10, groups: [[1, 16]] },
  { ecPerBlock: 16, groups: [[1, 28]] },
  { ecPerBlock: 26, groups: [[1, 44]] },
  { ecPerBlock: 18, groups: [[2, 32]] },
  { ecPerBlock: 24, groups: [[2, 43]] },
  { ecPerBlock: 16, groups: [[4, 27]] },
  { ecPerBlock: 18, groups: [[4, 31]] },
  { ecPerBlock: 22, groups: [[2, 38], [2, 39]] },
  { ecPerBlock: 22, groups: [[3, 36], [2, 37]] },
  { ecPerBlock: 26, groups: [[4, 43], [1, 44]] }
];

// ── GF(256) arithmetic, primitive polynomial 0x11D ─────────────────────────

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if ((x & 0x100) !== 0) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function polyMul(a: number[], b: number[]): number[] {
  const result = new Array<number>(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      result[i + j]! ^= gfMul(a[i]!, b[j]!);
    }
  }
  return result;
}

function rsGeneratorPoly(degree: number): number[] {
  let poly: number[] = [1];
  for (let i = 0; i < degree; i++) poly = polyMul(poly, [1, GF_EXP[i]!]);
  return poly;
}

/** The Reed–Solomon remainder for one data stream. */
function rsEncode(data: number[], ecCount: number): number[] {
  const generator = rsGeneratorPoly(ecCount);
  const buffer = data.concat(new Array<number>(ecCount).fill(0));
  for (let i = 0; i < data.length; i++) {
    const coefficient = buffer[i]!;
    if (coefficient === 0) continue;
    for (let j = 0; j < generator.length; j++) buffer[i + j]! ^= gfMul(generator[j]!, coefficient);
  }
  return buffer.slice(data.length);
}

// ── data coding ──────────────────────────────────────────────────────────────

/**
 * The alignment-pattern centre coordinates per version.
 * v1 has none; v2–6 use `[6, size-7]`; v7–v10 follow the ISO table.
 */
function alignmentCentres(version: number): number[] {
  if (version <= 1) return [];
  // ISO/IEC 18004 Table E (alignment-pattern centre coordinates), v2–v10.
  // Use the values AS THEY ARE: v2–v6 have one non-6 centre (which happens to
  // equal size-7), v7–v10 have three distinct centres — a `c === 6 ? 6 :
  // size-7` mapping silently collapsed the middle centre and produced
  // unscannable codes.
  const table = [null, null, [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  return table[version] ?? [];
}

/** Pick the smallest version (1–10) that holds `byteLength` bytes, or -1. */
function pickVersion(byteLength: number): number {
  for (let version = 1; version <= 10; version++) {
    const capacityBits = DATA_CODEWORDS[version]! * 8;
    // mode indicator (4 bits) + the byte-count field (8 for v1–9, 16 for v10).
    const overheadBits = 4 + (version <= 9 ? 8 : 16);
    if (overheadBits + byteLength * 8 <= capacityBits) return version;
  }
  return -1;
}

/** Encode the payload bytes as the bit stream the codeword interleave consumes. */
function buildCodewords(bytes: number[], version: number): number[] {
  const capacityBits = DATA_CODEWORDS[version]! * 8;
  const bits: number[] = [];
  const pushBits = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  pushBits(0b0100, 4); // byte mode
  pushBits(bytes.length, version <= 9 ? 8 : 16); // length field
  for (const byte of bytes) pushBits(byte, 8);
  // Terminator: up to 4 zero bits (fewer when the capacity is exactly full).
  pushBits(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  // Alternating pad bytes fill the remainder of the capacity.
  for (let i = 0; bits.length < capacityBits; i++) pushBits(i % 2 === 0 ? 0xec : 0x11, 8);

  const dataCodewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!;
    dataCodewords.push(byte);
  }

  // Split into blocks, compute the EC per block, then interleave: all data
  // codewords in block order first, then all EC codewords in block order.
  // `version` is 1–10 (pickVersion's contract, checked by buildQrMatrix before
  // this runs), so the row and its group entries are in-bounds by construction.
  const blocks = EC_BLOCKS_M[version - 1]!;
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (const [count, dataPerBlock] of blocks.groups) {
    for (let b = 0; b < count; b++) {
      const block = dataCodewords.slice(offset, offset + dataPerBlock);
      offset += dataPerBlock;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, blocks.ecPerBlock));
    }
  }
  const result: number[] = [];
  const maxDataLen = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]!);
  }
  for (let i = 0; i < blocks.ecPerBlock; i++) {
    for (const block of ecBlocks) if (i < block.length) result.push(block[i]!);
  }
  return result;
}

// ── matrix construction ─────────────────────────────────────────────────────

/**
 * The QR module grid before masking: the finder / alignment / timing / dark
 * module / format-placeholder cells are placed, and the codewords fill the
 * remaining cells in the ISO zig-zag. `isFunction` records which cells a mask
 * (or the final format write) must never touch.
 */
function buildMatrix(size: number, codewords: number[], version: number): { modules: boolean[][]; isFunction: boolean[][] } {
  const modules: boolean[][] = [];
  const isFunction: boolean[][] = [];
  for (let row = 0; row < size; row++) {
    modules.push(new Array<boolean>(size).fill(false));
    isFunction.push(new Array<boolean>(size).fill(false));
  }

  const set = (row: number, col: number, dark: boolean): void => {
    modules[row]![col]! = dark;
    isFunction[row]![col]! = true;
  };

  // Timing patterns FIRST (drawing order is load-bearing): row 6 / column 6
  // run the full grid, but the finder patterns below must WIN where they
  // overlap — a finder's row-6/col-6 slice is part of its 7×7 ring, not an
  // alternating stripe. Drawing timing after the finders (as a first draft
  // did) scrubbed those slices into stripes and produced codes no decoder
  // could read.
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // Finder + separator, centred on (3,3), (size-4,3) and (3,size-4). The
  // ring at distance 4 is the light separator; distance 2 is the light inner
  // ring; everything else in the 9×9 box is dark.
  const finder = (cx: number, cy: number): void => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const xx = cx + dx;
        const yy = cy + dy;
        if (xx < 0 || xx >= size || yy < 0 || yy >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        set(yy, xx, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);

  // Alignment patterns, skipping the three corners that sit on finders.
  const centres = alignmentCentres(version);
  for (const row of centres) {
    for (const col of centres) {
      if ((row === 6 && col === 6) || (row === 6 && col === size - 7) || (row === size - 7 && col === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(row + dy, col + dx, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // The always-dark module at (row size-8, col 8) — beside the bottom-left
  // finder's format strip, NOT its transpose.
  set(size - 8, 8, true);

  // Reserve the format strips BEFORE data placement (drawing order is
  // load-bearing): the zig-zag below must skip the 31 format cells, or the
  // data stream is displaced and no decoder can follow it. The placeholder
  // values here are overwritten by `writeFormat` once the mask is chosen.
  const reserveFormat = (row: number, col: number) => {
    if (row >= 0 && row < size && col >= 0 && col < size) {
      modules[row]![col]! = false;
      isFunction[row]![col]! = true;
    }
  };
  for (let i = 0; i <= 8; i++) { reserveFormat(i, 8); reserveFormat(8, i); }
  for (let i = 0; i < 8; i++) { reserveFormat(size - 1 - i, 8); reserveFormat(8, size - 1 - i); }
  // v7+: the two 3×6 version-information blocks occupy data cells too —
  // reserve them BEFORE placement, or the codeword stream is displaced.
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      reserveFormat(b, a);
      reserveFormat(a, b);
    }
  }

  // Data placement in the ISO zig-zag, two-column strips from the right edge,
  // alternating upward / downward, with the timing column (col 6) skipped.
  // Every (row, col) below is inside the size×size grid the loops build, and
  // a bit is consumed only while `bitIndex < codewords.length * 8`, so the
  // indexed reads are in-bounds by construction.
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the timing column
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        const row = upward ? size - 1 - vert : vert;
        if (isFunction[row]![col]!) continue;
        if (bitIndex < codewords.length * 8) {
          const byte = codewords[bitIndex >> 3]!;
          modules[row]![col]! = ((byte >> (7 - (bitIndex & 7))) & 1) === 1;
          bitIndex++;
        }
      }
    }
  }

  return { modules, isFunction };
}

// ── masking ─────────────────────────────────────────────────────────────────

/** The ISO mask functions; mask 7 is the default case. */
function maskInvert(row: number, col: number, mask: number): boolean {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    // Mask 5 is "the sum is ZERO" — no outer % 2. Collapsing it onto mask 6's
    // formula (as a first draft did) made a matrix whose format bits claim 5
    // while the data carries mask 6: unreadable to every decoder.
    case 5: return (row * col) % 2 + (row * col) % 3 === 0;
    case 6: return ((row * col) % 2 + (row * col) % 3) % 2 === 0;
    default: return ((row + col) % 2 + (row * col) % 3) % 2 === 0;
  }
}

/**
 * Toggle every data cell the given mask selects.
 *
 * The single home of "apply a mask" — masking the candidate, rolling it back,
 * and finalising the winner used to be the same twin loops copy-pasted three
 * times (jscpd's only clone in the tree). XOR is its own inverse, so applying
 * a mask twice returns to the pre-mask state; the caller relies on that for
 * the rollback step.
 *
 * The loops walk exactly the size×size grid `buildMatrix` produced, so every
 * cell below exists; the assertions state that invariant.
 */
function applyMask(modules: boolean[][], isFunction: boolean[][], mask: number): void {
  const size = modules.length;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (isFunction[row]![col]!) continue;
      if (maskInvert(row, col, mask)) modules[row]![col]! = !modules[row]![col]!;
    }
  }
}

/** The 15-bit format information for one mask at EC level M. */
function formatBits(mask: number): number {
  const data = (0b00 << 3) | (mask & 0b111);
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/**
 * Write the format bits, in both copies, marking them function cells so the
 * mask never disturbs them. The bit indices are the ISO ordering:
 *
 *   copy 1: bit i → (col 8, row i) for i ≤ 5; bit 6 → (8,7); bit 7 → (8,8);
 *           bit 8 → (7,8); bit i → (row 14-i, col 8) for i = 9..14.
 *   copy 2: bit i → (row size-1-i, col 8) for i ≤ 7; bit i → (row 8,
 *           col size-7+i-8) for i = 8..14.
 */
function writeFormat(modules: boolean[][], isFunction: boolean[][], mask: number): void {
  const size = modules.length;
  const bits = formatBits(mask);
  const bit = (i: number): boolean => ((bits >>> i) & 1) === 1;
  // ISO layout (nayuki's setFunctionModule(x = col, y = row)):
  //   first copy: bits 0–5 → (row i, col 8); bit 6 → (7, 8); bit 7 → (8, 8);
  //   bit 8 → (8, 7); bits 9–14 → (row 8, col 14-i).
  //   second copy: bits 0–7 → (row 8, col size-1-i, along the top-right
  //   finder's edge); bits 8–14 → (row size-15+(i-8), col 8, down the
  //   bottom-left finder's edge). Dark module: (row size-8, col 8).
  const set = (row: number, col: number, dark: boolean): void => {
    modules[row]![col]! = dark;
    isFunction[row]![col]! = true;
  };
  for (let i = 0; i <= 5; i++) set(i, 8, bit(i));
  set(7, 8, bit(6));
  set(8, 8, bit(7));
  set(8, 7, bit(8));
  for (let i = 9; i < 15; i++) set(8, 14 - i, bit(i));
  for (let i = 0; i < 8; i++) set(8, size - 1 - i, bit(i));
  for (let i = 8; i < 15; i++) set(size - 15 + i, 8, bit(i));
  set(size - 8, 8, true); // the dark module
}

/** The 18-bit version block (v7+), placed above the bottom-left finder. */
function writeVersion(modules: boolean[][], isFunction: boolean[][], version: number): void {
  const size = modules.length;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  const set = (row: number, col: number, dark: boolean): void => {
    modules[row]![col]! = dark;
    isFunction[row]![col]! = true;
  };
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >> i) & 1) === 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    set(b, a, dark);
    set(a, b, dark);
  }
}

/**
 * The four ISO penalty rules (lower = better mask): N1 same-colour runs, N2
 * 2×2 blocks, N3 finder-like patterns, N4 the dark-fraction balance.
 */
function penaltyScore(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;
  const linePenalty = (line: boolean[]): number => {
    let result = 0;
    // N1: same-colour runs of 5+ — 3 + 1 per extra module.
    let runLength = 1;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) {
        runLength++;
      } else {
        if (runLength >= 5) result += 3 + (runLength - 5);
        runLength = 1;
      }
    }
    if (runLength >= 5) result += 3 + (runLength - 5);
    // N3: the 1:1:3:1:1 light-dark pattern, four light on each side, in
    // both directions (an 11-bit window).
    const PATTERN_A = [true, false, true, true, true, false, true, false, false, false, false];
    const PATTERN_B = [false, false, false, false, true, false, true, true, true, false, true];
    for (let i = 0; i + 11 <= line.length; i++) {
      let matchA = true;
      let matchB = true;
      for (let j = 0; j < 11; j++) {
        if (line[i + j] !== PATTERN_A[j]) matchA = false;
        if (line[i + j] !== PATTERN_B[j]) matchB = false;
        if (!matchA && !matchB) break;
      }
      if (matchA) result += 40;
      if (matchB) result += 40;
    }
    return result;
  };
  // `row`/`col` iterate the size×size grid built by buildMatrix, so every read
  // below is in-bounds by construction.
  for (let row = 0; row < size; row++) score += linePenalty(modules[row]!);
  for (let col = 0; col < size; col++) {
    const column: boolean[] = [];
    for (let row = 0; row < size; row++) column.push(modules[row]![col]!);
    score += linePenalty(column);
  }
  // N2: 2×2 blocks of the same colour — 3 points each.
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const value = modules[row]![col]!;
      if (value === modules[row]![col + 1]! && value === modules[row + 1]![col]! && value === modules[row + 1]![col + 1]!) score += 3;
    }
  }
  // N4: the dark fraction deviating from 50%, in 10%-steps of 10 points.
  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark++;
  const total = size * size;
  const k = Math.floor((Math.abs(dark * 20 - total * 10) / total) + 1) - 1;
  score += Math.max(0, k) * 10;
  return score;
}

/**
 * Build the matrix for one payload: encode, place, mask (the lowest-penalty
 * of the eight), write the format bits, and the version block for v7+.
 * @throws {Error} when the payload does not fit versions 1–10 at level M.
 */
export function buildQrMatrix(text: string): QrMatrix {
  const bytes = Array.from(new TextEncoder().encode(text));
  const version = pickVersion(bytes.length);
  if (version < 1) throw new Error(`qr: payload of ${bytes.length} bytes exceeds the v1–10/M capacity`);

  const size = 17 + version * 4;
  const { modules, isFunction } = buildMatrix(size, buildCodewords(bytes, version), version);

  // Try each mask: apply, write the format block for that mask, score, and
  // roll the mask back (XOR is its own inverse) before the next attempt.
  let bestMask = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(modules, isFunction, mask);
    writeFormat(modules, isFunction, mask);
    if (version >= 7) writeVersion(modules, isFunction, version);
    const score = penaltyScore(modules);
    if (score < bestPenalty) {
      bestPenalty = score;
      bestMask = mask;
    }
    applyMask(modules, isFunction, mask);
  }

  // Apply the winning mask for good and write its format block.
  applyMask(modules, isFunction, bestMask);
  writeFormat(modules, isFunction, bestMask);
  if (version >= 7) writeVersion(modules, isFunction, version);

  return { size, modules };
}

/**
 * Render a matrix as a compact SVG data-URL the panel can drop straight into
 * an `<img>` (no further client-side encoding logic is needed).
 * @param {string} text - the payload.
 * @param {object} [options]
 * @param {number} [options.size] - rendered pixel size (default 200).
 * @returns {string} `data:image/svg+xml;utf8,` + the URL-encoded SVG.
 */
export function qrDataUrl(text: string, options: { size?: number } = {}): string {
  const { size, modules } = buildQrMatrix(text);
  const margin = 4;
  const dim = size + margin * 2;
  const segments: string[] = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (modules[row]![col]!) segments.push(`M${col + margin} ${row + margin}h1v1h-1z`);
    }
  }
  const px = options.size ?? 200;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="#fff"/><path d="${segments.join("")}" fill="#000"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
