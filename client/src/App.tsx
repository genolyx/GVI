import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import DashboardLayout from "./components/DashboardLayout";
import { OrganizationProvider } from "./contexts/OrganizationContext";
import CasesPage from "./pages/Cases";
import NewCasePage from "./pages/NewCase";
import CaseDetailPage from "./pages/CaseDetail";
import WorkbenchPage from "./pages/Workbench";
import WorkbenchLandingPage from "./pages/WorkbenchLanding";
import ReportsPage from "./pages/Reports";
import ReportEditorPage from "./pages/ReportEditor";
import OrganizationPage from "./pages/Organization";
import InviteAcceptPage from "./pages/InviteAccept";
import AuditLogPage from "./pages/AuditLog";
import SecurityConsolePage from "./pages/SecurityConsole";

function Router() {
  // make sure to consider if you need authentication for certain routes
  return (
    <Switch>
      <Route path={"/"} component={Home} />
      <Route path={"/invite/:token"} component={InviteAcceptPage} />
      <Route path={"/cases"} component={CasesPage} />
      <Route path={"/cases/new"} component={NewCasePage} />
      <Route path={"/cases/:id"} component={CaseDetailPage} />
      <Route path={"/workbench"} component={WorkbenchLandingPage} />
      <Route path={"/workbench/:caseId"} component={WorkbenchPage} />
      <Route path={"/reports"} component={ReportsPage} />
      <Route path={"/reports/:id"} component={ReportEditorPage} />
      <Route path={"/organization"} component={OrganizationPage} />
      <Route path={"/audit"} component={AuditLogPage} />
      <Route path={"/security"} component={SecurityConsolePage} />
      <Route path={"/404"} component={NotFound} />
      {/* Final fallback route */}
      <Route component={NotFound} />
    </Switch>
  );
}

// NOTE: About Theme
// - First choose a default theme according to your design style (dark or light bg), than change color palette in index.css
//   to keep consistent foreground/background color across components
// - If you want to make theme switchable, pass `switchable` ThemeProvider and use `useTheme` hook

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider
        defaultTheme="light"
        // switchable
      >
        <TooltipProvider>
          <Toaster />
          <OrganizationProvider>
            <DashboardLayout>
              <Router />
            </DashboardLayout>
          </OrganizationProvider>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
