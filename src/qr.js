/**
 * A QR Code Model 2 encoder, byte mode only, versions 1-10.
 *
 * Written from the ISO/IEC 18004 description rather than transcribed from
 * another library: Galois-field arithmetic, Reed-Solomon over GF(256), block
 * interleaving, function patterns, the zig-zag placement, all eight masks and
 * the four penalty rules. The tables below are the parts a standard defines, and
 * each one is checked by a test that does not depend on the encoder itself
 * (BCH format strings, Reed-Solomon syndromes, placement round-trips).
 *
 * Byte mode means the payload is UTF-8 bytes, not the more compact numeric or
 * alphanumeric modes. That is a deliberate trade: ticket codes and URLs are
 * short, and byte mode accepts anything.
 */

/* ---------------------------------------------------------------- tables */

const VERSIONS = [
  null,
  { total: 26, align: [], remainder: 0, blocks: { L: [7, 1, 19, 0, 0], M: [10, 1, 16, 0, 0], Q: [13, 1, 13, 0, 0], H: [17, 1, 9, 0, 0] } },
  { total: 44, align: [6, 18], remainder: 7, blocks: { L: [10, 1, 34, 0, 0], M: [16, 1, 28, 0, 0], Q: [22, 1, 22, 0, 0], H: [28, 1, 16, 0, 0] } },
  { total: 70, align: [6, 22], remainder: 7, blocks: { L: [15, 1, 55, 0, 0], M: [26, 1, 44, 0, 0], Q: [18, 2, 17, 0, 0], H: [22, 2, 13, 0, 0] } },
  { total: 100, align: [6, 26], remainder: 7, blocks: { L: [20, 1, 80, 0, 0], M: [18, 2, 32, 0, 0], Q: [26, 2, 24, 0, 0], H: [16, 4, 9, 0, 0] } },
  { total: 134, align: [6, 30], remainder: 7, blocks: { L: [26, 1, 108, 0, 0], M: [24, 2, 43, 0, 0], Q: [18, 2, 15, 2, 16], H: [22, 2, 11, 2, 12] } },
  { total: 172, align: [6, 34], remainder: 7, blocks: { L: [18, 2, 68, 0, 0], M: [16, 4, 27, 0, 0], Q: [24, 4, 19, 0, 0], H: [28, 4, 15, 0, 0] } },
  { total: 196, align: [6, 22, 38], remainder: 0, blocks: { L: [20, 2, 78, 0, 0], M: [18, 4, 31, 0, 0], Q: [18, 2, 14, 4, 15], H: [26, 4, 13, 1, 14] } },
  { total: 242, align: [6, 24, 42], remainder: 0, blocks: { L: [24, 2, 97, 0, 0], M: [22, 2, 38, 2, 39], Q: [22, 4, 18, 2, 19], H: [26, 4, 14, 2, 15] } },
  { total: 292, align: [6, 26, 46], remainder: 0, blocks: { L: [30, 2, 116, 0, 0], M: [22, 3, 36, 2, 37], Q: [20, 4, 16, 4, 17], H: [24, 4, 12, 4, 13] } },
  { total: 346, align: [6, 28, 50], remainder: 0, blocks: { L: [18, 2, 68, 2, 69], M: [26, 4, 43, 1, 44], Q: [24, 6, 19, 2, 20], H: [28, 6, 15, 2, 16] } },
];

/** Format-info bits per level. These are the two-bit codes the standard assigns. */
export const EC_LEVELS = {
  L: { order: 0, formatBits: 1 },
  M: { order: 1, formatBits: 0 },
  Q: { order: 2, formatBits: 3 },
  H: { order: 3, formatBits: 2 },
};

export const MIN_VERSION = 1;
export const MAX_VERSION = 10;

/* ------------------------------------------------------------ GF(256) ---- */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // primitive polynomial x^8 + x^4 + x^3 + x^2 + 1
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

