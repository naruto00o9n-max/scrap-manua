import { describe, expect, it } from "vitest";
import {
  buildHelpComponents,
  buildJobCard,
  buildMergeCard,
  buildMergePromptComponents,
  buildPromptComponents,
  getRegisteredDiscordCommands,
  noticeFromJob,
} from "./discordBot";

type ComponentShape = {
  type: number;
  accent_color?: number;
  content?: string;
  components?: unknown[];
  accessory?: unknown;
  custom_id?: string;
  url?: string;
  style?: number;
  media?: { url?: string };
};

function flatten(component: ComponentShape): ComponentShape[] {
  const found: ComponentShape[] = [component];
  if (Array.isArray(component.components)) {
    for (const child of component.components as ComponentShape[])
      found.push(...flatten(child));
  }
  // القسم (type 9) يحمل الصورة المصغرة في خاصية accessory وليس داخل components.
  if (component.accessory)
    found.push(...flatten(component.accessory as ComponentShape));
  return found;
}

function collectTexts(components: unknown[]): string[] {
  return flatten({ type: 0, components: components as ComponentShape[] })
    .filter(item => item.type === 10 && typeof item.content === "string")
    .map(item => item.content as string);
}

function collectButtons(components: unknown[]): ComponentShape[] {
  return flatten({
    type: 0,
    components: components as ComponentShape[],
  }).filter(item => item.type === 2);
}

function collectThumbnails(components: unknown[]): ComponentShape[] {
  return flatten({
    type: 0,
    components: components as ComponentShape[],
  }).filter(item => item.type === 11);
}

