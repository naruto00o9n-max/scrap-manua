// ============================================================
// QQ كوميكس (m.ac.qq.com / ac.qq.com) — سحب الفصول مباشرة
// ============================================================
// موقع تينسنت للمانجا الصينية. صفحة الفصل على النطاق الجوال تدمج كل
// بيانات القارئ داخلها سربًا نصيًا مُبهمًا: JSON مبني على base64 أُقحمت
// فيه أحرف زائدة في مواضع تحددها «nonce» — سلسلة تُبنى في سكربت مدمج
// بتعبيرات eval مُبهمة (أرقام وحروف) تتغير شكلها بين الطلبات.
// فك التباس القارئ نفسه (منقولة حرفيًا من سكربت الموقع index_v2.2):
//   decode(raw, nonce): نقسم النص لمحارف، ثم بمفاتيح nonce «\d+[a-zA-Z]+»
//   نمسح الأحرف الزائدة من الآخر للأمام: position = parseInt(digits)&255
//   وحجم المسح = طول الحروف — ثم base64 → JSON.
// الفصول المدفوعة (VIP) تصل بـ canRead=false أو بلا مصفوفة picture —
// كوكي جلسة موثق من لوحة التحكم قد يفتح الفصول المشتراة في الحساب.
// روابط الفصول المدعومة:
//   https://m.ac.qq.com/chapter/index/id/<comicId>/cid/<chapterId>
//   https://ac.qq.com/ChapterView/index/id/<comicId>/cid/<chapterId> (سطح المكتب)
// ============================================================

/** عامل المستخدم لطلبات QQ كوميكس — متصفح جوال كي يخدم النطاق الجوال صفحة القارئ. */
export const QQ_AC_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const REQUEST_TIMEOUT_MS = 25_000;

/** نطاقات QQ كوميكس — كلها تُخدَم على النطاق الجوال m.ac.qq.com. */
export const QQ_AC_HOSTS = ["m.ac.qq.com", "ac.qq.com"] as const;

export function isQqAcHost(hostname: string | null | undefined): boolean {
  if (!hostname) return false;
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return (QQ_AC_HOSTS as readonly string[]).includes(host);
}

export type QqAcLink = { comicId: string; chapterId: string };

/** يحلل رابط فصل QQ كوميكس ويعيد null لأي رابط لا يخص هذا الموقع. */
export function parseQqAcChapterUrl(rawUrl: string): QqAcLink | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!isQqAcHost(parsed.hostname)) return null;
  const mobile = parsed.pathname.match(/^\/chapter\/index\/id\/(\d+)\/cid\/(\d+)(?:\/)?$/i);
  if (mobile) return { comicId: mobile[1]!, chapterId: mobile[2]! };
  // صيغة سطح المكتب ChapterView تحمل المعرّفات نفسها
  const desktop = parsed.pathname.match(/^\/ChapterView\/index\/id\/(\d+)\/cid\/(\d+)(?:\/)?$/i);
  if (desktop) return { comicId: desktop[1]!, chapterId: desktop[2]! };
  return null;
}

/** رابط الفصل على النطاق الجوال — كل السحب يجري من هناك. */
export function mobileQqAcUrl(comicId: string, chapterId: string): string {
  return `https://m.ac.qq.com/chapter/index/id/${comicId}/cid/${chapterId}`;
}

// ===== مقيّم تعبيرات الـ nonce المُبهمة =====

/**
 * يقيّم تعبيرًا حسابيًا مقيّدًا كما تنتجه طبقة التشويش في الموقع:
 * أرقام وعوامل + - * / ( )، وسلاسل charCodeAt('حرف')، و«!» متسلسلة
 * على أرقام (0/1 كما في JS)، و parseInt(تعبير) بقصّه إلى عدد صحيح.
 * تعيد null عند أي تعبير خارج هذا النطاق — الأمان قبل الذكاء.
 */
