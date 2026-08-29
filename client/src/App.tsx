import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import DashboardLayout from "./components/DashboardLayout";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import Jobs from "./pages/Jobs";
import NotFound from "./pages/NotFound";
import Settings from "./pages/Settings";
import Sources from "./pages/Sources";
import Users from "./pages/Users";
import Login from "./pages/Login";

function ProtectedPage({ Component }: { Component: React.ComponentType }) {
  return (
    <DashboardLayout>
      <Component />
    </DashboardLayout>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/" component={() => <ProtectedPage Component={Home} />} />
      <Route path="/jobs" component={() => <ProtectedPage Component={Jobs} />} />
      <Route path="/sources" component={() => <ProtectedPage Component={Sources} />} />
      <Route path="/settings" component={() => <ProtectedPage Component={Settings} />} />
      <Route path="/users" component={() => <ProtectedPage Component={Users} />} />
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster richColors position="top-center" />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
