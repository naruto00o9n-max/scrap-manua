import sharp from "sharp";

// ============================================================
// فك تشويش صور كوميكس — نقل مباشر لملف Descrambler.kt من إضافة
// Comix في keiyoushi إلى TypeScript مع sharp بدل Bitmap:
// - «x-enc-*»: تشويش بايتات بذرة عشوائية (LCG أو xorshift) يُفك قبل
//   أي معالجة، وطوله محدود بحقل x-enc-len.
// - «x-scramble-*»: شبكة 5×5 من الكتل مرتبة بترتيب مبذوث (xorshift أو
//   LCG) تُعاد لمواضعها، مع بصمة hash صغيرة تصحح البذرة.
// الترويسات تُقرأ من استجابة الصورة نفسها عند التنزيل، والفك يُطبق على
// الملف المحفوظ في المكان (نمط unscrambleGigaViewerPage نفسه).
// ============================================================

const GRID_COLS = 5;
const GRID_ROWS = 5;
const NUM_TILES = GRID_COLS * GRID_ROWS;

const ENC_MULTIPLIER = 1000005;
const ENC_INCREMENT = 1234567891;
const LCG_MULTIPLIER = 1664525;
const LCG_INCREMENT = 1013904223;

/** ترويسات الصورة التي يحتاجها فك التشويش — تُمرر من أنبوب التنزيل. */
export type ComixScrambleHeaders = {
  "x-scramble-seed"?: string | null;
  "x-scramble-grid"?: string | null;
  "x-scramble-algo"?: string | null;
  "x-scramble-hash"?: string | null;
  "x-enc-seed"?: string | null;
  "x-enc-len"?: string | null;
  "x-enc-algo"?: string | null;
};

/** هل تحمل الترويسات أي شكل تشويش معروف؟ */
export function hasComixScrambleHeaders(headers: ComixScrambleHeaders): boolean {
  const encSeed = Number(headers["x-enc-seed"]);
  const encLen = Number(headers["x-enc-len"]);
  const scrambleSeed = Number(headers["x-scramble-seed"]);
  const needsXor = Number.isFinite(encSeed) && encSeed !== 0 && Number.isFinite(encLen);
  const grid = headers["x-scramble-grid"]?.trim() ?? "";
  const algo = headers["x-scramble-algo"]?.trim() ?? "";
  const shouldGrid = grid === "5x5" &&
    (algo === "" || algo === "1" || algo === "2" || algo === "3") &&
    Number.isFinite(scrambleSeed) && scrambleSeed !== 0;
  return needsXor || shouldGrid;
}

/** لغة Java في الطرح الحسابي: int32 مع لف صريح — Math.imul يحاكيها بدقة. */
function wrapInt32(value: number): number {
  return value | 0;
}

/** فك تشويش البايتات ببذرة LCG — عكس decodeWithLcg حرفيًا. */
export function decodeWithLcg(bytes: Uint8Array, seed: number, length: number): Uint8Array {
  const result = bytes.slice();
  let state = wrapInt32(seed);
  const limit = Math.min(result.length, length);
  for (let i = 0; i < limit; i += 1) {
    // ضرب int32 مع لف ثم إضافة ثابت مع لف — مطابق لطفح Java
    state = wrapInt32(Math.imul(state, ENC_MULTIPLIER));
    state = wrapInt32(state + ENC_INCREMENT);
    const key = wrapInt32(state) >>> 24;
    result[i] = (result[i]! ^ key) & 0xff;
  }
  return result;
}

/** خطوة xorshift32 واحدة — مطابقة لـ nextXorshiftState. */
function nextXorshiftState(state: number): number {
  let next = state | 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next | 0;
}

/** فك تشويش البايتات ببذرة xorshift — عكس decodeWithXorshift. */
export function decodeWithXorshift(bytes: Uint8Array, initialState: number, length: number, highByte: boolean): Uint8Array {
  const result = bytes.slice();
  let state = initialState | 0;
  const limit = Math.min(result.length, length);
  for (let i = 0; i < limit; i += 1) {
    state = nextXorshiftState(state);
    const key = highByte ? state >>> 24 : state & 0xff;
    result[i] = (result[i]! ^ key) & 0xff;
  }
  return result;
}

/** بصمة ملف صورة صالحة بعد فك البايتات. */
function hasImageSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const isWebp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  return isWebp || isJpeg || isPng;
}

/** خوارزمية فك البايتات المناسبة حسب x-enc-algo مع تجريب المرشحين لـ«2». */
export function decodeEncodedBytes(bytes: Uint8Array, seed: number, length: number, algo: string | null | undefined): Uint8Array {
  if (algo !== "2") return decodeWithLcg(bytes, seed, length);
  const candidates = [
    decodeWithXorshift(bytes, seed | 1, length, false),
    decodeWithXorshift(bytes, seed, length, false),
    decodeWithXorshift(bytes, seed | 1, length, true),
    decodeWithLcg(bytes, seed, length),
  ];
  return candidates.find(candidate => hasImageSignature(candidate)) ?? candidates[0]!;
}