export function evaluateNonceExpression(input: string): number | null {
  let expr = input.trim();
  if (!expr || expr.length > 200) return null;
  // 'حرف'.charCodeAt() → رقمه
  expr = expr.replace(/'([^'])'\s*\.\s*charCodeAt\s*\(\s*\)/g, (_m, char: string) => String(char.charCodeAt(0)));
  // ! متسلسلة على أرقام: !5→0 و!!5→1 و!!!5→0
  expr = expr.replace(/(!+)(\d+(?:\.\d+)?)/g, (_m, bangs: string, num: string) => {
    const truthy = Number(num) !== 0;
    const negated = bangs.length % 2 === 1 ? !truthy : truthy;
    return Number(negated).toString();
  });
  // دوال التحويل الصحيح (parseInt وMath.*) — تُقيَّم بطونها أولًا بإعادة الاستدعاء
  const functionPatterns: Array<[RegExp, (value: number) => number]> = [
    [/parseInt\s*\(/, value => Math.trunc(value)],
    [/Math\.round\s*\(/, value => Math.round(value)],
    [/Math\.floor\s*\(/, value => Math.floor(value)],
    [/Math\.ceil\s*\(/, value => Math.ceil(value)],
    [/Math\.abs\s*\(/, value => Math.abs(value)],
  ];
  for (let guard = 0; guard < 8; guard += 1) {
    let next = expr;
    for (const [pattern, apply] of functionPatterns) {
      if (pattern.test(next)) {
        next = next.replace(
          new RegExp(pattern.source + String.raw`\s*([^()]*)\s*\)`),
          (_m, inner: string) => {
            const value = evaluateNonceExpression(inner);
            return value === null ? "NaN" : String(apply(value));
          }
        );
      }
    }
    // ~~x → قصّ صحيح (بواقي أقواس تُترك للتقييم الحسابي)
    next = next.replace(/~~\s*(\d+(?:\.\d+)?)/g, (_m, num: string) => String(Math.trunc(Number(num))));
    if (next === expr) break;
    expr = next;
  }
  if (/Math\.|parseInt|charCodeAt|~~/.test(expr)) return null;
  return evaluateArithmetic(expr);
}

/**
 * يحسب معادلة حسابية خالصة (أرقام — بكسور تبدأ بنقطة أيضًا — و + - * /
 * وأقواس) بمحلّل يدوي صغير — بلا أي تقييم نصّي، فالتعبيرات المجهولة
 * ترجع null لا استثناء.
 */
function evaluateArithmetic(expr: string): number | null {
  if (!expr || expr.length > 200) return null;
  if (!/^[\d\s+\-*/().]*$/.test(expr.replace(/\.\d+/g, "0"))) return null;
  const tokens = expr.match(/\d+\.\d+|\.\d+|\d+|[+\-*/()]/g);
  if (!tokens) return null;
  let position = 0;
  const peek = () => tokens[position];
  const advance = () => tokens[position++];
  const parsePrimary = (): number | null => {
    const token = peek();
    if (token === undefined) return null;
    if (token === "(") {
      advance();
      const value = parseAdditive();
      if (peek() !== ")") return null;
      advance();
      return value;
    }
    if (/^\d/.test(token) || /^\.\d+$/.test(token)) {
      advance();
      return Number(token);
    }
    return null;
  };
  const parseUnary = (): number | null => {
    if (peek() === "-") {
      advance();
      const value = parseUnary();
      return value === null ? null : -value;
    }
    if (peek() === "+") {
      advance();
      return parseUnary();
    }
    return parsePrimary();
  };
  const parseMultiplicative = (): number | null => {
    let left = parseUnary();
    if (left === null) return null;
    while (peek() === "*" || peek() === "/") {
      const operator = advance();
      const right = parseUnary();
      if (right === null) return null;
      left = operator === "*" ? left * right : left / right;
    }
    return left;
  };
  const parseAdditive = (): number | null => {
    let left = parseMultiplicative();
    if (left === null) return null;
    while (peek() === "+" || peek() === "-") {
      const operator = advance();
      const right = parseMultiplicative();
      if (right === null) return null;
      left = operator === "+" ? left + right : left - right;
    }
    return left;
  };
  const value = parseAdditive();
  if (position !== tokens.length || value === null || !Number.isFinite(value)) return null;
  return value;
}

/**
 * يبني الـ nonce من تعبير الإسناد المُبهم كما يظهر في سكربت الصفحة:
 *   window["n"+"once"] = "596a" + (+eval("4 * 1 / 4")).toString() + "9769…" + ""
 * يجمع السلاسل الحرفية ويقيّم كل eval ويحوّله إلى نص عدد صحيح (دلالة
 * (+x).toString() في JS — x صغير موجب فيصير نصه بلا كسور).
 * يعيد null عند أي صيغة غير مفهومة.
 */
export function evaluateNonceAssignment(expression: string): string | null {
  const trimmed = expression.trim().replace(/;+\s*$/, "");
  if (!trimmed || trimmed.length > 600) return null;
  let nonce = "";
  // تفكيك على «+» خارج النصوص المقتبسة فقط — تعبيرات eval قد تحمل
  // «+» داخل نصّها (مثل "!!1+!1+!!2+!!2+1") فلا يصح التقسيم الأعمى
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]!;
    if (quote) {
      current += char;
      if (char === "\\") {
        current += trimmed[index + 1] ?? "";
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"') {
      quote = '"';
      current += char;
      continue;
    }
    // «+» فاصل تجميع فقط حين يسبقه معامل — أما «(+eval(…))» فزائد أحادي
    // يبقى ضمن القطعة، وكذلك «+» داخل eval غير المقتبسة بعد قوس
    if (char === "+" && current.trim() !== "" && !/\(\s*$/.test(current)) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (quote) return null;
  parts.push(current);
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) return null;
    const literal = part.match(/^"([^"]*)"$/);
    if (literal) {
      nonce += literal[1];
      continue;
    }
    // (+eval("…")).toString() أو eval("…").toString()
    const evalPart = part.match(/^\(?\s*\+?\s*eval\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)\s*\)?(?:\s*\.\s*toString\s*\(\s*\))?$/);
    if (evalPart) {
      const inner = (evalPart[1] ?? "").replace(/\\"/g, '"');
      const value = evaluateNonceExpression(inner);
      if (value === null) return null;
      nonce += String(Math.trunc(value));
      continue;
    }
    // عدد حرفي مباشر (نادر لكن مسموح به)
    if (/^\d+$/.test(part)) {
      nonce += part;
      continue;
    }
    return null;
  }
  return /^[0-9a-f]{8,64}$/i.test(nonce) ? nonce : null;
}

/** يستخرج تعبير إسناد nonce من HTML الصفحة ويعيد nonce جاهزًا — أو null. */
export function extractQqAcNonce(html: string): string | null {
  // المفتاح يُكتب مقسّمًا بسلاسل متجاورة: window["n"+"once"] و["nonc"+"e"]
  // و["no"+"nce"]… — نمط عام لأي تقسيم لسلسلتين ثم تحقّق أن حاصل جمعهما nonce
  const patterns = [
    /window\s*\[\s*"([a-z]{1,5})"\s*\+\s*"([a-z]{1,5})"\s*\]\s*=\s*([\s\S]*?)<\/script>/gi,
    /window\s*\.\s*nonce\s*=\s*([\s\S]*?)<\/script>/gi,
  ];
  for (const pattern of patterns) {
    for (const match of Array.from(html.matchAll(pattern))) {
      const [, first, second, expression] = match;
      // التحقق من أن المفتاح المفكك هو nonce فعلًا
      if (first !== undefined && second !== undefined) {
        if (`${first}${second}`.toLowerCase() !== "nonce") continue;
      }
      const tail = expression ?? "";
      // التقييم على الكتلة كاملة أولًا (الإسناد قد ينتهي بسلسلة حرفية بعد
      // آخر قوس) — وإن فشل جُرّب القص عند آخر قوس إغلاق لأسابيع نص تالٍ
      const nonce = evaluateNonceAssignment(tail) ?? (() => {
        const cut = tail.slice(0, tail.lastIndexOf(")") + 1 || tail.length);
        return cut === tail ? null : evaluateNonceAssignment(cut);
      })();
      if (nonce) return nonce;
    }
  }
  return null;
}

// ===== فك سرب البيانات =====

/** عنصر صفحة في سرب picture. */
export type QqAcPicture = { pid?: string; width?: number; height?: number; url?: string };

/** سرب بيانات الفصل بعد فك التباس — الحقول المستخدمة فقط. */
export type QqAcData = {
  comic?: { id?: number | string; title?: string | null; finishState?: boolean } | null;
  chapter?: {
    cid?: number | string;
    title?: string | null;
    canRead?: boolean;
    seqNo?: number | string;
    nextCid?: number | string | null;
    prevCid?: number | string | null;
  } | null;
  picture?: QqAcPicture[] | null;
};

/**
 * يفك سرب البيانات المُبهم بخوارزمية القارئ نفسها: مفاتيح nonce «\d+[a-zA-Z]+»
 * تُطبَّق من الأخير للأول (بصمت التطابق مع حلقة i-- في الموقع)، وموضع المسح
 * parseInt(الأرقام)&255 بطول الحروف، ثم base64 → JSON.
 * يعيد null عند فشل الفك (سرب تالف/nonce لا يطابق).
 */
export function decodeQqAcData(raw: string, nonce: string): QqAcData | null {
  if (!raw || !nonce) return null;
  const tokens = nonce.match(/\d+[a-zA-Z]+/g);
  if (!tokens || !tokens.length) return null;
  const chars = raw.split("");
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]!;
    const parsed = token.match(/^(\d+)([a-zA-Z]+)$/);
    if (!parsed) return null;
    const position = Number.parseInt(parsed[1]!, 10) & 255;
    const length = parsed[2]!.length;
    if (position > chars.length) return null;
    chars.splice(position, length);
  }
  const base64 = chars.join("");
  try {
    const binary = Buffer.from(base64, "base64");
    const text = binary.toString("utf8");
    return JSON.parse(text) as QqAcData;
  } catch {
    return null;
  }
}

