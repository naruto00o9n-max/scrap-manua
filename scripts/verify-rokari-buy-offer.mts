/**
 * تحقق حي من آلية شراء الفصول المقفلة في rokari comics:
 *   npx tsx scripts/verify-rokari-buy-offer.mts [رابط فصل مقفل]
 * الافتراضي: الفصل 103 من «The Villainous Family Is Against Independence» (مقفل).
 * يتحقق من: قراءة صفحة القفل، استخراج معرّف الفصل ومفتاح الجلسة والسعر،
 * ثم نداء نقطة الشراء بلا جلسة — يرد رفض دخول (لا يخصم شيئًا) وهذا يثبت
 * أن المسار موصول وتصنيف الاستجابة يعمل.
 */
import {
  classifyRokariBuyResponse,
  inspectRokariLockedChapter,
  purchaseRokariChapter,
} from "../server/services/rokariPurchase";

const DEFAULT_URL =
  "https://rokaricomics.com/the-villainous-family-is-against-independence-chapter-103/";
const url = process.argv[2] ?? DEFAULT_URL;

console.log(`[1] فحص صفحة الفصل المقفل: ${url}`);
const inspection = await inspectRokariLockedChapter(url, "");
if (inspection.state !== "locked") {
  console.error(`✗ الحالة: ${inspection.state}${"reason" in inspection ? ` — ${inspection.reason}` : ""}`);
  process.exit(1);
}
console.log(`✓ العمل: ${inspection.mangaTitle}`);
console.log(`✓ الفصل: ${inspection.chapterName}`);
console.log(`✓ معرّف الفصل في الموقع: ${inspection.offer.chapterPostId}`);
console.log(`✓ مفتاح الجلسة: ${inspection.offer.nonce}`);
console.log(`✓ السعر: ${inspection.offer.coinCost ?? "غير معلن"} عملة`);

console.log("[2] نداء نقطة الشراء بلا جلسة — الرد المتوقع رفض دخول بلا أي خصم");
const outcome = await purchaseRokariChapter(url, inspection.offer, "");
if (outcome.ok) {
  console.error("✗ نجح الشراء بلا جلسة؟! استجابة غير متوقعة — توقف.");
  process.exit(1);
}
console.log(`✓ رُفض كما هو متوقع (${outcome.kind}): ${outcome.message}`);
console.log("[3] تصنيف استجابات الصيغ غير المفهومة");
const weird = classifyRokariBuyResponse(200, "0");
console.log(`✓ الجسم «0» صُنّف: ${weird.ok ? "؟" : weird.kind}`);

console.log("كل فحوص شراء rokari الحية نجحت.");
