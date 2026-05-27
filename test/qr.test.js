import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeQR, byteCapacity, chooseVersion, dataCodewords, gfMultiply, gfPower,
  rsGenerator, rsEncode, formatBits, versionBits, maskBit, penaltyScore,
} from "../src/qr.js";

/* ------------------------------------------------------------- arithmetic */

test("GF(256) multiplication has the field's identity and inverse properties", () => {
  assert.equal(gfMultiply(0, 123), 0);
  assert.equal(gfMultiply(1, 123), 123);
  assert.equal(gfMultiply(123, 1), 123);
  assert.equal(gfMultiply(2, 3), 6); // 6 < 256, no reduction needed
  assert.equal(gfMultiply(0x80, 2), 0x1d); // 0x100 reduced by the primitive polynomial
  for (const a of [1, 2, 5, 17, 99, 201, 255]) {
    const inverse = gfPower(a, 254); // a^254 = a^-1 in GF(256)
    assert.equal(gfMultiply(a, inverse), 1, `inverse failed for ${a}`);
  }
});

test("GF addition is XOR and the exponent table wraps at 255", () => {
  assert.equal(gfPower(2, 0), 1);
  assert.equal(gfPower(2, 8), 0x1d);
  assert.equal(gfPower(2, 255), 1);
});

test("Reed-Solomon generator polynomials are monic and have the right degree", () => {
  assert.deepEqual(rsGenerator(1), [1, 1]);
  assert.deepEqual(rsGenerator(2), [1, 3, 2]); // (x + 1)(x + α)
  for (const degree of [7, 10, 18, 30]) {
    const generator = rsGenerator(degree);
    assert.equal(generator.length, degree + 1);
    assert.equal(generator[0], 1);
  }
});

