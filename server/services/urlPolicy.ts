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
  rejectLoginRequired: boolean;
  rejectCaptchaRequired: boolean;
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
  return hostname.toLowerCase().replace(/^www\./, "");
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

  const accessPath = `${parsed.pathname}${parsed.search}`.toLowerCase();
  if (source.rejectLoginRequired && /(?:login|sign-in|signin|oauth|authenticate)/.test(accessPath)) {
    throw new UrlPolicyError("LOGIN_NOT_ALLOWED", "يرفض النظام روابط تسجيل الدخول أو المصادقة للمصادر المصرح بها.");
  }
  if (source.rejectCaptchaRequired && /(?:captcha|challenge|verify)/.test(accessPath)) {
    throw new UrlPolicyError("CAPTCHA_NOT_ALLOWED", "يرفض النظام الروابط التي تشير إلى CAPTCHA أو تحدي وصول.");
  }

  const canonicalUrl = canonicalize(parsed);
  return {
    canonicalUrl,
    hostname,
    sourceId: source.id,
    urlHash: createHash("sha256").update(canonicalUrl).digest("hex"),
  };
}
