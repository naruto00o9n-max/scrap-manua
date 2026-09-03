import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import {
  Ban,
  Check,
  CircleAlert,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { FormEvent, useState } from "react";
import { toast } from "sonner";

type SourceForm = {
  name: string; hostname: string; baseUrl: string; suwayomiSourceId: string; extensionPackage: string; extensionName: string; documentedIntegrationUrl: string; notes: string; status: "active" | "disabled"; allowDirectChapterLookup: boolean;
};

type SourceRow = {
  id: number;
  name: string;
  hostname: string;
  baseUrl: string;
  status: "active" | "disabled";
  suwayomiSourceId: string | null;
  extensionName: string | null;
  documentedIntegrationUrl: string | null;
  notes: string | null;
  allowDirectChapterLookup: boolean;
  ownerLocked?: boolean | null;
  lang?: string | null;
  origin?: string | null;
};

const initialForm: SourceForm = { name: "", hostname: "", baseUrl: "", suwayomiSourceId: "", extensionPackage: "", extensionName: "", documentedIntegrationUrl: "", notes: "", status: "disabled", allowDirectChapterLookup: false };

export default function Sources() {
  const utils = trpc.useUtils();
  const sources = trpc.sources.list.useQuery();
  const blocked = trpc.sources.blocked.useQuery();
  const installedSources = trpc.integrations.listSuwayomiSources.useQuery();
  const [form, setForm] = useState<SourceForm>(initialForm);
  const [renameTarget, setRenameTarget] = useState<SourceRow | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SourceRow | null>(null);

  const invalidate = () => { utils.sources.list.invalidate(); utils.sources.blocked.invalidate(); utils.dashboard.summary.invalidate(); };
  const save = trpc.sources.save.useMutation({ onSuccess: () => { toast.success("تم حفظ المصدر. لا يصبح صالحًا للطلبات إلا عند تفعيله."); setForm(initialForm); invalidate(); }, onError: error => toast.error(error.message) });
  const setStatus = trpc.sources.setStatus.useMutation({
    onSuccess: updated => {
      toast.success(updated.status === "active" ? "تم تفعيل المصدر — عاد صالحًا للطلبات." : "تم تعطيل المصدر — لن تعيد المزامنة تفعيله تلقائيًا.");
      invalidate();
    },
    onError: error => toast.error(error.message),
  });
  const rename = trpc.sources.rename.useMutation({
    onSuccess: () => { toast.success("تمت إعادة تسمية المصدر."); setRenameTarget(null); invalidate(); },
    onError: error => toast.error(error.message),
  });
  const remove = trpc.sources.remove.useMutation({
    onSuccess: () => { toast.success("حُذف المصدر نهائيًا ولن تعيد المزامنة إضافته تلقائيًا."); setDeleteTarget(null); invalidate(); },
    onError: error => toast.error(error.message),
  });
  const syncNow = trpc.sources.syncNow.useMutation({
    onSuccess: result => {
      toast.success(result ? `اكتملت المزامنة: أُضاف ${result.added}، فُعّل ${result.activated}، عُطّل ${result.disabled}.` : "المزامنة غير مهيأة بعد — أضف عنوان الخادم في أسرار الخادم أولًا.");
      invalidate();
    },
    onError: error => toast.error(error.message),
  });

  const change = <K extends keyof SourceForm>(key: K, value: SourceForm[K]) => setForm(current => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    let hostname = form.hostname.trim().toLowerCase().replace(/^www\./, "");
    try { if (!hostname) hostname = new URL(form.baseUrl).hostname.replace(/^www\./, ""); } catch { toast.error("تحقق من رابط الصفحة الرئيسية للمصدر."); return; }
    save.mutate({ ...form, hostname, suwayomiSourceId: form.suwayomiSourceId || null, extensionPackage: form.extensionPackage || null, extensionName: form.extensionName || null, documentedIntegrationUrl: form.documentedIntegrationUrl || null, notes: form.notes || null });
  };
  const selectInstalledSource = (value: string) => {
    const selected = installedSources.data?.find(source => source.id === value);
    if (!selected) return;
    setForm(current => ({
      ...current,
      suwayomiSourceId: selected.id,
      extensionName: selected.extension?.name ?? current.extensionName,
      extensionPackage: selected.extension?.pkgName ?? current.extensionPackage,
      name: current.name || selected.displayName,
    }));
  };

  const openRename = (source: SourceRow) => { setRenameTarget(source); setRenameValue(source.name); };

  return <div className="mx-auto max-w-7xl"><header className="page-intro"><p className="eyebrow">سياسة الوصول</p><h1>المصادر المصرّح بها</h1><p>لا يقبل البوت أي رابط ما لم يطابق نطاقًا مسموحًا ومصدرًا مفعّلًا ومُثبتًا بالفعل. التفعيل والتعطيل وإعادة التسمية والحذف تُدار من هذه الصفحة فقط.</p></header>
    <div className="mt-7 grid gap-6 xl:grid-cols-[1.1fr_0.9fr]"><Card className="artdeco-card"><CardContent className="p-0"><div className="section-title-row"><div><p className="eyebrow">السجل المعتمد</p><h2>المصادر الحالية</h2></div><div className="flex items-center gap-2"><Badge className="status-muted">{sources.data?.length ?? 0} مصدر</Badge><Button variant="outline" size="sm" className="artdeco-outline" onClick={() => syncNow.mutate()} disabled={syncNow.isPending}><RefreshCw className={`ml-2 h-4 w-4 ${syncNow.isPending ? "animate-spin" : ""}`} />{syncNow.isPending ? "يجري الفحص…" : "مزامنة فورية"}</Button></div></div><div className="divide-y divide-primary/10">{sources.isLoading ? <div className="p-6 text-sm text-muted-foreground">يجري تحميل المصادر…</div> : sources.data?.length ? sources.data.map(source => <div key={source.id} className="p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><h3 className="font-display text-xl font-bold">{source.name}</h3><Badge className={source.status === "active" ? "status-complete" : "status-muted"}>{source.status === "active" ? "مفعّل" : "متوقف"}</Badge>{source.status === "disabled" && source.ownerLocked && <Badge className="status-muted">قفل المالك</Badge>}</div><p className="mt-1 text-sm text-muted-foreground">{source.hostname}</p></div><div className="flex items-center gap-3"><div className="flex items-center gap-2 text-xs text-muted-foreground"><ShieldCheck className="h-3.5 w-3.5 text-primary" />{source.suwayomiSourceId ? `مصدر #${source.suwayomiSourceId}` : "غير مربوط"}</div><div className="flex items-center gap-1"><Button variant="outline" size="sm" className="artdeco-outline h-8 w-8 p-0" title="إعادة تسمية" onClick={() => openRename(source)}><Pencil className="h-3.5 w-3.5" /></Button><Button variant="outline" size="sm" className="artdeco-outline h-8 w-8 p-0 text-red-400 hover:text-red-300" title="حذف نهائي" onClick={() => setDeleteTarget(source)}><Trash2 className="h-3.5 w-3.5" /></Button><Switch checked={source.status === "active"} onCheckedChange={checked => setStatus.mutate({ id: source.id, status: checked ? "active" : "disabled" })} disabled={setStatus.isPending} aria-label={source.status === "active" ? `تعطيل ${source.name}` : `تفعيل ${source.name}`} /></div></div></div><div className="mt-4 flex flex-wrap gap-2 text-xs"><span className="info-chip">{source.extensionName || "إضافة غير محددة"}</span>{source.lang && <span className="info-chip">{source.lang}</span>}{source.origin === "suwayomi" && <span className="info-chip">أُضيف تلقائيًا</span>}<span className="info-chip">{source.allowDirectChapterLookup ? "يسمح بطلب فصل" : "يحتاج تحققًا"}</span>{source.documentedIntegrationUrl && <a target="_blank" rel="noreferrer" href={source.documentedIntegrationUrl} className="info-chip text-primary hover:opacity-75">وثائق التكامل <Link2 className="mr-1 inline h-3 w-3" /></a>}</div>{source.notes && <p className="mt-3 text-xs leading-6 text-muted-foreground">{source.notes}</p>}</div>) : <div className="p-10 text-center"><CircleAlert className="mx-auto h-7 w-7 text-primary" /><p className="mt-3 font-semibold">لم يُعتمد أي مصدر بعد</p><p className="mt-2 text-sm leading-6 text-muted-foreground">أضف المصدر بعد تثبيت إضافته والتحقق من ترخيص استخدامه.</p></div>}</div>{blocked.data && (blocked.data.hostnames.length > 0 || blocked.data.suwayomiSourceIds.length > 0) && <div className="border-t border-primary/10 p-5"><div className="flex items-center gap-2"><Ban className="h-4 w-4 text-primary" /><p className="text-sm font-semibold">قائمة الحجب</p><span className="text-xs text-muted-foreground">مواقع حُذفت نهائيًا — لا تعيد المزامنة إضافتها</span></div><div className="mt-3 flex flex-wrap gap-2 text-xs">{blocked.data.hostnames.map(hostname => <span key={hostname} className="info-chip">{hostname}</span>)}{blocked.data.suwayomiSourceIds.length > 0 && <span className="info-chip">{blocked.data.suwayomiSourceIds.length} معرّف مصدر محجوب</span>}</div></div>}</CardContent></Card>
      <Card className="artdeco-card"><CardContent className="p-6"><div className="flex items-center gap-3"><div className="metric-icon"><Plus className="h-5 w-5" /></div><div><p className="eyebrow !mb-0">اعتماد مصدر</p><h2 className="font-display text-2xl font-bold">إضافة موصل مصرح</h2></div></div><form onSubmit={submit} className="mt-6 space-y-4"><Field label="الإضافة المثبتة في الخادم"><select value={form.suwayomiSourceId} onChange={e => selectInstalledSource(e.target.value)} className="filter-input w-full"><option value="">اختر مصدرًا مثبتًا فعليًا</option>{installedSources.data?.map(source => <option key={source.id} value={source.id}>{source.displayName} — {source.extension?.pkgName || "بدون إضافة"}</option>)}</select><p className="mt-1 text-[11px] text-muted-foreground">تظهر فقط المصادر التي يعيدها خادم السحب الحالي. يظل اعتماد النطاق والإذن مسؤولية المالك.</p></Field><div className="grid gap-4 sm:grid-cols-2"><Field label="اسم المصدر"><Input value={form.name} onChange={e => change("name", e.target.value)} placeholder="اسم داخلي واضح" required /></Field><Field label="النطاق المسموح"><Input value={form.hostname} onChange={e => change("hostname", e.target.value)} placeholder="example.com" /></Field></div><Field label="الرابط الأساسي"><Input type="url" value={form.baseUrl} onChange={e => change("baseUrl", e.target.value)} placeholder="https://example.com" required /></Field><div className="grid gap-4 sm:grid-cols-2"><Field label="معرّف المصدر في الخادم"><Input value={form.suwayomiSourceId} onChange={e => change("suwayomiSourceId", e.target.value)} placeholder="مثال: 123" /></Field><Field label="اسم الإضافة المثبتة"><Input value={form.extensionName} onChange={e => change("extensionName", e.target.value)} placeholder="كما يظهر في الخادم" /></Field></div><Field label="حزمة الإضافة (اختياري)"><Input value={form.extensionPackage} onChange={e => change("extensionPackage", e.target.value)} placeholder="معرّف الحزمة الفعلي" /></Field><Field label="رابط وثيقة التكامل المصرح"><Input type="url" value={form.documentedIntegrationUrl} onChange={e => change("documentedIntegrationUrl", e.target.value)} placeholder="https://…" /></Field><Field label="ملاحظات التحقق"><Textarea value={form.notes} onChange={e => change("notes", e.target.value)} placeholder="سجل الموافقة، القيود، أو طريقة التحقق…" rows={3} /></Field><label className="flex cursor-pointer items-start gap-3 rounded-sm border border-primary/20 bg-primary/5 p-3"><input type="checkbox" checked={form.allowDirectChapterLookup} onChange={e => change("allowDirectChapterLookup", e.target.checked)} className="mt-1 accent-amber-400" /><span><span className="text-sm font-semibold">السماح بطلبات الفصول</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">فعّل هذا فقط بعد التحقق من الإضافة والمصدر؛ تظل روابط تسجيل الدخول وCAPTCHA مرفوضة.</span></span></label><div className="flex flex-wrap items-center justify-between gap-3 border-t border-primary/15 pt-5"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.status === "active"} onChange={e => change("status", e.target.checked ? "active" : "disabled")} className="accent-amber-400" />تفعيل المصدر الآن</label><Button type="submit" disabled={save.isPending} className="gold-button">{save.isPending ? "يجري الحفظ…" : <><Check className="ml-2 h-4 w-4" />حفظ المصدر</>}</Button></div></form></CardContent></Card></div>

    <Dialog open={Boolean(renameTarget)} onOpenChange={open => !open && setRenameTarget(null)}>
      <DialogContent className="artdeco-card sm:max-w-md">
        <DialogHeader><DialogTitle>إعادة تسمية «{renameTarget?.name}»</DialogTitle></DialogHeader>
        <div className="space-y-2"><Label className="text-xs font-semibold text-muted-foreground">الاسم الجديد</Label><Input value={renameValue} onChange={e => setRenameValue(e.target.value)} maxLength={80} autoFocus onKeyDown={e => { if (e.key === "Enter" && renameValue.trim()) { e.preventDefault(); rename.mutate({ id: renameTarget!.id, name: renameValue.trim() }); } }} /></div>
        <DialogFooter><Button variant="outline" className="artdeco-outline" onClick={() => setRenameTarget(null)}>إلغاء</Button><Button className="gold-button" disabled={!renameValue.trim() || rename.isPending} onClick={() => rename.mutate({ id: renameTarget!.id, name: renameValue.trim() })}>{rename.isPending ? "يجري الحفظ…" : "حفظ الاسم"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <AlertDialog open={Boolean(deleteTarget)} onOpenChange={open => !open && setDeleteTarget(null)}>
      <AlertDialogContent className="artdeco-card">
        <AlertDialogHeader><AlertDialogTitle>حذف «{deleteTarget?.name}» نهائيًا؟</AlertDialogTitle><AlertDialogDescription>سيُحذف الموقع من قوائم البحث والسحب ولن تعيد المزامنة إضافته تلقائيًا (يُسجَّل في قائمة الحجب). لا يُحذف أي شيء من المصدر نفسه.</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>تراجع</AlertDialogCancel><AlertDialogAction className="bg-red-600 text-white hover:bg-red-500" onClick={() => deleteTarget && remove.mutate({ id: deleteTarget.id })}>{remove.isPending ? "يجري الحذف…" : "تأكيد الحذف"}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-2"><Label className="text-xs font-semibold text-muted-foreground">{label}</Label>{children}</div>; }
