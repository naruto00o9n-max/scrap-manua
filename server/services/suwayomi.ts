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
  parsed.search = "";
  parsed.hash = "";
  parsed.hostname = parsed.hostname.replace(/^www\./, "");
  return parsed.toString().replace(/\/$/, "");
}

export function mangaUrlFromChapterUrl(chapterUrl: string): string | null {
  const parsed = new URL(chapterUrl);
  const match = parsed.pathname.match(/^(.*)\/chapter\/[^/]+\/?$/i);
  if (!match?.[1]) return null;
  return `${parsed.origin}${match[1]}`;
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

  private async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(10_000),
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
    return result.sources.nodes;
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
    const searchQuery = sourceSearchQueryFromChapterUrl(chapterUrl);
    if (!mangaUrl || !searchQuery) return null;

    const mangaCandidates = await this.searchSourceManga(sourceId, searchQuery);
    const targetMangaUrl = normalizedUrl(mangaUrl);
    const manga = mangaCandidates.find(candidate => {
      const candidateUrl = candidate.realUrl || candidate.url;
      try { return normalizedUrl(candidateUrl) === targetMangaUrl; } catch { return false; }
    }) ?? mangaCandidates.find(candidate => normalizedTitle(candidate.title) === normalizedTitle(searchQuery));
    if (!manga) return null;

    const chapters = await this.fetchMangaAndChapters(manga.id);
    const targetChapterUrl = normalizedUrl(chapterUrl);
    return chapters.find(chapter => {
      const candidateUrl = chapter.realUrl || chapter.url;
      try { return normalizedUrl(candidateUrl) === targetChapterUrl; } catch { return false; }
    }) ?? null;
  }

  async fetchChapterPages(chapterId: number): Promise<{ chapter: SuwayomiChapter; pages: string[] }> {
    const result = await this.request<{ fetchChapterPages: { chapter: SuwayomiChapter; pages: string[] } }>(
      "mutation FetchChapterPages($input: FetchChapterPagesInput!) { fetchChapterPages(input: $input) { chapter { id name url realUrl manga { id title sourceId } } pages } }",
      { input: { chapterId } },
    );
    return {
      ...result.fetchChapterPages,
      pages: result.fetchChapterPages.pages.map(page => resolveSuwayomiPageUrl(page, this.endpoint)),
    };
  }
}
