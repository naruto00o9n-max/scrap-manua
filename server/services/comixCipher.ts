import { createHash } from "node:crypto";

// ============================================================
// تشفير كوميكس (comix.to) — نقل مباشر لخوارزمية إضافة Comix في
// keiyoushi (ملف Cipher.kt) إلى TypeScript:
// - «material» ثلاث صناديق استبدال (256 بايت) وثلاثة مفاتيح (24/32 بايت)
//   تُستخرج من تنفيذ JavaScript الموقع نفسه في متصفح حقيقي — الخادم
//   لا يستطيع تنفيذها لأن Cloudflare يحجب مراكز البيانات، لذا تُلصق
//   مرة واحدة من لوحة التحكم (كود جاهز في بطاقة الإعدادات).
// - sign(path, query) يبني قيمة الباراميتر «_» لطلبات /api/v1.
// - decrypt(value) يفك الاستجابات المشفرة {"e": "..."}.
// ============================================================

/** ثوابت التسلسل لكل جولة — من Cipher.kt (PREVIOUS). */
const PREVIOUS = [189, 133, 32];

export type ComixCipherMaterial = {
  sboxes: number[][];
  keys: number[][];
};

/** يتحقق من سلامة المادة: 3 صناديق × 256 و3 مفاتيح غير فارغة (24/32). */
export function isValidComixMaterial(material: ComixCipherMaterial | null): boolean {
  if (!material) return false;
  if (!Array.isArray(material.sboxes) || material.sboxes.length !== 3) return false;
  if (!material.sboxes.every(sbox => Array.isArray(sbox) && sbox.length === 256 && sbox.every(b => Number.isInteger(b) && b >= 0 && b <= 255))) return false;
  if (!Array.isArray(material.keys) || material.keys.length !== 3) return false;
  if (!material.keys.every(key => Array.isArray(key) && key.length > 0 && key.every(b => Number.isInteger(b) && b >= 0 && b <= 255))) return false;
  return true;
}

/**
 * يقبل المادة بأي صيغة عملية من اللوحة:
 * - JSON كامل: {"sboxes":[[...]],"keys":[[...]]}
 * - JSON بقيم نصية داخلية أو أرقام عشرية (تُقرأ كأعداد صحيحة 0-255)
 * ويعيد null عند أي خلل بدل رمي استثناء.
 */
export function parseComixMaterial(input: string): ComixCipherMaterial | null {
  const cleaned = input.trim();
  if (!cleaned || cleaned.length > 200_000) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as { sboxes?: unknown; keys?: unknown };
  const toBytes = (value: unknown): number[] | null => {
    if (!Array.isArray(value)) return null;
    const bytes = value.map(item => {
      if (typeof item === "number" && Number.isInteger(item)) return item;
      if (typeof item === "string" && /^-?\d+$/.test(item.trim())) return Number(item.trim());
      return -1;
    });
    if (bytes.some(byte => byte < 0 || byte > 255)) return null;
    return bytes;
  };
  const sboxes = Array.isArray(candidate.sboxes) ? candidate.sboxes.map(toBytes) : [];
  const keys = Array.isArray(candidate.keys) ? candidate.keys.map(toBytes) : [];
  if (sboxes.some(sbox => sbox === null) || keys.some(key => key === null)) return null;
  const material: ComixCipherMaterial = {
    sboxes: sboxes as number[][],
    keys: keys as number[][],
  };
  return isValidComixMaterial(material) ? material : null;
}

/** بصمة قصيرة للمادة للعرض في اللوحة بلا كشف قيمها. */
export function comixMaterialFingerprint(material: ComixCipherMaterial): string {
  return createHash("sha256")
    .update(JSON.stringify({ s: material.sboxes, k: material.keys }))
    .digest("hex")
    .slice(0, 12);
}

/** جولة الاستبدال المتسلسل — عكس Cipher.kt.substitute حرفيًا. */
function substituteRound(data: Uint8Array, sbox: number[], key: number[], previous: number): Uint8Array {
  const output = new Uint8Array(data.length);
  let prev = previous;
  for (let index = 0; index < data.length; index += 1) {
    const substituted = sbox[(data[index]! ^ key[index % key.length]! ^ prev) & 0xff]!;
    output[index] = substituted;
    prev = substituted;
  }
  return output;
}

/** جولة فك الاستبدال — عكس Cipher.kt.substituteInverse حرفيًا. */
function substituteInverseRound(data: Uint8Array, sbox: number[], key: number[], previous: number): Uint8Array {
  const inverse = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) inverse[sbox[i]!] = i;
  const output = new Uint8Array(data.length);
  let prev = previous;
  for (let index = 0; index < data.length; index += 1) {
    const value = data[index]!;
    output[index] = (inverse[value]! ^ key[index % key.length]! ^ prev) & 0xff;
    prev = value;
  }
  return output;
}

function base64UrlEncode(data: Uint8Array): string {
  return Buffer.from(data)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
}

/** يعني التشفير الجاهز للتوقيع والفك — بلا حالة قابلة للتعديل بعد البناء. */
export class ComixCipher {
  private readonly sboxes: number[][];
  private readonly keys: number[][];

  constructor(material: ComixCipherMaterial) {
    if (!isValidComixMaterial(material)) {
      throw new Error("مادة تشفير كوميكس غير صالحة.");
    }
    this.sboxes = material.sboxes;
    this.keys = material.keys;
  }

  /** يبني قيمة الباراميتر «_» لمسار واجهة كوميكس (path يبدأ بـ /api/v1). */
  sign(path: string, query: string): string {
    let data: Uint8Array<ArrayBufferLike> = new Uint8Array(Buffer.from(
      `${path.replace(/^\/api\/v1/, "")}${query ? `?${query}` : ""}`,
      "utf8",
    ));
    for (let round = 0; round < 3; round += 1) {
      data = substituteRound(data, this.sboxes[round]!, this.keys[round]!, PREVIOUS[round]!);
    }
    return base64UrlEncode(data);
  }

  /** يفك نص الاستجابة المشفرة {"e": "..."} إلى JSON نصي. */
  decrypt(value: string): string {
    let data = base64UrlDecode(value);
    for (let round = 2; round >= 0; round -= 1) {
      data = substituteInverseRound(data, this.sboxes[round]!, this.keys[round]!, PREVIOUS[round]!);
    }
    return Buffer.from(data).toString("utf8");
  }
}

/** يجمع باراميترات الطلب بالترتيب القياسي نفسه الذي توقعه واجهة كوميكس. */
export function canonicalQueryEntries(params: Record<string, string | string[]>): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  const names = Object.keys(params).sort();
  for (const rawName of names) {
    const value = params[rawName]!;
    const name = rawName.replace(/\[\]$/, "");
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 1 && !rawName.endsWith("[]")) {
      entries.push([name, values[0]!.trim()]);
    } else {
      values.forEach((item, index) => entries.push([`${name}[${index}]`, item.trim()]));
    }
  }
  return entries;
}
