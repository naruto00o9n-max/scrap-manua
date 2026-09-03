import { matchScore } from "./sourceSearch";

type GraphQlResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

export type SuwayomiSource = {
  id: string;
  name: string;
  displayName: string;
  homeUrl: string | null;
  lang: string;
  extension: { name: string; pkgName: string; isInstalled: boolean } | null;
};

export type SuwayomiChapter = {
  id: number;
  name: string;
  url: string;
  realUrl: string | null;
  // ملاحظة: لا نطلب releaseDate إطلاقًا — بعض إصدارات Suwayomi لا تعرف هذا
  // الحقل في ChapterType وترفض الاستعلام كله بخطأ FieldUndefined.
  chapterNumber?: number;
  manga: { id: number; title: string; sourceId: string };
};

export type SuwayomiManga = {
  id: number;
  title: string;
  url: string;
  realUrl: string | null;
  thumbnailUrl?: string | null;
  sourceId: string;
};

/** تفاصيل العمل الكاملة كما تعيده صفحة العمل في Suwayomi (وصف/مؤلف/حالة/تصنيفات). */
export type SuwayomiMangaDetails = {
  id: number;
  title: string;
  url: string;
  realUrl: string | null;
  thumbnailUrl: string | null;
  author: string | null;
  artist: string | null;
  description: string | null;
  /** قيمة MangaStatus النصية مثل ONGOING/COMPLETED — قد تكون UNKNOWN. */
  status: string | null;
  genre: string[];
  sourceId: string;
};

function normalizedUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.hostname = parsed.hostname.replace(/^www\./, "");
  // Webtoons serves the same catalog on webtoons.com, www.webtoons.com and
  // m.webtoons.com (the extension stores realUrl on www). Canonicalize them
  // onto one host so URL matching does not miss.
  if (parsed.hostname === "webtoons.com") parsed.hostname = "m.webtoons.com";
  if (parsed.hostname === "comic.naver.com") {
    parsed.searchParams.delete("week");
  } else {
    parsed.search = "";
  }
  return parsed.toString().replace(/\/$/, "");
}

/**
 * يستنتج رابط العمل من رابط الفصل عبر مسح مقاطع المسار من النهاية بحثًا عن
 * «علامة فصل»: إما كلمة الفصل وحدها (…/chapter/157) أو مقطع مركّب يحمل الرقم
 * (chapter-6، ch-12.5، ep-4، أو بمعرف الموقع قبله مثل 11302227-chapter-6
 * بروابط comix.to) — وكل ما قبل هذا المقطع هو مسار العمل.
 * هذا يغطي صيغ الروابط الشائعة بدل قاعدة /chapter/ الوحيدة التي كانت تُفشل
 * سحب مواقع كثيرة (comix.to وغيرها) بخطأ «لم يعثر Suwayomi على الفصل».
 */
export function mangaUrlFromChapterUrl(chapterUrl: string): string | null {
  const parsed = new URL(chapterUrl);
  const host = parsed.hostname.replace(/^www\./, "");
  if (host === "comic.naver.com" && parsed.pathname === "/webtoon/detail") {
    const titleId = parsed.searchParams.get("titleId");
    return titleId ? `${parsed.origin}/webtoon/list?titleId=${encodeURIComponent(titleId)}` : null;
  }
  if ((host === "m.webtoons.com" || host === "webtoons.com") && /\/viewer\/?$/i.test(parsed.pathname)) {
    const titleNo = parsed.searchParams.get("title_no");
    if (!titleNo) return null;
    const listPath = parsed.pathname.replace(/\/ep-[^/]+\/viewer\/?$/i, "/list");
    return `${parsed.origin}${listPath}?title_no=${encodeURIComponent(titleNo)}`;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (isChapterMarkerSegment(segments[index]!)) {
      const mangaSegments = segments.slice(0, index);
      if (!mangaSegments.length) return null;
      return `${parsed.origin}/${mangaSegments.join("/")}`;
    }
  }
  return null;
}

