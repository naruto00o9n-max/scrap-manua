import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cookieDisplayName,
  directSourceMode,
  extractGigaViewerEpisode,
  extractReaderImages,
  extractWaMangaEpisodeMeta,
  extractWaMangaPages,
  extractWebtoonsPages,
  isGigaViewerLockedEpisode,
  normalizeCookieHeader,
  parseMangaChapterTitle,
  parseWaMangaTitle,
  parseWebtoonsTitle,
  probeDirectChapterPage,
} from "./directSource";

describe("normalizeCookieHeader", () => {
  it("يقبل الصيغة القياسية name=value كما هي", () => {
    expect(normalizeCookieHeader("wordpress_logged_in_abc123=Rios%7C1788653464%7Ctoken%7Chash")).toBe(
      "wordpress_logged_in_abc123=Rios%7C1788653464%7Ctoken%7Chash"
    );
  });

  it("يحوّل صيغة أدوات المطور «الاسم مسافة القيمة» إلى الصيغة القياسية", () => {
    expect(normalizeCookieHeader("wordpress_logged_in_abc123 Rios%7C1788653464%7Ctoken%7Chash")).toBe(
      "wordpress_logged_in_abc123=Rios%7C1788653464%7Ctoken%7Chash"
    );
  });

  it("يقبل الفصل بمسافة جدولة (Tab) كما في النسخ من نافذة المتصفح", () => {
    expect(normalizeCookieHeader("wordpress_logged_in_abc123\tRios%7Ctoken")).toBe(
      "wordpress_logged_in_abc123=Rios%7Ctoken"
    );
  });

  it("يزيل المسافات الزائدة حول علامة التساوي", () => {
    expect(normalizeCookieHeader("wordpress_logged_in_abc123 = Rios%7Ctoken")).toBe(
      "wordpress_logged_in_abc123=Rios%7Ctoken"
    );
  });

  it("يقبل سطر Cookie كاملًا بعدة أزواج ويرتبها بفواصل موحدة", () => {
    expect(normalizeCookieHeader("wordpress_logged_in_abc123=Rios%7Ctoken; csrftoken=qwerty12")).toBe(
      "wordpress_logged_in_abc123=Rios%7Ctoken; csrftoken=qwerty12"
    );
  });

  it("يقبل خيار Cookie: المنسوخ من تبويب Network", () => {
    expect(normalizeCookieHeader("Cookie: wordpress_logged_in_abc123=Rios%7Ctoken")).toBe(
      "wordpress_logged_in_abc123=Rios%7Ctoken"
    );
  });

  it("يقبل صيغة المسافة داخل سطر متعدد الأزواج", () => {
    expect(normalizeCookieHeader("csrftoken qwerty12; wordpress_logged_in_abc123 Rios%7Ctoken")).toBe(
      "csrftoken=qwerty12; wordpress_logged_in_abc123=Rios%7Ctoken"
    );
  });

  it("يبقي أول = فاصلة فقط عندما تحوي القيمة نفسها =", () => {
    expect(normalizeCookieHeader("session=base64==data")).toBe("session=base64==data");
  });

  it("يزيل المكرر", () => {
    expect(normalizeCookieHeader("a=1; a=1; b=2")).toBe("a=1; b=2");
  });

  it("يرفض الفارغ وأسطر جديدة والنص بلا أزواج", () => {
    expect(normalizeCookieHeader("")).toBeNull();
    expect(normalizeCookieHeader("   ")).toBeNull();
    expect(normalizeCookieHeader("a=1\nb=2")).toBeNull();
    expect(normalizeCookieHeader("مجرد نص بلا أي زوج")).toBeNull();
  });

  it("يرفض قيمة الاسم المحتوية على مسافة", () => {
    expect(normalizeCookieHeader("bad name=value")).toBeNull();
  });
});

