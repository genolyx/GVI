# Genolyx Variant Interpreter 검증 기록

이 문서는 현재 구현의 **라우트별 상태 UI, 권한 경계, 키보드 접근성, 자동 테스트 및 빌드 검증 근거**를 기록한다. 이는 규제 승인이나 의료기기 적합성 인증을 대체하지 않으며, 실제 임상 사용 전 조직의 품질관리체계에 따른 별도 검증이 필요하다.

## 라우트별 상태 및 접근성 감사

| 라우트 | 로딩 | 빈 상태 | 오류·재시도 | 권한 부족 | 키보드·포커스 |
|---|---|---|---|---|---|
| `/` | 대시보드 쿼리 스켈레톤 | 온보딩·최근 케이스 없음 | 재시도 가능한 `StatePanel` | 메뉴·액션 권한 기반 | 기본 버튼·링크 및 전역 포커스 링 |
| `/cases` | 목록 스켈레톤 | 공통 `StatePanel` + 분석 의뢰 | 목록 재시도 | `case:read` 직접 URL 가드 | 모바일 버튼·데스크톱 행 Enter/Space |
| `/cases/new` | 프로젝트 로딩 상태 | 프로젝트 없음 | 프로젝트·업로드·제출 재시도 | `case:create` 가드 | 레이블 연결 폼 컨트롤 |
| `/cases/:id` | 상세 스켈레톤 | 테넌트 은닉형 없음 상태 | 상세·타임라인·보고서 초안 재시도 | `case:read` 직접 URL 가드 | 네이티브 버튼·링크 |
| `/workbench` | 해당 없음 | 케이스 선택 안내 | 해당 없음 | `variant:read` 가드 | 네이티브 CTA |
| `/workbench/:caseId` | 케이스·변이·상세·Copilot 로딩 | 변이·근거·대화 없음 | 모든 query 및 refresh/save/approve/ask 작업별 재시도 | `variant:read` 직접 URL 가드 | 변이 행 Enter/Space, 레이블 있는 필터 |
| `/reports` | 목록 스켈레톤 | 공통 `StatePanel` + 케이스 이동 | 목록 재시도 | `report:read` 직접 URL 가드 | 보고서 카드가 네이티브 버튼 |
| `/reports/:id` | 문서 스켈레톤 | 테넌트 은닉형 없음 상태 | 조회·저장·검토·서명 오류 | `report:read` 직접 URL 가드, 액션별 권한 | 폼 레이블·다이얼로그 포커스 관리 |
| `/organization` | 멤버·초대 로딩 | 초대 없음 | 목록·초대·역할 변경 재시도 | `member:manage` 가드 | 네이티브 폼 컨트롤 |
| `/audit` | 로그 스켈레톤 | 공통 `StatePanel` | 로그 재시도 | `audit:view` 가드 | 네이티브 필터 컨트롤 |
| `/security` | 보안 컨텍스트 스켈레톤 | 프로젝트 없음 | 컨텍스트 재시도 | `security:view` 가드 | 읽기 중심 구조 |
| 미등록 경로 | 해당 없음 | 404 안내 | 해당 없음 | 해당 없음 | 네이티브 복귀 링크 |

## 전역 상태 및 상호작용 규칙

`OrganizationContext`는 조직 목록과 권한 카탈로그의 로딩·오류를 전역 레이아웃에 노출한다. 인증 후 조직 컨텍스트를 확인하기 전에는 자식 라우트를 렌더링하지 않으며, 실패 시 재시도 또는 로그아웃만 제공한다. `StatePanel`은 `loading`, `empty`, `error`, `forbidden` 변형을 제공하고 오류 변형에는 `role="alert"`와 assertive live region을 적용한다.

`client/src/index.css`는 버튼, 링크, 입력 컨트롤과 양의 `tabIndex` 요소에 2px 전역 `:focus-visible` 윤곽선을 제공한다. `prefers-reduced-motion: reduce`에서는 애니메이션과 전환 시간을 사실상 제거한다. 클릭 가능한 케이스·변이 행은 `tabIndex`, 의미 역할, `Enter`·`Space` 핸들러와 포커스 링을 함께 가진다.

## 보안·임상 경계 검증

| 검증 영역 | 자동 검증 근거 |
|---|---|
| 조직 침범 은닉 | 비멤버 조직 요청이 `NOT_FOUND`로 수렴하는 tenant 테스트 |
| 서버 RBAC | analyst·clinician·viewer 액션 분리 및 거부 테스트 |
| 감사 기록 | 조직·행위자·대상·before/after·요청 메타데이터 기록 테스트 |
| ACMG/AMP | 유효 코드, 중복 코드, 최종 분류, 목적별 제약 테스트 |
| Copilot | Evidence Ledger 외 인용 거부, 인용 누락 거부, 유효 인용 허용 테스트 |
| 보고서 불변성 | draft만 수정 가능하며 reviewed/signed/amended는 불변인 정책 테스트 |
| 게이트웨이 인증 | 선택적 Bearer 토큰 인증 성공·실패 테스트 |

## 재현 명령

```bash
pnpm install
pnpm check
pnpm vitest run
pnpm build
```

최종 소스 ZIP을 빈 임시 디렉터리에 해제하고 기존 프로젝트의 `node_modules`나 빌드 산출물을 연결하지 않은 상태에서 위 명령을 순서대로 실행했다. `pnpm install`은 잠금 파일 기준으로 완료됐고 TypeScript 오류는 없었다. 또한 `GVI_GATEWAY_TOKEN`을 제거한 프로세스에서도 **7개 테스트 파일의 22개 테스트가 통과**했으며, 프로덕션 Vite 번들과 `dist/index.js` 서버 번들이 성공적으로 생성되었다. Gateway 인증 테스트는 테스트 전용 토큰을 자체 주입하고 종료 시 기존 환경을 복원하므로 로컬 비밀값을 요구하지 않는다.

| ZIP 단독 재현 단계 | 결과 |
|---|---|
| 압축 무결성 | `unzip -t` 오류 없음 |
| 의존성 설치 | `pnpm install` 성공 |
| 타입 검사 | `tsc --noEmit` 성공 |
| 자동 테스트 | `GVI_GATEWAY_TOKEN` 없이 7개 파일, 22개 테스트 통과 |
| 프로덕션 빌드 | Vite 클라이언트 및 서버 번들 생성 성공 |

Vite의 500 kB 초과 청크 경고와 pnpm의 일부 의존성 빌드 스크립트 승인 경고는 존재하지만 설치·테스트·빌드 실패는 아니다. 후속 성능 단계에서는 페이지 단위 동적 import와 명시적인 의존성 빌드 정책을 검토할 수 있다.

## 운영 전 필수 확인

실제 임상 운영 전에는 조직별 역할 매핑, 초대 정책, 서명 권한, 데이터 보존·삭제 정책, S3 접근 로그, 데이터베이스 백업·복구, 외부 근거 라이선스, 개인정보 처리방침, 침해사고 대응 절차를 별도로 승인해야 한다. AI Copilot 결과는 자동 판정이나 서명 입력으로 사용하지 말고, 저장된 Evidence Ledger와 전문가 검토를 거친 초안으로만 취급해야 한다.