/** يستخرج سرب البيانات المدمج في الصفحة (‎data: 'eyJ…'‎ داخل إعداد الصفحة). */
export function extractQqAcPageData(html: string): string | null {
  const match = html.match(/data:\s*'((?:[^'\\]|\\.)*)'/);
  if (match?.[1]) {
    const value = match[1].replace(/\\'/g, "'");
    return value.length > 32 ? value : null;
  }
  return null;
}

/** عنصر في فهرس فصول العمل كما يدمجه الصفحة في data_chapterInfo. */
export type QqAcChapterEntry = {
  cid: number;
  seqNo: number;
  title: string;
  url: string;
  vipState: number | null;
};

/** يستخرج فهرس فصول العمل من كتلة data_chapterInfo — أو null. */
export function extractQqAcChapterList(html: string): QqAcChapterEntry[] | null {
  const match = html.match(
    /<script[^>]*id="data_chapterInfo"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1].trim()) as Array<Record<string, unknown>>;
    if (!Array.isArray(parsed)) return null;
    const entries: QqAcChapterEntry[] = [];
    for (const item of parsed) {
      const cid = typeof item.cid === "number" ? item.cid : Number(item.cid);
      if (!Number.isFinite(cid)) continue;
      const seqNo = typeof item.seq_no === "number" ? item.seq_no : Number(item.seq_no ?? 0);
      entries.push({
        cid,
        seqNo: Number.isFinite(seqNo) ? seqNo : 0,
        title: typeof item.cTitle === "string" ? item.cTitle : typeof item.title === "string" ? item.title : "",
        url: typeof item.url === "string" ? item.url : "",
        vipState: typeof item.vipStatus === "number" ? item.vipStatus : null,
      });
    }
    return entries;
  } catch {
    return null;
  }
}

