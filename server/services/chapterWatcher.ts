// ============================================================
// مراقب الفصول الجديدة — إعلانات تلقائية من مكتبة Suwayomi
// ============================================================
// المالك يضيف مانوهات مكتبته في Suwayomi من مواقع مختلفة (كلها مصادر
// مثبتة). هذا المراقب يلف على أعمال المكتبة دوريًا، يسحب فهرس فصول كل
// عمل حيًا من موقعه عبر Suwayomi، ويقارن أعلى ترتيب فصل مرصود بحالته
// المحفوظة: أي فصل أعلى يُعلن فورًا في قناة ديسكورد — فوقه سطر الفصل
// (صورة GIF) ثم بطاقة الإعلان.
//
// • الدورة الأولى لأي عمل «أساس» فقط: تُحفظ حالته دون إعلان كي لا يغرق
//   الإعلان الأول بالمكتبة كلها.
// • الفصول المدفوعة تظهر في فهارس المواقع غالبًا (أسماءها فقط) فتُعلن
//   عاديًا، وسحبها لاحقًا يمر عبر جلسات المواقع الموثقة من لوحة التحكم.
// • إعدادات المراقب في appSettings، وحالة كل عمل في مجموعة watchedManga.
// • الإرسال يتم عبر عميل البوت في discordBot (استيراد حي لكسر الدورة).
// ============================================================

import { ENV } from "../_core/env";
import {
  deleteWatchedMangaState,
  getSetting,
  listSources,
  listWatchedMangaStates,
  saveWatchedMangaState,
  setSetting,
  type WatchedMangaState,
} from "../db";
import { getUsableSuwayomiToken } from "./settings";
import { SuwayomiClient, type SuwayomiWatchedChapter } from "./suwayomi";

/** مفتاح إعدادات المراقب في appSettings. */
export const CHAPTER_WATCHER_SETTINGS_KEY = "chapter_watcher_config";

/** سطر الفصل فوق كل إعلان — صورة GIF يرسلها البوت كرسالة مستقلة. */
export const DEFAULT_DIVIDER_GIF_URL = "https://iili.io/n3p13R1.gif";

export type ChapterWatcherConfig = {
  enabled: boolean;
  /** قناة الإعلانات — معرّف قناة نصية في سيرفر المالك. */
  channelId: string;
  /** فاصل الدورة بالدقائق — أدنى قيمة دقيقتان. */
  intervalMinutes: number;
  /** سطر الفصل (GIF) فوق الإعلان — قابل للتغيير من اللوحة. */
  dividerGifUrl: string;
  /** عنوان بطاقة الإعلان — يقبل {manga} و{chapter} و{source} و{link}. */
  titleTemplate: string;
  /** نص بطاقة الإعلان — يقبل المتغيرات نفسها. */
  descriptionTemplate: string;
};

export const DEFAULT_CHAPTER_WATCHER_CONFIG: ChapterWatcherConfig = {
  enabled: false,
  channelId: "",
  intervalMinutes: 5,
  dividerGifUrl: DEFAULT_DIVIDER_GIF_URL,
  titleTemplate: "🔔 فصل جديد من «{manga}»",
  descriptionTemplate: "**{chapter}**\n\nالمصدر: {source}\n[افتح الفصل في الموقع]({link})",
};

export const CHAPTER_WATCHER_INTERVAL_MIN = 2;
export const CHAPTER_WATCHER_INTERVAL_MAX = 1440;

/** أقصى عدد فصول يُعلن عنها لعمل واحد في الدورة الواحدة (حماية من إغراق القناة). */
export const MAX_ANNOUNCE_PER_MANGA = 5;

