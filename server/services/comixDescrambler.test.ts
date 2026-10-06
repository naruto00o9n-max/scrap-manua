import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildOrder,
  buildOrderLcg,
  decodeEncodedBytes,
  decodeScrambleHash,
  decodeWithLcg,
  decodeWithXorshift,
  hasComixScrambleHeaders,
  unscrambleComixPage,
} from "./comixDescrambler";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "comix-scramble-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("فك تشويش بايتات كوميكس", () => {
  it("LCG يفك ما شفرته نفسه (عملية XOR تناظرية)", () => {
    const bytes = new Uint8Array(64).map((_, i) => (i * 37) & 0xff);
    const scrambled = decodeWithLcg(bytes, 123456, bytes.length);
    expect(Array.from(scrambled)).not.toEqual(Array.from(bytes));
    const restored = decodeWithLcg(scrambled, 123456, bytes.length);
    expect(Array.from(restored)).toEqual(Array.from(bytes));
  });

  it("xorshift بمتغيرات مختلفة يعيد الأصل", () => {
    const bytes = new Uint8Array(32).map((_, i) => i & 0xff);
    const scrambled = decodeWithXorshift(bytes, 0xdeadbeef | 1, bytes.length, false);
    const restored = decodeWithXorshift(scrambled, 0xdeadbeef | 1, bytes.length, false);
    expect(Array.from(restored)).toEqual(Array.from(bytes));
  });

  it("algo=2 يختار المرشح صاحب بصمة الصورة", () => {
    // بايتات JPEG حقيقية من sharp
    return (async () => {
      const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#123456" } }).jpeg().toBuffer();
      const scrambled = decodeWithLcg(new Uint8Array(jpeg), 777, jpeg.length);
      const restored = decodeEncodedBytes(scrambled, 777, jpeg.length, "2");
      expect(Array.from(restored)).toEqual(Array.from(new Uint8Array(jpeg)));
    })();
  });

  it("بصمات hash المعروفة تُترجم", () => {
    expect(decodeScrambleHash("03632")).toBe(58414);
    expect(decodeScrambleHash("02900")).toBe(117532);
    expect(decodeScrambleHash(undefined)).toBe(0);
    expect(decodeScrambleHash("9999")).toBe(0);
  });
});

describe("ترتيب شبكة 5×5", () => {
  it("buildOrder يعيد تقليصًا صحيحًا (كل فهرس فريد ويغطي كامل النطاق)", () => {
    const order = buildOrder(424242, 25);
    expect(new Set(order).size).toBe(25);
    expect(Math.min(...order)).toBe(0);
    expect(Math.max(...order)).toBe(24);
  });

  it("buildOrderLcg يعيد تقليصًا صحيحًا", () => {
    const order = buildOrderLcg(-987654321, 25);
    expect(new Set(order).size).toBe(25);
  });
});

describe("hasComixScrambleHeaders", () => {
  it("يكتشف XOR فقط", () => {
    expect(hasComixScrambleHeaders({ "x-enc-seed": "123", "x-enc-len": "500" })).toBe(true);
  });
  it("يكتشف الشبكة فقط", () => {
    expect(hasComixScrambleHeaders({ "x-scramble-seed": "9", "x-scramble-grid": "5x5" })).toBe(true);
  });
  it("يرفض الصفر والغياب والشبكة الغريبة", () => {
    expect(hasComixScrambleHeaders({ "x-enc-seed": "0", "x-enc-len": "500" })).toBe(false);
    expect(hasComixScrambleHeaders({})).toBe(false);
    expect(hasComixScrambleHeaders({ "x-scramble-seed": "9", "x-scramble-grid": "4x4" })).toBe(false);
  });
});

describe("unscrambleComixPage على ملف حقيقي", () => {
  it("يفك شبكة 5×5 محفوظة محليًا وتعود الصورة مطابقة", async () => {
    // نبني صورة أصلية بعرض/ارتفاع من مضاعفات 5
    const width = 100;
    const height = 50;
    const original = await sharp({
      create: { width, height, channels: 3, background: { r: 10, g: 200, b: 30 } },
    }).png().toBuffer();
    const originalRaw = await sharp(original).raw().toBuffer();

    // نشوّشها بأنفسنا: نطبق الترتيب المعكوس (نفس منطق الموقع)
    const filePath = join(dir, "page.jpg");
    await writeFile(filePath, original);
    const seed = 777;
    const order = buildOrderLcg(seed, 25);
    const tileWidth = Math.floor(width / 5);
    const tileHeight = Math.floor(height / 5);
    const scrambled = sharp({
      create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
    });
    const composites: Array<{ input: Buffer; left: number; top: number }> = [];
    for (let dst = 0; dst < 25; dst += 1) {
      const src = order[dst]!;
      const buffer = await sharp(original)
        .extract({
          left: (dst % 5) * tileWidth,
          top: Math.floor(dst / 5) * tileHeight,
          width: tileWidth,
          height: tileHeight,
        })
        .toBuffer();
      composites.push({
        input: buffer,
        left: (src % 5) * tileWidth,
        top: Math.floor(src / 5) * tileHeight,
      });
    }
    void scrambled;
    const scrambledBuffer = await sharp({
      create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite(composites)
      .png()
      .toBuffer();
    await writeFile(filePath, scrambledBuffer);

    // فك التشويش بالترويسات نفسها
    const changed = await unscrambleComixPage(filePath, {
      "x-scramble-seed": String(seed),
      "x-scramble-grid": "5x5",
    });
    expect(changed).toBe(true);

    const restoredRaw = await sharp(filePath).raw().toBuffer();
    expect(restoredRaw.length).toBe(originalRaw.length);
    // مقارنة متسامحة (فقد إعادة ترميز JPEG لا حصر لها هنا لأن الصيغة PNG… sharp يعيد JPEG 90 عند الفك)
    let diff = 0;
    for (let i = 0; i < restoredRaw.length; i += 1) {
      if (Math.abs((restoredRaw[i] ?? 0) - (originalRaw[i] ?? 0)) > 8) diff += 1;
    }
    const tolerance = originalRaw.length * 0.02;
    expect(diff).toBeLessThan(tolerance);
  });

  it("بلا ترويسات تشويش يعيد false ولا يغير الملف", async () => {
    const filePath = join(dir, "plain.jpg");
    const buffer = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#000" } }).jpeg().toBuffer();
    await writeFile(filePath, buffer);
    expect(await unscrambleComixPage(filePath, {})).toBe(false);
    expect((await readFile(filePath)).length).toBe(buffer.length);
  });

  it("فك بايتات XOR عبر ملف يعيد صورة قابلة للقراءة", async () => {
    const jpeg = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#ff8800" } }).jpeg().toBuffer();
    const scrambled = decodeWithLcg(new Uint8Array(jpeg), 55, jpeg.length);
    const filePath = join(dir, "xor.jpg");
    await writeFile(filePath, scrambled);
    const changed = await unscrambleComixPage(filePath, {
      "x-enc-seed": "55",
      "x-enc-len": String(jpeg.length),
    });
    expect(changed).toBe(true);
    const metadata = await sharp(filePath).metadata();
    expect(metadata.width).toBe(32);
    expect(metadata.height).toBe(32);
  });
});
