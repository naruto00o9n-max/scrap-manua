import { describe, expect, it } from "vitest";
import {
  buildHelpComponents,
  buildJobCard,
  buildMergeCard,
  buildMergePromptComponents,
  buildMoveCard,
  buildPromptComponents,
  buildSearchCardComponents,
  buildSearchPageNavRow,
  buildSourcesComponents,
  chaptersCount,
  foldersCount,
  getRegisteredDiscordCommands,
  groupSourcesByLang,
  languageGroupLabel,
  mangaStatusAr,
  MAX_MOVE_LINKS,
  moveAccessFailureDetail,
  noticeFromJob,
  paginateForSelect,
  parseDriveFolderLinks,
  safeMediaUrl,
  sitesCount,
  SOURCES_GROUP_LIMIT,
  stripHtmlTags,
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
    expect(names).toEqual(["فصل", "دمج", "مواقع", "بحث", "نقل", "مساعدة"]);
  });

  it("registers the move command with both folder link options required", () => {
    const move = getRegisteredDiscordCommands().find(
      command => command.name === "نقل"
    );
    expect(move).toBeTruthy();
    const options = (move?.options ?? []).map(option => option.name);
    expect(options).toEqual(["من", "إلى"]);
    for (const option of move?.options ?? []) {
      expect(option.required).toBe(true);
    }
  });

  it("never mentions Suwayomi in the registered command descriptions", () => {
    const descriptions = getRegisteredDiscordCommands().map(
      command => command.description
    );
    for (const description of descriptions) {
      expect(description.toLowerCase()).not.toContain("suwayomi");
    }
  });

  it("paginates lists with the Discord select limit and stable global offsets", () => {
    const items = Array.from({ length: 63 }, (_, index) => index);
    const first = paginateForSelect(items, 0);
    expect(first.slice).toHaveLength(25);
    expect(first.totalPages).toBe(3);
    expect(first.start).toBe(0);
    const second = paginateForSelect(items, 1);
    expect(second.start).toBe(25);
    expect(second.slice[0]).toBe(25);
    const last = paginateForSelect(items, 99);
    expect(last.page).toBe(2);
    expect(last.slice).toHaveLength(13);
    expect(paginateForSelect([], 0).totalPages).toBe(1);
  });

  it("builds page navigation row with disabled bounds and a page indicator", () => {
    const nav = buildSearchPageNavRow("page", "s1", 0, 3);
    expect(nav).not.toBeNull();
    const buttons = (nav as { components: Array<Record<string, unknown>> }).components;
    expect(buttons).toHaveLength(3);
    expect(buttons[0]).toMatchObject({
      type: 2,
      custom_id: "search:page:s1:prev",
      disabled: true,
    });
    // زر المؤشر المعطّل يحمل custom_id أيضًا — Discord يرفض أي زر بلا custom_id
    // بخطأ 50035 BUTTON_COMPONENT_CUSTOM_ID_REQUIRED حتى لو كان معطّلًا.
    expect(buttons[1]).toMatchObject({
      type: 2,
      custom_id: "search:page:s1:stay",
      disabled: true,
    });
    expect(buttons[2]).toMatchObject({
      type: 2,
      custom_id: "search:page:s1:next",
      disabled: false,
    });
    expect(buildSearchPageNavRow("cpage", "s2", 0, 1)).toBeNull();
  });

  it("appends a back button to the nav row even when there is a single page", () => {
    const nav = buildSearchPageNavRow("cpage", "s3", 0, 1, {
      label: "عودة إلى النتائج",
      customId: "search:back:s3",
    });
    expect(nav).not.toBeNull();
    const buttons = (nav as { components: Array<Record<string, unknown>> }).components;
    // صفحة واحدة بلا أزرار تنقل — زر العودة وحده، ودائمًا بمعرّف.
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toMatchObject({
      type: 2,
      label: "عودة إلى النتائج",
      custom_id: "search:back:s3",
    });
  });

  it("phrases site counts in Arabic", () => {
    expect(sitesCount(1)).toBe("موقع واحد");
    expect(sitesCount(2)).toBe("موقعين");
    expect(sitesCount(5)).toBe("5 مواقع");
    expect(sitesCount(12)).toBe("12 موقعًا");
  });

  it("phrases folder counts in Arabic", () => {
    expect(foldersCount(1)).toBe("مجلد واحد");
    expect(foldersCount(2)).toBe("مجلدين");
    expect(foldersCount(7)).toBe("7 مجلدات");
    expect(foldersCount(25)).toBe("25 مجلدًا");
  });

  it("builds the move card with live progress and a final open-folder button", () => {
    const [running] = buildMoveCard({
      status: "downloading",
      title: "⏳ جاري النقل",
      label: "من «One Piece [site.com]» إلى «One Piece» — 5 مجلدات",
      progress: { done: 3, total: 5 },
    }) as unknown as [ComponentShape];
    expect(running.type).toBe(17);
    expect(running.accent_color).toBe(0xd4af37);
    const runningTexts = collectTexts([running]).join("\n");
    expect(runningTexts).toContain("3 / 5");
    expect(runningTexts).toContain("من «One Piece [site.com]» إلى «One Piece»");

    const driveUrl = "https://drive.google.com/drive/folders/dest";
    const [done] = buildMoveCard(
      {
        status: "completed",
        title: "✅ تم النقل",
        label: "تم نقل 5 مجلدات إلى «One Piece» — كل مجلد فصل بصوره.",
        driveUrl,
      },
      { requesterId: "656783724662226963" }
    ) as unknown as [ComponentShape];
    expect(done.accent_color).toBe(0x57f287);
    const doneTexts = collectTexts([done]).join("\n");
    expect(doneTexts).toContain("✅ تم النقل");
    expect(doneTexts).toContain(`**رابط المجلد:** ${driveUrl}`);
    expect(doneTexts).toContain("<@656783724662226963>");
    const openButtons = collectButtons([done]).filter(
      button => button.style === 5 && button.url === driveUrl
    );
    expect(openButtons).toHaveLength(1);
    expect(collectButtons([done]).some(button => button.custom_id)).toBe(false);
  });

  it("lists failed folders on the move card when some transfers error", () => {
    const [partial] = buildMoveCard({
      status: "completed",
      title: "⚠️ اكتمل النقل مع أخطاء",
      label: "تم نقل 2 من 3 مجلدات إلى «X» — وتعذر نقل الباقي.",
      detail: "• الفصل 5: تعذر نقل المجلد على Google Drive: خطأ",
    }) as unknown as [ComponentShape];
    expect(partial.accent_color).toBe(0x57f287);
    const texts = collectTexts([partial]).join("\n");
    expect(texts).toContain("⚠️ اكتمل النقل مع أخطاء");
    expect(texts).toContain("• الفصل 5");
  });

  it("extracts every folder link from a numbered multi-link paste", () => {
    const paste = [
      "1- https://drive.google.com/drive/folders/aaaaaaaaaaaaaaaaaaaaaa",
      "2- https://drive.google.com/drive/folders/bbbbbbbbbbbbbbbbbbbbbb",
      "كلام عشوائي بين الروابط",
      "3- https://drive.google.com/drive/folders/cccccccccccccccccccc",
    ].join("\n");
    expect(parseDriveFolderLinks(paste)).toEqual([
      "aaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbb",
      "cccccccccccccccccccc",
    ]);
  });

  it("dedupes repeated folder links, accepts bare ids, and skips file links", () => {
    const value = [
      "https://drive.google.com/drive/folders/aaaaaaaaaaaaaaaaaaaaaa",
      "aaaaaaaaaaaaaaaaaaaaaa", // نفس المجلد كمعرّف مجرد — يُحذف المكرر
      "dddddddddddddddddddd",
      "https://drive.google.com/file/d/eeeeeeeeeeeeeeeeeeee/view", // ملف لا مجلد
    ].join(" ");
    expect(parseDriveFolderLinks(value)).toEqual([
      "aaaaaaaaaaaaaaaaaaaaaa",
      "dddddddddddddddddddd",
    ]);
    expect(parseDriveFolderLinks("لا روابط هنا")).toEqual([]);
    // الفاصلة العربية تفصل الروابط كذلك.
    expect(
      parseDriveFolderLinks(
        "https://drive.google.com/drive/folders/ffffffffffffffffffff، https://drive.google.com/drive/folders/66666666666666666666"
      )
    ).toEqual(["ffffffffffffffffffff", "66666666666666666666"]);
  });

  it("explains access failure with the bot drive account and fix steps", () => {
    const withEmail = moveAccessFailureDetail(
      "إلى",
      "العنصر غير موجود على Google Drive أو لا يُرى من حساب Drive المصرّح للبوت — تأكد من صحة الرابط ومن أن المجلد في نفس الحساب الذي وثّق البوت به.",
      "bot@drive-account.iam.gserviceaccount.com"
    );
    expect(withEmail).toContain("خانة «إلى»");
    expect(withEmail).toContain("**حساب Drive الذي يستخدمه البوت:** bot@drive-account.iam.gserviceaccount.com");
    expect(withEmail).toContain("بصلاحية **محرر**");

    const withoutEmail = moveAccessFailureDetail("من", "سبب ما", null);
    expect(withoutEmail).toContain("خانة «من»");
    expect(withoutEmail).toContain("GDRIVE_REFRESH_TOKEN");
  });

  it("caps the number of folder links accepted per move", () => {
    expect(MAX_MOVE_LINKS).toBe(50);
  });

  it("renders pagination info and page nav buttons on the search results card", () => {
    const matches = Array.from({ length: 25 }, (_, index) => ({
      title: `Work ${26 + index}`,
      sourceName: "Site A",
      lang: "en",
    }));
    const [container] = buildSearchCardComponents(
      {
        state: "results",
        query: "سولو",
        resultCount: 63,
        failedCount: 2,
        page: 2,
        totalPages: 3,
        matches,
      },
      {
        customId: "search:pick:s1",
        placeholder: "اختر…",
        options: matches.map((match, index) => ({
          label: match.title,
          description: "Site A (en)",
          value: String(25 + index),
        })),
      },
      null,
      buildSearchPageNavRow("page", "s1", 1, 3)
    ) as unknown as [
      {
        type: number;
        components: Array<Record<string, unknown>>;
      }
    ];

    expect(container.type).toBe(17);
    const texts = collectTexts([container]).join("\n");
    expect(texts).toContain("63 نتيجة");
    expect(texts).toContain("تعذر الوصول إلى موقعين");
    expect(texts).toContain("الصفحة 2 من 3");
    // ترقيم النتائج يواصل التسلسل العالمي عبر الصفحات (الصفحة الثانية تبدأ من 26).
    expect(texts).toContain("26. Work 26");
    // أزرار التنقل موجودة داخل البطاقة مع قيمها العالمية في القائمة المنسدلة.
    const buttons = collectButtons([container as unknown as ComponentShape]);
    const customIds = buttons
      .map(button => button.custom_id ?? "")
      .filter(Boolean);
    expect(customIds).toContain("search:page:s1:next");
    const select = flatten(container as unknown as ComponentShape).find(
      item => item.type === 3
    );
    expect(select).toBeTruthy();
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
    expect(texts).toContain("✓ فحص الرابط والموقع");
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
    expect(texts).toContain("✓ فحص الرابط والموقع");
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
    expect(texts).toContain("✗ فحص الرابط والموقع");
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
    expect(texts).toContain("### 🔹 /نقل");
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
      ...[
        {
          status: "pending" as const,
          title: "⏳ جاري فحص المجلدين",
        },
        {
          status: "downloading" as const,
          title: "⏳ جاري النقل",
          label: "من «A» إلى «B» — 5 مجلدات",
          progress: { done: 2, total: 5 },
        },
        {
          status: "completed" as const,
          title: "✅ تم النقل",
          label: "تم نقل 5 مجلدات إلى «B».",
          driveUrl: "https://drive.google.com/drive/folders/dest",
        },
        {
          status: "failed" as const,
          title: "❌ روابط غير صالحة",
          detail: "أرسل رابطَي مجلد Google Drive.",
        },
      ].map(notice => buildMoveCard(notice)),
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
    // 1 ActionRow، 2 Button، 3 StringSelect، 9 Section، 10 TextDisplay،
    // 11 Thumbnail، 12 MediaGallery، 14 Separator، 17 Container.
    // أي نوع آخر (كـ 18) يرفضه الـ API.
    const KNOWN_TYPES = new Set([1, 2, 3, 9, 10, 11, 12, 14, 17]);
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
      if (parentType === 1 && component.type !== 2 && component.type !== 3) {
        problems.push(
          `${path}: داخل الصف (1) يُسمح فقط بالأزرار (2) والقوائم المنسدلة (3)`
        );
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
      buildSourcesComponents(
        [
          {
            id: 1,
            name: "RokariComics",
            hostname: "rokaricomics.com",
            baseUrl: "https://rokaricomics.com",
            suwayomiSourceId: "rokaricomics",
            extensionPackage: "rokaricomics",
            extensionName: "RokariComics",
            status: "active",
            documentedIntegrationUrl: null,
            allowDirectChapterLookup: true,
            rejectLoginRequired: true,
            rejectCaptchaRequired: true,
            notes: null,
            origin: "suwayomi",
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        1,
        null
      ),
      ...[
        { state: "progress" as const, query: "سولو", progress: { done: 3, total: 12 }, failedCount: 1 },
        {
          state: "results" as const,
          query: "سولو",
          resultCount: 3,
          failedCount: 0,
          matches: [
            { title: "Solo Leveling", sourceName: "A", lang: "en" },
            { title: "سولو لفلنغ", sourceName: "B", lang: "ar" },
          ],
        },
        {
          state: "availability" as const,
          query: "سولو",
          chapterNumber: 38,
          availability: [
            { ok: true, sourceName: "A", title: "Solo Leveling", detail: "Chapter 38 — 2026-02-01" },
            { ok: false, sourceName: "B", title: "سولو لفلنغ", detail: "لم ينزل بعد في هذا المصدر" },
            { ok: false, sourceName: "C", title: "X", detail: "تعذر الفحص: مهلة" },
          ],
          anyAvailable: true,
        },
        { state: "chapters" as const, mangaTitle: "Solo Leveling", sourceName: "A", totalChapters: 200, chaptersShown: 25 },
        { state: "failed" as const, detail: "لا نتائج" },
      ].map(notice =>
        buildSearchCardComponents(notice, {
          customId: "search:pick:s1",
          placeholder: "اختر…",
          options: [
            { label: "Solo Leveling", description: "A (en)", value: "0" },
            { label: "سولو لفلنغ", description: "B (ar)", value: "1" },
          ],
        })
      ),
      buildSearchCardComponents({ state: "results" as const, query: "x", resultCount: 1, matches: [{ title: "T", sourceName: "S", lang: "en" }] }, null),
      buildSearchCardComponents(
        {
          state: "results" as const,
          query: "سولو",
          resultCount: 63,
          failedCount: 2,
          page: 2,
          totalPages: 3,
          matches: [{ title: "Work 26", sourceName: "A", lang: "en" }],
        },
        {
          customId: "search:pick:s1",
          placeholder: "اختر…",
          options: [{ label: "Work 26", description: "A (en)", value: "25" }],
        },
        null,
        buildSearchPageNavRow("page", "s1", 1, 3)
      ),
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

  it("gives every button a custom_id or a url (50035 BUTTON_COMPONENT_CUSTOM_ID_REQUIRED guard)", () => {
    // زر مؤشر الصفحات المعطّل شُيّد ذات مرة بلا custom_id فرُفضت الرسالة
    // كلها على Discord بخطأ 50035 وتوقف الترقيم واختفى نصف البطاقة.
    const searchNotices = [
      { state: "results" as const, query: "q", resultCount: 63, failedCount: 0, page: 2, totalPages: 3, matches: [{ title: "T", sourceName: "S", lang: "en" }] },
      { state: "availability" as const, query: "q", chapterNumber: 3, anyAvailable: true, availability: [{ ok: true, sourceName: "S", title: "T", detail: null }] },
      { state: "chapters" as const, mangaTitle: "M", sourceName: "S", totalChapters: 60, page: 1, totalPages: 3, thumbnailUrl: null, author: null, artist: null, statusText: null, genres: [], description: null },
    ];
    const samples: unknown[][] = [
      buildJobCard({ status: "downloading", stage: "download", jobId: "j1", progress: { done: 1, total: 5 } }),
      buildMergeCard({ status: "downloading", stage: "merge", mergeId: "m1", progress: { done: 1, total: 5 } }),
      // بطاقة النقل أثناء العمل بلا أزرار — عيّنة المكتمل تحمل زر فتح بالرابط.
      buildMoveCard({
        status: "completed",
        title: "✅ تم النقل",
        driveUrl: "https://drive.google.com/drive/folders/dest",
      }),
      ...searchNotices.map((notice, index) =>
        buildSearchCardComponents(
          notice,
          { customId: `search:pick:sg${index}`, placeholder: "اختر…", options: [{ label: "L", value: "0" }] },
          null,
          buildSearchPageNavRow(
            index === 2 ? "cpage" : "page",
            "sg",
            1,
            3,
            index === 2 ? { label: "عودة إلى النتائج", customId: "search:back:sg" } : undefined
          )
        )
      ),
      // صفحة واحدة: زر العودة وحده في الصف — يجب أن يبقى بمعرّف.
      buildSearchCardComponents(
        { state: "chapters" as const, mangaTitle: "M", sourceName: "S", totalChapters: 5, page: 1, totalPages: 1 },
        { customId: "search:chap:sg9", placeholder: "اختر…", options: [{ label: "L", value: "0" }] },
        null,
        buildSearchPageNavRow("cpage", "sg9", 0, 1, { label: "عودة إلى النتائج", customId: "search:back:sg9" })
      ),
    ];
    for (const components of samples) {
      const buttons = collectButtons(components as ComponentShape[]);
      expect(buttons.length).toBeGreaterThan(0);
      for (const button of buttons) {
        expect(button.custom_id || button.url).toBeTruthy();
      }
    }
  });

  it("phrases chapter counts, statuses, and cleans html summaries", () => {
    expect(chaptersCount(1)).toBe("فصل واحد");
    expect(chaptersCount(2)).toBe("فصلان");
    expect(chaptersCount(7)).toBe("7 فصول");
    expect(chaptersCount(180)).toBe("180 فصلًا");
    expect(mangaStatusAr("ONGOING")).toBe("مستمرة");
    expect(mangaStatusAr("COMPLETED")).toBe("مكتملة");
    expect(mangaStatusAr("CANCELLED")).toBe("ملغاة");
    expect(mangaStatusAr("HIATUS")).toBe("متوقفة مؤقتًا");
    expect(mangaStatusAr("UNKNOWN")).toBeNull();
    expect(mangaStatusAr(null)).toBeNull();
    expect(stripHtmlTags("<p>Hi<br>there</p>  <b>bold</b>")).toBe("Hi\nthere bold");
    expect(safeMediaUrl("https://ok.com/x.jpg")).toBe("https://ok.com/x.jpg");
    expect(safeMediaUrl("http://insecure.com/x.jpg")).toBeNull();
    expect(safeMediaUrl("javascript:alert(1)")).toBeNull();
    expect(safeMediaUrl(null)).toBeNull();
  });

  it("renders the manga page with cover, ordered summary, and total chapters only", () => {
    const [container] = buildSearchCardComponents(
      {
        state: "chapters",
        mangaTitle: "Solo Leveling",
        sourceName: "MangaSwat",
        totalChapters: 180,
        page: 1,
        totalPages: 8,
        thumbnailUrl: "https://example.com/cover.jpg",
        author: "Chugong",
        statusText: "مستمرة",
        genres: ["أكشن", "فانتازيا"],
        description: "قصة سونغ جين وو…",
      },
      {
        customId: "search:chap:s1",
        placeholder: "اختر فصلًا…",
        options: [{ label: "فصل 180", value: "0" }],
      },
      null,
      buildSearchPageNavRow("cpage", "s1", 0, 8, {
        label: "عودة إلى النتائج",
        customId: "search:back:s1",
      })
    ) as unknown as [ComponentShape];

    expect(container.type).toBe(17);
    const texts = collectTexts([container]).join("\n");
    // العنوان في رأس البطاقة مع سطر الموقع.
    expect(texts).toContain("## Solo Leveling");
    expect(texts).toContain("الموقع: **MangaSwat**");
    // التفاصيل مرتبة: القصة ثم المؤلف ثم الحالة ثم التصنيفات.
    expect(texts).toContain("📖 **القصة:** قصة سونغ جين وو…");
    expect(texts).toContain("✍️ **المؤلف:** Chugong");
    expect(texts).toContain("📊 **الحالة:** مستمرة");
    expect(texts).toContain("🏷️ **التصنيفات:** أكشن، فانتازيا");
    // الفصول ملخصًا بالعدد الكلي فقط.
    expect(texts).toContain("📚 **عدد الفصول: 180 فصلًا**");
    expect(texts).toContain("الصفحة 1 من 8");
    // غلاف العمل في رأس القسم بدل صورة البوت.
    const header = container.components![0] as ComponentShape;
    expect(header.accessory).toMatchObject({
      media: { url: "https://example.com/cover.jpg" },
    });
    // زر العودة موجود داخل البطاقة بمعرّفه.
    const back = collectButtons([container]).find(
      button => button.custom_id === "search:back:s1"
    );
    expect(back).toBeTruthy();
  });

  it("falls back gracefully when the cover is missing or unsafe and details are absent", () => {
    const [container] = buildSearchCardComponents(
      {
        state: "chapters",
        mangaTitle: "X",
        sourceName: "S",
        totalChapters: 3,
        page: 1,
        totalPages: 1,
        thumbnailUrl: "http://insecure.com/x.jpg",
        author: null,
        artist: null,
        statusText: null,
        genres: [],
        description: null,
      },
      {
        customId: "search:chap:s2",
        placeholder: "اختر فصلًا…",
        options: [{ label: "فصل 3", value: "0" }],
      },
      null,
      buildSearchPageNavRow("cpage", "s2", 0, 1, {
        label: "عودة إلى النتائج",
        customId: "search:back:s2",
      })
    ) as unknown as [ComponentShape];

    // صورة غير آمنة + لا صورة بوت في الاختبار → لا accessory إطلاقًا.
    const header = container.components![0] as ComponentShape;
    expect(header.accessory).toBeUndefined();
    const texts = collectTexts([container]).join("\n");
    expect(texts).toContain("عدد الفصول: 3 فصول");
    // لا سطور تفاصيل فارغة.
    expect(texts).not.toContain("القصة:");
    expect(texts).not.toContain("المؤلف:");
  });

  it("groups /مواقع sources into ordered language sections with clear separators", () => {
    const source = (id: number, name: string, lang: string | null) => ({
      id,
      name,
      hostname: `${name.toLowerCase()}.com`,
      baseUrl: `https://${name.toLowerCase()}.com`,
      suwayomiSourceId: `src-${id}`,
      extensionPackage: `pkg-${id}`,
      extensionName: name,
      status: "active" as const,
      documentedIntegrationUrl: null,
      allowDirectChapterLookup: true,
      rejectLoginRequired: true,
      rejectCaptchaRequired: true,
      notes: null,
      origin: "suwayomi" as const,
      lang,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const groups = groupSourcesByLang([
      source(1, "EnglishSite", "en"),
      source(2, "ArabicSite", "ar"),
      source(3, "SpanishSite", "es"),
      source(4, "MysterySite", null),
    ]);
    // العربية أولًا ثم الإنجليزية ثم البقية، وبلا لغة آخرًا.
    expect(groups.map(group => group.key)).toEqual(["ar", "en", "es", "other"]);
    expect(groups[0]!.label).toBe("المواقع العربية");
    expect(groups[1]!.label).toBe("المواقع الإنجليزية");
    expect(languageGroupLabel("multi")).toBe("مواقع متعددة اللغات");
    expect(languageGroupLabel(null)).toBe("مواقع أخرى");
    // اللغات غير الشهيرة تُسمّى بالعربية عبر Intl (أو رمزها إن غاب).
    expect(languageGroupLabel("es")).toMatch(/^مواقع/);

    const [container] = buildSourcesComponents(
      [
        source(2, "ArabicSite", "ar"),
        source(1, "EnglishSite", "en"),
        source(4, "MysterySite", null),
      ],
      4,
      null
    ) as unknown as [ComponentShape];
    const texts = collectTexts([container]).join("\n");
    expect(texts).toContain("🌐 **المواقع العربية — 1**");
    expect(texts).toContain("• **ArabicSite** — arabicsite.com ⚡");
    expect(texts).toContain("🌐 **المواقع الإنجليزية — 1**");
    expect(texts).toContain("🌐 **مواقع أخرى — 1**");
    // ترتيب الأقسام في النص نفسه: العربية قبل الإنجليزية قبل الأخرى.
    const arIndex = texts.indexOf("المواقع العربية");
    const enIndex = texts.indexOf("المواقع الإنجليزية");
    const otherIndex = texts.indexOf("مواقع أخرى");
    expect(arIndex).toBeLessThan(enIndex);
    expect(enIndex).toBeLessThan(otherIndex);
  });

  it("truncates oversized language sections with a footer line", () => {
    const source = (id: number) => ({
      id,
      name: `Site${String(id).padStart(2, "0")}`,
      hostname: `site${id}.com`,
      baseUrl: `https://site${id}.com`,
      suwayomiSourceId: `src-${id}`,
      extensionPackage: null,
      extensionName: null,
      status: "active" as const,
      documentedIntegrationUrl: null,
      allowDirectChapterLookup: true,
      rejectLoginRequired: true,
      rejectCaptchaRequired: true,
      notes: null,
      origin: "suwayomi" as const,
      lang: "ar",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const sources = Array.from({ length: SOURCES_GROUP_LIMIT + 5 }, (_, index) => source(index + 1));
    const [container] = buildSourcesComponents(sources, sources.length, null) as unknown as [ComponentShape];
    const texts = collectTexts([container]).join("\n");
    expect(texts).toContain(`🌐 **المواقع العربية — ${SOURCES_GROUP_LIMIT + 5}**`);
    expect(texts).toContain(`و5 موقعًا آخر في هذا القسم…`);
    expect(texts).not.toContain(`Site${String(SOURCES_GROUP_LIMIT + 1).padStart(2, "0")}`);
  });
});