test("Reed-Solomon matches the worked example from ISO 18004", () => {
  // The numeric "01234567" example, version 1-M: 16 data codewords and 10 ECC.
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(rsEncode(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test("every Reed-Solomon codeword evaluates to zero at the generator roots", () => {
  const data = [64, 12, 86, 97, 128, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17];
  const ec = rsEncode(data, 10);
  const codeword = [...data, ...ec];
  for (let i = 0; i < 10; i++) {
    let sum = 0;
    for (let j = 0; j < codeword.length; j++) {
      sum ^= gfMultiply(codeword[j], gfPower(2, (i * (codeword.length - 1 - j)) % 255));
    }
    assert.equal(sum, 0, `syndrome ${i} is not zero`);
  }
});

/* ------------------------------------------------------- format and version */

test("format bits match the fifteen-bit strings the standard publishes", () => {
  const known = {
    L: 0b111011111000100,
    M: 0b101010000010010,
    Q: 0b011010101011111,
    H: 0b001011010001001,
  };
  for (const [level, bits] of Object.entries(known)) {
    assert.equal(formatBits(level, 0), bits, `format bits wrong for ${level}`);
  }
  // The mask index is part of the payload, so every pair must be distinct.
  const seen = new Set();
  for (const level of ["L", "M", "Q", "H"]) {
    for (let mask = 0; mask < 8; mask++) {
      const bits = formatBits(level, mask);
      assert.ok(bits > 0 && bits < 1 << 15);
      seen.add(bits);
    }
  }
  assert.equal(seen.size, 32);
});

test("version bits match the published strings for versions 7 and 10", () => {
  assert.equal(versionBits(7), 0b000111110010010100);
  assert.equal(versionBits(10), 0b001010010011010011);
  assert.equal(versionBits(8), 0b001000010110111100);
});

/* ------------------------------------------------------------------ tables */

test("data and error-correction codewords add up to the table total", () => {
  const totals = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
  for (let version = 1; version <= 10; version++) {
    for (const level of ["L", "M", "Q", "H"]) {
      const data = dataCodewords(version, level);
      assert.ok(data > 0 && data < totals[version], `${version}-${level}`);
      // L always carries the most data, H the least.
    }
    assert.ok(dataCodewords(version, "L") >= dataCodewords(version, "H"));
  }
});

test("byte capacity matches the familiar version-1 numbers", () => {
  assert.equal(byteCapacity(1, "L"), 17);
  assert.equal(byteCapacity(1, "M"), 14);
  assert.equal(byteCapacity(1, "Q"), 11);
  assert.equal(byteCapacity(1, "H"), 7);
  assert.equal(byteCapacity(2, "L"), 32);
  assert.equal(byteCapacity(3, "L"), 53);
  assert.equal(byteCapacity(4, "L"), 78);
  assert.equal(byteCapacity(10, "L"), 271);
});

test("chooseVersion picks the smallest symbol that fits", () => {
  assert.equal(chooseVersion(14, "M"), 1);
  assert.equal(chooseVersion(15, "M"), 2);
  assert.equal(chooseVersion(17, "L"), 1);
  assert.equal(chooseVersion(18, "L"), 2);
  assert.equal(chooseVersion(26, "M"), 2);
  assert.throws(() => chooseVersion(300, "L"), /does not fit/);
});

/* ------------------------------------------------------------- symbol shape */

const isDark = (symbol, row, col) => symbol.modules[row][col] === 1;

test("a symbol has the right size, finders, timing and dark module", () => {
  const symbol = encodeQR("HELLO WORLD", { ecLevel: "M" });
  assert.equal(symbol.version, 1);
  assert.equal(symbol.size, 21);
  assert.equal(symbol.modules.length, 21);
  assert.equal(symbol.modules[0].length, 21);

  for (const [top, left] of [[0, 0], [0, symbol.size - 7], [symbol.size - 7, 0]]) {
    for (let d = 0; d < 7; d++) {
      assert.equal(isDark(symbol, top, left + d), true, "finder border");
      assert.equal(isDark(symbol, top + 6, left + d), true, "finder border");
      assert.equal(isDark(symbol, top + d, left), true, "finder border");
      assert.equal(isDark(symbol, top + d, left + 6), true, "finder border");
    }
    assert.equal(isDark(symbol, top + 3, left + 3), true, "finder centre");
    assert.equal(isDark(symbol, top + 1, left + 1), false, "finder ring");
  }

  for (let i = 8; i < symbol.size - 8; i++) {
    assert.equal(symbol.modules[6][i], i % 2 === 0 ? 1 : 0, "horizontal timing");
    assert.equal(symbol.modules[i][6], i % 2 === 0 ? 1 : 0, "vertical timing");
  }
  assert.equal(symbol.modules[symbol.size - 8][8], 1, "always-dark module");
});

test("versions 7 and up carry their version information in both corners", () => {
  const symbol = encodeQR("EV26-GA-0007-K3", { ecLevel: "M", version: 7 });
  assert.equal(symbol.size, 45);
  assert.equal(symbol.versionInfo, versionBits(7));
  let fromBottomLeft = 0;
  let fromTopRight = 0;
  for (let i = 0; i < 18; i++) {
    const a = symbol.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    fromBottomLeft |= symbol.modules[a][b] << i;
    fromTopRight |= symbol.modules[b][a] << i;
  }
  assert.equal(fromBottomLeft, symbol.versionInfo);
  assert.equal(fromTopRight, symbol.versionInfo);
});

test("data modules equal codeword bits plus the version's remainder bits", () => {
  const remainders = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];
  for (const [text, version] of [["A", 1], ["EV26-GA-0007-K3", 2], ["x".repeat(60), 4], ["y".repeat(120), 8]]) {
    const symbol = encodeQR(text, { ecLevel: "M", version });
    let dataModules = 0;
    for (let row = 0; row < symbol.size; row++) {
      for (let col = 0; col < symbol.size; col++) if (!symbol.isFunction[row][col]) dataModules++;
    }
    assert.equal(dataModules, symbol.codewords.length * 8 + remainders[version], `version ${version}`);
  }
});

/* ------------------------------------------------------------- placement */

test("unmasking and re-reading the matrix recovers the codewords", () => {
  const cases = [
    ["EV26-GA-0007-K3", { ecLevel: "M" }],
    ["https://arviontech.net/pass/EV26", { ecLevel: "Q" }],
    ["काठमाडौं डिजाइन विक", { ecLevel: "L" }],
  ];
  for (const [text, options] of cases) {
    const symbol = encodeQR(text, options);
    const bits = [];
    let upward = true;
    for (let column = symbol.size - 1; column > 0; column -= 2) {
      if (column === 6) column--;
      for (let step = 0; step < symbol.size; step++) {
        const row = upward ? symbol.size - 1 - step : step;
        for (const col of [column, column - 1]) {
          if (symbol.isFunction[row][col]) continue;
          let value = symbol.modules[row][col];
          if (maskBit(symbol.mask, row, col)) value ^= 1;
          bits.push(value);
        }
      }
      upward = !upward;
    }
    const extracted = [];
    for (let i = 0; i + 8 <= symbol.codewords.length * 8; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      extracted.push(byte);
    }
    assert.deepEqual(extracted, symbol.codewords, `round-trip failed for "${text.slice(0, 12)}"`);
  }
});

test("the chosen mask has the lowest penalty of the eight", () => {
  const auto = encodeQR("EV26-VI-0012-5Q", { ecLevel: "Q" });
  let best = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = encodeQR("EV26-VI-0012-5Q", { ecLevel: "Q", mask });
    assert.equal(candidate.mask, mask);
    best = Math.min(best, penaltyScore(candidate.modules));
  }
  assert.equal(auto.penalty, best);
  assert.equal(penaltyScore(auto.modules), auto.penalty);
});

test("multi-byte text is measured in UTF-8 bytes, not characters", () => {
  const text = "काठमाडौं"; // 9 characters, 27 bytes in UTF-8
  const bytes = new TextEncoder().encode(text).length;
  assert.ok(bytes > text.length);
  assert.equal(chooseVersion(bytes, "M"), 2);
  const symbol = encodeQR(text, { ecLevel: "M" });
  assert.equal(symbol.version, 2);
  assert.equal(symbol.version, chooseVersion(bytes, "M"));
});

test("the formatter refuses to silently truncate an oversized payload", () => {
  assert.throws(() => encodeQR("x".repeat(272), { ecLevel: "L" }), /does not fit/);
  assert.throws(() => encodeQR("hello", { ecLevel: "Z" }), /unknown EC level/);
  assert.throws(() => encodeQR("hello", { version: 11 }), /unsupported QR version/);
});

test("the same input and options always produce the same matrix", () => {
  const a = encodeQR("EV26-EB-0003-9B", { ecLevel: "H" });
  const b = encodeQR("EV26-EB-0003-9B", { ecLevel: "H" });
  assert.deepEqual(a.modules, b.modules);
  assert.equal(a.mask, b.mask);
  assert.equal(a.penalty, b.penalty);
});
