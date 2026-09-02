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
  const match = parsed.pathname.match(/^(.*)\/chapter\/[^/]+\/?$/i);
  if (!match?.[1]) return null;
  return `${parsed.origin}${match[1]}`;
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
    .filter(segment => !/^(list|detail|viewer|episode)$/i.test(segment));
  const slug = segments.at(-1);
  if (!slug) return null;
  return slug
    .replace(/-[a-f0-9]{6,}$/i, "")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim() || null;
}

function normalizedTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
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

  async findOrFetchChapterFromSource(sourceId: string, chapterUrl: string): Promise<SuwayomiChapter | null> {
    const indexedChapter = await this.findChapterByUrl(chapterUrl);
    if (indexedChapter) return indexedChapter;

    const mangaUrl = mangaUrlFromChapterUrl(chapterUrl);
    const parsedChapterUrl = new URL(chapterUrl);
    const baseSearchQuery = sourceSearchQueryFromChapterUrl(chapterUrl);
    // Naver chapter URLs carry no readable slug, so derive the series title
    // from the chapter page itself before searching the source.
    const isNaver = parsedChapterUrl.hostname.replace(/^www\./, "") === "comic.naver.com";
    const searchQuery = isNaver ? await naverTitleFromChapterUrl(chapterUrl) : baseSearchQuery;
    if (!mangaUrl) return null;

    const targetMangaUrl = normalizedUrl(mangaUrl);
    const matchManga = (candidates: SuwayomiManga[]): SuwayomiManga | undefined => {
      const byUrl = candidates.find(candidate => {
        const candidateUrl = absoluteUrl(candidate.realUrl || candidate.url, mangaUrl);
        try { return normalizedUrl(candidateUrl) === targetMangaUrl; } catch { return false; }
      });
      if (byUrl) return byUrl;
      return searchQuery
        ? candidates.find(candidate => normalizedTitle(candidate.title) === normalizedTitle(searchQuery))
        : undefined;
    };

    const directManga = await this.findMangaByUrl(mangaUrl);
    const mangaCandidates = directManga ? [directManga] : searchQuery ? await this.searchSourceManga(sourceId, searchQuery) : [];
    let manga = directManga ?? matchManga(mangaCandidates);

    // Webtoons.com search is punctuation-insensitive on its side, so the raw
    // slug (which drops apostrophes) can miss the series. Retry with
    // progressively shorter prefixes of the slug words.
    if (!manga && !isNaver && searchQuery) {
      const words = searchQuery.split(" ").filter(Boolean);
      for (const length of [Math.min(6, words.length), Math.min(4, words.length), Math.min(3, words.length)]) {
        if (length < 3) break;
        const shortened = words.slice(0, length).join(" ");
        if (shortened === searchQuery) continue;
        const retry = await this.searchSourceManga(sourceId, shortened);
        manga = matchManga(retry);
        if (manga) break;
      }
    }
    if (!manga) return null;

    const chapters = await this.fetchMangaAndChapters(manga.id);
    const targetChapterUrl = normalizedUrl(chapterUrl);
    return chapters.find(chapter => {
      const candidateUrl = absoluteUrl(chapter.realUrl || chapter.url, chapterUrl);
      try { return normalizedUrl(candidateUrl) === targetChapterUrl; } catch { return false; }
    }) ?? null;
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
