import { describe, expect, it } from "vitest";
import {
  MANGASHI_HOSTS,
  isMangashiHost,
  isMangashiMangaPageUrl,
  parseMangashiChapterUrl,
  extractMangashiPages,
  extractMangashiEpisodeMeta,
  parseMangashiTitle,
  fetchMangashiChapter,
} from "./mangashiPage";
import { directSourceMode, isDirectSourceSupported } from "./directSource";

// عينة HTML مستمدة حرفيًا من صفحة قارئ حقيقية
// https://manga-shi.org/manga/the-counts-secret-maid/glava-111/
const READER_HTML = `<!DOCTYPE html>
<html lang="ru">
<head><title>Тайная служанка графа 111 глава читать онлайн — Mangashi</title></head>
<body>
<script type="application/ld+json">[{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Главная","item":"https://manga-shi.org/"},{"@type":"ListItem","position":2,"name":"Каталог","item":"https://manga-shi.org/catalog/"},{"@type":"ListItem","position":3,"name":"Тайная служанка графа / The Count's secret maid","item":"https://manga-shi.org/manga/the-counts-secret-maid/"},{"@type":"ListItem","position":4,"name":"Глава 111","item":"https://manga-shi.org/manga/the-counts-secret-maid/glava-111/"}]}]</script>
<img
                        src="/media/chapters/001_TVYvMD7.webp"

                        alt="Страница 1 главы 111"

                        title="Тайная служанка графа — глава 111"

                        class="reader-image w-full h-auto block"

                        fetchpriority="high"
                    >
<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" data-src="/media/chapters/002_WDb62Cm.webp" alt="Страница 2" class="reader-image w-full h-auto block">
<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" data-src="/media/chapters/003_7dveCXz.webp" alt="Страница 3" class="reader-image w-full h-auto block">
</body>
</html>`;

describe("isMangashiHost", () => {
  it("يقبل النطاق بأشكاله ويرفض غيره", () => {
    expect(isMangashiHost("manga-shi.org")).toBe(true);
    expect(isMangashiHost("www.manga-shi.org")).toBe(true);
    expect(isMangashiHost("MANGA-SHI.ORG")).toBe(true);
    expect(isMangashiHost("comix.to")).toBe(false);
    expect(isMangashiHost(null)).toBe(false);
  });

  it("النطاق مسجل في المصادر المباشرة بنمط direct-first", () => {
    expect((MANGASHI_HOSTS as readonly string[]).includes("manga-shi.org")).toBe(true);
    expect(isDirectSourceSupported("manga-shi.org")).toBe(true);
    expect(directSourceMode("manga-shi.org")).toBe("direct-first");
  });
});

describe("parseMangashiChapterUrl", () => {
  it("يقبل رابط الفصل القياسي ويطبعه بلا استعلام أو هاش", () => {
    const url = parseMangashiChapterUrl(
      "https://manga-shi.org/manga/the-counts-secret-maid/glava-111/?utm_source=x#top"
    );
    expect(url).toBe("https://manga-shi.org/manga/the-counts-secret-maid/glava-111/");
  });

  it("يقبل رابط فصل بمجلد (tom-N) وقبل ذي شرطة أخيرة", () => {
    expect(
      parseMangashiChapterUrl("https://www.manga-shi.org/manga/frilanser/tom-1/glava-26")
    ).toBe("https://manga-shi.org/manga/frilanser/tom-1/glava-26");
  });

  it("يقبل الفصول الجزئية بصيغة المسار المزدوجة", () => {
    expect(
      parseMangashiChapterUrl("https://manga-shi.org/manga/take-a-picture-of-me/tom-1/glava-60-5/")
    ).toBe("https://manga-shi.org/manga/take-a-picture-of-me/tom-1/glava-60-5/");
  });

  it("يرفض رابط العمل وحده وروابط النطاقات الأخرى", () => {
    expect(
      parseMangashiChapterUrl("https://manga-shi.org/manga/the-counts-secret-maid/")
    ).toBeNull();
    expect(parseMangashiChapterUrl("https://comix.to/manga/x/glava-1/")).toBeNull();
    expect(parseMangashiChapterUrl("https://manga-shi.org/catalog/")).toBeNull();
    expect(parseMangashiChapterUrl("not a url")).toBeNull();
  });

  it("يكشف رابط العمل وحده لإنتاج رسالة موجهة", () => {
    expect(isMangashiMangaPageUrl("https://manga-shi.org/manga/the-counts-secret-maid/")).toBe(true);
    expect(isMangashiMangaPageUrl("https://manga-shi.org/manga/the-counts-secret-maid/glava-1/")).toBe(false);
    expect(isMangashiMangaPageUrl("https://comix.to/manga/x/")).toBe(false);
  });
});