/** يطبّع الإعدادات: قيم ناقصة من الافتراضي، أرقام خارج المدى تُرجع لحدّه. */
export function normalizeChapterWatcherConfig(
  input: Partial<ChapterWatcherConfig> | null | undefined
): ChapterWatcherConfig {
  const raw = input ?? {};
  const interval = Number(raw.intervalMinutes);
  const clamp = (value: number) =>
    Math.min(CHAPTER_WATCHER_INTERVAL_MAX, Math.max(CHAPTER_WATCHER_INTERVAL_MIN, Math.round(value)));
  return {
    enabled: raw.enabled === true,
    channelId: typeof raw.channelId === "string" ? raw.channelId.trim().replace(/\D/g, "").slice(0, 25) : "",
    intervalMinutes: Number.isFinite(interval) ? clamp(interval) : DEFAULT_CHAPTER_WATCHER_CONFIG.intervalMinutes,
    dividerGifUrl:
      typeof raw.dividerGifUrl === "string" && /^https?:\/\//i.test(raw.dividerGifUrl.trim())
        ? raw.dividerGifUrl.trim().slice(0, 500)
        : DEFAULT_DIVIDER_GIF_URL,
    titleTemplate:
      typeof raw.titleTemplate === "string" && raw.titleTemplate.trim()
        ? raw.titleTemplate.trim().slice(0, 250)
        : DEFAULT_CHAPTER_WATCHER_CONFIG.titleTemplate,
    descriptionTemplate:
      typeof raw.descriptionTemplate === "string" && raw.descriptionTemplate.trim()
        ? raw.descriptionTemplate.trim().slice(0, 1500)
        : DEFAULT_CHAPTER_WATCHER_CONFIG.descriptionTemplate,
  };
}

export async function loadChapterWatcherConfig(): Promise<ChapterWatcherConfig> {
  const raw = await getSetting(CHAPTER_WATCHER_SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_CHAPTER_WATCHER_CONFIG };
  try {
    return normalizeChapterWatcherConfig(JSON.parse(raw) as Partial<ChapterWatcherConfig>);
  } catch {
    return { ...DEFAULT_CHAPTER_WATCHER_CONFIG };
  }
}