/** تصحيح البذرة ببصمة x-scramble-hash — عكس decodeScrambleHash. */
export function decodeScrambleHash(hash: string | null | undefined): number {
  const trimmed = (hash ?? "").trim();
  if (trimmed === "03632") return 58414;
  if (trimmed === "02900") return 117532;
  return 0;
}

/** ترتيب xorshift المبذوث ثم معكوسه — عكس buildOrder. */
export function buildOrder(seed: number, n: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i);
  let state = seed | 1;
  for (let i = n - 1; i >= 1; i -= 1) {
    state = nextXorshiftState(state);
    const j = (state >>> 0) % (i + 1);
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  const inverse = new Array<number>(n);
  for (let i = 0; i < n; i += 1) inverse[arr[i]!] = i;
  return inverse;
}

/** ترتيب LCG المبذوث ثم معكوسه — عكس buildOrderLcg. */
export function buildOrderLcg(seed: number, n: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i);
  let state = wrapInt32(seed);
  for (let i = n - 1; i >= 1; i -= 1) {
    state = wrapInt32(Math.imul(state, LCG_MULTIPLIER));
    state = wrapInt32(state + LCG_INCREMENT);
    const j = (state >>> 0) % (i + 1);
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  const inverse = new Array<number>(n);
  for (let i = 0; i < n; i += 1) inverse[arr[i]!] = i;
  return inverse;
}

/**
 * يفك تشويش صورة كوميكس كاملة من الترويسات على الملف المحفوظ في مكانه:
 * 1) فك بايتات XOR إن وُجدت x-enc-*.
 * 2) إعادة ترتيب شبكة 5×5 إن وُجدت x-scramble-*.
 * تعيد true إن أجري أي تعديل.
 */
export async function unscrambleComixPage(
  filePath: string,
  headers: ComixScrambleHeaders
): Promise<boolean> {
  const encSeed = Number(headers["x-enc-seed"]);
  const encLen = Number(headers["x-enc-len"]);
  const scrambleSeed = Number(headers["x-scramble-seed"]);
  const encAlgo = headers["x-enc-algo"]?.trim() ?? null;
  const scrambleAlgo = headers["x-scramble-algo"]?.trim() ?? null;
  const scrambleGrid = headers["x-scramble-grid"]?.trim() ?? "";

  const needsXor = Number.isFinite(encSeed) && encSeed !== 0 && Number.isFinite(encLen);
  const shouldGrid = scrambleGrid === "5x5" &&
    (scrambleAlgo === null || scrambleAlgo === "" || scrambleAlgo === "1" || scrambleAlgo === "2" || scrambleAlgo === "3") &&
    Number.isFinite(scrambleSeed) && scrambleSeed !== 0;
  if (!needsXor && !shouldGrid) return false;

  if (needsXor) {
    const { readFile, writeFile } = await import("node:fs/promises");
    const fileBytes = new Uint8Array(await readFile(filePath));
    const decoded = decodeEncodedBytes(fileBytes, encSeed, encLen, encAlgo);
    // نستبدل الملف بالبايتات المفككة — إن كانت صورة صالحة أكملها sharp طبيعيًا
    await writeFile(filePath, decoded);
  }

  if (shouldGrid) {
    const metadata = await sharp(filePath).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (!width || !height) return needsXor;
    const tileWidth = Math.floor(width / GRID_COLS);
    const tileHeight = Math.floor(height / GRID_ROWS);
    if (tileWidth <= 0 || tileHeight <= 0) return needsXor;
    const order = scrambleAlgo === "3"
      ? buildOrder(scrambleSeed ^ decodeScrambleHash(headers["x-scramble-hash"]), NUM_TILES)
      : buildOrderLcg(scrambleSeed ^ decodeScrambleHash(headers["x-scramble-hash"]), NUM_TILES);
    const composites: Array<{ input: Buffer; left: number; top: number }> = [];
    for (let dstIndex = 0; dstIndex < NUM_TILES; dstIndex += 1) {
      const srcIndex = order[dstIndex]!;
      const srcCol = srcIndex % GRID_COLS;
      const srcRow = Math.floor(srcIndex / GRID_COLS);
      const dstCol = dstIndex % GRID_COLS;
      const dstRow = Math.floor(dstIndex / GRID_COLS);
      const buffer = await sharp(filePath)
        .extract({ left: srcCol * tileWidth, top: srcRow * tileHeight, width: tileWidth, height: tileHeight })
        .toBuffer();
      composites.push({ input: buffer, left: dstCol * tileWidth, top: dstRow * tileHeight });
    }
    const unscrambled = await sharp(filePath).composite(composites).jpeg({ quality: 90 }).toBuffer();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${filePath}.unscrambled`, unscrambled);
    const { rename } = await import("node:fs/promises");
    await rename(`${filePath}.unscrambled`, filePath);
  }
  return true;
}
