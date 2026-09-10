/**
 * توليد GDRIVE_REFRESH_TOKEN بالنطاق الكامل (https://www.googleapis.com/auth/drive).
 *
 * لماذا؟ نطاق drive.file المحدود يجعل البوت يرى المجلدات التي أنشأها هو فقط،
 * حتى المجلدات المشتركة مع حساب البوت بصلاحية محرر لا يراها — فيفشل
 * /نقل و/دمج عليها. بالنطاق الكامل يرى البوت كل ما شُوِك معه ويعمل النقل.
 *
 * الاستخدام:
 *   1) اضبط GDRIVE_CLIENT_ID و GDRIVE_CLIENT_SECRET في البيئة (أو مرّرهما كوسيطين)،
 *      وإن كان OAuth Client من نوع Web فأضف http://localhost:43617 إلى
 *      Authorized redirect URIs في Google Cloud Console (نوع Desktop لا يحتاج ذلك):
 *        GDRIVE_CLIENT_ID=... GDRIVE_CLIENT_SECRET=... npx tsx scripts/mint-drive-token.mts
 *   2) افتح رابط التفويض الظاهر وسجّل الدخول بحساب البوت ثم وافق.
 *   3) يعود المتصفح إلى localhost ويطبع السكربت التوكن الجديد ونطاقه ثم ينتهي.
 *   4) ضع التوكن في GDRIVE_REFRESH_TOKEN في Railway وأعد النشر.
 *
 * وضع بديل يدوي: npx tsx scripts/mint-drive-token.mts --code <كود التفويض>
 * (الكود من رابط تفويض بنفس redirect_uri أعلاه).
 */
import http from "node:http";
import { google } from "googleapis";

const REDIRECT_PORT = 43617;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;
const FULL_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

const argv = process.argv.slice(2);
const codeArgIndex = argv.indexOf("--code");
const manualCode = codeArgIndex >= 0 ? argv[codeArgIndex + 1] : undefined;
const positional = argv.filter((value, index) => value !== "--code" && index !== codeArgIndex + 1);
const clientId = process.env.GDRIVE_CLIENT_ID ?? positional[0] ?? "";
const clientSecret = process.env.GDRIVE_CLIENT_SECRET ?? positional[1] ?? "";

if (!clientId || !clientSecret) {
  console.error(
    "أضبط GDRIVE_CLIENT_ID و GDRIVE_CLIENT_SECRET في البيئة أو مرّرهما: npx tsx scripts/mint-drive-token.mts <CLIENT_ID> <CLIENT_SECRET>"
  );
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

async function finish(code: string) {
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    console.error(
      "لم يعيد Google Refresh Token — أعد التفويض مع إجبار موافقة جديدة (أزل التطبيق من حسابك ثم أعد، أو أضف prompt=consent وهو مضاف هنا أصلًا)."
    );
    process.exit(1);
  }
  console.log("\n=== GDRIVE_REFRESH_TOKEN الجديد ===\n");
  console.log(tokens.refresh_token);
  console.log(`\nالنطاق الممنوح: ${tokens.scope ?? FULL_DRIVE_SCOPE}`);
  console.log(
    `\nالخطوة الأخيرة: ضع التوكن في GDRIVE_REFRESH_TOKEN في Railway ثم أعد النشر — بعدها يرى البوت المجلدات المشتركة معه ويعمل /نقل و/دمج عليها.`
  );
  process.exit(0);
}

if (manualCode) {
  await finish(manualCode);
}

const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: [FULL_DRIVE_SCOPE],
});

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://localhost:${REDIRECT_PORT}`);
  const code = url.searchParams.get("code");
  if (!code) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("لا يوجد كود تفويض في الرابط.");
    return;
  }
  response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  response.end("تم التفويض — ارجع إلى الطرفية وستجد التوكن الجديد.");
  void finish(code).catch(error => {
    console.error("تعذر استبدال الكود بتوكن:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
});

server.listen(REDIRECT_PORT, async () => {
  console.log("افتح الرابط التالي وسجّل بحساب البوت ثم وافق على صلاحية Drive الكاملة:\n");
  console.log(authUrl);
  console.log(`\nبانتظار العودة إلى ${REDIRECT_URI} ...`);
});

setTimeout(() => {
  console.error("انتهت مهلة الانتظار (10 دقائق) — أعد تشغيل السكربت.");
  process.exit(1);
}, 10 * 60 * 1000).unref?.();
