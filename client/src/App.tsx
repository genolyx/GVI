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
import WorkbenchHomePage from "./pages/workbench/WorkbenchHome";
import SomaticWorkbenchHomePage from "./pages/workbench/SomaticWorkbenchHome";
import BatchPage from "./pages/workbench/BatchPage";
import BatchReviewPage from "./pages/workbench/BatchReviewPage";
import ReportsPage from "./pages/Reports";
import ClinicalReportPage from "./pages/ClinicalReport";
import OrganizationPage from "./pages/Organization";
import InviteAcceptPage from "./pages/InviteAccept";
import AuditLogPage from "./pages/AuditLog";
import SecurityConsolePage from "./pages/SecurityConsole";
import SettingsPage from "./pages/Settings";
import LiteraturePage from "./pages/Literature";
import ClassificationsPage from "./pages/Classifications";
import SomaticReportTemplatesPage from "./pages/SomaticReportTemplates";
import SomaticGovernancePage from "./pages/SomaticGovernance";

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
      <Route path={"/workbench/germline"} component={WorkbenchHomePage} />
      <Route path={"/workbench/somatic"} component={SomaticWorkbenchHomePage} />
      <Route path={"/somatic-governance"} component={SomaticGovernancePage} />
      <Route
        path={"/workbench/batches/:batchId/review/:runId"}
        component={BatchReviewPage}
      />
      <Route path={"/workbench/batches/:batchId"} component={BatchPage} />
      <Route path={"/workbench/:caseId"} component={WorkbenchPage} />
      <Route path={"/reports"} component={ReportsPage} />
      <Route
        path={"/report-templates/somatic"}
        component={SomaticReportTemplatesPage}
      />
      <Route path={"/reports/:id"} component={ClinicalReportPage} />
      <Route path={"/organization"} component={OrganizationPage} />
      <Route path={"/audit"} component={AuditLogPage} />
      <Route path={"/security"} component={SecurityConsolePage} />
      <Route path={"/settings"} component={SettingsPage} />
      <Route path={"/literature"} component={LiteraturePage} />
      <Route path={"/classifications"} component={ClassificationsPage} />
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
      <ThemeProvider defaultTheme="dark" switchable>
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