/** هل هذا المقطع يوصف بأنه علامة فصل في مسار رابط؟ */
function isChapterMarkerSegment(segment: string): boolean {
  const value = segment.toLowerCase();
  // كلمة الفصل وحدها: الرقم في المقطع التالي (…/chapter/157)
  if (/^(chapter|ch|episode|ep)$/.test(value)) return true;
  // مقطع مركّب يحمل الرقم داخل نفس المقطع، ومعرّف الموقع مسموح قبله
  // (chapter-6، ch-12.5، ep-4، 11302227-chapter-6)
  return /^(?:\d+-)?(?:chapter|ch|episode|ep)[-_.]?\d+(?:\.\d+)?$/.test(value);
}

function numberFromDigits(input: string): number | null {
  const normalized = input
    .replace(/[\u0660-\u0669]/g, digit => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, digit => String(digit.charCodeAt(0) - 0x06f0));
  const value = Number(normalized);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * يستخرج رقم الفصل من رابطه إن وُجد — من علامة الفصل نفسها:
 * …/chapter/157 → 157، …/11302227-chapter-6 → 6، …/ch-12.5 → 12.5.
 * يُستخدم كتحقق ثانٍ عند تعذر مطابقة الرابط حرفيًا ضمن فصول العمل.
 */
export function chapterNumberFromUrl(chapterUrl: string): number | null {
  let segments: string[];
  try {
    segments = new URL(chapterUrl).pathname.split("/").filter(Boolean);
  } catch {
    return null;
  }
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const value = segments[index]!.toLowerCase();
    const compound = value.match(/^(?:\d+-)?(?:chapter|ch|episode|ep)[-_.](\d+(?:\.\d+)?)$/);
    if (compound?.[1]) return numberFromDigits(compound[1]);
    if (/^(chapter|ch|episode|ep)$/.test(value)) {
      const next = segments[index + 1];
      if (!next) return null;
      return numberFromDigits(next.split(/[^0-9.]/)[0] ?? "");
    }
  }
  return null;
}

export async function naverTitleFromChapterUrl(chapterUrl: string): Promise<string | null> {
  const parsed = new URL(chapterUrl);
  if (parsed.hostname.replace(/^www\./, "") !== "comic.naver.com" || parsed.pathname !== "/webtoon/detail") return null;
  const response = await fetch(parsed, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return null;
  const html = await response.text();
  const titleTag = html.match(/<title[^>]*>\s*([^<]+?)\s*<\/title>/i)?.[1];
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1]
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)?.[1];
  const title = ogTitle || titleTag?.split(/\s*\|\s*|\s*::\s*/)[0];
  return title?.replace(/&amp;/g, "&").replace(/&#39;/g, "'").trim() || null;
}

export function sourceSearchQueryFromChapterUrl(chapterUrl: string): string | null {
  const mangaUrl = mangaUrlFromChapterUrl(chapterUrl);
  if (!mangaUrl) return null;
  const segments = new URL(mangaUrl).pathname
    .split("/")
    .filter(Boolean)
    .filter(segment => !/^(list|detail|viewer|episode|title|read|series|manga|comic|comics)$/i.test(segment));
  const slug = segments.at(-1);
  if (!slug) return null;
  return slug
    .replace(/-[a-f0-9]{6,}$/i, "")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim() || null;
}

/**
 * صيغ بحث بديلة لاستعلام العمل: الاستعلام الأساسي ثم نفسه دون أول كلمة إذا
 * كانت تبدو معرّف موقع قصيرًا (مثل «501vk the top …» في comix.to) — تكرار
 * المعرّف في نص البحث يُفشل البحث عند بعض المواقع حتى لو كان العمل موجودًا.
 */
export function searchQueryVariants(query: string | null): string[] {
  if (!query) return [];
  const variants = [query];
  const words = query.split(" ").filter(Boolean);
  if (words.length >= 4 && words[0]!.length <= 8 && /^[\da-z]+$/i.test(words[0]!)) {
    const rest = words.slice(1).join(" ");
    if (!variants.includes(rest)) variants.push(rest);
  }
  return variants;
}