export function gfMultiply(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

export function gfPower(alpha, exponent) {
  return EXP[(LOG[alpha] * exponent) % 255];
}

/** Generator polynomial for `degree` error-correction codewords, highest first. */
export function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMultiply(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Reed-Solomon codewords for one block. */
export function rsEncode(data, ecLength) {
  const generator = rsGenerator(ecLength);
  const work = new Uint8Array(data.length + ecLength);
  work.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = work[i];
    if (factor === 0) continue;
    for (let j = 0; j < generator.length; j++) {
      work[i + j] ^= gfMultiply(generator[j], factor);
    }
  }
  return Array.from(work.slice(data.length));
}

/* ------------------------------------------------------------- capacity -- */

export function dataCodewords(version, ecLevel) {
  const spec = VERSIONS[version];
  if (!spec) throw new Error(`unsupported QR version ${version}`);
  const [ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data] = spec.blocks[ecLevel];
  return g1Blocks * g1Data + g2Blocks * g2Data;
}

function countBits(version) {
  return version < 10 ? 8 : 16;
}

/** How many UTF-8 bytes fit in a symbol. */
export function byteCapacity(version, ecLevel) {
  const bits = dataCodewords(version, ecLevel) * 8 - 4 - countBits(version);
  return Math.floor(bits / 8);
}

export function chooseVersion(byteLength, ecLevel) {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
    if (byteCapacity(version, ecLevel) >= byteLength) return version;
  }
  throw new Error(`payload of ${byteLength} bytes does not fit in version ${MAX_VERSION}-${ecLevel}`);
}

/* ---------------------------------------------------------------- helpers */

function bitLength(value) {
  let length = 0;
  while (value) { length++; value >>>= 1; }
  return length;
}

function bchRemainder(value, generator, shift) {
  let remainder = value << shift;
  const generatorLength = bitLength(generator);
  while (bitLength(remainder) >= generatorLength) {
    remainder ^= generator << (bitLength(remainder) - generatorLength);
  }
  return remainder;
}

/** 15-bit masked format string for one EC level and mask. */
export function formatBits(ecLevel, mask) {
  const data = (EC_LEVELS[ecLevel].formatBits << 3) | mask;
  return ((data << 10) | bchRemainder(data, 0x537, 10)) ^ 0x5412;
}

/** 18-bit version string for versions 7 and above. */
export function versionBits(version) {
  return (version << 12) | bchRemainder(version, 0x1f25, 12);
}

/* ------------------------------------------------------------ data stream */

function utf8Bytes(text) {
  return Array.from(new TextEncoder().encode(text));
}

function buildDataBits(bytes, version, ecLevel) {
  const capacityCodewords = dataCodewords(version, ecLevel);
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, countBits(version));
  for (const byte of bytes) push(byte, 8);

  const capacityBits = capacityCodewords * 8;
  if (bits.length > capacityBits) throw new Error("data does not fit the chosen version");
  // Terminator, up to four zero bits.
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
  // Pad to the next codeword boundary.
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  const padBytes = [0xec, 0x11];
  let index = 0;
  while (codewords.length < capacityCodewords) codewords.push(padBytes[index++ % 2]);
  return codewords;
}

function splitBlocks(codewords, version, ecLevel) {
  const [ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data] = VERSIONS[version].blocks[ecLevel];
  const blocks = [];
  let offset = 0;
  for (let i = 0; i < g1Blocks; i++) { blocks.push(codewords.slice(offset, offset + g1Data)); offset += g1Data; }
  for (let i = 0; i < g2Blocks; i++) { blocks.push(codewords.slice(offset, offset + g2Data)); offset += g2Data; }
  if (offset !== codewords.length) throw new Error("block split does not consume every codeword");
  return { blocks, ecPerBlock };
}

function interleave(codewords, version, ecLevel) {
  const { blocks, ecPerBlock } = splitBlocks(codewords, version, ecLevel);
  const ecBlocks = blocks.map((block) => rsEncode(block, ecPerBlock));
  const longest = Math.max(...blocks.map((b) => b.length));
  const result = [];
  for (let i = 0; i < longest; i++) {
    for (const block of blocks) if (i < block.length) result.push(block[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) result.push(block[i]);
  }
  return result;
}

/* --------------------------------------------------------------- matrix -- */

function createMatrix(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(0));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
  return { size, modules, isFunction };
}

function setFunction(symbol, row, col, dark) {
  if (row < 0 || col < 0 || row >= symbol.size || col >= symbol.size) return;
  symbol.modules[row][col] = dark ? 1 : 0;
  symbol.isFunction[row][col] = true;
}

function placeFinder(symbol, top, left) {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const row = top + dr;
      const col = left + dc;
      if (row < 0 || col < 0 || row >= symbol.size || col >= symbol.size) continue;
      const inRing = (Math.max(Math.abs(dr - 3), Math.abs(dc - 3)) <= 3);
      const dark = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6
        && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
      setFunction(symbol, row, col, inRing && dark);
    }
  }
}

