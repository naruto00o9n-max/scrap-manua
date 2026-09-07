import { createHash } from "node:crypto";
import { isIP } from "node:net";

const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain", "metadata.google.internal"]);
const BLOCKED_SUFFIXES = [".local", ".internal", ".localhost"];

export class UrlPolicyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "UrlPolicyError";
  }
}

export type AllowedSourceForPolicy = {
  id: number;
  hostname: string;
  status: "active" | "disabled";
  allowDirectChapterLookup: boolean;
};

export type ValidatedChapterUrl = {
  canonicalUrl: string;
  urlHash: string;
  hostname: string;
  sourceId: number;
};

function isForbiddenHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    BLOCKED_HOSTS.has(normalized) ||
    BLOCKED_SUFFIXES.some(suffix => normalized.endsWith(suffix)) ||
    isIP(normalized) !== 0
  );
}

function normalizeHostname(hostname: string): string {
  const normalized = hostname.toLowerCase().replace(/^www\./, "");
  // webtoons.com and www.webtoons.com serve the same catalog as m.webtoons.com,
  // so canonicalize them onto the registered source hostname.
  if (normalized === "webtoons.com") return "m.webtoons.com";
  return normalized;
}

function canonicalize(parsed: URL): string {
  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";
  parsed.hostname = normalizeHostname(parsed.hostname);

  for (const key of Array.from(parsed.searchParams.keys())) {
    if (key.toLowerCase().startsWith("utm_")) parsed.searchParams.delete(key);
  }

  return parsed.toString();
}

export function validateChapterUrl(input: string, allowedSources: AllowedSourceForPolicy[]): ValidatedChapterUrl {
  const raw = input.trim();
  if (!raw || raw.length > 2000) {
    throw new UrlPolicyError("INVALID_URL", "رابط الفصل غير صالح أو أطول من الحد المسموح.");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UrlPolicyError("INVALID_URL", "أدخل رابط فصل كامل يبدأ بـ https://.");
  }

  if (parsed.protocol !== "https:") {
    throw new UrlPolicyError("HTTPS_REQUIRED", "يقبل النظام روابط HTTPS فقط.");
  }

  if (parsed.username || parsed.password || parsed.port) {
    throw new UrlPolicyError("UNSAFE_URL", "لا يقبل النظام روابط تحتوي بيانات دخول أو منفذًا مخصصًا.");
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (isForbiddenHost(hostname)) {
    throw new UrlPolicyError("UNSAFE_HOST", "هذا الرابط لا يشير إلى مصدر خارجي مسموح.");
  }

  const source = allowedSources.find(item => normalizeHostname(item.hostname) === hostname);
  if (!source) {
    throw new UrlPolicyError("SOURCE_NOT_ALLOWED", "هذا النطاق غير مدرج ضمن المصادر المسموح بها.");
  }

  if (source.status !== "active" || !source.allowDirectChapterLookup) {
    throw new UrlPolicyError("SOURCE_NOT_READY", "هذا المصدر غير مفعّل أو لم يُتحقق من تكامله بعد.");
  }

  // طلب المالك: لا رفض لأي رابط بسبب كلمات في مساره (كابشا/تحقق/دخول) —
  // روابط WEBTOON تحمل «challenge» في مسارها وهي أعمال القرّاء وليست صفحة
  // تحقق، والمحاولة الفعلية للسحب هي التي تحسم نجاح الرابط أو فشله.

  const canonicalUrl = canonicalize(parsed);
  return {
    canonicalUrl,
    hostname,
    sourceId: source.id,
    urlHash: createHash("sha256").update(canonicalUrl).digest("hex"),
  };
}
