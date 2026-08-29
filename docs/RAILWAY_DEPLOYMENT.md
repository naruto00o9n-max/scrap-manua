# نشر Manga Drive على Railway

هذا الدليل مخصص لنشر المشروع من الأرشيف أو مستودع GitHub على Railway. يتكون المشروع من لوحة إدارة، خادم Express/tRPC، بوت Discord، عامل طابور، وتكامل مع Suwayomi وGoogle Drive.

## 1. لماذا انطفأ البوت والخادم؟

العملية التي كانت تعمل داخل بيئة التطوير في Manus ليست خدمة دائمة؛ البيئة قد تنام بعد فترة عدم نشاط، وعند نومها تنتهي عملية Node وينقطع Discord Gateway والعامل. كما أن نسخة الويب الإنتاجية تضبط Gateway والعامل على الإيقاف افتراضيًا حتى لا تبدأ عدة نسخ اتصال Discord في الوقت نفسه وتسبب `40060 Interaction has already been acknowledged`.

للتشغيل المستمر، انشر المشروع على Railway بخدمة واحدة دائمة، واضبط فيها:

```text
NODE_ENV=production
DISCORD_GATEWAY_ENABLED=true
JOB_WORKER_ENABLED=true
```

يجب ألا توجد خدمة أخرى تشغل Gateway بالتوكن نفسه. يمكن فصل خدمة المراقبة فقط، لأنها تستدعي مسار HTTP ولا تتصل بـ Discord Gateway.

## 2. إنشاء خدمة Railway

أنشئ مشروعًا جديدًا في Railway، ثم أضف خدمة من GitHub أو ارفع مجلد المشروع بعد فك الأرشيف. يجب أن يكون جذر الخدمة هو المجلد الذي يحتوي `package.json` و`railway.toml`.

ملف `railway.toml` يحدد الإعدادات التالية تلقائيًا:

| الإعداد | القيمة |
|---|---|
| Builder | `RAILPACK` |
| Build command | `pnpm build` |
| Start command | `pnpm start` |
| Healthcheck | `/api/healthz` |
| Restart policy | `ON_FAILURE` حتى 10 محاولات |

اترك Railway يعيّن `PORT` تلقائيًا. لا تشغّل `pnpm dev` في الإنتاج، ولا تضف `tsx watch` إلى Start Command.

## 3. قاعدة البيانات

أضف MongoDB، ثم عرّف `MONGODB_URI` في خدمة التطبيق. لا تضع عنوان قاعدة البيانات داخل الكود أو الأرشيف.

قبل تشغيل البوت، تأكد من أن MongoDB متاح عبر `MONGODB_URI`. ينشئ التطبيق الفهارس المطلوبة تلقائيًا عند أول اتصال، وتشمل فهارس التفرد للمستخدمين والمصادر والأدوار وروابط المهام.

## 4. متغيرات البيئة المطلوبة

أضف القيم في Railway من صفحة **Variables**. لا تضعها في GitHub أو داخل ملف ZIP.