function placeTiming(symbol) {
  for (let i = 8; i < symbol.size - 8; i++) {
    const dark = i % 2 === 0;
    setFunction(symbol, 6, i, dark);
    setFunction(symbol, i, 6, dark);
  }
}

function placeAlignment(symbol, version) {
  const positions = VERSIONS[version].align;
  for (const row of positions) {
    for (const col of positions) {
      // Skip the three alignment patterns that would collide with finders.
      if ((row <= 8 && col <= 8) || (row <= 8 && col >= symbol.size - 9) || (row >= symbol.size - 9 && col <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFunction(symbol, row + dr, col + dc, dark);
        }
      }
    }
  }
}

function reserveFormatAreas(symbol) {
  for (let i = 0; i < 9; i++) {
    if (!symbol.isFunction[8][i]) setFunction(symbol, 8, i, false);
    if (!symbol.isFunction[i][8]) setFunction(symbol, i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    if (!symbol.isFunction[8][symbol.size - 1 - i]) setFunction(symbol, 8, symbol.size - 1 - i, false);
    if (!symbol.isFunction[symbol.size - 1 - i][8]) setFunction(symbol, symbol.size - 1 - i, 8, false);
  }
}

function reserveVersionAreas(symbol, version) {
  if (version < 7) return;
  for (let i = 0; i < 18; i++) {
    const a = symbol.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    if (!symbol.isFunction[a][b]) setFunction(symbol, a, b, false);
    if (!symbol.isFunction[b][a]) setFunction(symbol, b, a, false);
  }
}

function placeDataBits(symbol, bits) {
  let index = 0;
  let upward = true;
  for (let column = symbol.size - 1; column > 0; column -= 2) {
    if (column === 6) column--; // the vertical timing column is not data
    for (let step = 0; step < symbol.size; step++) {
      const row = upward ? symbol.size - 1 - step : step;
      for (const col of [column, column - 1]) {
        if (symbol.isFunction[row][col]) continue;
        symbol.modules[row][col] = bits[index] ?? 0;
        index++;
      }
    }
    upward = !upward;
  }
  return index;
}

export function maskBit(mask, row, col) {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: throw new Error(`invalid mask ${mask}`);
  }
}

function applyMask(symbol, mask) {
  for (let row = 0; row < symbol.size; row++) {
    for (let col = 0; col < symbol.size; col++) {
      if (symbol.isFunction[row][col]) continue;
      if (maskBit(mask, row, col)) symbol.modules[row][col] ^= 1;
    }
  }
  return symbol;
}

function drawFormatBits(symbol, ecLevel, mask) {
  const bits = formatBits(ecLevel, mask);
  const get = (i) => (bits >>> i) & 1;
  for (let i = 0; i < 6; i++) setFunction(symbol, 8, i, get(i));
  setFunction(symbol, 8, 7, get(6));
  setFunction(symbol, 8, 8, get(7));
  setFunction(symbol, 7, 8, get(8));
  for (let i = 9; i < 15; i++) setFunction(symbol, 14 - i, 8, get(i));
  for (let i = 0; i < 8; i++) setFunction(symbol, symbol.size - 1 - i, 8, get(i));
  for (let i = 8; i < 15; i++) setFunction(symbol, 8, symbol.size - 15 + i, get(i));
  setFunction(symbol, symbol.size - 8, 8, true); // always-dark module
}

function drawVersionBits(symbol, version) {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const bit = (bits >>> i) & 1;
    const a = symbol.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunction(symbol, a, b, bit);
    setFunction(symbol, b, a, bit);
  }
}

/* -------------------------------------------------------------- penalty -- */

function penaltyRule1(symbol) {
  let score = 0;
  for (const line of [...rowsOf(symbol.modules), ...columnsOf(symbol.modules)]) {
    let run = 1;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  return score;
}

function rowsOf(modules) {
  return modules.map((row) => row);
}

function columnsOf(modules) {
  const size = modules.length;
  return Array.from({ length: size }, (_, col) => modules.map((row) => row[col]));
}

function penaltyRule2(symbol) {
  let score = 0;
  for (let row = 0; row < symbol.size - 1; row++) {
    for (let col = 0; col < symbol.size - 1; col++) {
      const value = symbol.modules[row][col];
      if (value === symbol.modules[row][col + 1] && value === symbol.modules[row + 1][col] && value === symbol.modules[row + 1][col + 1]) {
        score += 3;
      }
    }
  }
  return score;
}

const FINDER_LIKE_A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
const FINDER_LIKE_B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];

