# Somatic CDS 운영 준비 TODO

이 문서는 개발 완료 후 사용자가 준비하고 승인해야 하는 10개 운영 항목을 추적합니다. 각 항목은 **준비 → 적용 → 검증 → 증빙 보관**까지 완료해야 체크합니다. 환자 직접 식별정보, 접근 권한이 없는 데이터, API token은 Git에 커밋하지 않습니다.

## 진행 현황

- [ ] 1. Node.js 22 LTS 및 필수 dependency update
- [ ] 2. OncoKB Research API 계정과 secret 설정
- [ ] 3. GRCh37/GRCh38 reference FASTA 승인 및 배포
- [ ] 4. Target Panel별 BED와 version 등록
- [ ] 5. Coverage 및 CNV/Fusion/MSI/TMB/HRD 검증 자료 준비
- [ ] 6. 전문가 gold set 작성 및 검증
- [ ] 7. 기관 임상 SOP와 change-control 확정
- [ ] 8. Clinical Report template와 서명 권한 승인
- [ ] 9. Production DB migration, backup, restore 검증
- [ ] 10. OncoKB Commercial 전환 준비

---

## 1. Node.js 22 LTS 및 필수 dependency update

### 준비

- Production, CI, 개발 환경의 현재 `node --version`, `pnpm --version` 기록
- 권장 기준: Node.js 22 LTS, 저장소에 고정된 pnpm version
- 상세 package 위험과 update 후보는 `docs/dependency-update-register.md` 참고

### 적용 방법

`nvm`을 사용하는 경우:

```bash
nvm install 22
nvm use 22
node --version
corepack enable
corepack prepare pnpm@10.4.1 --activate
pnpm --version
pnpm install --frozen-lockfile
```

Production container/CI에서는 base image를 Node 22 LTS로 고정합니다. 이후 AWS SDK, Tailwind, Vitest critical advisory를 각각 별도 변경 묶음으로 업데이트합니다. 모든 package를 한 번에 major update하지 않습니다.

### 검증

```bash
pnpm check
pnpm vitest run
pnpm exec tsx scripts/somatic-e2e.ts all
pnpm build
pnpm audit --prod
```

### 완료 기준과 증빙

- [ ] 모든 실행 환경이 Node 22 LTS 사용
- [ ] typecheck, 전체 test, DB E2E, build 통과
- [ ] production critical advisory 해소
- [ ] Node/pnpm version, audit 결과, `pnpm-lock.yaml` SHA-256 보관

---

## 2. OncoKB Research API 계정과 secret 설정

### 준비

- 기관 이메일로 Research/Academic API access 승인
- 허용 용도, 사용자, 만료일, 결과 보관 가능 범위를 문서화
- API token은 Git 파일이 아닌 secret manager에 저장

### 적용 방법

Research 환경 secret:

```bash
ONCOKB_API_MODE=research
ONCOKB_API_TOKEN=<secret-manager-reference>
ONCOKB_BASE_URL=https://www.oncokb.org
```

애플리케이션의 `/somatic-governance`에서 OncoKB provider를 등록하되 Research license reference를 기록합니다. Research 결과는 Clinical Report에 사용할 수 없으므로 organization policy의 임상 OncoKB 사용은 활성화하지 않습니다.

### 검증

- 승인된 비식별 test variant로 API smoke test
- 401/403이 없고 response version/date와 raw-response hash가 저장되는지 확인
- token이 DB, audit, log, raw response에 노출되지 않는지 확인
- Research evidence가 report review/signing에서 차단되는지 확인

### 완료 기준과 증빙

- [ ] Research 승인서와 만료일 보관
- [ ] Secret manager 등록 및 rotation 담당자 지정
- [ ] API smoke test와 report 차단 결과 보관

---

## 3. GRCh37/GRCh38 reference FASTA 승인 및 배포

### 준비

- 실제 Panel이 사용하는 build만 우선 준비
- FASTA 출처, release명, contig naming, decoy/alternate 포함 정책 확정
- FASTA와 같은 경로에 `samtools faidx` 호환 `.fai` 생성

### 적용 방법

```bash
samtools faidx /data/reference/GRCh38.fa
sha256sum /data/reference/GRCh38.fa
```

환경 설정 예:

```bash
SOMATIC_REFERENCE_FASTA_GRCH38=/data/reference/GRCh38.fa
SOMATIC_REFERENCE_FASTA_GRCH38_SHA256=<64-character-sha256>
SOMATIC_REFERENCE_FASTA_GRCH38_VERSION=<approved-release-name>
```

GRCh37을 사용하는 경우 동일하게 `GRCH37` 변수 세 개를 설정합니다. FASTA와 `.fai`는 application runtime에서 read-only mount를 권장합니다.

### 검증

