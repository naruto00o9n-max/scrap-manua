/**
 * تحقق حي: مسار القراءة العلني لروابط Google Drive في أمر /دمج.
 *
 * يحاكي بالضبط ما سيفعله البوت عندما لا يرى حساب OAuth المصرّح له العنصر
 * (تصريح بنطاق «لكل ملف» أو مجلد غير مشترك مع حساب البوت):
 *   1. فحص أن العنصر علني (probePublicDriveItem).
 *   2. تنزيل كل الصور عبر downloadPublicDriveFile بنفس سقوف الحجم.
 *   3. دمجها محليًا بنفس خوارزمية /دمج (openLocalImageMergeSession).
 *
 * الاستخدام:
 *   npx tsx scripts/verify-public-drive-merge.mts --url "https://drive.google.com/drive/folders/<id>" [--out /tmp/drive-public-check]
 */
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { downloadPublicDriveFile, probePublicDriveItem } from "../server/services/drivePublic";
import { openLocalImageMergeSession } from "../server/services/imageMerging";

const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const MAX_IMAGE_BYTES = 60 * 1024 * 1024;

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function parseDriveItemId(raw: string): { id: string; kind: "folder" | "file" } | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return raw.trim().match(/^[-\w]{10,}$/) ? { id: raw.trim(), kind: "folder" } : null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "drive.google.com") return null;
  const folder = url.pathname.match(/\/drive\/(?:u\/\d+\/)?folders\/([-\w]{10,})/);
  if (folder?.[1]) return { id: folder[1], kind: "folder" };
  const file = url.pathname.match(/\/file\/d\/([-\w]{10,})/);
  if (file?.[1]) return { id: file[1], kind: "file" };
  const idParam = url.searchParams.get("id");
  if (idParam && /^[-\w]{10,}$/.test(idParam)) return { id: idParam, kind: "file" };
  return null;
}

async function main(): Promise<void> {
  const rawUrl = argValue("--url");
  if (!rawUrl) {
    console.error("استخدم: --url <رابط مجلد أو ملف Drive>");
    process.exit(1);
  }
  const parsed = parseDriveItemId(rawUrl);
  if (!parsed) {
    console.error("الرابط ليس رابط Drive مدعوم.");
    process.exit(1);
  }
  const outDir = argValue("--out") ?? path.join(tmpdir(), "drive-public-check");
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  console.log(`[1/3] فحص العلنية: ${parsed.kind} ${parsed.id}`);
  const probed = await probePublicDriveItem(parsed.id, parsed.kind);
  if (!probed) {
    console.error("✗ العنصر غير علني — لن يستطيع البوت قراءته عبر المسار العلني.");
    process.exit(2);
  }
  if (probed.kind === "folder") {
    console.log(`✓ مجلد علني: «${probed.name}» — ${probed.files.length} عنصرًا مباشرًا`);
    for (const file of probed.files) console.log(`   · ${file.name} (${file.id})`);
  } else {
    console.log(`✓ ملف علني: «${probed.name}»`);
  }

  console.log("[2/3] تنزيل العناصر عبر الرابط العلني…");
  const downloads = probed.kind === "folder"
    ? probed.files.filter(file => IMAGE_EXTENSIONS.test(file.name))
    : [probed];
  const imagePaths: string[] = [];
  for (let index = 0; index < downloads.length; index += 1) {
    const target = path.join(outDir, `image-${String(index + 1).padStart(4, "0")}.img`);
    await downloadPublicDriveFile(downloads[index]!.id, target, MAX_IMAGE_BYTES);
    const size = (await stat(target)).size;
    imagePaths.push(target);
    console.log(`   ✓ ${downloads[index]!.name} ← ${(size / 1024).toFixed(0)}KB`);
  }
  if (!imagePaths.length) {
    console.error("✗ لا صور قابلة للدمج (لا امتدادات صور مباشرة في المجلد).");
    process.exit(3);
  }

  console.log("[3/3] دمج محلي بنفس خوارزمية /دمج…");
  const session = await openLocalImageMergeSession(imagePaths, async () => {}, undefined, undefined);
  try {
    for (const image of session.images) {
      const size = (await stat(image.filePath)).size;
      console.log(`   ✓ صورة مدمجة ${image.mimeType} ← ${(size / 1024 / 1024).toFixed(1)}MB`);
    }
    console.log(`\n✅ المسار العلني يعمل بالكامل: ${imagePaths.length} صورة مدخلة → ${session.images.length} صورة طويلة.`);
  } finally {
    await session.cleanup();
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error("✗ فشل التحقق:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
