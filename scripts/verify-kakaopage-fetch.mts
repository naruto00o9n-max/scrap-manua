/**
 * تحقق حي من سحب فصل مجاني من كاكاو بيج عبر الوحدة المباشرة الجديدة:
 *   npx tsx scripts/verify-kakaopage-fetch.mts [رابط الفصل]
 * الافتراضي: فصل 1 من «정령왕 엘퀴네스» (مجاني للزوار) على page.kakao.com.
 * يطبع العناوين وعدد الصفحات، ينزّل أول صفحتين ويتحقق من بصمتهما، ثم يجرّب
 * فصلًا مدفوعًا للتأكد من رفضه بنعرفة واضحة.
 */
import { writeFile, rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchKakaoPageChapter } from "../server/services/kakaoPage";

const DEFAULT_URL = "https://page.kakao.com/viewer?productId=49402089";
const PAID_URL = "https://page.kakao.com/content/49361421/viewer/49925913";
const url = process.argv[2] ?? DEFAULT_URL;

console.log(`[1] تحليل وجلب الفصل: ${url}`);
const outcome = await fetchKakaoPageChapter(url);
if (!outcome.ok) {
  console.error(`✗ فشل: ${outcome.message}${outcome.locked ? " (مدفوع)" : ""}`);
  process.exit(1);
}
console.log(`✓ العمل: ${outcome.mangaTitle}`);
console.log(`✓ الفصل: ${outcome.chapterName}`);
console.log(`✓ الصفحات: ${outcome.pages.length}`);
if (!outcome.pages.length) {
  console.error("✗ لا صفحات — توقف.");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "kp-verify-"));
try {
  for (const [index, pageUrl] of outcome.pages.slice(0, 2).entries()) {
    const response = await fetch(pageUrl, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      console.error(`✗ تنزيل الصفحة ${index + 1} ردّ ${response.status}`);
      process.exit(1);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
    const isPng = buffer[0] === 0x89 && buffer[1] === 0x50;
    const isWebp = buffer.subarray(0, 4).toString("ascii") === "RIFF";
    if (!isJpeg && !isPng && !isWebp) {
      console.error(`✗ الصفحة ${index + 1} ليست صورة (البصمة: ${buffer.subarray(0, 4).toString("hex")})`);
      process.exit(1);
    }
    await writeFile(join(dir, `page-${index + 1}.bin`), buffer);
    console.log(
      `✓ الصفحة ${index + 1}: ${buffer.length.toLocaleString()} بايت — ${isJpeg ? "JPEG" : isPng ? "PNG" : "WebP"}`
    );
  }
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

console.log(`[2] التحقق من رفض الفصل المدفوع بنعرفة: ${PAID_URL}`);
const paid = await fetchKakaoPageChapter(PAID_URL);
if (paid.ok) {
  console.error("✗ غير متوقع: الفصل المدفوع عاد بصفحات؟");
  process.exit(1);
}
console.log(`✓ رُفض كما هو متوقع (مدفوع: ${paid.locked}): ${paid.message}`);

console.log("\nكل فحوصات كاكاو بيج الحية نجحت.");