- 승인된 SNV, deletion, insertion, repeat INDEL로 normalization 확인
- 잘못된 REF, build, contig, SHA-256이 fail-closed 되는지 확인
- run analysis와 signed report snapshot에 FASTA version/hash가 남는지 확인

### 완료 기준과 증빙

- [ ] FASTA source/license와 release 승인
- [ ] `.fai`, 독립 검산 SHA-256, read-only 배포 완료
- [ ] 정상 및 실패 normalization 결과 보관

---

## 4. Target Panel별 BED와 version 등록

### 준비

Panel version마다 다음을 별도로 준비합니다.

- 제조사, 제품명, 정확한 version(예: `3.1.2`, `4`)
- genome build, assay type, SNV/INDEL·CNV·Fusion·MSI·TMB·HRD capability
- reportable BED 또는 normalized JSON
- minimum depth, minimum coverage percentage, limitation
- artifact SHA-256와 승인자

Strict BED4 형식:

```text
chromosome<TAB>start0<TAB>endExclusive<TAB>regionKey
```

### 적용 방법

1. Somatic Case 생성 시 정확한 Panel version을 선택하거나 새 version 등록
2. Somatic Workbench에서 BED/JSON upload
3. 변환 좌표와 region count 검토
4. `interpretation:approve` 권한자가 region artifact 승인
5. 승인 후 수정하지 않고 변경은 새 Panel version으로 등록

### 검증

- 중복 `regionKey`, 잘못된 좌표, build mismatch가 거부되는지 확인
- capability와 실제 assay 범위 일치 확인
- Panel version diff preview에서 추가·삭제·threshold 변경이 표시되는지 확인

### 완료 기준과 증빙

- [ ] 운영할 모든 Panel/version 등록
- [ ] BED/JSON SHA-256와 validation summary 보관
- [ ] 전문가 승인 및 change-control ID 기록

---

## 5. Coverage 및 CNV/Fusion/MSI/TMB/HRD 검증 자료 준비

### 준비

Coverage TSV:

```text
regionKey<TAB>meanDepth<TAB>coveredPercent
```

Assay normalized TSV:

```text
findingType<TAB>status<TAB>result<TAB>sourceRunId<TAB>coverageSummaryId
```

장비별로 pipeline/software version, field dictionary, unit, cutoff, 검출한계, failed/null 표현, 원본 export 예시를 준비합니다.

### 적용 방법

1. 비식별 validation case에 coverage upload
2. Panel threshold로 재계산된 QC 검토 후 승인
3. Assay JSON/TSV upload
4. 모든 finding이 `reportable=false`로 시작하는지 확인
5. 전문가가 개별 결과와 source artifact hash를 확인해 reportability 승인

### 검증

- 누락 region 또는 threshold 미달 시 negative reporting 차단
- `not_tested`가 full-panel negative로 처리되지 않는지 확인
- 새 assay artifact가 기존 reportable finding과 겹치면 impact task 생성

### 완료 기준과 증빙

- [ ] 각 finding type별 양성·음성·indeterminate example 확보
- [ ] cutoff 및 QC validation report 승인
- [ ] 원본/normalized artifact SHA-256와 mapping specification 보관

---

## 6. 전문가 gold set 작성 및 검증

### 준비

- 대표 target-panel 비식별 case 15–30건 권장
- 양성, 음성, VUS/불확실, low-depth, conflict, non-reportable 사례 포함
- `shared/fixtures/somatic/expert-gold/template.json`을 복사하여 작성

### 적용 및 검증 방법

```bash
cp shared/fixtures/somatic/expert-gold/template.json /secure/path/gold-v1.json
pnpm validate:somatic-gold -- /secure/path/gold-v1.json
```

각 case에 ontology, Panel version, normalized variant, QC, oncogenicity, AMP Tier/Level, reportability, evidence ID와 pseudonymous reviewer 정보를 입력합니다. `status: "final"`에는 draft review를 포함하지 않습니다.

### 완료 기준과 증빙

- [ ] validator 통과
- [ ] 최소 두 명의 전문가 또는 기관 승인 절차에 따른 adjudication 완료
- [ ] manifest SHA-256, reviewer/version, 기대 결과 보관
- [ ] 플랫폼 결과와 gold 결과의 불일치 목록 및 처리 결정 보관

---

## 7. 기관 임상 SOP와 change-control 확정

### 준비할 결정

- AMP/ASCO/CAP 적용 및 override 승인 규칙
- analyst/clinician 역할 분리와 최종 sign-out 권한
- negative/not-tested/insufficient coverage 판정
- knowledge, policy, Panel, assay 변경 승인
- 재해석 task SLA와 `completed`/`dismissed` 기준
- signed report amendment와 환자·의료진 재통지
- emergency rollback, audit 보존, incident response

### 적용 방법

