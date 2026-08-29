import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { useAuth } from "@/_core/hooks/useAuth";
import { useIsMobile } from "@/hooks/useMobile";
import { BookOpenText, Crown, Database, LayoutDashboard, ListChecks, LogOut, PanelRightClose, Settings2, Users } from "lucide-react";
import { CSSProperties, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from "./DashboardLayoutSkeleton";
import { Button } from "./ui/button";

const menuItems = [
  { icon: LayoutDashboard, label: "نظرة عامة", path: "/" },
  { icon: ListChecks, label: "طابور الفصول", path: "/jobs" },
  { icon: BookOpenText, label: "المصادر المصرح بها", path: "/sources" },
  { icon: Settings2, label: "الإعدادات والتكامل", path: "/settings" },
  { icon: Users, label: "الأعضاء والصلاحيات", path: "/users" },
];

const SIDEBAR_WIDTH_KEY = "manga-drive-sidebar-width";
const DEFAULT_WIDTH = 292;
const MIN_WIDTH = 236;
const MAX_WIDTH = 420;

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return saved ? Number.parseInt(saved, 10) : DEFAULT_WIDTH;
  });
  const { loading, user } = useAuth({ redirectOnUnauthenticated: true, redirectPath: "/login" });
  const [, setLocation] = useLocation();

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
  }, [sidebarWidth]);

  if (loading) return <DashboardLayoutSkeleton />;

  if (!user) {
    return (
      <div dir="rtl" className="artdeco-shell flex min-h-screen items-center justify-center p-5">
        <div className="artdeco-frame w-full max-w-md p-8 text-center">
          <div className="gold-emblem mx-auto mb-6"><Crown className="h-6 w-6" /></div>
          <p className="eyebrow">بوابة الإدارة الخاصة</p>
          <h1 className="mt-3 font-display text-4xl font-bold text-foreground">أهلًا بك في دار الفصول</h1>
          <p className="mt-4 leading-7 text-muted-foreground">تتطلب هذه اللوحة تسجيل الدخول لحماية إعدادات Discord وGoogle Drive ومصادر Suwayomi.</p>
          <Button onClick={() => setLocation("/login")} size="lg" className="gold-button mt-7 w-full">تسجيل الدخول</Button>
        </div>
      </div>
    );
  }

  return (
    <SidebarProvider style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <DashboardLayoutContent setSidebarWidth={setSidebarWidth}>{children}</DashboardLayoutContent>
    </SidebarProvider>
  );
}

function DashboardLayoutContent({ children, setSidebarWidth }: { children: React.ReactNode; setSidebarWidth: (width: number) => void }) {
  const { user, logout } = useAuth();
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const activeMenuItem = menuItems.find(item => item.path === location);
  const isMobile = useIsMobile();

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (!isResizing) return;
      const rightEdge = sidebarRef.current?.getBoundingClientRect().right ?? window.innerWidth;
      const width = rightEdge - event.clientX;
      if (width >= MIN_WIDTH && width <= MAX_WIDTH) setSidebarWidth(width);
    };
    const handleMouseUp = () => setIsResizing(false);
    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, setSidebarWidth]);

  return (
    <div dir="rtl" className="artdeco-shell flex min-h-screen w-full">
      <div className="relative" ref={sidebarRef}>
        <Sidebar side="right" collapsible="icon" className="artdeco-sidebar border-l-0" disableTransition={isResizing}>
          <SidebarHeader className="h-auto p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3 group-data-[collapsible=icon]:justify-center">
                <div className="gold-emblem h-10 w-10 shrink-0"><Crown className="h-5 w-5" /></div>
                {!isCollapsed && <div className="min-w-0"><p className="font-display text-lg font-bold tracking-wide text-foreground">دار الفصول</p><p className="mt-0.5 truncate text-[10px] tracking-[0.18em] text-primary">MANGA OPERATIONS</p></div>}
              </div>
              {!isCollapsed && <button onClick={toggleSidebar} aria-label="طي القائمة" className="nav-icon-button"><PanelRightClose className="h-4 w-4" /></button>}
            </div>
          </SidebarHeader>

          <SidebarContent className="px-3 pt-4">
            {!isCollapsed && <p className="px-3 pb-2 text-[10px] font-bold tracking-[0.2em] text-muted-foreground">الإدارة</p>}
            <SidebarMenu className="gap-1.5">
              {menuItems.map(item => {
                const active = location === item.path;
                return (
                  <SidebarMenuItem key={item.path}>
                    <SidebarMenuButton isActive={active} onClick={() => setLocation(item.path)} tooltip={item.label} className="nav-menu-button h-11">
                      <item.icon className="h-4 w-4" />
                      <span>{item.label}</span>
                      {active && !isCollapsed && <span className="mr-auto h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_12px_var(--primary)]" />}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
            <div className="m-3 mt-8 border-t border-primary/20 pt-6 group-data-[collapsible=icon]:hidden">
              <div className="rounded-sm border border-primary/20 bg-primary/5 p-3">
                <div className="flex items-center gap-2 text-primary"><Database className="h-3.5 w-3.5" /><span className="text-xs font-semibold">البيانات مصانة</span></div>
                <p className="mt-2 text-[11px] leading-5 text-muted-foreground">لا تُعرض الأسرار في هذه اللوحة أو في سجل المهام.</p>
              </div>
            </div>
          </SidebarContent>

          <SidebarFooter className="p-4">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex w-full items-center gap-3 rounded-sm border border-transparent px-2 py-2 text-right transition-colors hover:border-primary/20 hover:bg-primary/5 group-data-[collapsible=icon]:justify-center">
                  <Avatar className="h-9 w-9 shrink-0 border border-primary/35"><AvatarFallback className="bg-primary/10 text-xs font-bold text-primary">{user?.name?.charAt(0).toUpperCase() ?? "م"}</AvatarFallback></Avatar>
                  <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden"><p className="truncate text-sm font-semibold">{user?.name || "المالك"}</p><p className="mt-0.5 truncate text-[11px] text-muted-foreground">إدارة المنصة</p></div>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48 border-primary/25 bg-popover">
                <DropdownMenuItem onClick={logout} className="cursor-pointer text-destructive focus:text-destructive"><LogOut className="ml-2 h-4 w-4" />تسجيل الخروج</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarFooter>
        </Sidebar>
        <div className={`absolute left-0 top-0 z-50 h-full w-1 cursor-col-resize transition-colors hover:bg-primary/30 ${isCollapsed ? "hidden" : ""}`} onMouseDown={() => setIsResizing(true)} />
      </div>

      <SidebarInset className="min-w-0 flex-1 bg-transparent">
        {isMobile && <div className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-primary/15 bg-background/95 px-4 backdrop-blur"><div className="flex items-center gap-2"><SidebarTrigger className="border border-primary/25 bg-card" /><span className="font-display text-base font-bold">{activeMenuItem?.label ?? "دار الفصول"}</span></div><div className="gold-emblem h-7 w-7"><Crown className="h-3.5 w-3.5" /></div></div>}
        <main className="min-h-screen p-4 sm:p-7 lg:p-10">{children}</main>
      </SidebarInset>
    </div>
  );
}