| المتغير | مطلوب | الاستخدام |
|---|---:|---|
| `MONGODB_URI` | نعم | اتصال MongoDB بسجل المستخدمين والطلبات والإعدادات. |
| `JWT_SECRET` | نعم | توقيع جلسات لوحة الإدارة. استخدم قيمة عشوائية طويلة. |
| `VITE_APP_ID` | نعم | معرّف تطبيق Manus OAuth للوحة. |
| `OAUTH_SERVER_URL` | نعم | عنوان خادم OAuth المستخدم في تسجيل دخول اللوحة. |
| `VITE_OAUTH_PORTAL_URL` | نعم | عنوان بوابة OAuth الذي يستعمله المتصفح. |
| `OWNER_OPEN_ID` | نعم | معرّف مالك لوحة الإدارة في نظام OAuth. |
| `OWNER_NAME` | مستحسن | الاسم الظاهر للمالك في اللوحة والتنبيهات. |
| `DISCORD_BOT_TOKEN` | نعم | توكن البوت. لا تشاركه في Discord أو GitHub. |
| `DISCORD_APPLICATION_ID` | نعم | معرّف تطبيق Discord لتسجيل الأوامر. |
| `DISCORD_GUILD_ID` | نعم | معرّف السيرفر الذي تسجل فيه أوامر Guild فورًا. |
| `OWNER_DISCORD_USER_ID` | نعم | معرّف Discord للمالك والتنبيهات. |
| `DISCORD_GATEWAY_ENABLED` | نعم للبوت | يجب أن تكون `true` في خدمة Railway الوحيدة التي تشغل البوت. |
| `JOB_WORKER_ENABLED` | نعم للعامل | يجب أن تكون `true` في الخدمة نفسها حتى تعالج الطابور. |
| `GDRIVE_CLIENT_ID` | نعم | OAuth Client ID لـ Google Drive. |
| `GDRIVE_CLIENT_SECRET` | نعم | سر OAuth Client لـ Google Drive. |
| `GDRIVE_REFRESH_TOKEN` | نعم | Refresh Token للحساب الذي ينشئ مجلدات الفصول. |
| `GDRIVE_API_KEY` | حسب مشروع Google | مفتاح Google API إذا كان مشروعك يحتاجه. |
| `SUWAYOMI_BASE_URL` | نعم | عنوان خادم Suwayomi، مثل عنوان Railway الحالي. |
| `SUWAYOMI_API_TOKEN` | حسب الحماية | اتركه فارغًا فقط إذا كان Suwayomi غير محمي. |
| `INTEGRATION_MONITOR_TOKEN` | مستحسن | رمز حماية مسار فحص التكاملات الداخلي. |
| `BUILT_IN_FORGE_API_URL` | حسب إعداد Manus | عنوان خدمات Manus المدمجة إذا كان مطلوبًا في بيئة النشر. |
| `BUILT_IN_FORGE_API_KEY` | حسب إعداد Manus | مفتاح خدمات Manus المدمجة إذا كان مطلوبًا. |

لا يحتاج المشروع إلى `GOOGLE_DRIVE_ROOT_FOLDER_ID`. ينشئ مجلد المنصة والعمل والفصل تلقائيًا في My Drive، وفق سياسة المشاركة التي تضبطها من اللوحة.

## 5. إعداد Discord

من Discord Developer Portal، افتح التطبيق الذي يطابق `DISCORD_APPLICATION_ID`، وأنشئ أو أعد تعيين توكن البوت ثم احفظه في `DISCORD_BOT_TOKEN`. أضف البوت إلى `DISCORD_GUILD_ID` باستخدام النطاقين `bot` و`applications.commands`.

يحتاج البوت إلى الوصول إلى القناة، قراءة القناة، إرسال الرسائل، وتضمين الروابط. لا يحتاج إلى Message Content Intent لأن الإدخال يتم عبر Slash Commands.

عند تشغيل الخدمة سيعيد البوت تسجيل أربعة أوامر داخل الـ Guild: `/فصل` و`/chapter` و`/مساعدة` و`/help`. لا يوجد أمر `/حالة`؛ استخدم لوحة الإدارة للسجل والطابور.

## 6. إعداد Suwayomi والمصادر

ضع عنوان Suwayomi في `SUWAYOMI_BASE_URL`، ثم تأكد من أن الخدمة متاحة من Railway عبر HTTPS أو شبكة Railway المناسبة. ثبّت الإضافات المصرح بها فقط داخل Suwayomi.

بعد تسجيل الدخول إلى لوحة الإدارة، افتح «المصادر المصرح بها» وسجل لكل مصدر النطاق، وSource ID، وحزمة الإضافة، وحالة التفعيل. يعتمد البوت على الإضافات المثبتة فعليًا وواجهة GraphQL الرسمية، ولا ينفذ scraper مباشرًا ولا يتجاوز تسجيل الدخول أو CAPTCHA.

تم التحقق من مسار Naver عبر استخراج `titleId` ومطابقته مع فهرس إضافة Naver الرسمية. كما تم التحقق من Rokari عبر فصل `Bunker Days — Chapter 33` بعد إصلاح مهلة GraphQL.

## 7. إعداد Google Drive

