import { listSources, saveSource } from "../server/db";

const existing = (await listSources()).find(source => source.hostname === "asurascans.com");
const source = await saveSource({
  id: existing?.id,
  name: "Asura Scans (EN)",
  hostname: "asurascans.com",
  baseUrl: "https://asurascans.com",
  suwayomiSourceId: "6247824327199706550",
  extensionName: "Asura Scans",
  extensionPackage: "eu.kanade.tachiyomi.extension.en.asurascans",
  status: "active",
  allowDirectChapterLookup: true,
  notes: "اعتماد الاختبار بناءً على إقرار المالك بوجود موافقة رسمية. يتحقق البوت من الإضافة المثبتة قبل كل طلب.",
});

console.log(`Authorized source ${source.name} (${source.hostname}) with id ${source.id}.`);
process.exit(0);
