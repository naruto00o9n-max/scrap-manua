/**
 * تشخيص حيّ لتحليل رابط فصل عبر خادم Suwayomi — نفس مسار /فصل بالضبط.
 *
 * الاستخدام:
 *   npx tsx scripts/verify-chapter-resolution-live.mts \
 *     --url "https://m.webtoons.com/en/challenge/{slug}/ep-133/viewer?title_no=855089&episode_no=204" \
 *     --source 2522335540328470744 \
 *     [--server https://suwayomi-server-production-xxxx.up.railway.app] \
 *     [--token <suwayomiApiToken>] \
 *     [--pages]
 *
 * خطوات المخرجات تطابق طبقات jobWorker/suwayomi:
 *   1) استنتاج رابط العمل ورقم الفصل وصيغة البحث من الرابط
 *   2) استعلام بحث برابط العمل (webtoons) إن أمكن
 *   3) findOrFetchChapterFromSource كاملة (فهرس الخادم → بحث نصي → مطابقة)
 *   4) --pages: جلب الصفحات فعليًا وعدّها (يتحقق من مسار الصور أيضًا)
 *
 * أمثلة جاهزة:
 *   webtoons canvas : --source 2522335540328470744
 *   نافير الرسمي     : --source 1311262507446028482
 */

import { parseArgs } from "node:util";

import {
  SuwayomiClient,
  chapterNumberFromUrl,
  mangaUrlFromChapterUrl,
  naverTitleFromChapterUrl,
  sourceSearchQueryFromChapterUrl,
  urlSearchQueryFromMangaUrl,
} from "../server/services/suwayomi";
import { searchQueryVariants } from "../server/services/suwayomi";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    source: { type: "string" },
    server: { type: "string", default: process.env.SUWAYOMI_BASE_URL || "" },
    token: { type: "string", default: "" },
    pages: { type: "boolean", default: false },
  },
});

if (!values.url || !values.source) {
  console.error("المطلوب: --url <رابط الفصل> --source <معرّف مصدر Suwayomi> [--server ...] [--pages]");
  process.exit(1);
}
if (!values.server) {
  console.error("المطلوب: --server <عنوان خادم Suwayomi> أو متغير البيئة SUWAYOMI_BASE_URL");
  process.exit(1);
}

const chapterUrl = values.url;
const sourceId = values.source;
const client = new SuwayomiClient(values.server, values.token);

const mangaUrl = mangaUrlFromChapterUrl(chapterUrl);
const chapterNumber = chapterNumberFromUrl(chapterUrl);
const textQuery = sourceSearchQueryFromChapterUrl(chapterUrl);
const isNaver = /(^|\.)comic\.naver\.com$/.test(new URL(chapterUrl).hostname.replace(/^www\./, ""));
const naverTitle = isNaver ? await naverTitleFromChapterUrl(chapterUrl) : null;
const urlQuery = mangaUrl ? urlSearchQueryFromMangaUrl(mangaUrl) : null;

console.log("== 1) استنتاج من الرابط ==");
console.log(JSON.stringify({
  mangaUrl,
  chapterNumber,
  textQuery,
  naverTitle,
  searchVariants: searchQueryVariants(naverTitle ?? textQuery),
  urlSearchQuery: urlQuery,
}, null, 2));

if (urlQuery) {
  console.log("\n== 2) البحث برابط العمل ==");
  try {
    const viaUrl = await client.searchSourceManga(sourceId, urlQuery, 20_000);
    console.log(JSON.stringify(viaUrl.map(m => ({ id: m.id, title: m.title, url: m.url })), null, 2));
  } catch (error) {
    console.log(`فشل (الإضافة قد لا تدعمه): ${(error as Error).message}`);
  }
}

console.log("\n== 3) التحليل الكامل findOrFetchChapterFromSource ==");
try {
  const chapter = await client.findOrFetchChapterFromSource(sourceId, chapterUrl);
  console.log(JSON.stringify({
    chapterId: chapter.id,
    name: chapter.name,
    chapterNumber: chapter.chapterNumber,
    manga: chapter.manga.title,
    mangaSourceId: chapter.manga.sourceId,
  }, null, 2));

  if (values.pages) {
    console.log("\n== 4) جلب الصفحات ==");
    const { pages } = await client.fetchChapterPages(chapter.id);
    console.log(`عدد الصفحات: ${pages.length}`);
    console.log(`أول صفحة: ${pages[0]}`);
  }
} catch (error) {
  console.error(`✗ فشل التحليل: ${(error as Error).message}`);
  process.exit(2);
}
