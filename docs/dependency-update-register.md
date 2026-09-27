# Runtime and dependency update register

이 문서는 배포 전에 필요한 런타임 및 패키지 업데이트를 추적합니다. 임상 CDS의 재현성을 위해 패키지는 자동 일괄 갱신하지 않고, 별도 변경 관리에서 typecheck, 전체 테스트, DB E2E, 브라우저 acceptance와 snapshot 재현성을 다시 검증합니다.

## 2026-09-27 audit

실행 명령:

```bash
pnpm outdated --format json
pnpm audit --json
pnpm audit --prod --json
```

현재 lockfile 기준 전체 audit는 critical 3, high 46, moderate 50, low 6건이며, production dependency audit는 critical 1, high 11, moderate 20, low 5건입니다. 하나의 취약한 transitive package가 여러 dependency path에 나타나므로 이 숫자는 고유 package 수가 아닙니다.

## 배포 전 필수 업데이트

- Node.js `18.19.1` → `20.19+` 또는 `22.12+`: 현재 Vite 7 지원 범위 밖입니다. 권장 배포 기준은 Node.js 22 LTS입니다.
- `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` resolved `3.907.0` → 검증된 최신 3.x: 현재 transitive `fast-xml-parser 5.2.5`에 critical advisory가 있습니다. 최소 patched version은 `fast-xml-parser >=5.3.5`입니다.
- `@tailwindcss/vite`/`tailwindcss` `4.1.14` → `4.3.3`: transitive `tar 7.5.1`을 최소 `7.5.19` 이상으로 올려야 하는 critical build-time advisory가 있습니다.
- `vitest` `2.1.9` → 최소 `3.2.6`, 권장 검증 대상 `5.0.2`: 현재 버전에 critical advisory가 있습니다. major update이므로 test environment와 mocking behavior를 전부 재검증해야 합니다.

위 항목이 해소되기 전에는 현재 lockfile을 production release 기준으로 승인하지 않습니다.

## 동일 major 내 업데이트 후보

- AWS: `@aws-sdk/client-s3` `3.907.0 → 3.1141.0`, `@aws-sdk/s3-request-presigner` `3.907.0 → 3.1141.0`
- Data/API: `@tanstack/react-query` `5.90.2 → 5.104.0`; `@trpc/client`, `@trpc/react-query`, `@trpc/server` `11.6.0 → 11.19.0`; `zod` `4.1.12 → 4.6.5`; `drizzle-orm` `0.44.6 → 0.45.3`; `drizzle-kit` `0.31.5 → 0.31.11`
- Forms/UI: `@hookform/resolvers` `5.2.2 → 5.9.1`; `react-hook-form` `7.64.0 → 7.89.0`; `input-otp` `1.4.2 → 1.5.0`; `sonner` `2.0.7 → 2.0.8`; `tailwind-merge` `3.3.1 → 3.7.0`; `wouter` `3.7.1 → 3.11.0`
- React: `react`, `react-dom` `19.2.1 → 19.3.0`; `@types/react`, `@types/react-dom` `19.2.1 → 19.3.0`
- Security/runtime utilities: `dompurify` `3.4.15 → 3.4.16`; `jose` `6.1.0 → 6.2.12`; `date-fns` `4.1.0 → 4.4.0`
- Build tooling: `@tailwindcss/vite`, `tailwindcss` `4.1.14 → 4.3.3`; `@tailwindcss/typography` `0.5.19 → 0.5.20`; `autoprefixer` `10.4.21 → 10.6.1`; `postcss` `8.5.6 → 8.5.28`; `prettier` `3.6.2 → 3.9.9`; `tsx` `4.20.6 → 4.23.15`; `esbuild` `0.25.10 → 0.28.2`
- Types: `@types/google.maps` `3.58.1 → 3.66.4`
- Radix patch/minor: accordion `1.2.12 → 1.2.20`, alert-dialog `1.1.15 → 1.1.23`, aspect-ratio `1.1.7 → 1.1.15`, avatar `1.1.10 → 1.2.6`, checkbox `1.3.3 → 1.3.11`, collapsible `1.1.12 → 1.1.20`, context-menu `2.2.16 → 2.3.7`, dialog `1.1.15 → 1.1.23`, dropdown-menu `2.1.16 → 2.1.24`, hover-card `1.1.15 → 1.1.23`, label `2.1.7 → 2.1.15`, menubar `1.1.16 → 1.1.24`, navigation-menu `1.2.14 → 1.2.22`, popover `1.1.15 → 1.1.23`, progress `1.1.7 → 1.1.16`, radio-group `1.3.8 → 1.4.7`, scroll-area `1.2.10 → 1.2.18`, select `2.2.6 → 2.3.7`, separator `1.1.7 → 1.1.15`, slider `1.3.6 → 1.4.7`, slot `1.2.3 → 1.3.3`, switch `1.2.6 → 1.3.7`, tabs `1.1.13 → 1.1.21`, toggle `1.1.10 → 1.1.18`, toggle-group `1.1.11 → 1.1.19`, tooltip `1.2.8 → 1.2.16`
- 기타 개발 도구: `add` `2.0.6 → 2.0.9`

`0.x` 패키지와 Radix minor update도 API 변화 가능성이 있으므로 lockfile 갱신 후 UI keyboard/focus 회귀를 확인합니다.

## 별도 호환성 프로젝트가 필요한 major 업데이트

- `express` `4.21.2 → 5.2.1`, `@types/express` `4.17.21 → 5.0.6`
- `vite` `7.1.9 → 8.3.1`, `@vitejs/plugin-react` `5.0.4 → 6.1.1`
- `vitest` `2.1.9 → 5.0.2`
- `typescript` `5.9.3 → 7.0.2`, `@types/node` `24.7.0 → 26.6.3`
- `pnpm` resolved `10.18.0 → 12.6.0`; 저장소의 고정 `packageManager`는 현재 `10.4.1`
- `cookie` `1.0.2 → 2.0.1`, `dotenv` `17.2.3 → 18.0.4`, `nanoid` `5.1.6 → 6.0.1`
- `framer-motion` `12.23.22 → 13.4.4`
- `react-day-picker` `9.11.1 → 10.0.1`
- `react-resizable-panels` `3.0.6 → 4.14.1`
- `recharts` `2.15.4 → 3.10.1`
- `streamdown` `1.4.0 → 2.6.0`
- `superjson` `1.13.3 → 2.2.6`
- `jsdom` `26.1.0 → 30.1.1`
- `lucide-react` `0.453.0 → 1.48.0`

## 업데이트 검증 순서

1. Node.js 22 LTS 환경과 현재 pnpm 고정 버전을 준비합니다.
2. critical production dependency, critical build/test dependency, 동일-major update, major update 순으로 변경을 분리합니다.
3. 각 변경 묶음에서 `pnpm check`, 전체 Vitest, Somatic DB E2E, Germline triage regression, production build를 실행합니다.
4. 로그인, 파일 업로드/S3 presign, report print/PDF, Workbench keyboard/focus, tRPC serialization을 브라우저에서 확인합니다.
5. `pnpm audit --prod` 결과와 lockfile SHA-256을 release validation artifact에 보관합니다.
