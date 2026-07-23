# Genolyx Variant Interpreter

**Genolyx Variant Interpreter(GVI)**는 FASTQ 또는 VCF에서 시작해 Germline·Somatic 변이 검토, 근거 추적, 전문가 판정, 전자서명 보고서까지 연결하는 임상 유전체 해석 SaaS입니다.

> GVI는 전문가의 판단을 보조하는 소프트웨어입니다. AI 출력은 근거 초안이며 임상 판정이나 전자서명을 대체하지 않습니다. 실제 진단 환경에 사용하려면 기관별 검증, QMS, 규제 검토와 승인된 데이터 라이선스가 필요합니다.

## Product principles

| 원칙 | 구현 기준 |
|---|---|
| Tenant isolation | 모든 테넌트 레코드에 `organizationId`를 강제하고, 서버의 모든 조회·변경 전에 활성 구성원과 액션 권한을 검증합니다. |
| Evidence first | 분류와 보고 문장은 근거 레코드, 출처 URL, 접근 시각과 원문 요약에 연결합니다. |
| Deterministic before generative | ACMG/AMP 코드와 보고 상태 전이는 결정적 규칙으로 처리하며 LLM은 근거 요약과 초안에만 사용합니다. |
| Human sign-out | AI는 판정 승인이나 보고서 서명을 수행할 수 없습니다. 서명은 `clinician` 역할만 가능합니다. |
| Immutable reporting | 서명 시 보고서 JSON 스냅샷과 SHA-256 해시를 생성하며 이후에는 새 amendment 버전만 만들 수 있습니다. |
| Transparent security | 활성 조직, 역할, 데이터 범위, 격리 통제와 감사 이벤트를 사용자가 직접 확인할 수 있습니다. |

## Architecture

GVI 웹 제어면은 React, TypeScript, tRPC, Drizzle/MySQL과 S3 호환 저장소로 구성됩니다. FASTQ의 중량 분석은 웹 요청 안에서 실행하지 않으며, 내부 분석 서버의 `gx-daemon`/`gx-exome`이 outbound 방식으로 작업 manifest를 가져가고 상태와 산출물을 반환하도록 경계를 분리합니다. VCF는 제한된 크기에서 포털 직접 업로드·파싱이 가능하며 대용량 파일은 같은 Site Gateway 경로를 사용합니다.

자세한 설계는 [`docs/architecture.md`](docs/architecture.md)와 [`docs/security-model.md`](docs/security-model.md)에서 확인할 수 있습니다.

## Local development

```bash
pnpm install
pnpm dev
```

검증 명령은 다음과 같습니다.

```bash
pnpm check
pnpm test
pnpm build
```

환경 변수와 비밀값은 저장소에 커밋하지 않습니다. 관리형 런타임은 인증, 데이터베이스, 파일 저장소와 서버측 LLM 자격 증명을 주입합니다.

## Current implementation target

첫 릴리스는 조직·프로젝트·케이스, VCF 수직 워크플로, FASTQ 작업 manifest, Germline·Somatic 판정 워크벤치, 근거 기반 AI 코파일럿, 불변 보고서, 전자서명, 감사 로그와 보안 투명성 콘솔을 하나의 검증 가능한 흐름으로 제공합니다.
