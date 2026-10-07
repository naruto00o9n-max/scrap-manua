// ============================================================
// كوايكان مانها (kuaikanmanhua.com) — سحب الفصول مباشرة
// ============================================================
// منصة كوايكان الصينية. صفحة الفصل على النطاق الجوال تطبيق Nuxt يحمل
// حالة القارئ كاملة داخل window.__NUXT__: سرب مُشفَّر بصيغة NUXT
// القياسية — استدعاء دالة بمعاملات نصية يُشار إليها من جسم الحالة
// بالمعرفات نفسها (a,b,…,z,A,…,Z,_,$,aa,ab…). صفحات الفصل داخل
// comic_images: لكل عنصر url بدقة w640 وurl1280 بدقة w1280 (معرف
// دالة يُحلّ إلى رابط موقع) موقعة بعلامة sign صالحة مؤقتًا — تُستهلك
// فورًا. صور CDN كوايكان ترفض الطلبات بلا UA، وReferer يرسل معها.
// روابط الفصول المدعومة:
//   https://kuaikanmanhua.com/mobile/comics/<id>/
//   https://m.kuaikanmanhua.com/mobile/comics/<id>/
//   https://kuaikanmanhua.com/web/comic/<id> (قارئ سطح المكتب)
// الفصول المدفوعة تصل بلا comic_images (أو بعلامات is_pay_comic/
// locked في topic_info) — تُرفض بنعرفة مع رسالة تشرح السبب.
// ============================================================

/** عامل المستخدم لطلبات كوايكان — متصفح سطح مكتب حديث. */
export const KUAIKAN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = 25_000;

/** نطاقات كوايكان — نفس الكتالوج على الجوال وسطح المكتب. */
export const KUAIKAN_HOSTS = ["kuaikanmanhua.com", "m.kuaikanmanhua.com"] as const;

export function isKuaikanHost(hostname: string | null | undefined): boolean {
  if (!hostname) return false;
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return (KUAIKAN_HOSTS as readonly string[]).includes(host);
}

export type KuaikanLink = { comicId: string };

/** يحلل رابط فصل كوايكان ويعيد null لأي رابط لا يخص هذا الموقع. */
export function parseKuaikanUrl(rawUrl: string): KuaikanLink | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!isKuaikanHost(parsed.hostname)) return null;
  // صيغة الجوال /mobile/comics/<id>/ وصيغة سطح المكتب /web/comic/<id>
  const match = parsed.pathname.match(/^\/(?:mobile\/comics|web\/comic)\/(\d+)(?:\/)?$/i);
  return match ? { comicId: match[1]! } : null;
}

/** يحلل أي سلسلة مهربة بأسلوب JS (\uXXXX و \" و \\ و \n) إلى نصها الحقيقي. */
export function unescapeJsString(value: string): string {
  return value.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_m, token: string) => {
    if (token[0] === "u" || token[0] === "x") {
      const code = Number.parseInt(token.slice(1), 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : token;
    }
    switch (token) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      default: return token;
    }
  });
}

/**
 * يستخرج سرب حالة NUXT من HTML الصفحة: من window.__NUXT__= حتى إغلاق
 * السكربت. يعيد null إن لم يوجد.
 */
export function extractKuaikanNuxtPayload(html: string): string | null {
  const start = html.indexOf("window.__NUXT__=");
  if (start === -1) return null;
  const end = html.indexOf("</script>", start);
  if (end === -1) return null;
  const payload = html.slice(start + "window.__NUXT__=".length, end).trim();
  return payload.length > 64 ? payload : null;
}

/**
 * يحلل NUXT سربًا كاملًا إلى خريطة معرف→قيمة: معرفات المعاملات من توقيع
 * الدالة (a,b,…,_,$,aa,ab…) وقيمها من وسائط الاستدعاء الأخير ("نص"/رقم/null).
 * يعيد null عند بنية غير مفهومة.
 */
