import type { SuwayomiChapter, SuwayomiManga } from "./suwayomi";

// ============================================================
// محرك البحث الشامل عبر مصادر Suwayomi المثبتة
// — مسار مستقل كليًا عن خط /فصل: يقرأ فقط ولا يعدّل شيئًا.
// ============================================================

export type SearchMatch = {
  sourceId: string;
  sourceName: string;
  lang: string;
  mangaId: number;
  title: string;
  url: string;
  realUrl: string | null;
  thumbnailUrl: string | null;
  score: number;
};

export type SearchFailure = { sourceName: string; message: string };

export type SearchOutcome = {
  matches: SearchMatch[];
  searched: number;
  failed: SearchFailure[];
};

/** واجهة مصغرة للعميل تكتفي بما يحتاجه البحث — تجعل الاختبار بدون سيرفر حقيقي.
 *  المهلة اختيارية: مسار /بحث يمرر مهلة أطول من الافتراضية للمواقع البطيئة. */
export type MangaSearcher = {
  searchSourceManga(sourceId: string, query: string, timeoutMs?: number): Promise<SuwayomiManga[]>;
  fetchMangaAndChapters(mangaId: number, timeoutMs?: number): Promise<SuwayomiChapter[]>;
};

export type SearchableSource = {
  suwayomiSourceId: string;
  name: string;
  lang: string;
};

/**
 * تطبيع النص للبحث: تكبير/تصغير، إزالة التشكيل والتطويل، توحيد الألف
 * والياء والتاء المربوطة، وحذف غير الحروف — عربي وإنجليزي.
 */
export function normalizeForSearch(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u064B-\u0655\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** درجة مطابقة اسم العمل مع نص البحث (0 = لا مطابقة). */
export function matchScore(query: string, title: string): number {
  const queryNormalized = normalizeForSearch(query);
  const titleNormalized = normalizeForSearch(title);
  if (!queryNormalized || !titleNormalized) return 0;
  if (titleNormalized === queryNormalized) return 100;
  if (titleNormalized.startsWith(queryNormalized)) return 85;
  if (titleNormalized.includes(queryNormalized)) return 70;
  const queryWords = queryNormalized.split(" ").filter(Boolean);
  if (!queryWords.length) return 0;
  const titleWords = new Set(titleNormalized.split(" ").filter(Boolean));
  const hits = queryWords.filter(word => titleWords.has(word)).length;
  if (hits === queryWords.length) return 55;
  if (hits * 2 >= queryWords.length && hits > 0) return 35;
  return 0;
}

function toMatch(source: SearchableSource, manga: SuwayomiManga, score: number): SearchMatch {
  return {
    sourceId: source.suwayomiSourceId,
    sourceName: source.name,
    lang: source.lang,
    mangaId: manga.id,
    title: manga.title,
    url: manga.url,
    realUrl: manga.realUrl ?? null,
    thumbnailUrl: manga.thumbnailUrl ?? null,
    score,
  };
}

/**
 * يبحث في كل مصدر على حدة بالتوازي (تزامن محدود) ويجمع أفضل التطابقات،
 * مع مهلة لكل مصدر: المصدر البطيء لا يُفشل البحث كله — يُحصى كمتعثر فقط.
 *
 * محاولتان لا واحدة: المصادر كثيرًا ما تفشل في الموجة الأولى بسبب بطئها
 * أو تقييدها عند اندفاع الطلبات المتوازية عليها، ثم تنجح من محاولة هادئة
 * بعد اكتمال الموجة — لذا المتعثرون يُعادون مرة واحدة بتزامن أقل ومهلة أطول،
 * وما بقي متعثرًا بعدها يُعد فشلًا حقيقيًا ويُرفع في النتيجة.
 */
export async function searchAllSources(
  searcher: MangaSearcher,
  sources: SearchableSource[],
  query: string,
  options?: {
    concurrency?: number;
    timeoutMs?: number;
    /** تزامن محاولة إعادة المصادر المتعثرة — أهدأ من الموجة الأولى. */
    retryConcurrency?: number;
    /** مهلة محاولة الإعادة — أطول من الموجة الأولى لأنها للمواقع البطيئة تحديدًا. */
    retryTimeoutMs?: number;
    topPerSource?: number;
    onProgress?: (done: number, total: number) => Promise<void> | void;
  }
): Promise<SearchOutcome> {
  const concurrency = Math.max(1, Math.min(options?.concurrency ?? 6, 8));
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const retryConcurrency = Math.max(1, Math.min(options?.retryConcurrency ?? 2, 8));
  const retryTimeoutMs = options?.retryTimeoutMs ?? 30_000;
  const topPerSource = Math.max(1, options?.topPerSource ?? 3);
  const matches: SearchMatch[] = [];

  /**
   * موجة بحث واحدة فوق قائمة مصادر. تعيد المتعثرين مع كائن المصدر نفسه
   * (لا الاسم فقط) لتمييز المكررات عند إعادة المحاولة.
   */
  async function runPass(
    list: SearchableSource[],
    passConcurrency: number,
    passTimeoutMs: number,
    withProgress: boolean
  ): Promise<Array<{ source: SearchableSource; message: string }>> {
    const passFailed: Array<{ source: SearchableSource; message: string }> = [];
    let cursor = 0;
    let done = 0;

    async function worker() {
      while (true) {
        const index = cursor++;
        if (index >= list.length) return;
        const source = list[index]!;
        try {
          // المهلة الداخلية تتجاوز مهلة السباق بقليل حتى تكون رسالة المهلة
          // العربية هي ما يُلتقط، لا رسالة إحباط fetch الإنجليزية.
          const found = await Promise.race([
            searcher.searchSourceManga(source.suwayomiSourceId, query, passTimeoutMs + 1_000),
            new Promise<never>((_resolve, reject) =>
              setTimeout(() => reject(new Error("انتهت مهلة هذا الموقع")), passTimeoutMs)
            ),
          ]);
          const ranked = found
            .map(manga => ({ manga, score: matchScore(query, manga.title) }))
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, topPerSource);
          for (const item of ranked) matches.push(toMatch(source, item.manga, item.score));
        } catch (error) {
          passFailed.push({
            source,
            message: error instanceof Error ? error.message : "خطأ غير معروف",
          });
        }
        done += 1;
        if (withProgress && options?.onProgress) {
          try { await options.onProgress(done, list.length); } catch { /* فشل الإشعار لا يُفشل البحث */ }
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(passConcurrency, list.length) }, () => worker()));
    return passFailed;
  }

  const firstPassFailed = await runPass(sources, concurrency, timeoutMs, true);
  let failed = firstPassFailed;
  if (firstPassFailed.length) {
    // الموجة الثانية الهادئة: نفس المصادر المتعثرة بتزامن أقل ومهلة أطول.
    const retryTargets = firstPassFailed.map(item => item.source);
    failed = await runPass(retryTargets, retryConcurrency, retryTimeoutMs, false);
  }

  matches.sort((a, b) => b.score - a.score);
  return {
    matches,
    searched: sources.length,
    failed: failed.map(item => ({ sourceName: item.source.name, message: item.message })),
  };
}

