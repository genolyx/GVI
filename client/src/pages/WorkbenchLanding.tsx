import { PageHeader } from "@/components/PageHeader";
import { StatePanel } from "@/components/StatePanel";
import { Button } from "@/components/ui/button";
import { useOrganization } from "@/contexts/OrganizationContext";
import { ArrowRight } from "lucide-react";
import { useLocation } from "wouter";

export default function WorkbenchLandingPage() {
  const { hasPermission } = useOrganization();
  const [, navigate] = useLocation();
  return <div className="space-y-7"><PageHeader eyebrow="Variant interpretation" title="변이 워크벤치" description="케이스별 변이, Evidence Ledger, ACMG/AMP 판정과 AI 보조 초안을 검토합니다." />{hasPermission("variant:read") ? <StatePanel type="empty" title="검토할 케이스를 선택하십시오" description="워크벤치는 케이스의 참조 빌드, 검사 목적, 조직 경계를 유지한 채 열립니다." action={<Button onClick={() => navigate("/cases")}>케이스 선택<ArrowRight className="ml-2 size-4" /></Button>} /> : <StatePanel type="forbidden" title="변이 조회 권한이 없습니다" description="조직 관리자에게 variant:read 액션이 포함된 역할을 요청하십시오." />}</div>;
}
