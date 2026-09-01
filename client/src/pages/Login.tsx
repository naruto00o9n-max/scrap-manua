import { FormEvent, useState } from "react";
import { useLocation } from "wouter";
import { Crown, LockKeyhole, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";

export default function Login() {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const [email, setEmail] = useState("admin@manga-drive.local");
  const [password, setPassword] = useState("");
  const login = trpc.auth.login.useMutation({
    onSuccess: async () => {
      await utils.auth.me.invalidate();
      setLocation("/");
    },
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    await login.mutateAsync({ email, password });
  }

  return (
    <div dir="rtl" className="artdeco-shell flex min-h-screen items-center justify-center p-5">
      <form onSubmit={submit} className="artdeco-frame w-full max-w-md p-8">
        <div className="gold-emblem mx-auto mb-6"><Crown className="h-6 w-6" /></div>
        <p className="eyebrow text-center">دخول الإدارة</p>
        <h1 className="mt-3 text-center font-display text-4xl font-bold text-foreground">دار الفصول</h1>
        <p className="mt-4 text-center leading-7 text-muted-foreground">سجّل ببريد وكلمة مرور لإدارة البوت والتكاملات.</p>
        <label className="mt-7 block text-sm font-semibold">البريد</label>
        <div className="mt-2 flex items-center gap-2 rounded-sm border border-primary/20 bg-background/60 px-3">
          <Mail className="h-4 w-4 text-primary" />
          <Input value={email} onChange={event => setEmail(event.target.value)} type="email" autoComplete="email" className="border-0 bg-transparent" />
        </div>
        <label className="mt-4 block text-sm font-semibold">كلمة المرور</label>
        <div className="mt-2 flex items-center gap-2 rounded-sm border border-primary/20 bg-background/60 px-3">
          <LockKeyhole className="h-4 w-4 text-primary" />
          <Input value={password} onChange={event => setPassword(event.target.value)} type="password" autoComplete="current-password" className="border-0 bg-transparent" />
        </div>
        {login.error ? <p className="mt-4 rounded-sm border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{login.error.message}</p> : null}
        <Button disabled={login.isPending} className="gold-button mt-7 w-full" size="lg">{login.isPending ? "جارٍ الدخول..." : "تسجيل الدخول"}</Button>
      </form>
    </div>
  );
}