أنشئ OAuth Client في Google Cloud، فعّل Google Drive API، واستخرج Refresh Token للحساب المقصود. خزّن القيم الثلاث في Railway Variables. لا تحتاج إلى معرّف مجلد جذري.

ينشئ البوت تلقائيًا البنية التالية:

```text
Manga Drive Discord Bot/
└── اسم العمل/
    └── اسم الفصل/
        ├── 001.png
        ├── 002.png
        └── ...
```

تُرفع صور PNG المدمجة فقط. يستخدم الدمج عرضًا موحدًا يساوي أكبر عرض في الفصل، ويستهدف ارتفاعًا بين 11000 و14000 بكسل دون قص. عندما يمنع طول الصفحات الوصول إلى المجال دون تجاوز 14000، تبقى الصفحة كاملة منفردة.

## 8. تشغيل خدمة مراقبة اختيارية

أنشئ خدمة Cron منفصلة في Railway من نفس المستودع، واجعل Start Command الخاص بها:

```bash
node scripts/monitor.mjs
```

في خدمة Cron عرّف:

```text
MANGA_DRIVE_MONITOR_URL=https://عنوان-خدمة-البوت/api/internal/run-monitor
INTEGRATION_MONITOR_TOKEN=نفس-الرمز-الموجود-في-خدمة-البوت
```

اضبط الجدول مثل `*/10 * * * *` بتوقيت UTC. هذه الخدمة لا تشغل Gateway ولا العامل؛ وظيفتها فحص Discord وGoogle Drive وSuwayomi وإرسال النتيجة إلى المسار المحمي.

## 9. منع تضارب Gateway

شغّل `DISCORD_GATEWAY_ENABLED=true` و`JOB_WORKER_ENABLED=true` في خدمة واحدة فقط. لا تضبطهما على خدمة الويب الثانية أو نسخة Preview أو جهاز محلي في الوقت نفسه.

إذا ظهر `40060 Interaction has already been acknowledged`، أوقف كل النسخ الأخرى التي تستخدم التوكن نفسه، ثم أعد تشغيل خدمة Railway الوحيدة. ابحث في السجلات عن اتصال واحد فقط باسم البوت ورسالة تحديث الأوامر.

## 10. فحص ما بعد النشر

بعد اكتمال Deploy نفّذ الخطوات الآتية بالترتيب:

1. افتح `https://عنوان-الخدمة/api/healthz` وتأكد من استجابة JSON تحتوي `ok: true`.
2. راجع Logs وتأكد من ظهور `Server running` واتصال Discord وتحديث أربعة أوامر.
3. افتح لوحة الإدارة وسجّل الدخول ثم افحص اتصال Suwayomi وGoogle Drive.
4. تأكد من ظهور المصدر المصرح به مع الإضافة المثبتة.
5. أرسل طلبًا واحدًا من `/chapter` في الـ Guild المحدد.
6. راقب بطاقة التقدم العامة، ثم رسالة الإكمال العامة ومنشن العضو ورابط Drive.
7. تحقق من أن مجلد الفصل يحتوي PNG المدمجة فقط وبترتيب رقمي.

## 11. أرشيف المشروع

الأرشيف المرفق يحتوي مصدر اللوحة والخادم والبوت والعامل والتكاملات والاختبارات وملفات Railway وCompose والتوثيق. تم استبعاد `node_modules` و`dist` وسجلات التشغيل وملفات Manus المحلية والأسرار. بعد فك الضغط، نفّذ:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test -- --run
pnpm build
```

ثم ارفع المجلد إلى GitHub أو اربطه مباشرة بخدمة Railway. لا ترفع أي ملف يبدأ بنقطة ويحتوي قيمة سرية، ولا تنسخ Variables إلى مستودع عام.

## 12. التشغيل الذاتي الاختياري عبر Docker Compose

إذا أردت تشغيل Suwayomi والبوت على خادم تملكه، استخدم:

```bash
docker compose -f deploy/compose.yaml up -d --build
```

ضع المتغيرات في ملف بيئة محلي خارج Git، وتأكد من أن خدمة البوت هي الوحيدة التي تستخدم توكن Discord. يحتاج Suwayomi إلى Volume دائم حتى لا تضيع الإضافات والإعدادات عند إعادة التشغيل.
