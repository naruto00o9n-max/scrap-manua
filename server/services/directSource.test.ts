import { describe, expect, it } from "vitest";
import {
  cookieDisplayName,
  directSourceMode,
  extractGigaViewerEpisode,
  extractReaderImages,
  isGigaViewerLockedEpisode,
  normalizeCookieHeader,
  parseMangaChapterTitle,
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
});
