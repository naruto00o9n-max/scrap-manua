import { ENV } from "../_core/env";
import {
  getBlockedSources,
  listSources,
  saveSource,
  type BlockedSources,
} from "../db";
import { ensureBuiltinSources } from "./builtinSources";
import { getUsableSuwayomiToken } from "./settings";
import { SuwayomiClient, type SuwayomiSource } from "./suwayomi";

// ============================================================
// مزامنة تلقائية: أي مصدر مثبت في Suwayomi يظهر في البوت تلقائيًا،
// وأي مصدر يُحذف من Suwayomi يُعلَّم كغير متاح — دون لمس المصادر
// اليدوية المضافة من لوحة التحكم (بلا origin=suwayomi).
// ============================================================

const SYNC_INTERVAL_MS = 10 * 60 * 1000;
const AUTO_NOTE = "أُضيف تلقائيًا";

export type SyncPlanAction =
  | { kind: "create"; source: SuwayomiSource; hostname: string | null }
  | { kind: "activate"; existingId: number }
  | { kind: "disable"; existingId: number };

export type SyncPlan = {
  create: Extract<SyncPlanAction, { kind: "create" }>[];
  activate: number[];
  disable: number[];
  keep: number;
  /** مصادر تُوقفت عن الإضافة لأن نطاقها محجوز بصف موجود أو بمصدر آخر في نفس الدفعة. */
  skippedHostname: number;
  /** مواقع حذفها المالك سابقًا (قائمة الحجب) — لا تُعاد إضافتها تلقائيًا. */
  blockedSkipped: number;
  /** صفوف مزامنت سابقًا بنطاق مؤقت لأصبح نطاقها الحقيقي متاحًا الآن. */
  healed: number;
};

/** النطاق المؤقت الذي تُسجّل به صفوف المصادر التي لم يعرف خادم السحب نطاقها وقت المزامنة. */
export function isPlaceholderHostname(hostname: string): boolean {
  return /^suwayomi-\d+\.sync\.internal$/.test(hostname);
}

export type HostnameHeal = { source: SuwayomiSource; hostname: string };

/**
 * شفاء الصفوف المؤقتة: صف سُجّل بنطاق مؤقت (لأن homeUrl كان فارغًا وقت المزامنة)
 * يحتفظ بـ allowDirectChapterLookup=false فترفض روابطه «غير مدرج ضمن المصادر»
 * أبديًا. حين يعلن خادم السحب نطاقه الحقيقي لاحقًا، يُحدَّث الصف به — إن كان
 * النطاق الجديد حرًا وغير محجوب، ودون مسّ حالة التفعيل الحالية.
 */
export function planHostnameHeals(
  installed: SuwayomiSource[],
  existing: SyncableExistingSource[],
  blocked: BlockedSources = { suwayomiSourceIds: [], hostnames: [] }
): HostnameHeal[] {
  const bySuwayomiId = new Map(installed.map(source => [source.id, source]));
  const takenHostnames = new Set(
    existing.filter(row => !isPlaceholderHostname(row.hostname)).map(row => row.hostname)
  );
  const heals: HostnameHeal[] = [];
  for (const row of existing) {
    if (row.origin !== "suwayomi" || !row.suwayomiSourceId) continue;
    if (!isPlaceholderHostname(row.hostname)) continue;
    if (blocked.suwayomiSourceIds.includes(row.suwayomiSourceId)) continue;
    const source = bySuwayomiId.get(row.suwayomiSourceId);
    if (!source) continue;
    const hostname = hostnameFromHomeUrl(source.homeUrl);
    if (!hostname || hostname === row.hostname || takenHostnames.has(hostname)) continue;
    if (blocked.hostnames.includes(hostname)) continue;
    takenHostnames.add(hostname);
    heals.push({ source, hostname });
  }
  return heals;
}