1. SOP 문서 ID/version/effective date/owner 확정
2. `/somatic-governance`의 policy profile에 승인된 구조화 정책 등록
3. 실제 SOP 원문 대신 필요한 version ID와 승인된 발췌만 저장 가능
4. policy activation 전 validation artifact SHA-256와 change-control ID 기록

### 완료 기준과 증빙

- [ ] 의료책임자·검사실·정보보안 승인
- [ ] 역할별 RACI와 재해석 SLA 확정
- [ ] policy activation 및 rollback rehearsal 완료

---

## 8. Clinical Report template와 서명 권한 승인

### 준비

- 기관명/검사명, methodology, result summary, interpretation
- recommendation, limitation, negative-report 문구
- Panel/version, coverage, evidence provenance 표시 기준
- 전자서명 문구, 서명 가능한 role과 대리서명 정책
- amendment 제목·사유·원본 report 연결 방식

### 적용 방법

1. `/report-templates/somatic`에서 draft template 생성
2. version별 section과 negative 문구 편집
3. 승인 권한자가 publish
4. 양성, full-panel negative, not-tested, amendment test report 생성
5. Clinical/법무 승인 후 production version 고정

### 검증

- Draft → In Review → Signed → Amended 전이 확인
- Signed snapshot SHA-256, template version, 서명자, 시각 확인
- print/PDF에 필수 provenance와 limitation이 표시되는지 확인

### 완료 기준과 증빙

- [ ] 승인된 template version publish
- [ ] role/signing matrix 반영
- [ ] 4종 test report PDF와 승인 기록 보관

---

## 9. Production DB migration, backup, restore 검증

### 준비

- 배포 전 maintenance window와 rollback 담당자 지정
- Production `DATABASE_URL`은 secret manager로 제공
- migration 전 backup 및 복구 가능한 별도 환경 준비

### 적용 방법

예시:

```bash
pg_dump --format=custom --file=gvi-pre-migration.dump "$DATABASE_URL"
DATABASE_URL="$DATABASE_URL" pnpm exec drizzle-kit migrate
```

새 설치는 migration `0000`부터, 기존 설치는 migration journal 다음 번호부터 `0019`까지 적용합니다. 운영 DB에서 `db:push`로 schema를 직접 동기화하지 않습니다.

복구 rehearsal 예:

```bash
createdb gvi_restore_validation
pg_restore --exit-on-error --dbname=gvi_restore_validation gvi-pre-migration.dump
```

### 검증

```bash
pnpm exec tsx scripts/somatic-e2e.ts all
```

Production 본 데이터에서 E2E fixture를 허용하지 않는 경우 동일 schema의 staging clone에서 실행하고, production에서는 migration journal·table/index/FK와 read-only smoke query를 확인합니다.

### 완료 기준과 증빙

- [ ] 암호화 backup 생성 및 restore rehearsal 성공
- [ ] migration `0019`까지 적용 확인
- [ ] staging DB E2E와 production smoke test 통과
- [ ] backup ID, migration log, 승인자, rollback 결정 기록 보관

---

## 10. OncoKB Commercial 전환 준비

### 준비

- Commercial/clinical-use 계약과 API 사용 범위
- 결과와 raw response의 내부 저장·report 인용 허용 범위
- version/date 재현성 및 과거 결과 재해석 조건
- 사용자 수, 호출량, 만료·갱신·감사 조건

### 적용 방법

계약 완료 후 production secret:

```bash
ONCOKB_API_MODE=commercial
ONCOKB_API_TOKEN=<production-secret-manager-reference>
```

`/somatic-governance`에서 다음 순서로 적용합니다.

1. OncoKB provider license status를 `approved`로 설정
2. license reference와 유효기간 기록
3. Commercial API smoke/contract validation
4. organization policy에서 `enableOncoKb=true`인 새 version 생성
5. 승인된 policy activation 및 영향 case task 검토

### 완료 기준과 증빙

- [ ] 계약·license reference와 유효기간 등록
- [ ] Production token rotation 및 접근통제 적용
- [ ] Commercial response provenance 검증
- [ ] 임상 report 후보 허용과 Research/demo 차단 회귀 확인

---

## 최종 Production 승인 Gate

10개 항목 완료 후 아래 명령과 브라우저 임상 시나리오를 다시 수행합니다.

```bash
pnpm check
pnpm vitest run
pnpm exec tsx scripts/somatic-e2e.ts all
pnpm build
pnpm audit --prod
```

- [ ] Germline annotation/review 회귀 없음
- [ ] Somatic positive, negative, not-tested, amendment 시나리오 통과
- [ ] tenant isolation/RBAC 및 secret 비노출 확인
- [ ] backup/restore와 worker recovery 확인
- [ ] 의료책임자, 검사실, 보안, 운영 배포 승인