describe("extractReaderImages", () => {
  it("يستخرج صور مصدر ts_reader الأول الحامل لصور", () => {
    const html = `<script>ts_reader.run({"sources":[{"source":"s1","images":[]},{"source":"s2","images":["https://site.com/p1.webp","https://site.com/p2.webp"]}]});</script>`;
    expect(extractReaderImages(html)).toEqual(["https://site.com/p1.webp", "https://site.com/p2.webp"]);
  });

  it("يعود بقائمة فارغة عند غياب الصور", () => {
    expect(extractReaderImages("<p>لا شيء</p>")).toEqual([]);
  });
});

describe("parseMangaChapterTitle", () => {
  it("يفصل عنوان العمل عن اسم الفصل", () => {
    expect(parseMangaChapterTitle("Perfection is Everything Chapter 57 – rokari comics")).toEqual({
      mangaTitle: "Perfection is Everything",
      chapterName: "Chapter 57",
    });
  });

  it("يتعامل مع عنوان بلا نمط فصل", () => {
    expect(parseMangaChapterTitle("عمل مجهول – rokari comics")).toEqual({
      mangaTitle: "عمل مجهول",
      chapterName: "",
    });
  });
});

describe("cookieDisplayName", () => {
  it("يعرض اسم الكوكي فقط دون قيمته", () => {
    expect(cookieDisplayName("wordpress_logged_in_abc123=Rios%7Ctoken; other=1")).toBe(
      "wordpress_logged_in_abc123…"
    );
  });
});

// ===== GigaViewer (شونين جامب+) =====

/** عينة مبسطة من كتلة episode-json كما ترد في صفحات shonenjumpplus.com. */
function gigaHtml(dataValue: string): string {
  return `<html><head><title>少年ジャンプ＋</title></head><body><script id='episode-json' type='text/json' data-value='${dataValue}'></script></body></html>`;
}

