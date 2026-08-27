import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { Check, CircleAlert, Link2, Plus, ShieldCheck } from "lucide-react";
import { FormEvent, useState } from "react";
import { toast } from "sonner";

type SourceForm = {
  name: string; hostname: string; baseUrl: string; suwayomiSourceId: string; extensionPackage: string; extensionName: string; documentedIntegrationUrl: string; notes: string; status: "active" | "disabled"; allowDirectChapterLookup: boolean;
};

const initialForm: SourceForm = { name: "", hostname: "", baseUrl: "", suwayomiSourceId: "", extensionPackage: "", extensionName: "", documentedIntegrationUrl: "", notes: "", status: "disabled", allowDirectChapterLookup: false };

export default function Sources() {
  const utils = trpc.useUtils();
  const sources = trpc.sources.list.useQuery();
  const installedSources = trpc.integrations.listSuwayomiSources.useQuery();
  const [form, setForm] = useState<SourceForm>(initialForm);
  const save = trpc.sources.save.useMutation({ onSuccess: () => { toast.success("تم حفظ المصدر. لا يصبح صالحًا للطلبات إلا عند تفعيله."); setForm(initialForm); utils.sources.list.invalidate(); utils.dashboard.summary.invalidate(); }, onError: error => toast.error(error.message) });
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

  return <div className="mx-auto max-w-7xl"><header className="page-intro"><p className="eyebrow">سياسة الوصول</p><h1>المصادر المصرّح بها</h1><p>لا يقبل البوت أي رابط ما لم يطابق نطاقًا مسموحًا ومصدرًا مفعّلًا ومُثبتًا بالفعل على Suwayomi.</p></header>
    <div className="mt-7 grid gap-6 xl:grid-cols-[1.1fr_0.9fr]"><Card className="artdeco-card"><CardContent className="p-0"><div className="section-title-row"><div><p className="eyebrow">السجل المعتمد</p><h2>المصادر الحالية</h2></div><Badge className="status-muted">{sources.data?.length ?? 0} مصدر</Badge></div><div className="divide-y divide-primary/10">{sources.isLoading ? <div className="p-6 text-sm text-muted-foreground">يجري تحميل المصادر…</div> : sources.data?.length ? sources.data.map(source => <div key={source.id} className="p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><h3 className="font-display text-xl font-bold">{source.name}</h3><Badge className={source.status === "active" ? "status-complete" : "status-muted"}>{source.status === "active" ? "مفعّل" : "متوقف"}</Badge></div><p className="mt-1 text-sm text-muted-foreground">{source.hostname}</p></div><div className="flex items-center gap-2 text-xs text-muted-foreground"><ShieldCheck className="h-3.5 w-3.5 text-primary" />{source.suwayomiSourceId ? `Suwayomi #${source.suwayomiSourceId}` : "لم يُربط بـ Suwayomi"}</div></div><div className="mt-4 flex flex-wrap gap-2 text-xs"><span className="info-chip">{source.extensionName || "إضافة غير محددة"}</span><span className="info-chip">{source.allowDirectChapterLookup ? "يسمح بطلب فصل" : "يحتاج تحققًا"}</span>{source.documentedIntegrationUrl && <a target="_blank" rel="noreferrer" href={source.documentedIntegrationUrl} className="info-chip text-primary hover:opacity-75">وثائق التكامل <Link2 className="mr-1 inline h-3 w-3" /></a>}</div>{source.notes && <p className="mt-3 text-xs leading-6 text-muted-foreground">{source.notes}</p>}</div>) : <div className="p-10 text-center"><CircleAlert className="mx-auto h-7 w-7 text-primary" /><p className="mt-3 font-semibold">لم يُعتمد أي مصدر بعد</p><p className="mt-2 text-sm leading-6 text-muted-foreground">أضف المصدر بعد تثبيت إضافته والتحقق من ترخيص استخدامه.</p></div>}</div></CardContent></Card>
      <Card className="artdeco-card"><CardContent className="p-6"><div className="flex items-center gap-3"><div className="metric-icon"><Plus className="h-5 w-5" /></div><div><p className="eyebrow !mb-0">اعتماد مصدر</p><h2 className="font-display text-2xl font-bold">إضافة موصل مصرح</h2></div></div><form onSubmit={submit} className="mt-6 space-y-4"><Field label="الإضافة المثبتة في Suwayomi"><select value={form.suwayomiSourceId} onChange={e => selectInstalledSource(e.target.value)} className="filter-input w-full"><option value="">اختر مصدرًا مثبتًا فعليًا</option>{installedSources.data?.map(source => <option key={source.id} value={source.id}>{source.displayName} — {source.extension?.pkgName || "بدون إضافة"}</option>)}</select><p className="mt-1 text-[11px] text-muted-foreground">تظهر فقط المصادر التي يعيدها خادم Suwayomi الحالي. يظل اعتماد النطاق والإذن مسؤولية المالك.</p></Field><div className="grid gap-4 sm:grid-cols-2"><Field label="اسم المصدر"><Input value={form.name} onChange={e => change("name", e.target.value)} placeholder="اسم داخلي واضح" required /></Field><Field label="النطاق المسموح"><Input value={form.hostname} onChange={e => change("hostname", e.target.value)} placeholder="example.com" /></Field></div><Field label="الرابط الأساسي"><Input type="url" value={form.baseUrl} onChange={e => change("baseUrl", e.target.value)} placeholder="https://example.com" required /></Field><div className="grid gap-4 sm:grid-cols-2"><Field label="معرف مصدر Suwayomi"><Input value={form.suwayomiSourceId} onChange={e => change("suwayomiSourceId", e.target.value)} placeholder="مثال: 123" /></Field><Field label="اسم الإضافة المثبتة"><Input value={form.extensionName} onChange={e => change("extensionName", e.target.value)} placeholder="كما يظهر في Suwayomi" /></Field></div><Field label="حزمة الإضافة (اختياري)"><Input value={form.extensionPackage} onChange={e => change("extensionPackage", e.target.value)} placeholder="معرّف الحزمة الفعلي" /></Field><Field label="رابط وثيقة التكامل المصرح"><Input type="url" value={form.documentedIntegrationUrl} onChange={e => change("documentedIntegrationUrl", e.target.value)} placeholder="https://…" /></Field><Field label="ملاحظات التحقق"><Textarea value={form.notes} onChange={e => change("notes", e.target.value)} placeholder="سجل الموافقة، القيود، أو طريقة التحقق…" rows={3} /></Field><label className="flex cursor-pointer items-start gap-3 rounded-sm border border-primary/20 bg-primary/5 p-3"><input type="checkbox" checked={form.allowDirectChapterLookup} onChange={e => change("allowDirectChapterLookup", e.target.checked)} className="mt-1 accent-amber-400" /><span><span className="text-sm font-semibold">السماح بطلبات الفصول</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">فعّل هذا فقط بعد التحقق من الإضافة والمصدر؛ تظل روابط تسجيل الدخول وCAPTCHA مرفوضة.</span></span></label><div className="flex flex-wrap items-center justify-between gap-3 border-t border-primary/15 pt-5"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.status === "active"} onChange={e => change("status", e.target.checked ? "active" : "disabled")} className="accent-amber-400" />تفعيل المصدر الآن</label><Button type="submit" disabled={save.isPending} className="gold-button">{save.isPending ? "يجري الحفظ…" : <><Check className="ml-2 h-4 w-4" />حفظ المصدر</>}</Button></div></form></CardContent></Card></div></div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-2"><Label className="text-xs font-semibold text-muted-foreground">{label}</Label>{children}</div>; }
