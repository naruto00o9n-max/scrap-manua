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

  async fetchChapterPages(chapterId: number): Promise<{ chapter: SuwayomiChapter; pages: string[] }> {
    const result = await this.request<{ fetchChapterPages: { chapter: SuwayomiChapter; pages: string[] } }>(
      "mutation FetchChapterPages($input: FetchChapterPagesInput!) { fetchChapterPages(input: $input) { chapter { id name url realUrl manga { id title sourceId } } pages } }",
      { input: { chapterId } },
    );
    return result.fetchChapterPages;
  }
}