/** يستخرج نطاق موقع المصدر من homeUrl إن وُجد. */
export function hostnameFromHomeUrl(homeUrl: string | null | undefined): string | null {
  if (!homeUrl) return null;
  try {
    const parsed = new URL(homeUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** خطة المزامنة كدالة نقية — قابلة للاختبار دون قاعدة بيانات ولا سيرفر. */
export type SyncableExistingSource = {
  id: number;
  suwayomiSourceId: string | null;
  status: string;
  origin?: string | null;
  hostname: string;
  lang?: string | null;
  /** قفله المالك يدويًا — لا تفعيل ولا تعطيل تلقائي له. */
  ownerLocked?: boolean | null;
};

export function planSourceChanges(
  installed: SuwayomiSource[],
  existing: SyncableExistingSource[],
  blocked: BlockedSources = { suwayomiSourceIds: [], hostnames: [] }
): SyncPlan {
  const bySuwayomiId = new Map(
    existing.filter(row => row.suwayomiSourceId).map(row => [row.suwayomiSourceId!, row])
  );
  const installedIds = new Set(installed.map(source => source.id));
  const plan: SyncPlan = { create: [], activate: [], disable: [], keep: 0, skippedHostname: 0, blockedSkipped: 0, healed: 0 };

  // فهرس hostname محجوز فريدًا في قاعدة البيانات — أي مصدر جديد يطلب نطاقًا
  // محجوزًا (مثل عشرات لغات MangaDex كلها على mangadex.org، أو مصدر أُضيف
  // يدويًا من اللوحة) يُتخطّى بصمت بدل الفشل بخطأ E11000 مكرر كل دورة.
  const takenHostnames = new Set(existing.map(row => row.hostname));

  for (const source of installed) {
    const row = bySuwayomiId.get(source.id);
    if (!row) {
      // مواقع حذفها المالك من إدارة المواقع لا تُعاد إضافتها تلقائيًا.
      const hostname = hostnameFromHomeUrl(source.homeUrl);
      if (
        blocked.suwayomiSourceIds.includes(source.id) ||
        (hostname && blocked.hostnames.includes(hostname))
      ) {
        plan.blockedSkipped += 1;
        continue;
      }
      if (hostname && takenHostnames.has(hostname)) {
        plan.skippedHostname += 1;
        continue;
      }
      if (hostname) takenHostnames.add(hostname);
      plan.create.push({ kind: "create", source, hostname });
    } else if (row.status !== "active" && !row.ownerLocked) {
      plan.activate.push(row.id);
    } else {
      plan.keep += 1;
    }
  }

  for (const row of existing) {
    if (
      !row.ownerLocked &&
      row.origin === "suwayomi" &&
      row.suwayomiSourceId &&
      !installedIds.has(row.suwayomiSourceId) &&
      row.status === "active"
    ) {
      plan.disable.push(row.id);
    }
  }
  return plan;
}

/**
 * صفوف مصادر مزامنتها سابقًا بلا لغة (قبل إدخال حقل lang) ووُجدت لغتها الآن
 * من إضافة Suwayomi — تُستكمل لغتها في كل دورة مزامنة حتى تكتمل كلها،
 * لتجميع /مواقع حسب اللغة. عامة على نوع الصف حتى تمر صفوف ContentSource
 * الكاملة وتعود كما هي مع اللغة. دالة نقية قابلة للاختبار.
 */
export type SourceLangBackfill<Row> = { row: Row; lang: string };

export function sourceLangBackfills<Row extends SyncableExistingSource>(
  existing: Row[],
  installed: SuwayomiSource[]
): SourceLangBackfill<Row>[] {
  const langBySuwayomiId = new Map(
    installed.filter(source => source.lang).map(source => [source.id, source.lang])
  );
  const backfills: SourceLangBackfill<Row>[] = [];
  for (const row of existing) {
    if (row.origin !== "suwayomi" || !row.suwayomiSourceId || row.lang) continue;
    const lang = langBySuwayomiId.get(row.suwayomiSourceId);
    if (lang) backfills.push({ row, lang });
  }
  return backfills;
}

let inFlight: Promise<{ added: number; activated: number; disabled: number } | null> | null = null;

/** يشغّل مزامنة واحدة (مع منع التداخل لو نُفّذت من أكثر من مكان في نفس اللحظة). */
export async function syncSourcesFromSuwayomi(): Promise<{ added: number; activated: number; disabled: number } | null> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    // تسجيل المواقع المدمجة أولًا — لا يتوقف لو كان خادم السحب غير مهيأ.
    try {
      const builtin = await ensureBuiltinSources();
      if (builtin.added.length) {
        console.info(`[SourceSync] سُجّلت مواقع مدمجة تلقائيًا: ${builtin.added.join("، ")}.`);
      }
    } catch (error) {
      console.warn("[SourceSync] تعذر تسجيل المواقع المدمجة:", error);
    }
    if (!ENV.suwayomiBaseUrl) return { added: 0, activated: 0, disabled: 0, healed: 0 };
    try {
      const suwayomi = new SuwayomiClient(ENV.suwayomiBaseUrl, getUsableSuwayomiToken());
      const installed = await suwayomi.listInstalledSources();
      const existing = await listSources();
      const blocked = await getBlockedSources();
      const plan = planSourceChanges(installed, existing, blocked);
      const heals = planHostnameHeals(installed, existing, blocked);

      let added = 0;
      for (const action of plan.create) {
        const { source } = action;
        // نطاق فريد مؤقت حتى يُستكمل من رابط العمل عند أول سحب عبر /بحث —
        // فهرس hostname فريد ولا يقبل تكرار الفراغ بين عدة مصادر.
        const hostname = action.hostname ?? `suwayomi-${source.id}.sync.internal`;
        try {
          await saveSource({
            name: source.displayName || source.name,
            hostname,
            baseUrl: source.homeUrl ?? "",
            suwayomiSourceId: source.id,
            extensionPackage: source.extension?.pkgName ?? null,
            extensionName: source.extension?.name ?? null,
            status: "active",
            allowDirectChapterLookup: Boolean(action.hostname),
            notes: AUTO_NOTE,
            origin: "suwayomi",
            lang: source.lang,
          });
          added += 1;
        } catch (error) {
          console.warn(`[SourceSync] تعذر إضافة المصدر ${source.displayName ?? source.id}:`, error);
        }
      }

      for (const id of plan.activate) {
        try {
          const row = existing.find(item => item.id === id);
          if (!row) continue;
          await saveSource({
            id: row.id,
            name: row.name,
            hostname: row.hostname,
            baseUrl: row.baseUrl,
            suwayomiSourceId: row.suwayomiSourceId,
            extensionPackage: row.extensionPackage,
            extensionName: row.extensionName,
            status: "active",
            allowDirectChapterLookup: row.allowDirectChapterLookup,
            notes: row.notes,
            origin: "suwayomi",
          });
        } catch (error) {
          console.warn(`[SourceSync] تعذر إعادة تفعيل المصدر ${id}:`, error);
        }
      }

      for (const id of plan.disable) {
        try {
          const row = existing.find(item => item.id === id);
          if (!row) continue;
          await saveSource({
            id: row.id,
            name: row.name,
            hostname: row.hostname,
            baseUrl: row.baseUrl,
            suwayomiSourceId: row.suwayomiSourceId,
            extensionPackage: row.extensionPackage,
            extensionName: row.extensionName,
            status: "disabled",
            allowDirectChapterLookup: row.allowDirectChapterLookup,
            notes: `${AUTO_NOTE} — ثم أُزيل من قائمة المواقع`,
            origin: "suwayomi",
          });
        } catch (error) {
          console.warn(`[SourceSync] تعذر تعطيل المصدر ${id}:`, error);
        }
      }

      // شفاء الصفوف المؤقتة: أول استقرار للنطاقات الحقيقية قبل كل شي —
      // يُبقي حالة التفعيل كما هي (وإن فُعّل في هذه الدورة فيبقى مفعّلًا).
      let healed = 0;
      for (const heal of heals) {
        const row = existing.find(
          item => item.suwayomiSourceId === heal.source.id && isPlaceholderHostname(item.hostname)
        );
        if (!row) continue;
        try {
          await saveSource({
            id: row.id,
            name: heal.source.displayName || heal.source.name || row.name,
            hostname: heal.hostname,
            baseUrl: heal.source.homeUrl ?? row.baseUrl,
            suwayomiSourceId: row.suwayomiSourceId,
            extensionPackage: heal.source.extension?.pkgName ?? row.extensionPackage,
            extensionName: heal.source.extension?.name ?? row.extensionName,
            status: plan.activate.includes(row.id) ? "active" : (row.status as "active" | "disabled"),
            allowDirectChapterLookup: true,
            notes: row.notes,
            origin: "suwayomi",
            lang: heal.source.lang || row.lang,
          });
          healed += 1;
        } catch (error) {
          console.warn(`[SourceSync] تعذر استكمال نطاق المصدر ${row.id}:`, error);
        }
      }

      // استكمال لغة الصفوف القديمة المُزامنة قبل إدخال حقل lang —
      // تشغيل رخيص: لا يكتب إلا الصفوف الناقصة فقط، ويشفي نفسه كل دورة.
      let backfilled = 0;
      for (const backfill of sourceLangBackfills(existing, installed)) {
        try {
          const row = backfill.row;
          await saveSource({
            id: row.id,
            name: row.name,
            hostname: row.hostname,
            baseUrl: row.baseUrl,
            suwayomiSourceId: row.suwayomiSourceId,
            extensionPackage: row.extensionPackage,
            extensionName: row.extensionName,
            status: "active",
            allowDirectChapterLookup: row.allowDirectChapterLookup,
            notes: row.notes,
            origin: "suwayomi",
            lang: backfill.lang,
          });
          backfilled += 1;
        } catch (error) {
          console.warn(`[SourceSync] تعذر استكمال لغة المصدر ${backfill.row.id}:`, error);
        }
      }

      if (added || plan.activate.length || plan.disable.length || backfilled || healed) {
        console.info(
          `[SourceSync] أُضيف ${added}، فُعّل ${plan.activate.length}، عُطّل ${plan.disable.length}، استُكملت لغة ${backfilled}، استُكمل نطاق ${healed}.`
        );
      }
      return { added, activated: plan.activate.length, disabled: plan.disable.length, healed };
    } catch (error) {
      console.warn("[SourceSync] فشلت مزامنة المصادر:", error);
      return { added: 0, activated: 0, disabled: 0, healed: 0 };
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** حلقة المزامنة الدورية — تُشغَّل من إقلاع الخدمة. */
export function startSourceSyncLoop(): void {
  void syncSourcesFromSuwayomi();
  const timer = setInterval(() => void syncSourcesFromSuwayomi(), SYNC_INTERVAL_MS);
  timer.unref?.();
}