describe("extractMangashiPages", () => {
  it("يستخرج الصور بترتيبها: src الحقيقي للأولى وdata-src للبقية ويحل النسبية", () => {
    const pages = extractMangashiPages(READER_HTML);
    expect(pages).toEqual([
      "https://manga-shi.org/media/chapters/001_TVYvMD7.webp",
      "https://manga-shi.org/media/chapters/002_WDb62Cm.webp",
      "https://manga-shi.org/media/chapters/003_7dveCXz.webp",
    ]);
  });

  it("يتجاهل علامات GIF المؤجلة والصور الغريبة ويحل المسارات على أصل الرابط المعطى", () => {
    const html = `<img src="data:image/gif;base64,R0lGODlh" data-src="/media/chapters/010_txP1h2g.webp" class="reader-image">
<img src="/media/covers/thumb_x.webp" alt="غلاف عمل آخر">
<img src="https://mc.yandex.ru/watch/103993582" alt="">`;
    const pages = extractMangashiPages(html, "https://manga-shi.org/manga/x/glava-2/");
    expect(pages).toEqual(["https://manga-shi.org/media/chapters/010_txP1h2g.webp"]);
  });

  it("يحل المسارات المطلقة كما هي ويزيل المكرر", () => {
    const html = `<img src="https://manga-shi.org/media/chapters/a.webp" class="reader-image">
<img data-src="https://manga-shi.org/media/chapters/a.webp" class="reader-image">`;
    expect(extractMangashiPages(html)).toEqual([
      "https://manga-shi.org/media/chapters/a.webp",
    ]);
  });

  it("يرجع قائمة فارغة لصفحة بلا قارئ (صفحة عمل)", () => {
    expect(extractMangashiPages("<html><body><p>catalog</p></body></html>")).toEqual([]);
  });
});

describe("extractMangashiEpisodeMeta", () => {
  it("يقرأ اسم العمل والفصل من مسار التنقل (آخر عنصرين)", () => {
    const meta = extractMangashiEpisodeMeta(READER_HTML);
    expect(meta).toEqual({
      mangaTitle: "Тайная служанка графа / The Count's secret maid",
      chapterName: "Глава 111",
    });
  });

  it("يقرأ الفصول الجزئية من مسار فصل حقيقي آخر", () => {
    const html = `<script type="application/ld+json">[{"@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Главная"},{"@type":"ListItem","position":2,"name":"Каталог"},{"@type":"ListItem","position":3,"name":"Сфотографируй меня"},{"@type":"ListItem","position":4,"name":"Глава 60.5"}]}]</script>`;
    expect(extractMangashiEpisodeMeta(html)).toEqual({
      mangaTitle: "Сфотографируй меня",
      chapterName: "Глава 60.5",
    });
  });

  it("يرجع null بلا كتلة مسار تنقل أو كتلة تالفة أو مسار قصير", () => {
    expect(extractMangashiEpisodeMeta("<html></html>")).toBeNull();
    expect(
      extractMangashiEpisodeMeta('<script type="application/ld+json">{"@type":"BreadcrumbList" broken</script>')
    ).toBeNull();
    expect(
      extractMangashiEpisodeMeta(
        '<script type="application/ld+json">[{"@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Главная"}]}]</script>'
      )
    ).toBeNull();
  });
});

describe("parseMangashiTitle", () => {
  it("يفصل العمل عن الفصل من عنوان صفحة حقيقية", () => {
    expect(parseMangashiTitle("Тайная служанка графа 111 глава читать онлайн — Mangashi")).toEqual({
      mangaTitle: "Тайная служанка графа",
      chapterName: "Глава 111",
    });
  });

  it("يعالج الفصول الجزئية بالفاصلة العشرية", () => {
    expect(parseMangashiTitle("Сфотографируй меня 60.5 глава читать онлайн — Mangashi")).toEqual({
      mangaTitle: "Сфотографируй меня",
      chapterName: "Глава 60.5",
    });
  });

  it("يعالج عنوان العمل المنتهي برقم والصيغة العربية للفاصل", () => {
    expect(parseMangashiTitle("Манга 7 60 глава читать онлайн — Mangashi")).toEqual({
      mangaTitle: "Манга 7",
      chapterName: "Глава 60",
    });
  });

  it("يعيد العنوان كما هو حين لا يطابق النمط", () => {
    expect(parseMangashiTitle("Каталог — Mangashi")).toEqual({
      mangaTitle: "Каталог",
      chapterName: "",
    });
  });
});

describe("fetchMangashiChapter", () => {
  it("يرفض رابط العمل برسالة تطلب رابط الفصل دون أي شبكة", async () => {
    const outcome = await fetchMangashiChapter("https://manga-shi.org/manga/the-counts-secret-maid/");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.locked).toBe(false);
      expect(outcome.message).toContain("وليس رابط فصل");
    }
  });

  it("يرفض الروابط غير المفهومة برسالة الصيغة", async () => {
    const outcome = await fetchMangashiChapter("https://manga-shi.org/catalog/");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("glava-");
  });
});
