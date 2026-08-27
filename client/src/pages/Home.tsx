import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { Archive, ArrowLeft, CheckCircle2, Clock3, ExternalLink, RefreshCcw, ShieldCheck, Sparkles, XCircle } from "lucide-react";
import { Link } from "wouter";

const statusMeta = {
  pending: { label: "قيد الانتظار", className: "status-pending" },
  downloading: { label: "جاري التنزيل", className: "status-progress" },
  uploading: { label: "جاري الرفع", className: "status-progress" },
  completed: { label: "مكتمل", className: "status-complete" },
  failed: { label: "فشل", className: "status-failed" },
  cancelled: { label: "أُلغي", className: "status-muted" },
} as const;

function countOf(counts: Record<string, number> | undefined, key: string) {
  return counts?.[key] ?? 0;
}

function dateLabel(value: Date | string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ar-IQ", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export default function Home() {
  const summary = trpc.dashboard.summary.useQuery(undefined, { refetchInterval: 8_000 });
  const data = summary.data;
  const cards = [
    { title: "في الطابور", value: countOf(data?.counts, "pending"), icon: Clock3, hint: "طلبات تنتظر التنفيذ" },
    { title: "قيد المعالجة", value: countOf(data?.counts, "downloading") + countOf(data?.counts, "uploading"), icon: RefreshCcw, hint: "تنزيل أو رفع نشط" },
    { title: "مكتملة", value: countOf(data?.counts, "completed"), icon: CheckCircle2, hint: "مجلدات أنشئت بنجاح" },
    { title: "مصادر مفعلة", value: data?.activeSourceCount ?? 0, icon: ShieldCheck, hint: `من أصل ${data?.sourceCount ?? 0} مصدر` },
  ];

  return (
    <div className="mx-auto max-w-7xl">
      <header className="page-header relative overflow-hidden">
        <div className="relative z-10 max-w-2xl">
          <div className="flex items-center gap-2 text-primary"><Sparkles className="h-4 w-4" /><span className="eyebrow !mb-0">مركز القيادة</span></div>
          <h1 className="mt-4 font-display text-4xl font-bold leading-tight text-foreground sm:text-5xl">كل فصل، في مكانه الصحيح.</h1>
          <p className="mt-4 max-w-xl leading-7 text-muted-foreground">تابع طلبات Discord، تحقق من المصادر المصادق عليها، واحفظ صفحات الفصول المصرح بها بترتيب دقيق داخل Google Drive.</p>
          <div className="mt-7 flex flex-wrap gap-3"><Link href="/jobs"><Button className="gold-button">فتح طابور الفصول <ArrowLeft className="mr-2 h-4 w-4" /></Button></Link><Link href="/sources"><Button variant="outline" className="artdeco-outline">إدارة المصادر</Button></Link></div>
        </div>
        <div className="hero-geometry" aria-hidden="true"><span /><span /><span /></div>
      </header>

      <section className="-mt-7 relative z-20 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(card => <Card className="metric-card" key={card.title}><CardContent className="flex items-start justify-between p-5"><div><p className="text-xs font-semibold text-muted-foreground">{card.title}</p>{summary.isLoading ? <Skeleton className="mt-3 h-9 w-12" /> : <p className="mt-2 font-display text-4xl font-bold text-foreground">{card.value}</p>}<p className="mt-2 text-[11px] text-muted-foreground">{card.hint}</p></div><div className="metric-icon"><card.icon className="h-5 w-5" /></div></CardContent></Card>)}
      </section>

      <section className="mt-8 grid gap-6 xl:grid-cols-[1.65fr_0.85fr]">
        <Card className="artdeco-card overflow-hidden"><CardContent className="p-0"><div className="section-title-row"><div><p className="eyebrow">سجل حي</p><h2>آخر الطلبات</h2></div><Link href="/jobs" className="text-xs font-bold text-primary transition-opacity hover:opacity-75">عرض السجل كاملًا</Link></div>
          <div className="overflow-x-auto"><table className="artdeco-table"><thead><tr><th>العضو</th><th>المصدر</th><th>الحالة</th><th>وقت الطلب</th><th /></tr></thead><tbody>{summary.isLoading ? <tr><td colSpan={5}><Skeleton className="h-10 w-full" /></td></tr> : data?.recentJobs.length ? data.recentJobs.map(({ job, sourceName }) => { const meta = statusMeta[job.status]; return <tr key={job.id}><td><p className="font-semibold text-foreground">{job.requestedByName}</p><p className="mt-1 max-w-48 truncate text-[11px] text-muted-foreground">{job.mangaTitle || job.canonicalUrl}</p></td><td className="text-muted-foreground">{sourceName || "غير معروف"}</td><td><Badge className={meta.className}>{meta.label}</Badge></td><td className="whitespace-nowrap text-xs text-muted-foreground">{dateLabel(job.createdAt)}</td><td>{job.googleDriveUrl ? <a href={job.googleDriveUrl} target="_blank" rel="noreferrer" className="inline-flex text-primary hover:opacity-70"><ExternalLink className="h-4 w-4" /></a> : null}</td></tr>}) : <tr><td colSpan={5}><div className="empty-row"><Archive className="h-5 w-5" /><span>لا توجد طلبات حتى الآن. ابدأ بتهيئة التكاملات والمصادر.</span></div></td></tr>}</tbody></table></div>
        </CardContent></Card>

        <Card className="artdeco-card relative overflow-hidden"><CardContent className="p-6"><p className="eyebrow">معيار التشغيل</p><h2 className="font-display text-2xl font-bold">قائمة الجاهزية</h2><div className="mt-6 space-y-4"><Readiness label="عنوان Suwayomi مضبوط" active={false} description="أضفه في أسرار الخادم ثم شغّل فحص الاتصال." /><Readiness label="Google Drive متصل" active={false} description="يلزم OAuth ومجلد جذر للاحتفاظ بالفصول." /><Readiness label="أدوار Discord محددة" active={false} description="لن تُقبل الطلبات إلا من الأدوار المعتمدة." /></div><Link href="/settings"><Button variant="outline" className="artdeco-outline mt-7 w-full">فتح إعدادات التكامل</Button></Link></CardContent></Card>
      </section>
    </div>
  );
}

function Readiness({ label, active, description }: { label: string; active: boolean; description: string }) {
  return <div className="flex gap-3"><div className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${active ? "bg-emerald-500/15 text-emerald-400" : "bg-muted text-muted-foreground"}`}>{active ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}</div><div><p className="text-sm font-semibold text-foreground">{label}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p></div></div>;
}