function gigaProductJson(product: Record<string, unknown>): string {
  return gigaHtml(JSON.stringify({ readableProduct: product }).replace(/"/g, "&quot;"));
}

describe("extractGigaViewerEpisode", () => {
  it("يستخرج صفحات main فقط من بنية الفصل المجاني مع مؤشر التشويش", () => {
    const html = gigaProductJson({
      title: "[第一話]ノイズリング",
      series: { title: "ノイズリング" },
      hasPurchased: false,
      pageStructure: {
        readingDirection: "rtl",
        choJuGiga: "baku",
        startPosition: "latter",
        pages: [
          { type: "cover", src: "https://cdn.example.com/cover" },
          { type: "main", src: "https://cdn.example.com/p1" },
          { type: "main", src: "https://cdn.example.com/p2" },
          { type: "link" },
          { type: "backMatter" },
        ],
      },
    });
    const episode = extractGigaViewerEpisode(html);
    expect(episode).toEqual({
      mangaTitle: "ノイズリング",
      chapterName: "[第一話]ノイズリング",
      pages: [
        "https://cdn.example.com/p1#scramble",
        "https://cdn.example.com/p2#scramble",
      ],
    });
  });

  it("لا يضيف مؤشر التشويش حين لا يكون choJuGiga هو baku", () => {
    const html = gigaProductJson({
      title: "فصل",
      series: { title: "عمل" },
      pageStructure: {
        choJuGiga: "",
        pages: [{ type: "main", src: "https://cdn.example.com/p1" }],
      },
    });
    expect(extractGigaViewerEpisode(html)?.pages).toEqual(["https://cdn.example.com/p1"]);
  });

  it("يرجع null لصفحة بلا كتلة قارئ", () => {
    expect(extractGigaViewerEpisode("<html><body>صفحة عادية</body></html>")).toBeNull();
  });

  it("يتعامل مع كتلة فاسدة بلا انهيار", () => {
    expect(extractGigaViewerEpisode(gigaHtml("{بيانات غير سليمة"))).toBeNull();
  });
});

describe("isGigaViewerLockedEpisode", () => {
  it("يعتبر الفصل المدفوع غير المشترى مقفلًا (بلا pageStructure)", () => {
    const html = gigaProductJson({
      title: "[73話]群青のマグメル",
      hasPurchased: false,
      isPublic: false,
    });
    expect(isGigaViewerLockedEpisode(html)).toBe(true);
  });

  it("يعتبر بنية بلا صفحات main مقفلًا", () => {
    const html = gigaProductJson({
      title: "فصل",
      pageStructure: { choJuGiga: "baku", pages: [{ type: "link" }] },
    });
    expect(isGigaViewerLockedEpisode(html)).toBe(true);
  });

  it("الفصل المجاني الصالح ليس مقفلًا", () => {
    const html = gigaProductJson({
      title: "فصل",
      pageStructure: {
        choJuGiga: "baku",
        pages: [{ type: "main", src: "https://cdn.example.com/p1" }],
      },
    });
    expect(isGigaViewerLockedEpisode(html)).toBe(false);
  });

  it("الصفحة بلا كتلة قارئ ليست «فصل مقفل» — فقط غير معروف", () => {
    expect(isGigaViewerLockedEpisode("<html></html>")).toBe(false);
  });
});

describe("directSourceMode", () => {
  it("rokari يعتمد الجلسة فقط وشونين جامب+ يعتمد المباشر أولًا", () => {
    expect(directSourceMode("rokaricomics.com")).toBe("session-only");
    expect(directSourceMode("shonenjumpplus.com")).toBe("direct-first");
    expect(directSourceMode("www.shonenjumpplus.com")).toBe("direct-first");
    expect(directSourceMode("example.com")).toBeNull();
    expect(directSourceMode(null)).toBeNull();
  });

  it("wamanga.ru يعتمد المباشر أولًا ويدعم النطاق بـ www", () => {
    expect(directSourceMode("wamanga.ru")).toBe("direct-first");
    expect(directSourceMode("www.wamanga.ru")).toBe("direct-first");
  });

  it("WEBTOON يعتمد المباشر أولًا على النطاقين webtoons.com وm.webtoons.com", () => {
    expect(directSourceMode("webtoons.com")).toBe("direct-first");
    expect(directSourceMode("m.webtoons.com")).toBe("direct-first");
    expect(directSourceMode("www.webtoons.com")).toBe("direct-first");
  });
});

describe("extractWaMangaPages", () => {
  const sample = [
    '<img src="https://mc.yandex.ru/watch/1" alt="">',
    '<img src="https://wamanga.ru/app/uploads/A/RklMRS0x==.webp" alt="«одн», глава 59, страница 1.000000000" class="reader-page svelte-tiaqfm auto-scale" crossorigin="anonymous" loading="eager">',
    '<img class="reader-page svelte-tiaqfm" src="https://wamanga.ru/app/uploads/A/RklMRS0y==.webp" alt="«одн», глава 59, страница 2.000000000">',
    '<img alt="غير مرتب" class="reader-page svelte-x" src="https://wamanga.ru/app/uploads/A/RklMRS0z==.webp">',
    '<img src="https://wamanga.ru/app/uploads/A/cover.webp" alt="غلاف" class="cover-page">',
  ].join("\n");

  it("يستخرج صور reader-page فقط وبترتيب ظهورها مهما كان ترتيب الخصائص", () => {
    expect(extractWaMangaPages(sample)).toEqual([
      "https://wamanga.ru/app/uploads/A/RklMRS0x==.webp",
      "https://wamanga.ru/app/uploads/A/RklMRS0y==.webp",
      "https://wamanga.ru/app/uploads/A/RklMRS0z==.webp",
    ]);
  });

  it("يتجاهل الصور ذات الروابط النسبية أو الفارغة ويعود بقائمة فارغة بلا قارئ", () => {
    expect(extractWaMangaPages('<img class="reader-page" src="/app/uploads/x.webp">')).toEqual([]);
    expect(extractWaMangaPages("<div>بلا صور</div>")).toEqual([]);
  });
});

describe("extractWaMangaEpisodeMeta", () => {
  const liveJsonLd = `
  <script type="application/ld+json">[{"@context":"https://schema.org","@type":"ComicIssue","name":"Одноклассник - Глава 59","issueNumber":59,"url":"https://wamanga.ru/manhwa/odnoklassnik/glava-59","inLanguage":"ru","isAccessibleForFree":true,"numberOfPages":10,"isPartOf":{"@type":"ComicSeries","name":"Одноклассник","url":"https://wamanga.ru/manhwa/odnoklassnik"}},{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"WaManga"},{"@type":"ListItem","position":2,"name":"Одноклассник"},{"@type":"ListItem","position":3,"name":"Глава 59"}]}]</script>`;

  it("يقرأ العمل من isPartOf والفصل من آخر عنصر في مسار التنقل وحالة الوصول", () => {
    const meta = extractWaMangaEpisodeMeta(liveJsonLd);
    expect(meta).toEqual({
      mangaTitle: "Одноклассник",
      chapterName: "Глава 59",
      accessibleForFree: true,
    });
  });

  it("يعتبر isAccessibleForFree=false فصلًا مدفوعًا ويسقط إلى اسم ComicIssue عند غياب المسار", () => {
    const meta = extractWaMangaEpisodeMeta(
      '<script type="application/ld+json">{"@type":"ComicIssue","name":"عمل - Глава 7","isAccessibleForFree":false,"isPartOf":{"name":"عمل"}}</script>'
    );
    expect(meta).toEqual({ mangaTitle: "عمل", chapterName: "عمل - Глава 7", accessibleForFree: false });
  });

  it("يرجع null للصفحة بلا JSON-Lد وللكتل التالفة", () => {
    expect(extractWaMangaEpisodeMeta("<html></html>")).toBeNull();
    expect(extractWaMangaEpisodeMeta('<script type="application/ld+json">{تالف</script>')).toBeNull();
  });
});

describe("parseWaMangaTitle", () => {
  it("يفصل العمل عن الفصل من عنوان صفحة WaManga ويرسم حرف الفصل", () => {
    expect(parseWaMangaTitle("Одноклассник — глава 59 читать онлайн | WaManga")).toEqual({
      mangaTitle: "Одноклассник",
      chapterName: "Глава 59",
    });
  });

  it("يتعامل مع الشرطة القصيرة وعناوين بلا نمط فصل", () => {
    expect(parseWaMangaTitle("عمل - глава 3.5 читать онлайн | WaManga")).toEqual({
      mangaTitle: "عمل",
      chapterName: "Глава 3.5",
    });
    expect(parseWaMangaTitle("عمل فقط | WaManga")).toEqual({ mangaTitle: "عمل فقط", chapterName: "" });
  });
});

// ===== WEBTOON (webtoons.com) =====

describe("extractWebtoonsPages", () => {
  const sample = [
    '<img src="https://webtoon-phinf.pstatic.net/banner.jpg?type=q90" alt="banner" class="area">',
    '<img class="_images" src="data:image/gif;base64,R0lGOD" data-url="https://webtoon-phinf.pstatic.net/20260816_214/p1.jpg?type=q90">',
    '<img data-url="https://webtoon-phinf.pstatic.net/20260816_215/p2&amp;v=3.jpg?type=q90" class="wk _images" alt="page 2">',
    '<img class="_images" src="https://webtoon-phinf.pstatic.net/20260816_216/p3.jpg?type=q90">',
  ].join("\n");

  it("يستخرج data-url من صور _images بترتيبها ويفك الكيانات ويسقط إلى src المطلق", () => {
    expect(extractWebtoonsPages(sample)).toEqual([
      "https://webtoon-phinf.pstatic.net/20260816_214/p1.jpg?type=q90",
      "https://webtoon-phinf.pstatic.net/20260816_215/p2&v=3.jpg?type=q90",
      "https://webtoon-phinf.pstatic.net/20260816_216/p3.jpg?type=q90",
    ]);
  });

  it("يتجاهل الروابط النسبية ويعود بقائمة فارغة بلا قارئ", () => {
    expect(extractWebtoonsPages('<img class="_images" data-url="/static/p1.jpg">')).toEqual([]);
    expect(extractWebtoonsPages("<div>بلا صور</div>")).toEqual([]);
  });
});

describe("parseWebtoonsTitle", () => {
  it("يفصل العمل عن الفصل من عنوان الصفحة الحي بترتيبه «الفصل | العمل»", () => {
    expect(parseWebtoonsTitle("Ep. 133 - 151 | Falling In Love With My Ex-fiance's Grandfather")).toEqual({
      mangaTitle: "Falling In Love With My Ex-fiance's Grandfather",
      chapterName: "Ep. 133 - 151",
    });
  });

  it("يتعامل مع لاحقة العلامة العامة وصيغة og:title المزدوجة الترميز", () => {
    expect(parseWebtoonsTitle("Ep. 5 | عمل جميل | WEBTOON")).toEqual({
      mangaTitle: "عمل جميل",
      chapterName: "Ep. 5",
    });
    expect(parseWebtoonsTitle("Falling In Love With My Ex-fiance&amp;#39;s Grandfather - Ep. 133")).toEqual({
      mangaTitle: "Falling In Love With My Ex-fiance's Grandfather",
      chapterName: "Ep. 133",
    });
  });

  it("يعود بالعنوان كما هو عند غياب أي نمط", () => {
    expect(parseWebtoonsTitle("عنوان فقط")).toEqual({ mangaTitle: "عنوان فقط", chapterName: "" });
  });
});

describe("probeDirectChapterPage — السبب المرصود عند عدم الحسم", () => {
  const webtoonsUrl = "https://m.webtoons.com/en/canvas/some-series/ep-1/viewer?title_no=1&episode_no=1";
  const htmlHeaders = { "content-type": "text/html; charset=utf-8" };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("يبين رسالة العطب الشبكي في السبب المرصود", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 1.2.3.4:443");
      })
    );
    const probe = await probeDirectChapterPage(webtoonsUrl);
    expect(probe.mode).toBe("unknown");
    expect(probe.reason).toContain("ECONNREFUSED");
  });

  it("يذكر رمز رفض الموقع في السبب (403 مثلًا)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("forbidden", { status: 403 }))
    );
    const probe = await probeDirectChapterPage(webtoonsUrl);
    expect(probe.mode).toBe("unknown");
    expect(probe.reason).toContain("403");
  });

  it("يفسر صفحة WEBTOON الخالية من الصور بسبب واضح ويرسل كوكي بوابة العمر", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("<html><body>قارئ بلا صور</body></html>", { status: 200, headers: htmlHeaders })
    );
    vi.stubGlobal("fetch", fetchMock);
    const probe = await probeDirectChapterPage(webtoonsUrl);
    expect(probe.mode).toBe("unknown");
    expect(probe.reason).toContain("WEBTOON");
    const init = fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(init?.headers?.cookie).toBe("needAgeVerified=true");
  });

  it("يعيد الفصل المجاني من صفحة WEBTOON كاملة الصور", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          '<html><head><title>Ep. 1 | Some Series</title></head><body>' +
            '<img class="_images" data-url="https://webtoon-phinf.pstatic.net/1.jpg">' +
            '<img class="_images" data-url="https://webtoon-phinf.pstatic.net/2.jpg">' +
            "</body></html>",
          { status: 200, headers: htmlHeaders }
        )
      )
    );
    const probe = await probeDirectChapterPage(webtoonsUrl);
    expect(probe.mode).toBe("free");
    expect(probe.chapter?.pages).toEqual([
      "https://webtoon-phinf.pstatic.net/1.jpg",
      "https://webtoon-phinf.pstatic.net/2.jpg",
    ]);
    expect(probe.chapter?.mangaTitle).toBe("Some Series");
    expect(probe.chapter?.chapterName).toBe("Ep. 1");
  });
});