export function parseNuxtPayload(payload: string): Map<string, string> | null {
  // الوسائط: آخر استدعاء }("a","b",…)) في السرب
  const callStart = payload.lastIndexOf("}(");
  if (callStart === -1) return null;
  const callBody = payload.slice(callStart + 2);
  const values = parseNuxtCallArgs(callBody);
  if (!values) return null;
  // توقيع المعاملات: أول قوسين بعد (function(
  const signature = payload.match(/^[(]?function\s*\(([^)]*)\)/);
  if (!signature?.[1]) return null;
  const params = signature[1].split(",").map(name => name.trim()).filter(Boolean);
  if (!params.length || params.length !== values.length) return null;
  const map = new Map<string, string>();
  for (let index = 0; index < params.length; index += 1) {
    map.set(params[index]!, values[index] ?? "");
  }
  return map;
}

/** يحلل وسائط الاستدعاء النهائية ("نص","نص",رقم,null…) إلى قيم نصية. */
function parseNuxtCallArgs(body: string): string[] | null {
  const values: string[] = [];
  // regex لاصق (y) يفحص من الموضع الحالي فقط — بلا نسخ السلسلة في كل تكرار
  const literalPattern = /^(null|true|false|-?\d+(?:\.\d+)?)/;
  const index_end = body.length;
  let index = 0;
  while (index < index_end) {
    const char = body[index]!;
    if (char === " " || char === "\n" || char === "\r" || char === "\t" || char === ",") {
      index += 1;
      continue;
    }
    if (char === ")") break;
    if (char === '"' || char === "'") {
      const quote = char;
      let value = "";
      index += 1;
      let terminated = false;
      while (index < index_end) {
        const inner = body[index]!;
        if (inner === "\\") {
          value += inner + (body[index + 1] ?? "");
          index += 2;
          continue;
        }
        if (inner === quote) {
          terminated = true;
          index += 1;
          break;
        }
        value += inner;
        index += 1;
      }
      if (!terminated) return null;
      values.push(unescapeJsString(value));
      continue;
    }
    // Array(n): قيمة مصفوفة تملأ بإسنادات في جسم الحالة — لا تُستخدم
    // كرابط صور مباشر، يكفي قبولها كقيمة فارغة حتى لا يفشل التحليل
    const arrayValue = body.slice(index, index + 16).match(/^Array\(\d+\)/);
    if (arrayValue?.[0]) {
      values.push("");
      index += arrayValue[0].length;
      continue;
    }
    // {}: كائن فارغ يملأ بإسنادات في جسم الحالة — يُقبل كقيمة فارغة
    if (body[index] === "{" && body[index + 1] === "}") {
      values.push("");
      index += 2;
      continue;
    }
    const literal = body.slice(index, index + 12).match(literalPattern);
    if (!literal?.[1]) return null;
    values.push(literal[1] === "null" ? "" : (literal[1] ?? ""));
    index += literal[1].length;
  }
  return values;
}

/**
 * يستخرج روابط صفحات الفصل من جسم حالة NUXT: عناصر comic_images على
 * الصيغة {width:X,height:Y,url:"…",width1280:N,url1280:معرف} — يُفضل
 * url1280 (الدقة الأعلى) ويُحل معرفه عبر خريطة المعاملات، وإن لم يوجد
 * يُستخدم url المضمّن. الترتيب كما في القارئ.
 */
export function extractKuaikanImages(payload: string, params?: Map<string, string>): string[] {
  const map = params ?? parseNuxtPayload(payload);
  if (!map) return [];
  const imagesStart = payload.indexOf("comic_images:[");
  if (imagesStart === -1) return [];
  const body = payload.slice(imagesStart + "comic_images:[".length);
  const elementPattern = /\{width:[^{}]*?url:"((?:[^"\\]|\\.)*)"(?:\s*,\s*width1280:[^,}]+,\s*url1280:([A-Za-z_$][\w$]*))?/g;
  const urls: string[] = [];
  for (const match of Array.from(body.matchAll(elementPattern))) {
    const inline = match[1] ? unescapeJsString(match[1]) : "";
    const highResRef = match[2];
    const resolved = highResRef ? map.get(highResRef) ?? "" : "";
    const url = (resolved || inline).trim();
    if (url) urls.push(url);
  }
  return urls;
}

/**
 * يفصل عنوان العمل عن اسم الفصل من <title> صفحة كوايكان:
 * «第1话 穿成恶毒长公主？！｜穿书后…漫画｜官方在线漫画全集-快看漫画»
 * → الفصل: 第1话 穿成恶毒长公主？！ والعمل: 穿书后… (بلا لاحقة 漫画).
 */
