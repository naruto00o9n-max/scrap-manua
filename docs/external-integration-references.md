# مراجع التكامل الخارجية

## Suwayomi Server

يعتمد التكامل على واجهة GraphQL في المسار `/api/graphql`، والتي فُحصت على الخدمة الحالية في Railway عبر استعلام القراءة `{ __typename }` دون إرسال أي عملية تعديل أو تنزيل. يعرّف مخطط Suwayomi عملية `fetchChapterPages` التي تستقبل `chapterId` وتعيد قائمة `pages`، كما يوفر الاستعلام `chapters` بمرشح `url` أو `realUrl` للعثور على فصل مسجل مسبقًا. لا يستدعي البوت هذه العملية إلا للمصادر المسجلة والمفعّلة في لوحة الإدارة.

| المرجع | الاستخدام |
|---|---|
| [مستودع Suwayomi Server](https://github.com/Suwayomi/Suwayomi-Server) | تأكيد نقطة GraphQL وتشغيل الإضافات المتوافقة. |
| [مخطط GraphQL في Suwayomi VUI](https://github.com/Suwayomi/Suwayomi-VUI/blob/main/schema.graphql) | حقول `ChapterType` وعملية `fetchChapterPages` ومدخلاتها. |
| [حاوية Suwayomi الرسمية](https://github.com/Suwayomi/Suwayomi-Server-docker) | تشغيل Docker ومسار البيانات الدائم. |

## Discord

يعتمد البوت على أمر Slash داخل Guild محدد، ويفحص أدوار العضو من بيانات التفاعل قبل قبول الطلب. بوابة Discord تستخدم اتصال WebSocket دائمًا، لذا لا تعد بيئة التطوير تشغيلًا موثوقًا بعد انتهاء الجلسة ويُنقل البوت لاحقًا إلى Railway.

| المرجع | الاستخدام |
|---|---|
| [أوامر تطبيق Discord](https://docs.discord.com/developers/interactions/application-commands) | تسجيل أمر Slash ضمن Guild الاختباري. |
| [Discord Gateway](https://docs.discord.com/developers/events/gateway) | تشغيل اتصال البوت المستمر ومعالجة الانقطاعات. |

## Google Drive

يستخدم الخادم OAuth 2.0 مع Refresh Token محفوظ في الأسرار فقط. يفحص المجلد الجذر قبل الإنشاء، ثم ينشئ مجلد العمل والفصل ويرفع الملفات مرقمة تسلسليًا. توصي وثائق Google باختيار أضيق نطاق OAuth ممكن وحفظ Refresh Token في تخزين آمن طويل الأجل.

| المرجع | الاستخدام |
|---|---|
| [Google Drive OAuth scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) | إعداد OAuth وحماية Refresh Token واختيار نطاق الصلاحيات. |

## Railway

الخدمة الحالية لـ Suwayomi مستضافة على Railway. عند نقل البوت، يُنشر كخدمة مستقلة دائمة ويجب أن تبقى بيانات Suwayomi على Volume دائم، لأن مساحة الخدمة العادية مؤقتة بين عمليات النشر.

| المرجع | الاستخدام |
|---|---|
| [Railway Services](https://docs.railway.com/services) | نشر خدمات ثابتة من GitHub أو Docker image. |
| [Railway Volumes](https://docs.railway.com/volumes) | تخزين دائم لبيانات Suwayomi. |