describe("Discord ZEUS chapter experience", () => {
  it("registers Arabic-only commands", () => {
    const names = getRegisteredDiscordCommands().map(command => command.name);
    expect(names).toEqual(["فصل", "دمج", "مساعدة"]);
  });

  it("builds a gold Components V2 card with a live progress bar and pipeline checklist", () => {
    const [container] = buildJobCard({
      jobId: "job-1",
      status: "downloading",
      stage: "download",
      label: "**Solo Leveling** — الفصل 101",
      pageCount: 34,
      progress: { done: 12, total: 34 },
    }) as unknown as [ComponentShape];

    expect(container.type).toBe(17);
    expect(container.accent_color).toBe(0xd4af37);
    const texts = collectTexts([container]).join("\n");
    expect(texts).toContain("▰");
    expect(texts).toContain("12 / 34");
    expect(texts).toContain("✓ فحص الرابط والمصدر");
    expect(texts).toContain("▸ سحب الصفحات — 12/34");
    expect(texts).toContain("· رفع الصور إلى Drive");
    const cancelButtons = collectButtons([container]).filter(
      button => button.custom_id === "job:cancel:job-1"
    );
    expect(cancelButtons).toHaveLength(1);
  });

  it("marks the merge stage live while pages are merged", () => {
    const texts = collectTexts(
      buildJobCard({
        status: "downloading",
        stage: "merge",
        pageCount: 34,
        progress: { done: 3, total: 17 },
      }) as unknown as unknown[]
    ).join("\n");
    expect(texts).toContain("▸ دمج الصفحات — 3/17");
    expect(texts).toContain("✓ سحب الصفحات — 34 صفحة");
  });

  it("finalizes with one green card: full checklist, drive link, and open button", () => {
    const driveUrl = "https://drive.google.com/drive/folders/test";
    const [container] = buildJobCard(
      {
        jobId: "job-2",
        status: "completed",
        stage: "upload",
        label: "**Solo Leveling** — الفصل 101",
        pageCount: 34,
        mergedCount: 17,
        driveUrl,
      },
      { requesterId: "656783724662226963" }
    ) as unknown as [ComponentShape];

    expect(container.accent_color).toBe(0x57f287);
    const texts = collectTexts([container]).join("\n");
    expect(texts).toContain("✓ فحص الرابط والمصدر");
    expect(texts).toContain("✓ دمج الصفحات — 17 صورة");
    expect(texts).toContain(`**رابط الفصل:** ${driveUrl}`);
    expect(texts).toContain("<@656783724662226963>");
    const linkButtons = collectButtons([container]).filter(
      button => button.style === 5 && button.url === driveUrl
    );
    expect(linkButtons).toHaveLength(1);
    // لا يوجد زر إلغاء في البطاقة النهائية.
    expect(
      collectButtons([container]).some(button =>
        button.custom_id?.startsWith("job:cancel:")
      )
    ).toBe(false);
  });

  it("renders failure in red with the failing stage marked", () => {
    const [container] = buildJobCard({
      status: "failed",
      stage: "validate",
      detail: "المصدر لم يعد مفعّلًا.",
    }) as unknown as [ComponentShape];
    expect(container.accent_color).toBe(0xed4245);
    const texts = collectTexts([container]).join("\n");
    expect(texts).toContain("✗ فحص الرابط والمصدر");
    expect(texts).toContain("المصدر لم يعد مفعّلًا.");
  });

  it("renders cancellation in gray", () => {
    const [container] = buildJobCard({
      status: "cancelled",
      stage: "upload",
      mergedCount: 5,
    }) as unknown as [ComponentShape];
    expect(container.accent_color).toBe(0x95a5a6);
    const texts = collectTexts([container]).join("\n");
    expect(texts).toContain("⊘ رفع الصور إلى Drive");
  });

  it("shows no checklist for stageless info cards", () => {
    const texts = collectTexts(
      buildJobCard({
        status: "info",
        title: "عنوان",
        detail: "تفصيل",
      }) as unknown as unknown[]
    ).join("\n");
    expect(texts).toContain("عنوان");
    expect(texts).toContain("تفصيل");
    expect(texts).not.toContain("▸");
  });

  it("help panel explains the bot and all commands with the ZEUS signature", () => {
    const texts = collectTexts(
      buildHelpComponents(
        "https://cdn.discordapp.com/avatars/1/x.png"
      ) as unknown as unknown[]
    ).join("\n");
    expect(texts).toContain("## 📖 ZEUS");
    expect(texts).toContain("### 🔹 /فصل");
    expect(texts).toContain("### 🔹 /دمج");
    expect(texts).toContain("ZIP");
    expect(texts).toContain("### 🔹 /مساعدة");
    expect(texts).toContain("-# ZEUS");
    expect(
      collectThumbnails(
        buildHelpComponents(
          "https://cdn.discordapp.com/avatars/1/x.png"
        ) as unknown as unknown[]
      )
    ).toHaveLength(1);
  });

  it("prompt panel asks for the link with numbered steps", () => {
    const texts = collectTexts(
      buildPromptComponents(null) as unknown as unknown[]
    ).join("\n");
    expect(texts).toContain("## ✍️ أرسل رابط الفصل");
    expect(texts).toContain("خلال دقيقتين");
  });

  it("merge prompt panel asks for a ZIP/CBZ or Drive folder link", () => {
    const texts = collectTexts(
      buildMergePromptComponents(null) as unknown as unknown[]
    ).join("\n");
    expect(texts).toContain("## 🧩 أرسل صور الفصل للدمج");
    expect(texts).toContain("ZIP");
    expect(texts).toContain("Google Drive");
    expect(texts).toContain("خلال دقيقتين");
  });

  it("merge card shows the four-stage checklist with live progress and a cancel button", () => {
    const [container] = buildMergeCard({
      mergeId: "merge-1",
      status: "downloading",
      stage: "merge",
      label: "**الفصل 12**",
      progress: { done: 2, total: 5 },
    }) as unknown as [ComponentShape];

    expect(container.type).toBe(17);
    expect(container.accent_color).toBe(0xd4af37);
    const texts = collectTexts([container]).join("\n");
    expect(texts).toContain("✓ فحص المدخلات");
    expect(texts).toContain("✓ جلب الصور");
    expect(texts).toContain("▸ دمج الصفحات — 2/5");
    expect(texts).toContain("· رفع الصور إلى Drive");
    const cancelButtons = collectButtons([container]).filter(
      button => button.custom_id === "merge:cancel:merge-1"
    );
    expect(cancelButtons).toHaveLength(1);
  });

  it("finalizes the merge with one green card: link, open button, and no cancel", () => {
    const driveUrl = "https://drive.google.com/drive/folders/merge-test";
    const [container] = buildMergeCard(
      {
        mergeId: "merge-2",
        status: "completed",
        stage: "upload",
        label: "**الفصل 12** — 3 صورة طويلة من 40 صورة",
        mergedCount: 3,
        imageCount: 40,
        driveUrl,
      },
      { requesterId: "656783724662226963" }
    ) as unknown as [ComponentShape];

    expect(container.accent_color).toBe(0x57f287);
    const texts = collectTexts([container]).join("\n");
    expect(texts).toContain("✅ اكتمل الدمج");
    expect(texts).toContain("✓ رفع الصور إلى Drive");
    expect(texts).toContain(`<@656783724662226963>`);
    expect(texts).toContain(`**رابط الفصل:** ${driveUrl}`);
    const linkButtons = collectButtons([container]).filter(
      button => button.style === 5 && button.url === driveUrl
    );
    expect(linkButtons).toHaveLength(1);
    expect(
      collectButtons([container]).some(button =>
        button.custom_id?.startsWith("merge:cancel:")
      )
    ).toBe(false);
  });

  it("renders merge failure and cancellation without leading the user on", () => {
    const [failed] = buildMergeCard({
      status: "failed",
      stage: "fetch",
      detail: "لم يُعثر على صور داخل الأرشيف.",
    }) as unknown as [ComponentShape];
    expect(failed.accent_color).toBe(0xed4245);
    const failedTexts = collectTexts([failed]).join("\n");
    expect(failedTexts).toContain("❌ فشل الدمج");
    expect(failedTexts).toContain("✗ جلب الصور");

    const [cancelled] = buildMergeCard({
      status: "cancelled",
      stage: "upload",
    }) as unknown as [ComponentShape];
    expect(cancelled.accent_color).toBe(0x95a5a6);
    const cancelledTexts = collectTexts([cancelled]).join("\n");
    expect(cancelledTexts).toContain("🚫 أُلغي الدمج");
    expect(cancelledTexts).toContain("⊘ رفع الصور إلى Drive");
  });

  it("keeps every card free of the removed boilerplate and old branding", () => {
    const samples: unknown[] = [
      ...buildJobCard({ status: "pending", stage: "validate", jobId: "j" }),
      ...buildJobCard({
        status: "completed",
        stage: "upload",
        driveUrl: "https://x",
        mergedCount: 2,
      }),
      ...buildJobCard({ status: "failed", stage: "chapter", detail: "خطأ" }),
      ...buildHelpComponents(null),
      ...buildPromptComponents(null),
      ...buildMergeCard({
        status: "downloading",
        stage: "merge",
        mergeId: "m",
        progress: { done: 1, total: 4 },
      }),
      ...buildMergeCard({
        status: "completed",
        driveUrl: "https://drive.google.com/x",
        mergedCount: 2,
        imageCount: 10,
      }),
      ...buildMergeCard({ status: "failed", stage: "fetch", detail: "خطأ" }),
      ...buildMergePromptComponents(null),
    ];
    const texts = collectTexts(samples).join("\n");
    expect(texts).not.toContain("الخطوة التالية");
    expect(texts).not.toContain("دار الفصول");
    expect(texts).not.toContain("طابور");
  });

  it("maps a database job to a stage-aware notice", () => {
    const notice = noticeFromJob({
      id: "job-9",
      status: "uploading",
      totalPages: 17,
      uploadedPages: 4,
      googleDriveUrl: null,
      mangaTitle: "Solo Leveling",
      chapterTitle: "الفصل 101",
      failureMessage: null,
    });
    expect(notice.stage).toBe("upload");
    expect(notice.progress).toEqual({ done: 4, total: 17 });
    expect(notice.label).toBe("Solo Leveling — الفصل 101");

    const stale = noticeFromJob({
      id: "job-10",
      status: "failed",
      totalPages: 0,
      uploadedPages: 0,
      googleDriveUrl: null,
      mangaTitle: null,
      chapterTitle: null,
      failureMessage: "توقفت المعالجة",
    });
    expect(stale.status).toBe("failed");
    expect(stale.detail).toBe("توقفت المعالجة");
    expect(stale.stage).toBe("validate");
  });

  it("uses only component types the Discord API accepts (50035 regression guard)", () => {
    // الأنواع الحقيقية المعروفة في Discord API:
    // 1 ActionRow، 2 Button، 9 Section، 10 TextDisplay، 11 Thumbnail،
    // 12 MediaGallery، 14 Separator، 17 Container. أي نوع آخر (كـ 18) يرفضه الـ API.
    const KNOWN_TYPES = new Set([1, 2, 9, 10, 11, 12, 14, 17]);
    // الأبناء المسموح بهم داخل الحاوية (17) كما يحددهم الـ API حرفيًا.
    const CONTAINER_CHILD_TYPES = new Set([1, 9, 10, 12, 13, 14]);
    // أنواع المكونات العليا المسموح بها في الرسالة.
    const TOP_LEVEL_TYPES = new Set([1, 9, 10, 12, 13, 14, 17]);

    const problems: string[] = [];

    const walk = (
      component: ComponentShape,
      parentType: number | null,
      path: string
    ) => {
      if (!KNOWN_TYPES.has(component.type)) {
        problems.push(
          `${path}: نوع المكوّن ${component.type} غير موجود في Discord API`
        );
        return;
      }
      if (parentType === null && !TOP_LEVEL_TYPES.has(component.type)) {
        problems.push(
          `${path}: النوع ${component.type} غير مسموح كمكوّن علوي في الرسالة`
        );
      }
      if (parentType === 17 && !CONTAINER_CHILD_TYPES.has(component.type)) {
        problems.push(
          `${path}: النوع ${component.type} غير مسموح داخل الحاوية (المسموح: 1, 9, 10, 12, 13, 14)`
        );
      }
      if (parentType === 9 && component.type !== 10) {
        problems.push(`${path}: داخل القسم (9) يُسمح فقط بالنص (10)`);
      }
      if (parentType === 1 && component.type !== 2) {
        problems.push(`${path}: داخل الصف (1) يُسمح فقط بالأزرار (2)`);
      }
      if (Array.isArray(component.components)) {
        for (const [index, child] of (
          component.components as ComponentShape[]
        ).entries()) {
          walk(child, component.type, `${path}.components[${index}]`);
        }
      }
    };

    const samples: unknown[][] = [
      ...[
        { status: "pending" as const, stage: "validate" as const, jobId: "g1" },
        {
          status: "downloading" as const,
          stage: "download" as const,
          progress: { done: 3, total: 20 },
        },
        {
          status: "downloading" as const,
          stage: "merge" as const,
          progress: { done: 5, total: 20 },
        },
        {
          status: "uploading" as const,
          stage: "upload" as const,
          progress: { done: 7, total: 20 },
        },
        {
          status: "completed" as const,
          stage: "upload" as const,
          driveUrl: "https://drive.google.com/x",
          mergedCount: 4,
        },
        { status: "failed" as const, stage: "chapter" as const, detail: "خطأ" },
        { status: "cancelled" as const, stage: "download" as const },
        { status: "info" as const, title: "عنوان", detail: "تفصيل" },
      ].map(notice => buildJobCard(notice)),
      ...[
        {
          status: "pending" as const,
          stage: "validate" as const,
          mergeId: "m1",
        },
        {
          status: "downloading" as const,
          stage: "fetch" as const,
          mergeId: "m1",
          progress: { done: 2, total: 9 },
        },
        {
          status: "downloading" as const,
          stage: "merge" as const,
          mergeId: "m1",
          progress: { done: 1, total: 3 },
        },
        {
          status: "uploading" as const,
          stage: "upload" as const,
          mergeId: "m1",
          progress: { done: 2, total: 3 },
        },
        {
          status: "completed" as const,
          driveUrl: "https://drive.google.com/y",
          mergedCount: 3,
          imageCount: 22,
        },
        { status: "failed" as const, stage: "merge" as const, detail: "خطأ" },
        { status: "cancelled" as const, stage: "upload" as const },
        { status: "info" as const, title: "مهلة الإرسال" },
      ].map(notice => buildMergeCard(notice)),
      buildHelpComponents("https://cdn.discordapp.com/avatars/1/x.png"),
      buildHelpComponents(null),
      buildPromptComponents(null),
      buildMergePromptComponents(null),
    ];

    for (const components of samples) {
      for (const [index, component] of (
        components as ComponentShape[]
      ).entries()) {
        walk(component, null, `top[${index}]`);
      }
    }

    expect(problems).toEqual([]);
  });
});