function absoluteUrl(value: string, baseUrl: string): string {
  return new URL(value, baseUrl).toString();
}

export function resolveSuwayomiPageUrl(rawPageUrl: string, suwayomiBaseUrl: string): string {
  return new URL(rawPageUrl, suwayomiBaseUrl).toString();
}

export class SuwayomiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuwayomiError";
  }
}

export class SuwayomiClient {
  private readonly endpoint: string;

  constructor(baseUrl: string, private readonly token = "") {
    if (!baseUrl) throw new SuwayomiError("لم يُضبط عنوان Suwayomi Server.");
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:") {
      throw new SuwayomiError("يجب أن يستخدم اتصال Suwayomi بروتوكول HTTPS.");
    }
    this.endpoint = new URL("/api/graphql", parsed).toString();
  }

  private async request<T>(query: string, variables?: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new SuwayomiError(`تعذر الوصول إلى Suwayomi (${response.status}).`);
    }

    const body = (await response.json()) as GraphQlResponse<T>;
    if (body.errors?.length) {
      throw new SuwayomiError(body.errors.map(error => error.message ?? "خطأ GraphQL").join("؛ "));
    }
    if (!body.data) throw new SuwayomiError("استجاب Suwayomi دون بيانات.");
    return body.data;
  }

  async healthcheck(): Promise<void> {
    await this.request<{ __typename: string }>("{ __typename }");
  }

  async listInstalledSources(): Promise<SuwayomiSource[]> {
    const result = await this.request<{ sources: { nodes: SuwayomiSource[] } }>(
      "{ sources(first: 100) { nodes { id name displayName homeUrl lang extension { name pkgName isInstalled } } } }",
    );
    return result.sources.nodes.filter(source => source.extension?.isInstalled === true);
  }

  async findChapterByUrl(chapterUrl: string): Promise<SuwayomiChapter | null> {
    const fragment = "id name url realUrl manga { id title sourceId }";
    const byRealUrl = await this.request<{ chapters: { nodes: SuwayomiChapter[] } }>(
      `query FindChapter($url: String!) { chapters(condition: { realUrl: $url }, first: 1) { nodes { ${fragment} } } }`,
      { url: chapterUrl },
    );
    if (byRealUrl.chapters.nodes[0]) return byRealUrl.chapters.nodes[0];

    const byUrl = await this.request<{ chapters: { nodes: SuwayomiChapter[] } }>(
      `query FindChapter($url: String!) { chapters(condition: { url: $url }, first: 1) { nodes { ${fragment} } } }`,
      { url: chapterUrl },
    );
    return byUrl.chapters.nodes[0] ?? null;
  }

  private async findMangaByUrl(mangaUrl: string): Promise<SuwayomiManga | null> {
    const parsed = new URL(mangaUrl);
    const relativeUrl = `${parsed.pathname}${parsed.search}`;
    const result = await this.request<{ mangas: { nodes: SuwayomiManga[] } }>(
      "query FindMangaByUrl($url: String!) { mangas(condition: { url: $url }, first: 1) { nodes { id title url realUrl sourceId } } }",
      { url: relativeUrl },
    );
    return result.mangas.nodes[0] ?? null;
  }

  /**
   * بحث حي داخل الموقع عبر Suwayomi — mutation ينتظر اجابة الموقع نفسه،
   * والمهلة الافتراضية 10s أضيق من اللازم لكثير من المواقع البطيئة؛
   * مسار /بحث يمرر مهلة أطول صراحة ليتناسب مع مهلة السباق الخارجية.
   */
  async searchSourceManga(sourceId: string, query: string, timeoutMs = 10_000): Promise<SuwayomiManga[]> {
    const result = await this.request<{ fetchSourceManga: { mangas: SuwayomiManga[] } }>(
      "mutation FetchSourceManga($input: FetchSourceMangaInput!) { fetchSourceManga(input: $input) { mangas { id title url realUrl thumbnailUrl sourceId } } }",
      { input: { source: sourceId, type: "SEARCH", query, page: 1, filters: [] } },
      timeoutMs,
    );
    return result.fetchSourceManga.mangas;
  }

  async fetchMangaAndChapters(mangaId: number, timeoutMs = 10_000): Promise<SuwayomiChapter[]> {
    const result = await this.request<{ fetchMangaAndChapters: { chapters: SuwayomiChapter[] } }>(
      "mutation FetchMangaAndChapters($input: FetchMangaAndChaptersInput!) { fetchMangaAndChapters(input: $input) { chapters { id name url realUrl chapterNumber manga { id title sourceId } } } }",
      { input: { id: mangaId, fetchManga: true, fetchChapters: true } },
      timeoutMs,
    );
    return result.fetchMangaAndChapters.chapters;
  }

  /**
   * يجلب تفاصيل العمل الكاملة (وصف/مؤلف/حالة/تصنيفات/غلاف) من Suwayomi —
   * نفس طلب صفحة العمل الذي تستخدمه واجهة الويب. فشل هذا الطلب لا يقتل
   * عرض الفصول أبديًا، لذا يتوقع المستدعي أن يعالج null/الاستثناء برفق.
   */
  async fetchMangaDetails(mangaId: number): Promise<SuwayomiMangaDetails> {
    const result = await this.request<{ fetchMangaDetails: { manga: SuwayomiMangaDetails } }>(
      `mutation FetchMangaDetails($input: FetchMangaDetailsInput!) { fetchMangaDetails(input: $input) { manga { id title url realUrl thumbnailUrl author artist description status genre sourceId } } }`,
      { input: { id: mangaId } },
      20_000,
    );
    return result.fetchMangaDetails.manga;
  }

  /**
   * يعثر على الفصل من رابطه داخل مصدر محدد. مساران: تطابق حرفي في فهرس
   * Suwayomi أولًا، ثم استنتاج رابط العمل وبحث حي في الموقع ومطابقة الفصل
   * بالرابط ثم برقمه. عند التعذر يُلقي خطأ Suwayomi برسالة عربية تشرح السبب
   * الفعلي (لم يُعثر على العمل؟ الفصل غير مفهرس؟ الإضافة متعثرة؟) بدل رمز
   * null صامت — بطاقة الفشل في Discord تعرض هذا السبب للطالب.
   */
  async findOrFetchChapterFromSource(sourceId: string, chapterUrl: string): Promise<SuwayomiChapter> {
    const indexedChapter = await this.findChapterByUrl(chapterUrl);
    if (indexedChapter) return indexedChapter;

    const mangaUrl = mangaUrlFromChapterUrl(chapterUrl);
    const parsedChapterUrl = new URL(chapterUrl);
    const baseSearchQuery = sourceSearchQueryFromChapterUrl(chapterUrl);
    // Naver chapter URLs carry no readable slug, so derive the series title
    // from the chapter page itself before searching the source.
    const isNaver = parsedChapterUrl.hostname.replace(/^www\./, "") === "comic.naver.com";
    const derivedQuery = isNaver ? await naverTitleFromChapterUrl(chapterUrl) : baseSearchQuery;
    if (!mangaUrl && !derivedQuery) {
      throw new SuwayomiError(
        "تعذر استنتاج رابط العمل من رابط الفصل — بنية هذا الرابط غير مدعومة بعد."
      );
    }

    const targetMangaUrl = mangaUrl ? normalizedUrl(mangaUrl) : null;
    const matchManga = (candidates: SuwayomiManga[], queries: string[]): SuwayomiManga | undefined => {
      const byUrl = targetMangaUrl
        ? candidates.find(candidate => {
            const candidateUrl = absoluteUrl(candidate.realUrl || candidate.url, mangaUrl!);
            try { return normalizedUrl(candidateUrl) === targetMangaUrl; } catch { return false; }
          })
        : undefined;
      if (byUrl) return byUrl;
      // مطابقة بالاسم: تطابق تام أو درجة قوية (≥75) مع أي صيغة من صيغ البحث.
      return candidates.find(candidate =>
        queries.some(query => matchScore(query, candidate.title) >= 75)
      );
    };

    const queries = searchQueryVariants(derivedQuery);
    let manga: SuwayomiManga | undefined;
    let searchedAny = false;
    for (const query of queries) {
      const directManga = mangaUrl ? await this.findMangaByUrl(mangaUrl) : null;
      if (directManga) {
        manga = directManga;
        break;
      }
      if (!query) continue;
      searchedAny = true;
      const candidates = await this.searchSourceManga(sourceId, query);
      manga = matchManga(candidates, queries);
      if (manga) break;
      // Webtoons.com search is punctuation-insensitive on its side, so the raw
      // slug (which drops apostrophes) can miss the series. Retry with
      // progressively shorter prefixes of the query words.
      const words = query.split(" ").filter(Boolean);
      for (const length of [Math.min(4, words.length), Math.min(3, words.length)]) {
        if (length < 3) break;
        const shortened = words.slice(0, length).join(" ");
        if (shortened === query) continue;
        const retry = await this.searchSourceManga(sourceId, shortened);
        manga = matchManga(retry, queries);
        if (manga) break;
      }
      if (manga) break;
    }
    if (!manga) {
      if (!searchedAny) {
        throw new SuwayomiError(
          "لم أعثر على العمل في الخادم بهذا الرابط ولم أمكن البحث عنه في الموقع — تأكد من أن الإضافة تعمل."
        );
      }
      throw new SuwayomiError(
        `لم أعثر على العمل في الموقع عبر البحث${derivedQuery ? ` بـ «${derivedQuery}»` : ""} — قد تكون الإضافة متعثرة أو اسم العمل مكتوبًا بشكل مختلف. جرّب /بحث أولًا.`
      );
    }

    const chapters = await this.fetchMangaAndChapters(manga.id);
    const targetChapterUrl = normalizedUrl(chapterUrl);
    const byUrl = chapters.find(chapter => {
      const candidateUrl = absoluteUrl(chapter.realUrl || chapter.url, chapterUrl);
      try { return normalizedUrl(candidateUrl) === targetChapterUrl; } catch { return false; }
    });
    if (byUrl) return byUrl;

    // مطابقة برقم الفصل: بعض المواقع تؤرشف روابط الفصول بصيغة مختلفة عن
    // رابطها العام، فيفشل التطابق الحرفي وينجح التطابق بالرقم داخل العمل.
    const urlChapterNumber = chapterNumberFromUrl(chapterUrl);
    if (urlChapterNumber !== null) {
      const byNumber = chapters.find(
        chapter => typeof chapter.chapterNumber === "number" && Math.abs(chapter.chapterNumber - urlChapterNumber) < 0.001
      );
      if (byNumber) return byNumber;
      throw new SuwayomiError(
        `وُجد العمل «${manga.title}» لكن الفصل ${urlChapterNumber} غير موجود بين فصوله المفهرسة (${chapters.length}) — افتح العمل في الخادم لتحديث فصوله ثم أعد المحاولة.`
      );
    }
    throw new SuwayomiError(
      `وُجد العمل «${manga.title}» لكن تعذر مطابقة الفصل بهذا الرابط ضمن فصوله المفهرسة.`
    );
  }

  async fetchChapterPages(chapterId: number): Promise<{ chapter: SuwayomiChapter; pages: string[] }> {
    const result = await this.request<{ fetchChapterPages: { chapter: SuwayomiChapter; pages: string[] } }>(
      "mutation FetchChapterPages($input: FetchChapterPagesInput!) { fetchChapterPages(input: $input) { chapter { id name url realUrl manga { id title sourceId } } pages } }",
      { input: { chapterId } },
      120_000,
    );
    return {
      ...result.fetchChapterPages,
      pages: result.fetchChapterPages.pages.map(page => resolveSuwayomiPageUrl(page, this.endpoint)),
    };
  }
}