function matches(line, start, pattern) {
  for (let i = 0; i < pattern.length; i++) if (line[start + i] !== pattern[i]) return false;
  return true;
}

function penaltyRule3(symbol) {
  let score = 0;
  for (const line of [...rowsOf(symbol.modules), ...columnsOf(symbol.modules)]) {
    for (let i = 0; i + 11 <= line.length; i++) {
      if (matches(line, i, FINDER_LIKE_A) || matches(line, i, FINDER_LIKE_B)) score += 40;
    }
  }
  return score;
}

function penaltyRule4(symbol) {
  let dark = 0;
  for (const row of symbol.modules) for (const value of row) dark += value;
  const percent = (dark * 100) / (symbol.size * symbol.size);
  return Math.floor(Math.abs(percent - 50) / 5) * 10;
}

export function penaltyScore(modules) {
  const symbol = { size: modules.length, modules };
  return penaltyRule1(symbol) + penaltyRule2(symbol) + penaltyRule3(symbol) + penaltyRule4(symbol);
}

/* -------------------------------------------------------------- encoder -- */

/**
 * Encode text as a QR symbol.
 *
 * @param {string} text
 * @param {{ecLevel?: "L"|"M"|"Q"|"H", version?: number, mask?: number}} [options]
 * @returns {{version:number, ecLevel:string, mask:number, size:number,
 *            modules:number[][], codewords:number[], segments:number,
 *            penalty:number, format:number, versionInfo:number|null}}
 */
export function encodeQR(text, { ecLevel = "M", version = null, mask = null } = {}) {
  if (!EC_LEVELS[ecLevel]) throw new Error(`unknown EC level ${ecLevel}`);
  const bytes = utf8Bytes(String(text));
  const chosenVersion = version ?? chooseVersion(bytes.length, ecLevel);
  if (chosenVersion < MIN_VERSION || chosenVersion > MAX_VERSION) throw new Error(`unsupported QR version ${chosenVersion}`);
  if (byteCapacity(chosenVersion, ecLevel) < bytes.length) {
    throw new Error(`payload of ${bytes.length} bytes does not fit version ${chosenVersion}-${ecLevel}`);
  }

  const codewords = buildDataBits(bytes, chosenVersion, ecLevel);
  const interleaved = interleave(codewords, chosenVersion, ecLevel);
  const remainder = VERSIONS[chosenVersion].remainder;

  let best = null;
  const masks = mask === null ? [0, 1, 2, 3, 4, 5, 6, 7] : [mask];
  for (const candidate of masks) {
    const symbol = createMatrix(chosenVersion);
    placeFinder(symbol, 0, 0);
    placeFinder(symbol, 0, symbol.size - 7);
    placeFinder(symbol, symbol.size - 7, 0);
    placeTiming(symbol);
    placeAlignment(symbol, chosenVersion);
    reserveFormatAreas(symbol);
    reserveVersionAreas(symbol, chosenVersion);

    const bits = [];
    for (const codeword of interleaved) {
      for (let i = 7; i >= 0; i--) bits.push((codeword >>> i) & 1);
    }
    for (let i = 0; i < remainder; i++) bits.push(0);
    const placed = placeDataBits(symbol, bits);
    if (placed !== bits.length) throw new Error(`placed ${placed} bits but had ${bits.length}`);

    applyMask(symbol, candidate);
    drawFormatBits(symbol, ecLevel, candidate);
    drawVersionBits(symbol, chosenVersion);
    const penalty = penaltyScore(symbol.modules);
    if (!best || penalty < best.penalty) {
      best = {
        version: chosenVersion, ecLevel, mask: candidate, size: symbol.size,
        modules: symbol.modules, isFunction: symbol.isFunction, penalty,
      };
    }
  }

  return {
    ...best,
    codewords: interleaved,
    dataCodewords: codewords,
    isFunction: best.isFunction,
    format: formatBits(ecLevel, best.mask),
    versionInfo: chosenVersion >= 7 ? versionBits(chosenVersion) : null,
  };
}
