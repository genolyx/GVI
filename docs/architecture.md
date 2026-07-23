# Genolyx Variant Interpreter 아키텍처

## 시스템 경계

Genolyx Variant Interpreter(GVI)는 **임상 유전체 해석 제어면**과 **중량 분석 실행면**을 분리한다. 웹 애플리케이션은 조직·프로젝트·케이스, 입력 파일 메타데이터, 변이, 근거, 판정, 보고서와 감사 이벤트를 관리한다. FASTQ 정렬·variant calling처럼 요청 제한 시간을 초과할 수 있는 작업은 웹 프로세스에서 실행하지 않고 기관 내부의 Site Gateway가 outbound 방식으로 가져간다.

| 계층 | 기술·구성 | 책임 |
|---|---|---|
| Web client | React 19, TypeScript, Tailwind, shadcn/ui | 조직별 임상 워크플로, 권한 기반 UI, 접근성 상태 |
| API | Express, tRPC | 입력 검증, 인증, 조직 경계, 액션 권한, 상태 전이 |
| Domain | 순수 TypeScript 정책 모듈 | ACMG/AMP 코드, Copilot 인용 가드, 보고서 해시·불변성 |
| Database | MySQL/TiDB, Drizzle ORM | 테넌트 소유 메타데이터, 관계, 감사 이벤트 |
| Object storage | S3 호환 저장소 | 입력 파일과 분석 산출물, 조직 prefix 격리 |
| Site Gateway | 기관 내부 `gx-daemon`·`gx-exome` 연계 | manifest pull, FASTQ 분석, 산출물 push |
| AI gateway | 서버측 내장 LLM API | Evidence Ledger 기반 요약·초안, 허용 모델 목록 |

## 요청 및 데이터 흐름

브라우저 요청은 OAuth 세션으로 사용자를 식별한다. tRPC 프로시저는 `organizationId`를 입력받고, 서버의 조직 권한 경계가 활성 멤버십과 요청 액션을 먼저 검증한다. 데이터베이스 조회는 검증된 조직 식별자를 조건으로 포함하며, 성공한 변경은 동일 조직의 감사 이벤트로 기록한다.

```text
Browser → OAuth session → tRPC input validation
        → organization membership + action permission
        → organization-scoped query/mutation → audit event
```

조직 목록이나 권한 카탈로그 조회가 실패하면 전역 레이아웃은 하위 라우트를 렌더링하지 않고 재시도·로그아웃만 제공한다.

## 핵심 도메인

| Aggregate | 주요 관계와 불변조건 |
|---|---|
| Organization | 멤버, 초대, 프로젝트의 루트 테넌트 |
| Project | 한 조직에 속하며 케이스를 묶는 운영 단위 |
| Case | 목적, reference build, 샘플, 파일, 분석 작업을 소유 |
| Variant | 조직·케이스에 속하며 정규화 ID와 임상 주석을 보유 |
| Evidence | 출처, URL, 접근 시각, 요약, 강도와 방향을 보유 |
| Interpretation | 변이별 판정 초안·검토·승인과 적용 기준을 보유 |
| Report | 케이스별 버전 체인, JSON 내용, 서명자, 스냅샷 해시 |
| Audit event | 조직, 행위자, 액션, 대상, before/after, 요청 메타데이터 |

모든 테넌트 소유 테이블은 `organizationId`를 포함한다. 케이스 하위 데이터는 조직 식별자를 포함한 부모 관계를 사용해 다른 조직의 부모를 참조하지 못하도록 설계한다.

## VCF와 FASTQ

VCF·TSV는 제한된 크기에서 웹 업로드 후 서버가 헤더와 변이 행을 파싱한다. 파일 바이트는 S3에 저장하고 데이터베이스에는 key, URL, MIME, 크기, SHA-256만 보관한다. 파싱된 변이는 동일 조직·케이스 범위에서 일괄 저장된다.

FASTQ와 대용량 입력은 `analysis_job`을 생성한다. Site Gateway는 Bearer 토큰으로 대기 manifest를 가져가 내부 파이프라인을 실행하고, 진행률·상태·산출물 메타데이터를 push한다. 웹 런타임은 요청 이후 살아 있어야 하는 worker를 실행하지 않는다.

## 판정과 보고

```text
Variant imported → Evidence Ledger reviewed → Interpretation draft
→ Submitted for review → Clinician approval → Report draft
→ In review → Electronic signature → Immutable snapshot + SHA-256
```

ACMG/AMP 코드와 보고서 상태 전이는 결정적 정책으로 검증한다. Copilot은 저장된 Evidence Ledger ID만 인용할 수 있고 판정 승인이나 전자서명을 수행할 수 없다. 서명된 보고서는 수정하지 않고 후속 amendment 버전으로 이어간다.

## 배포 특성

웹 애플리케이션은 단일 Node 서버 프로세스와 서버리스 Autoscale 환경을 전제로 한다. 장시간 실행, 고정 IP, 내부 데이터 접근이 필요한 분석은 Site Gateway 경계에 둔다. 운영 전 데이터베이스 백업·복구, S3 수명주기, 키 회전, 기관별 게이트웨이 등록과 장애 대응 절차를 별도로 확정해야 한다.
