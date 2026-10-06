/**
 * تحقق حي لمسار الوسيط: يبني رابط الوسيط بالمفتاح من متغير البيئة، يجلب صفحة
 * حقيقية محجوبة، يفحص بصمة الصورة من أول كتلة، ويكتبها على القرص كاملة.
 * (قراءة المفتاح من appSettings عبر getSetting تتطلب MongoDB — خارج نطاق هذا
 * السكربت؛ المسار الكامل مع القاعدة مغطى باختبارات الوحدة.)
 * تشغيل: SCRAPERAPI_KEY=... npx tsx scripts/verify-scraper-fallback.mts
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { buildScraperApiUrl, looksLikeImage } from "../server/services/scraperApi";

const key = process.env.SCRAPERAPI_KEY?.trim();
if (!key) {
  console.error("لا مفتاح — اضبط SCRAPERAPI_KEY");
  process.exit(1);
}

// صورة مغوستون الحقيقية التي أعادت 403 مباشرة من IP مركز بيانات.
const target = "https://storage.magustoon.org/upload/series/presepe-outside-the-cage/8d90f621-7a61-44ac-8ae9-b0777d2430e4/page-0001_01_1789337639871-209807.webp";
const scraperUrl = buildScraperApiUrl(target, key);
console.log("رابط الوسيط المبني:", scraperUrl.replace(/api_key=[^&]+/, "api_key=***"));

const started = Date.now();
const response = await fetch(scraperUrl, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
console.log("حالة الاستجابة:", response.status);
if (!response.ok || !response.body) process.exit(1);

const reader = response.body.getReader();
const first = await reader.read();
if (first.done || !first.value || !looksLikeImage(first.value)) {
  console.error("أول كتلة ليست صورة — الفحص فشل");
  process.exit(1);
}
const head = Buffer.from(first.value).subarray(0, 12).toString("hex");
console.log("بصمة أول كتلة:", head, "→ صورة ✓");

const dir = await mkdtemp(path.join(tmpdir(), "scraper-live-"));
const file = path.join(dir, "page-0001.img");
try {
  const handle = await import("node:fs/promises").then(m => m.open(file, "w"));
  await handle.write(first.value);
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    await handle.write(next.value);
  }
  await handle.close();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const info = await sharp(file).metadata();
  const size = (await stat(file)).size;
  const saved = await readFile(file);
  console.log(`اكتمل التنزيل في ${seconds}s — ${size} بايت، ${info.format} ${info.width}x${info.height}`);
  if (!info.width || !info.height || size < 100_000) process.exit(1);
  console.log(size === saved.length ? "✓ المسار الحي كامل: تمرير عبر الوسيط → فحص البصمة → كتابة القرص → صورة صالحة" : "حجم غير متطابق!");
} finally {
  await rm(dir, { recursive: true, force: true });
}