export type AvailabilityRow = {
  match: SearchMatch;
  chapter: { name: string; number: number } | null;
  error: string | null;
};

/** يفحص توفر رقم فصل محدد في كل عمل مطابق، مصدرًا مصدرًا. */
export async function checkChapterAvailability(
  searcher: MangaSearcher,
  matches: SearchMatch[],
  chapterNumber: number,
  options?: { concurrency?: number; timeoutMs?: number; limit?: number }
): Promise<AvailabilityRow[]> {
  const limit = Math.max(1, Math.min(options?.limit ?? 12, matches.length));
  const targets = matches.slice(0, limit);
  const concurrency = Math.max(1, Math.min(options?.concurrency ?? 5, 8));
  const timeoutMs = options?.timeoutMs ?? 25_000;
  const rows: AvailabilityRow[] = new Array(targets.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= targets.length) return;
      const match = targets[index]!;
      try {
        const chapters = await Promise.race([
          searcher.fetchMangaAndChapters(match.mangaId, timeoutMs + 1_000),
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error("انتهت مهلة جلب الفصول")), timeoutMs)
          ),
        ]);
        const hit = chapters.find(chapter =>
          typeof chapter.chapterNumber === "number" &&
          Math.abs(chapter.chapterNumber - chapterNumber) < 0.001
        );
        rows[index] = {
          match,
          chapter: hit
            ? {
                name: hit.name,
                number: hit.chapterNumber!,
              }
            : null,
          error: null,
        };
      } catch (error) {
        rows[index] = {
          match,
          chapter: null,
          error: error instanceof Error ? error.message : "خطأ غير معروف",
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));
  return rows;
}

/**
 * يبني رابط الفصل من بيانات Suwayomi: realUrl للفصل إن وُجد، وإلا رابط العمل
 * الكامل كأساس ومسار الفصل النسبي فوقه — نفس أسلوب تطبيقات القراءة.
 */
export function chapterUrlFromParts(
  manga: Pick<SearchMatch, "url" | "realUrl">,
  chapter: Pick<SuwayomiChapter, "url" | "realUrl">
): string | null {
  if (chapter.realUrl && /^https?:\/\//i.test(chapter.realUrl)) return chapter.realUrl;
  const base = manga.realUrl && /^https?:\/\//i.test(manga.realUrl)
    ? manga.realUrl
    : /^https?:\/\//i.test(manga.url)
      ? manga.url
      : null;
  if (!base || !chapter.url) return null;
  try {
    return new URL(chapter.url, base).toString();
  } catch {
    return null;
  }
}

/** يحوّل نص رقم الفصل (يدعم الأرقام العربية) إلى عدد صحيح/عشري موجب أو null. */
export function parseChapterNumber(input: string | null | undefined): number | null {
  if (!input) return null;
  const normalized = input
    .replace(/[\u0660-\u0669]/g, digit => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, digit => String(digit.charCodeAt(0) - 0x06f0))
    .trim();
  const value = Number(normalized);
  return Number.isFinite(value) && value > 0 ? value : null;
}
