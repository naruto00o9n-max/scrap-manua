---
Task ID: 46
Agent: Z.ai Code (main session)
Task: إضافة موقعي QQ كوميكس وكوايكان مانها + بناء نظام إعلانات الفصول الجديدة من مكتبة Suwayomi في قناة ديسكورد مع تحكم كامل من اللوحة

Work Log:
- استعادة البيئة: استنساخ scrap-manua من origin/main بعد تصفير البيئة (الساندبوكس الجديد) باستخدام توكن .github-token.
- تحليل موقع QQ كوميكس حيًا: اكتشاف سرب بيانات القارئ المشوش (JSON base64 بحروف زائدة بمواضع nonce) وخوارزمية decode من سكربت الموقع نفسه، وصيغ nonce الثلاث (n+once / nonc+e / no+nce) مع تعبيرات eval مبهمة (charCodeAt، !!سلاسل، parseInt، Math.round، ~~، كسور بنقطة).
- تنفيذ qqAcPage.ts: مقيّم تعبيرات آمن بمحلل يدوي بلا eval، بناء nonce، فك السرب، فهرس الفصول من data_chapterInfo، تحليل صيغتي الرابط (جوال + ChapterView سطح المكتب)، ورسائل عربية للفصل المدفوع.
- تحليل كوايكان حيًا: سرب NUXT (معاملات/وسائط مع Array(n) و{}) واستخراج comic_images بتفضيل url1280، والعناوين من <title>.
- تنفيذ kuaikanPage.ts كاملًا.
- الربط: directSource (direct-first + جلسة اختيارية)، urlPolicy (توحيد ac.qq.com وm.kuaikanmanhua.com)، builtinSources (تسجيل تلقائي للموقعين)، imageMerging (Referer لـ kkmh.com وacimg.cn).
- chapterWatcher.ts: مراقب مكتبة Suwayomi — listLibraryManga وfetchMangaChaptersWithOrder (sourceOrder) في SuwayomiClient، أساس أول بلا إعلان، كشف الجديد بسقف 5/عمل، إعلان بسطر GIF فوق البطاقة، حلقة كل 30 ثانية تفحص موعد الدورة من الإعدادات، كتم لكل عمل.
- discordBot.ts: sendChapterAnnouncement وlistAnnouncementChannels وsendTestChapterAnnouncement وتشغيل الحلقة بعد جهوزية البوت.
- db.ts: مجموعة watchedManga + CRUD كامل.
- routers.ts: راوتر chapterWatcher (config/save/channels/test/library/setMangaMuted/runNow).
- Settings.tsx: بطاقة إعلانات كاملة (تفعيل/قناة/فاصل/GIF/قوالب بمعاينة حية/رسالة تجريبية/فحص فوري/قائمة المكتبة مع كتم).
- اختبارات: qqAcPage.test (17) وkuaikanPage.test (13) وchapterWatcher.test (18) وتحديث builtinSources.test — 380 ناجحًا إجمالًا (3 فشل بيئة معروفة) + tsc نظيف.
- اختبار حي: QQ فصل 15 صفحة، كوايكان 175 صفحة بالصيغتين، صور QQ وكوايكان تنزل بنجاح.
- PR #45 → squash merge إلى main (8184cfa) → Railway ينشر تلقائيًا.

Stage Summary:
- QQ كوميكس وكوايكان مانها يعملان في /فصل بالسحب المباشر (مجاني) وبجلسة اختيارية (مشترى)، ومسجلان كدمج مصادر تلقائي.
- نظام إعلانات الفصول الجديدة كامل: مراقب المكتبة + قناة ديسكورد + سطر GIF فوق كل إعلان + رسالة تجريبية + معاينة حية + تحكم كامل من لوحة الإعدادات (قسم «فصول جديدة من مكتبة Suwayomi»).
- الفصول المدفوعة تُعلن عنها الرسائل إن ظهرت في فهرس الموقع، وسحبها لاحقًا يعتمد جلسات المواقع الموثقة.
- متبقٍ من مهام سابقة: luacomic.org (Node + إضافة Suwayomi)، KakaoPage جودة الفهرس، الإصلاحات الأخرى حسب أولوية المالك.