/** نتيجة جلب فصل QQ كوميكس. */
export type QqAcOutcome =
  | { ok: true; mangaTitle: string; chapterName: string; pages: string[] }
  | { ok: false; locked: boolean; message: string };

/**
 * المسار الكامل لرابط فصل QQ كوميكس: فتح صفحة الفصل على النطاق الجوال →
 * بناء nonce من السكربت المدمج → فك سرب البيانات → استخراج العناوين والصور.
 * cookie جلسة اختيارية (من لوحة التحكم) لمحاولة الفصول المدفوعة المشتراة.
 */
export async function fetchQqAcChapter(
  rawUrl: string,
  cookie?: string | null
): Promise<QqAcOutcome> {
  const parsed = parseQqAcChapterUrl(rawUrl);
  if (!parsed) {
    return { ok: false, locked: false, message: "الرابط ليس رابط فصل QQ كوميكس معروفًا." };
  }
  const headers: Record<string, string> = {
    "user-agent": QQ_AC_UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    referer: mobileQqAcUrl(parsed.comicId, parsed.chapterId),
  };
  if (cookie) headers.cookie = cookie;
  let html: string;
  try {
    const response = await fetch(mobileQqAcUrl(parsed.comicId, parsed.chapterId), {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        ok: false,
        locked: false,
        message: `صفحة الفصل في QQ كوميكس ردّت بحالة ${response.status} — الموقع مشغول أو يحجب الطلب، أعد المحاولة.`,
      };
    }
    html = await response.text();
  } catch (error) {
    return {
      ok: false,
      locked: false,
      message: `تعذر فتح صفحة الفصل في QQ كوميكس: ${error instanceof Error && error.message ? error.message : "خطأ شبكة غير معروف"}`,
    };
  }

  const nonce = extractQqAcNonce(html);
  if (!nonce) {
    return {
      ok: false,
      locked: false,
      message: "تعذر قراءة مفتاح فك تشويش QQ كوميكس من الصفحة — غيّر الموقع صيغته، أبلغ المالك.",
    };
  }
  const payload = extractQqAcPageData(html);
  if (!payload) {
    return {
      ok: false,
      locked: false,
      message: "لم أجد سرب بيانات الفصل في صفحة QQ كوميكس — غيّر الموقع صيغته، أبلغ المالك.",
    };
  }
  const data = decodeQqAcData(payload, nonce);
  if (!data) {
    return {
      ok: false,
      locked: false,
      message: "فشل فك تشويش بيانات الفصل في QQ كوميكس — ربما تجددت حماية الموقع، أبلغ المالك.",
    };
  }

  const pages = (data.picture ?? [])
    .map(page => (typeof page?.url === "string" ? page.url.trim() : ""))
    .filter(url => url.length > 0)
    .map(url => (url.startsWith("//") ? `https:${url}` : url));
  if (!pages.length) {
    const chapter = data.chapter ?? {};
    if (chapter.canRead === false) {
      return {
        ok: false,
        locked: true,
        message:
          "هذا الفصل مدفوع (VIP) في QQ كوميكس ولا يفتح إلا بعد شرائه في الحساب. لسحبه وثّق جلسة حسابك الموثق من لوحة التحكم ثم أعد /فصل.",
      };
    }
    return {
      ok: false,
      locked: false,
      message: "استجابة QQ كوميكس جاءت بلا صفحات — الفصل مدفوع غالبًا أو أن الموقع غيّر استجابته.",
    };
  }

  const mangaTitle = (data.comic?.title ?? "").trim() || "العمل";
  const chapterName = (data.chapter?.title ?? "").trim() || "الفصل";
  return { ok: true, mangaTitle, chapterName, pages };
}
