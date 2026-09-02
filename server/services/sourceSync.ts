import { ENV } from "../_core/env";
import { listSources, saveSource } from "../db";
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
};

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
};

export function planSourceChanges(installed: SuwayomiSource[], existing: SyncableExistingSource[]): SyncPlan {
  const bySuwayomiId = new Map(
    existing.filter(row => row.suwayomiSourceId).map(row => [row.suwayomiSourceId!, row])
  );
  const installedIds = new Set(installed.map(source => source.id));
  const plan: SyncPlan = { create: [], activate: [], disable: [], keep: 0, skippedHostname: 0 };

  // فهرس hostname محجوز فريدًا في قاعدة البيانات — أي مصدر جديد يطلب نطاقًا
  // محجوزًا (مثل عشرات لغات MangaDex كلها على mangadex.org، أو مصدر أُضيف
  // يدويًا من اللوحة) يُتخطّى بصمت بدل الفشل بخطأ E11000 مكرر كل دورة.
  const takenHostnames = new Set(existing.map(row => row.hostname));

  for (const source of installed) {
    const row = bySuwayomiId.get(source.id);
    if (!row) {
      const hostname = hostnameFromHomeUrl(source.homeUrl);
      if (hostname && takenHostnames.has(hostname)) {
        plan.skippedHostname += 1;
        continue;
      }
      if (hostname) takenHostnames.add(hostname);
      plan.create.push({ kind: "create", source, hostname });
    } else if (row.status !== "active") {
      plan.activate.push(row.id);
    } else {
      plan.keep += 1;
    }
  }

  for (const row of existing) {
    if (
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

let inFlight: Promise<{ added: number; activated: number; disabled: number } | null> | null = null;

/** يشغّل مزامنة واحدة (مع منع التداخل لو نُفّذت من أكثر من مكان في نفس اللحظة). */
export async function syncSourcesFromSuwayomi(): Promise<{ added: number; activated: number; disabled: number } | null> {
  if (!ENV.suwayomiBaseUrl) return null;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const suwayomi = new SuwayomiClient(ENV.suwayomiBaseUrl, getUsableSuwayomiToken());
      const installed = await suwayomi.listInstalledSources();
      const existing = await listSources();
      const plan = planSourceChanges(installed, existing);

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

      if (added || plan.activate.length || plan.disable.length) {
        console.info(
          `[SourceSync] أُضيف ${added}، فُعّل ${plan.activate.length}، عُطّل ${plan.disable.length}.`
        );
      }
      return { added, activated: plan.activate.length, disabled: plan.disable.length };
    } catch (error) {
      console.warn("[SourceSync] فشلت مزامنة المصادر:", error);
      return { added: 0, activated: 0, disabled: 0 };
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
