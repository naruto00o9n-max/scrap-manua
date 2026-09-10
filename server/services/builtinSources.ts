import { getBlockedSources, listSources, saveSource } from "../db";

// ============================================================
// المواقع المدمجة — تُسجَّل تلقائيًا في قائمة المواقع عند إقلاع
// الخدمة وفي كل دورة مزامنة، دون أي خطوة من لوحة التحكم.
// هذا هو مسار المواقع التي تسحب مباشرة كليًا ولا توجد في خادم
// السحب أصلًا (ككاكاو بيج)، فلا يُشترط ربط إضافة ولا تسجيل يدوي.
// احترام قرار المالك: ما حذفه من إدارة المواقع (قائمة الحجب) لا
// يُعاد تسجيله، وما سجّله بنفسه أو عطّله يبقى كما هو.
// ============================================================

export type BuiltinSourceSpec = {
  /** النطاق الفريد للموقع — مفتاح التسجيل والفحص. */
  hostname: string;
  /** الاسم المعروض في /مواقع ولوحة التحكم. */
  name: string;
  baseUrl: string;
  /** لغة الموقع — لتجميع /مواقع حسب اللغة. */
  lang: string;
  notes: string;
};

/** المواقع المدمجة حاليًا. */
export const BUILTIN_SOURCES: BuiltinSourceSpec[] = [
  {
    hostname: "page.kakao.com",
    name: "كاكاو بيج",
    baseUrl: "https://page.kakao.com",
    lang: "ko",
    notes: "مدمج داخل البوت: سحب مباشر لروابط الفصول المجانية من كاكاو بيج.",
  },
];

export type BuiltinSourcePlanAction =
  | { kind: "create"; spec: BuiltinSourceSpec }
  | { kind: "keep"; spec: BuiltinSourceSpec; reason: "registered" | "blocked" };

/** خطة تسجيل المواقع المدمجة كدالة نقية: يُسجَّل النطاق الغائب غير المحجوب فقط. */
export function planBuiltinSources(
  existingHostnames: string[],
  blockedHostnames: string[] = []
): BuiltinSourcePlanAction[] {
  const normalize = (value: string) => value.toLowerCase().replace(/^www\./, "");
  const registered = new Set(existingHostnames.map(normalize));
  const blocked = new Set(blockedHostnames.map(normalize));
  return BUILTIN_SOURCES.map(spec => {
    if (registered.has(normalize(spec.hostname))) {
      return { kind: "keep" as const, spec, reason: "registered" as const };
    }
    if (blocked.has(normalize(spec.hostname))) {
      return { kind: "keep" as const, spec, reason: "blocked" as const };
    }
    return { kind: "create" as const, spec };
  });
}

/** يسجّل المواقع المدمجة الناقصة — رخيص وآمن للاستدعاء في كل دورة مزامنة. */
export async function ensureBuiltinSources(): Promise<{ added: string[]; kept: number }> {
  const [existing, blocked] = await Promise.all([listSources(), getBlockedSources()]);
  const plan = planBuiltinSources(
    existing.map(row => row.hostname),
    blocked.hostnames
  );
  const added: string[] = [];
  for (const action of plan) {
    if (action.kind !== "create") continue;
    const spec = action.spec;
    await saveSource({
      name: spec.name,
      hostname: spec.hostname,
      baseUrl: spec.baseUrl,
      suwayomiSourceId: null,
      extensionPackage: null,
      extensionName: null,
      status: "active",
      allowDirectChapterLookup: true,
      notes: spec.notes,
      origin: "manual",
      lang: spec.lang,
    });
    added.push(spec.hostname);
  }
  return { added, kept: plan.length - added.length };
}
