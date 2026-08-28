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
  manga: { id: number; title: string; sourceId: string };
};

export type SuwayomiManga = {
  id: number;
  title: string;
  url: string;
  realUrl: string | null;
  sourceId: string;
};

function normalizedUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.hostname = parsed.hostname.replace(/^www\./, "");
  if (parsed.hostname === "comic.naver.com") {
    parsed.searchParams.delete("week");
  } else {
    parsed.search = "";
  }
  return parsed.toString().replace(/\/$/, "");
}

export function mangaUrlFromChapterUrl(chapterUrl: string): string | null {
  const parsed = new URL(chapterUrl);
  if (parsed.hostname.replace(/^www\./, "") === "comic.naver.com" && parsed.pathname === "/webtoon/detail") {
    const titleId = parsed.searchParams.get("titleId");
    return titleId ? `${parsed.origin}/webtoon/list?titleId=${encodeURIComponent(titleId)}` : null;
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
  const slug = new URL(mangaUrl).pathname.split("/").filter(Boolean).at(-1);
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

  private async searchSourceManga(sourceId: string, query: string): Promise<SuwayomiManga[]> {
    const result = await this.request<{ fetchSourceManga: { mangas: SuwayomiManga[] } }>(
      "mutation FetchSourceManga($input: FetchSourceMangaInput!) { fetchSourceManga(input: $input) { mangas { id title url realUrl sourceId } } }",
      { input: { source: sourceId, type: "SEARCH", query, page: 1, filters: [] } },
    );
    return result.fetchSourceManga.mangas;
  }

  private async fetchMangaAndChapters(mangaId: number): Promise<SuwayomiChapter[]> {
    const result = await this.request<{ fetchMangaAndChapters: { chapters: SuwayomiChapter[] } }>(
      "mutation FetchMangaAndChapters($input: FetchMangaAndChaptersInput!) { fetchMangaAndChapters(input: $input) { chapters { id name url realUrl manga { id title sourceId } } } }",
      { input: { id: mangaId, fetchManga: true, fetchChapters: true } },
    );
    return result.fetchMangaAndChapters.chapters;
  }

  async findOrFetchChapterFromSource(sourceId: string, chapterUrl: string): Promise<SuwayomiChapter | null> {
    const indexedChapter = await this.findChapterByUrl(chapterUrl);
    if (indexedChapter) return indexedChapter;

    const mangaUrl = mangaUrlFromChapterUrl(chapterUrl);
    const parsedChapterUrl = new URL(chapterUrl);
    const baseSearchQuery = sourceSearchQueryFromChapterUrl(chapterUrl);
    const searchQuery = baseSearchQuery === "list" && parsedChapterUrl.hostname.replace(/^www\\./, "") === "comic.naver.com"
      ? await naverTitleFromChapterUrl(chapterUrl)
      : baseSearchQuery;
    if (!mangaUrl) return null;

    const directManga = await this.findMangaByUrl(mangaUrl);
    const mangaCandidates = directManga ? [directManga] : searchQuery ? await this.searchSourceManga(sourceId, searchQuery) : [];
    const targetMangaUrl = normalizedUrl(mangaUrl);
    const mangaByUrl = mangaCandidates.find(candidate => {
      const candidateUrl = absoluteUrl(candidate.realUrl || candidate.url, mangaUrl);
      try { return normalizedUrl(candidateUrl) === targetMangaUrl; } catch { return false; }
    });
    const mangaByTitle = searchQuery
      ? mangaCandidates.find(candidate => normalizedTitle(candidate.title) === normalizedTitle(searchQuery))
      : undefined;
    const manga = directManga ?? mangaByUrl ?? mangaByTitle;
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
