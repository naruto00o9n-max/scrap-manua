import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { ShieldBan, ShieldCheck, Users as UsersIcon } from "lucide-react";

function dateLabel(value: Date | string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ar-IQ", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export default function Users() {
  const utils = trpc.useUtils();
  const users = trpc.users.list.useQuery(undefined, { refetchInterval: 10_000 });
  const block = trpc.users.setBlocked.useMutation({ onSuccess: () => utils.users.list.invalidate() });

  return (
    <div className="mx-auto max-w-7xl">
      <header className="page-header">
        <div className="flex items-center gap-2 text-primary"><UsersIcon className="h-4 w-4" /><span className="eyebrow !mb-0">إدارة الوصول</span></div>
        <h1 className="mt-4 font-display text-4xl font-bold text-foreground">الأعضاء والصلاحيات</h1>
        <p className="mt-4 max-w-2xl leading-7 text-muted-foreground">تابع حسابات لوحة التحكم، آخر دخول، واحظر أي حساب من الوصول إلى الإدارة.</p>
      </header>
      <Card className="artdeco-card mt-6 overflow-hidden"><CardContent className="p-0">
        <div className="overflow-x-auto"><table className="artdeco-table"><thead><tr><th>الحساب</th><th>الدور</th><th>آخر دخول</th><th>الحالة</th><th /></tr></thead><tbody>
          {users.isLoading ? <tr><td colSpan={5}><Skeleton className="h-10 w-full" /></td></tr> : users.data?.length ? users.data.map(user => <tr key={user.id}>
            <td><p className="font-semibold text-foreground">{user.name || user.email || user.openId}</p><p className="mt-1 text-xs text-muted-foreground">{user.email || "—"}</p></td>
            <td><Badge className={user.role === "admin" ? "status-complete" : "status-muted"}>{user.role === "admin" ? "مدير" : "مستخدم"}</Badge></td>
            <td className="text-xs text-muted-foreground">{dateLabel(user.lastSignedIn)}</td>
            <td><Badge className={user.isBlocked ? "status-failed" : "status-complete"}>{user.isBlocked ? "محظور" : "مسموح"}</Badge></td>
            <td><Button disabled={block.isPending || user.role === "admin"} variant="outline" className="artdeco-outline" onClick={() => block.mutate({ id: user.id, isBlocked: !user.isBlocked })}>{user.isBlocked ? <ShieldCheck className="ml-2 h-4 w-4" /> : <ShieldBan className="ml-2 h-4 w-4" />}{user.isBlocked ? "رفع الحظر" : "حظر"}</Button></td>
          </tr>) : <tr><td colSpan={5} className="text-center text-muted-foreground">لا توجد حسابات.</td></tr>}
        </tbody></table></div>
      </CardContent></Card>
    </div>
  );
}