export function parseKuaikanTitle(pageTitle: string): { mangaTitle: string; chapterName: string } {
  const title = pageTitle.trim();
  const segments = title.split("｜").map(part => part.trim()).filter(Boolean);
  if (segments.length >= 2) {
    const chapterName = segments[0] ?? "";
    const mangaTitle = (segments[1] ?? "").replace(/漫画$/, "").trim();
    if (chapterName && mangaTitle) return { mangaTitle, chapterName };
  }
  return { mangaTitle: title, chapterName: "" };
}

/** يستخرج عنوان الصفحة من HTML. */
export function extractKuaikanPageTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1]?.trim() ?? "";
}

/**
 * علامات الفصل المدفوع في حالة NUXT: topic_info.comics[0] يحمل
 * is_pay_comic — قيمته معرف معامل يُحل عبر خريطة القيم: true/1 يعني مدفوع.
 */
export function isKuaikanPayComic(payload: string, params?: Map<string, string>): boolean {
  const map = params ?? parseNuxtPayload(payload);
  if (!map) return false;
  const match = payload.match(/is_pay_comic:(\w+)/);
  if (!match?.[1]) return false;
  const value = map.get(match[1]);
  return value === "true" || value === "1";
}

/** نتيجة جلب فصل كوايكان. */
export type KuaikanOutcome =
  | { ok: true; mangaTitle: string; chapterName: string; pages: string[] }
  | { ok: false; locked: boolean; message: string };

/**
 * المسار الكامل لرابط فصل كوايكان: فتح صفحة الفصل → استخراج سرب NUXT →
 * حل معرفات الصور → العناوين والصفحات. cookie جلسة اختيارية (مقبل للتوافق
 * مع التوجيه العام — الموقع المجاني لا يحتاجها).
 */
export async function fetchKuaikanChapter(
  rawUrl: string,
  cookie?: string | null
): Promise<KuaikanOutcome> {
  const parsed = parseKuaikanUrl(rawUrl);
  if (!parsed) {
    return { ok: false, locked: false, message: "الرابط ليس رابط فصل كوايكان معروفًا." };
  }
  const headers: Record<string, string> = {
    "user-agent": KUAIKAN_UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    referer: "https://kuaikanmanhua.com/",
  };
  if (cookie) headers.cookie = cookie;
  let html: string;
  try {
    const response = await fetch(`https://kuaikanmanhua.com/mobile/comics/${parsed.comicId}/`, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        ok: false,
        locked: false,
        message: `صفحة الفصل في كوايكان ردّت بحالة ${response.status} — الموقع مشغول أو يحجب الطلب، أعد المحاولة.`,
      };
    }
    html = await response.text();
  } catch (error) {
    return {
      ok: false,
      locked: false,
      message: `تعذر فتح صفحة الفصل في كوايكان: ${error instanceof Error && error.message ? error.message : "خطأ شبكة غير معروف"}`,
    };
  }

  const payload = extractKuaikanNuxtPayload(html);
  if (!payload) {
    return {
      ok: false,
      locked: false,
      message: "لم أجد حالة القارئ في صفحة كوايكان — غيّر الموقع صيغته، أبلغ المالك.",
    };
  }
  const params = parseNuxtPayload(payload);
  if (!params) {
    return {
      ok: false,
      locked: false,
      message: "فشل تحليل حالة القارئ في كوايكان — ربما تجددت صيغة الموقع، أبلغ المالك.",
    };
  }
  const pages = extractKuaikanImages(payload, params)
    .map(url => (url.startsWith("//") ? `https:${url}` : url));
  if (!pages.length) {
    if (isKuaikanPayComic(payload, params)) {
      return {
        ok: false,
        locked: true,
        message:
          "هذا الفصل مدفوع في كوايكان ولا يفتح إلا بعد شرائه في الحساب. لسحبه وثّق جلسة حسابك الموثق من لوحة التحكم ثم أعد /فصل.",
      };
    }
    return {
      ok: false,
      locked: false,
      message: "استجابة كوايكان جاءت بلا صفحات — الفصل مدفوع غالبًا أو أن الموقع غيّر استجابته.",
    };
  }
  const { mangaTitle, chapterName } = parseKuaikanTitle(extractKuaikanPageTitle(html));
  return {
    ok: true,
    mangaTitle: mangaTitle || "العمل",
    chapterName: chapterName || "الفصل",
    pages,
  };
}
