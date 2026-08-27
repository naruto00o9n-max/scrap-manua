import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { Ban, ExternalLink, FilterX, Search, TimerReset } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const labels = { pending: "قيد الانتظار", downloading: "جاري التنزيل", uploading: "جاري الرفع", completed: "مكتمل", failed: "فشل", cancelled: "أُلغي" } as const;
const classes = { pending: "status-pending", downloading: "status-progress", uploading: "status-progress", completed: "status-complete", failed: "status-failed", cancelled: "status-muted" } as const;
type JobStatus = keyof typeof labels;

function formatDate(value: Date | string | null) { return value ? new Intl.DateTimeFormat("ar-IQ", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—"; }

export default function Jobs() {
  const utils = trpc.useUtils();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"" | JobStatus>("");
  const [sourceId, setSourceId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [pageCount, setPageCount] = useState("");
  const [withDrive, setWithDrive] = useState("");
  const sources = trpc.sources.list.useQuery();
  const jobs = trpc.jobs.list.useQuery({
    search: search || undefined,
    status: status || undefined,
    sourceId: sourceId ? Number(sourceId) : undefined,
    from: from ? new Date(`${from}T00:00:00.000Z`).toISOString() : undefined,
    to: to ? new Date(`${to}T23:59:59.999Z`).toISOString() : undefined,
    pageCount: pageCount ? Number(pageCount) : undefined,
    withDrive: withDrive === "yes" ? true : undefined,
  }, { refetchInterval: 7_500 });
  const cancel = trpc.jobs.cancel.useMutation({ onSuccess: () => { toast.success("تم طلب إلغاء المهمة."); utils.jobs.list.invalidate(); utils.dashboard.summary.invalidate(); }, onError: error => toast.error(error.message) });
  const clearFilters = () => { setSearch(""); setStatus(""); setSourceId(""); setFrom(""); setTo(""); setPageCount(""); setWithDrive(""); };
  return <div className="mx-auto max-w-7xl"><header className="page-intro"><p className="eyebrow">التشغيل والمراجعة</p><h1>طابور الفصول</h1><p>راقب كل طلب منذ التحقق من الرابط وحتى وضع الصفحات المرتبة في Google Drive.</p></header><Card className="artdeco-card mt-7 overflow-hidden"><CardContent className="p-0"><div className="flex flex-col gap-4 border-b border-primary/15 p-5"><div className="flex flex-wrap items-end justify-between gap-4"><div><p className="eyebrow !mb-1">سجل قابل للبحث</p><h2 className="font-display text-2xl font-bold">طلبات الفريق</h2></div><Button variant="outline" size="sm" onClick={clearFilters} className="artdeco-outline"><FilterX className="ml-2 h-3.5 w-3.5" />مسح الفلاتر</Button></div><div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4"><div className="relative"><Search className="absolute right-3 top-3 h-4 w-4 text-muted-foreground" /><Input value={search} onChange={e => setSearch(e.target.value)} className="w-full pr-9" placeholder="ابحث بالعضو أو الرابط" /></div><select value={status} onChange={e => setStatus(e.target.value as "" | JobStatus)} className="filter-input"><option value="">كل الحالات</option>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><select value={sourceId} onChange={e => setSourceId(e.target.value)} className="filter-input"><option value="">كل المصادر</option>{sources.data?.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</select><select value={withDrive} onChange={e => setWithDrive(e.target.value)} className="filter-input"><option value="">رابط Drive: الكل</option><option value="yes">مع رابط Google Drive</option></select><Input type="date" value={from} onChange={e => setFrom(e.target.value)} aria-label="من تاريخ" /><Input type="date" value={to} onChange={e => setTo(e.target.value)} aria-label="إلى تاريخ" /><Input type="number" min={1} value={pageCount} onChange={e => setPageCount(e.target.value)} placeholder="عدد الصفحات" /></div></div><div className="overflow-x-auto"><table className="artdeco-table min-w-[900px]"><thead><tr><th>الطلب</th><th>المصدر</th><th>التقدم</th><th>الحالة</th><th>الوقت</th><th>إجراء</th></tr></thead><tbody>{jobs.isLoading ? <tr><td colSpan={6} className="p-8 text-center text-sm text-muted-foreground">يجري تحميل السجل…</td></tr> : jobs.data?.length ? jobs.data.map(({ job, sourceName, sourceHostname }) => <tr key={job.id}><td><p className="font-semibold text-foreground">{job.requestedByName}</p><p className="mt-1 max-w-72 truncate text-[11px] text-muted-foreground" title={job.canonicalUrl}>{job.canonicalUrl}</p></td><td><p className="text-sm text-foreground">{sourceName || "غير معروف"}</p><p className="mt-1 text-[11px] text-muted-foreground">{sourceHostname || "—"}</p></td><td><div className="min-w-28"><div className="flex justify-between text-xs text-muted-foreground"><span>{job.uploadedPages}</span><span>{job.totalPages || "—"}</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary" style={{ width: job.totalPages ? `${Math.min(100, (job.uploadedPages / job.totalPages) * 100)}%` : "0%" }} /></div></div></td><td><Badge className={classes[job.status]}>{labels[job.status]}</Badge>{job.failureMessage && <p className="mt-2 max-w-48 truncate text-[11px] text-destructive" title={job.failureMessage}>{job.failureMessage}</p>}</td><td className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(job.createdAt)}</td><td><div className="flex items-center gap-2">{job.googleDriveUrl && <a href={job.googleDriveUrl} target="_blank" rel="noreferrer" className="rounded-sm p-2 text-primary hover:bg-primary/10" title="فتح Google Drive"><ExternalLink className="h-4 w-4" /></a>}{["pending", "downloading", "uploading"].includes(job.status) && <Button variant="ghost" size="icon" className="text-destructive hover:bg-destructive/10 hover:text-destructive" title="إلغاء المهمة" onClick={() => cancel.mutate({ jobId: job.id })} disabled={cancel.isPending}><Ban className="h-4 w-4" /></Button>}</div></td></tr>) : <tr><td colSpan={6}><div className="empty-row"><TimerReset className="h-5 w-5" /><span>لا توجد نتائج مطابقة. ستظهر طلبات Discord هنا فور قبولها.</span></div></td></tr>}</tbody></table></div></CardContent></Card></div>;
}