export async function saveChapterWatcherConfig(input: ChapterWatcherConfig): Promise<ChapterWatcherConfig> {
  const normalized = normalizeChapterWatcherConfig(input);
  await setSetting(CHAPTER_WATCHER_SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}

// ===== بناء الإعلان =====

export type AnnouncementEntry = {
  mangaTitle: string;
  sourceName: string;
  link: string | null;
  /** الفصول الجديدة تصاعديًا بترتيبها في الموقع. */
  chapters: Array<{ name: string; number: number | null; url: string }>;
};

/** يعبّئ متغيرات القالب: {manga} {chapter} {source} {link}. */
export function renderAnnouncementTemplate(
  template: string,
  vars: { manga: string; chapter: string; source: string; link: string }
): string {
  return template
    .replace(/\{manga\}/g, vars.manga)
    .replace(/\{chapter\}/g, vars.chapter)
    .replace(/\{source\}/g, vars.source)
    .replace(/\{link\}/g, vars.link);
}

export const ANNOUNCEMENT_COLOR = 0xd4af37;

export type ChapterAnnouncement = {
  dividerUrl: string | null;
  embed: {
    title: string;
    description: string;
    url: string | null;
    color: number;
    thumbnailUrl: string | null;
    footerText: string;
    timestampISO: string;
  };
};

/** يبني الإعلان (السطر + البطاقة) من قالب الإعدادات — دالة نقية قابلة للمعاينة. */
export function buildChapterAnnouncement(
  config: ChapterWatcherConfig,
  entry: AnnouncementEntry,
  options: { now?: Date } = {}
): ChapterAnnouncement {
  const newest = entry.chapters[entry.chapters.length - 1];
  const newestName = newest?.name?.trim() || "فصل جديد";
  const link = entry.link ?? newest?.url ?? "";
  const safeLink = /^https?:\/\//i.test(link) ? link : "";
  const vars = {
    manga: entry.mangaTitle,
    chapter: newestName,
    source: entry.sourceName,
    link: safeLink,
  };
  const title = renderAnnouncementTemplate(config.titleTemplate, vars);
  let description: string;
  if (entry.chapters.length <= 1) {
    description = renderAnnouncementTemplate(config.descriptionTemplate, vars);
  } else {
    // فصول متعددة في دورة واحدة: قائمة مدمجة بدل إغراق القناة برسائل
    const list = entry.chapters
      .map(chapter => `• ${chapter.name?.trim() || "فصل"}`)
      .join("\n");
    const suffix = renderAnnouncementTemplate(config.descriptionTemplate, vars);
    description = `${list}\n\n${suffix}`;
  }
  return {
    dividerUrl: config.dividerGifUrl,
    embed: {
      title: title.slice(0, 256),
      description: description.slice(0, 4000),
      url: safeLink || null,
      color: ANNOUNCEMENT_COLOR,
      thumbnailUrl: null,
      footerText: "ZEUS — إعلانات الفصول",
      timestampISO: (options.now ?? new Date()).toISOString(),
    },
  };
}

// ===== كشف الجديد =====

export type NewChaptersResult = {
  /** الفصول الجديدة تصاعديًا — فارغة عند الأساس أو لا جديد. */
  newChapters: SuwayomiWatchedChapter[];
  /** أعلى ترتيب مرصود في هذا الفحص — يُحفظ حتى لو لم يُعلن عن شيء. */
  maxOrder: number;
  /** هل هذا الفحص أساس أولي (لم يكن العمل متابعًا من قبل). */
  baseline: boolean;
};

/**
 * يقارن فهرس الفصول الحي بآخر ترتيب مرصود:
 * • بلا حالة سابقة (أو ترتيب 0): أساس — يُحفظ الأعلى بلا إعلان.
 * • وإلا كل فصل أعلى من المرصود يُعاد تصاعديًا، بسقف إعلان لكل عمل.
 */
export function detectNewChapters(
  chapters: SuwayomiWatchedChapter[],
  lastSourceOrder: number
): NewChaptersResult {
  const maxOrder = chapters.reduce((max, chapter) => Math.max(max, chapter.sourceOrder ?? 0), 0);
  if (!Number.isFinite(lastSourceOrder) || lastSourceOrder <= 0) {
    return { newChapters: [], maxOrder, baseline: true };
  }
  const newer = chapters
    .filter(chapter => (chapter.sourceOrder ?? 0) > lastSourceOrder)
    .sort((a, b) => a.sourceOrder - b.sourceOrder);
  // نعلن عن أحدث فصول على التوالي إذا تجاوزت السقف
  const newChapters = newer.length > MAX_ANNOUNCE_PER_MANGA ? newer.slice(-MAX_ANNOUNCE_PER_MANGA) : newer;
  return { newChapters, maxOrder, baseline: false };
}

/** يبني رابط الفصل: realUrl إن كان مطلقًا، وإلا يُحل على أساس المصدر. */
export function resolveChapterLink(
  chapter: SuwayomiWatchedChapter,
  source: { baseUrl: string } | undefined
): string | null {
  const raw = (chapter.realUrl ?? chapter.url ?? "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = source?.baseUrl?.trim();
  if (!base) return null;
  try {
    return new URL(raw, base).toString();
  } catch {
    return null;
  }
}

// ===== الدورة الكاملة =====

export type WatcherCycleSummary = {
  ranAt: string;
  enabled: boolean;
  reason: string | null;
  library: number;
  checked: number;
  announced: number;
  baselined: number;
  skippedMuted: number;
  errors: string[];
};

const CYCLE_MANGA_DELAY_MS = 600;
const CHAPTER_FETCH_TIMEOUT_MS = 45_000;

/**
 * دورة مراقبة كاملة: مكتبة Suwayomi → فهرس حي لكل عمل → مقارنة → إعلان.
 * فشل عمل واحد لا يوقف الدورة — يُسجَّل في errors ويُكمل البقية.
 */
export async function runChapterWatcherCycle(): Promise<WatcherCycleSummary> {
  const summary: WatcherCycleSummary = {
    ranAt: new Date().toISOString(),
    enabled: false,
    reason: null,
    library: 0,
    checked: 0,
    announced: 0,
    baselined: 0,
    skippedMuted: 0,
    errors: [],
  };
  const config = await loadChapterWatcherConfig();
  if (!config.enabled) {
    summary.reason = "المراقب معطّل من لوحة التحكم.";
    return summary;
  }
  if (!config.channelId) {
    summary.reason = "لم تُضبط قناة الإعلانات بعد.";
    return summary;
  }
  summary.enabled = true;

  const suwayomi = new SuwayomiClient(ENV.suwayomiBaseUrl, getUsableSuwayomiToken());
  const library = await suwayomi.listLibraryManga();
  summary.library = library.length;

  const [states, sources] = await Promise.all([listWatchedMangaStates(), listSources()]);
  const stateById = new Map<number, WatchedMangaState>(states.map(state => [state.suwayomiMangaId, state]));
  const sourceById = new Map(sources.map(source => [source.suwayomiSourceId ?? "", source]));

  // استيراد حي — يكسر دورة الاستيراد مع discordBot
  const { isDiscordBotReady, sendChapterAnnouncement } = await import("./discordBot");
  if (!isDiscordBotReady()) {
    summary.reason = "البوت غير متصل بعد.";
    return summary;
  }

  for (const manga of library) {
    const state = stateById.get(manga.id);
    if (state?.muted) {
      summary.skippedMuted += 1;
      continue;
    }
    let chapters: SuwayomiWatchedChapter[];
    try {
      chapters = await suwayomi.fetchMangaChaptersWithOrder(manga.id, CHAPTER_FETCH_TIMEOUT_MS);
      summary.checked += 1;
    } catch (error) {
      summary.errors.push(
        `${manga.title}: تعذر جلب الفهرس — ${error instanceof Error && error.message ? error.message : "خطأ غير معروف"}`
      );
      continue;
    }
    if (!chapters.length) continue;

    const lastOrder = state?.lastSourceOrder ?? 0;
    const { newChapters, maxOrder, baseline } = detectNewChapters(chapters, lastOrder);

    if (baseline) {
      const newest = newestChapter(chapters);
      await saveWatchedMangaState({
        suwayomiMangaId: manga.id,
        title: manga.title,
        sourceId: manga.sourceId,
        thumbnailUrl: manga.thumbnailUrl,
        lastSourceOrder: maxOrder,
        lastChapterName: newest?.name ?? null,
        lastChapterId: newest?.id ?? null,
        muted: false,
        updatedAt: new Date(),
        announcedAt: null,
      });
      summary.baselined += 1;
      continue;
    }
    if (!newChapters.length) continue;

    const source = sourceById.get(manga.sourceId);
    const newest = newChapters[newChapters.length - 1]!;
    const entry: AnnouncementEntry = {
      mangaTitle: manga.title,
      sourceName: source?.name ?? manga.sourceId,
      link: resolveChapterLink(newest, source),
      chapters: newChapters.map(chapter => ({
        name: chapter.name,
        number: typeof chapter.chapterNumber === "number" ? chapter.chapterNumber : null,
        url: resolveChapterLink(chapter, source) ?? "",
      })),
    };
    try {
      await sendChapterAnnouncement(config.channelId, buildChapterAnnouncement(config, entry));
      summary.announced += newChapters.length;
      await saveWatchedMangaState({
        suwayomiMangaId: manga.id,
        title: manga.title,
        sourceId: manga.sourceId,
        thumbnailUrl: manga.thumbnailUrl,
        lastSourceOrder: maxOrder,
        lastChapterName: newest.name ?? null,
        lastChapterId: newest.id,
        muted: false,
        updatedAt: new Date(),
        announcedAt: new Date(),
      });
    } catch (error) {
      summary.errors.push(
        `${manga.title}: فشل الإعلان — ${error instanceof Error && error.message ? error.message : "خطأ غير معروف"}`
      );
    }
    await new Promise(resolve => setTimeout(resolve, CYCLE_MANGA_DELAY_MS));
  }

  // تنظيف حالات أعمال خرجت من المكتبة
  const libraryIds = new Set(library.map(manga => manga.id));
  const stale = states.filter(state => !libraryIds.has(state.suwayomiMangaId));
  for (const state of stale) {
    await deleteWatchedMangaState(state.suwayomiMangaId).catch(() => undefined);
  }

  return summary;
}

/** الفصل الأحدث حسب ترتيب الموقع — لبناء الأساس وتحديث الحالة. */
function newestChapter(chapters: SuwayomiWatchedChapter[]): SuwayomiWatchedChapter | undefined {
  return chapters.reduce<SuwayomiWatchedChapter | undefined>(
    (newest, chapter) => ((chapter.sourceOrder ?? 0) >= (newest?.sourceOrder ?? 0) ? chapter : newest),
    undefined
  );
}

// ===== قائمة المكتبة للوحة التحكم =====

export type WatchedLibraryEntry = {
  id: number;
  title: string;
  sourceId: string;
  thumbnailUrl: string | null;
  sourceName: string;
  muted: boolean;
  /** تم رصد أساسه — الفصول الجديدة فوقه ستُعلن. */
  tracked: boolean;
  lastChapterName: string | null;
  announcedAt: string | null;
};

/** أعمال مكتبة Suwayomi مع حالة متابعتها — لقسم الإعلانات في اللوحة. */
export async function listWatchedLibrary(): Promise<WatchedLibraryEntry[]> {
  const suwayomi = new SuwayomiClient(ENV.suwayomiBaseUrl, getUsableSuwayomiToken());
  const [library, states, sources] = await Promise.all([
    suwayomi.listLibraryManga(),
    listWatchedMangaStates(),
    listSources(),
  ]);
  const stateById = new Map<number, WatchedMangaState>(states.map(state => [state.suwayomiMangaId, state]));
  const sourceById = new Map(sources.map(source => [source.suwayomiSourceId ?? "", source]));
  return library.map(manga => {
    const state = stateById.get(manga.id);
    return {
      id: manga.id,
      title: manga.title,
      sourceId: manga.sourceId,
      thumbnailUrl: manga.thumbnailUrl,
      sourceName: sourceById.get(manga.sourceId)?.name ?? manga.sourceId,
      muted: state?.muted ?? false,
      tracked: Boolean(state && state.lastSourceOrder > 0),
      lastChapterName: state?.lastChapterName ?? null,
      announcedAt: state?.announcedAt ? state.announcedAt.toISOString() : null,
    };
  });
}

// ===== حلقة التشغيل الدورية =====

let watcherTimer: NodeJS.Timeout | null = null;
let cycleRunning = false;
let lastRunAtMs = 0;

/** يدور كل 30 ثانية ويفحص هل حل موعد الدورة حسب إعدادات اللوحة. */
export function startChapterWatcherLoop(): void {
  if (watcherTimer) return;
  watcherTimer = setInterval(() => {
    if (cycleRunning) return;
    void (async () => {
      try {
        const config = await loadChapterWatcherConfig();
        if (!config.enabled || !config.channelId) return;
        const intervalMs = config.intervalMinutes * 60_000;
        const now = Date.now();
        if (lastRunAtMs && now - lastRunAtMs < intervalMs - 5_000) return;
        cycleRunning = true;
        lastRunAtMs = now;
        try {
          const summary = await runChapterWatcherCycle();
          if (summary.errors.length) {
            console.warn(`[Watcher] دورة اكتملت بـ ${summary.errors.length} خطأ — أُعلن ${summary.announced}.`, summary.errors.slice(0, 3));
          } else {
            console.info(
              `[Watcher] دورة اكتملت: مكتبة ${summary.library}، فُحص ${summary.checked}، أُعلن ${summary.announced}، أساس ${summary.baselined}.`
            );
          }
        } finally {
          cycleRunning = false;
        }
      } catch (error) {
        cycleRunning = false;
        console.warn("[Watcher] فشلت دورة المراقبة:", error);
      }
    })();
  }, 30_000);
  watcherTimer.unref?.();
}

/** إيقاف الحلقة (للاختبارات). */
export function stopChapterWatcherLoop(): void {
  if (watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
  }
}
