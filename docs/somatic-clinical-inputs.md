# Somatic 임상 검증 준비 자료

이 문서는 사용자가 준비해야 하는 Somatic CDS 임상 검증 자료를 계속 관리하는 별도 체크리스트입니다. 실제 환자 식별정보나 라이선스가 불명확한 원문 데이터는 이 저장소에 추가하지 않습니다.

실제 적용 명령, 검증 방법, 완료 기준과 증빙은 `docs/somatic-production-readiness-todo.md`의 10개 운영 준비 TODO에서 관리합니다.

## 현재 상태

- [x] AMP/ASCO/CAP 2017 baseline 확정
- [x] Synthetic/public validation fixture와 offline provider 구축
- [x] Expert gold manifest 형식과 로컬 validator 제공
- [x] 조직별 version-pinned CIViC offline release import와 영향 case 재해석 queue 구축
- [ ] 기관 전문가 gold set 수령 및 검증
- [ ] 기관에서 사용할 tumor ontology release와 hierarchy artifact 확정
- [ ] 실제 panel reportable-region/coverage artifact 수령 및 검증
- [ ] CNV/Fusion/MSI/TMB/HRD별 assay validation, cutoff와 결과 export 수령
- [ ] 기관 SOP와 승인 report 문구 수령
- [ ] 임상 운영에 사용할 CIViC release/export와 기관 승인 guideline rule 수령
- [ ] 선택적 상용 지식베이스의 임상 사용 권한 확인

## 1. 비식별 전문가 gold set

권장 규모는 대표적인 target-panel case 15–30건입니다. 각 case에 다음 항목이 필요합니다.

- 저장소 내부에서만 사용하는 pseudonymous case ID
- 비식별 VCF 또는 VCF 경로
- tumor ontology system, ontology version, code, label
- panel 제조사, 제품명, 정확한 version(예: `3.1.2`, `4`), reference build
- normalized variant identity, gene, transcript, HGVS
- 예상 normalization/QC/candidate 결과
- 전문가 확정 oncogenicity
- clinical domain과 effect
- 최종 AMP Tier/Level
- reportable 여부와 판정 근거
- 근거 record ID
- pseudonymous reviewer ID, 검토 상태와 검토 시각

초기 작성은 다음 template을 복사해서 시작합니다.

`shared/fixtures/somatic/expert-gold/template.json`

작성한 manifest는 다음 명령으로 검사합니다.

```bash
pnpm validate:somatic-gold -- path/to/manifest.json
```

`status: "final"`인 pack에는 case가 하나 이상 있어야 하며 draft review가 포함될 수 없습니다. Tier I/II에는 AMP Level이 필수이고, Tier III/IV에는 AMP Level을 입력하지 않습니다.

## 2. Panel/BED 및 coverage 검증 자료

Panel version별로 별도 준비합니다.

- 제조사, panel 이름, 정확한 version, genome build
- BED 또는 동등한 reportable-region 정의
- gene/exon/interval/fusion/signature 범위
- 최소 depth와 coverage percentage 기준
- assay validation summary 및 승인자
- reportable-region artifact SHA-256
- coverage validation artifact SHA-256

Workbench import용 reportable-region artifact는 JSON array로 정규화해야 합니다. 각 record에는 고유 `regionKey`, `regionType`(`gene`, `exon`, `interval`, `fusion_pair`, `signature`), reportable 여부가 필요합니다. Exon/interval에는 chromosome/start/end, threshold 적용 대상에는 `minimumDepth`와 `minimumCoveragePercent`를 포함합니다. Fusion/signature에는 해당 `findingType`과 구조화된 target 정의를 포함합니다.

BED 직접 업로드는 strict BED4를 사용합니다.

```text
chromosome<TAB>start0<TAB>endExclusive<TAB>regionKey
```

- BED 좌표는 0-based half-open으로 입력하며 플랫폼이 1-based inclusive로 변환합니다.
- `regionKey`는 필수이며 파일 안에서 고유해야 합니다.
- minimum depth와 covered percentage는 업로드 화면에서 해당 Panel version의 공통 threshold로 지정합니다.
- Gene/transcript별 threshold 또는 fusion/signature target은 normalized JSON artifact를 사용합니다.

Case별 coverage artifact에는 승인된 Panel artifact와 동일한 `regionKey`, mean depth, covered percentage가 필요합니다. 플랫폼은 Panel threshold로 QC를 다시 계산하며, 누락 region이나 threshold 미달 region이 하나라도 있으면 validation을 통과시키지 않습니다. 함께 준비할 정보:

```text
regionKey<TAB>meanDepth<TAB>coveredPercent
```

Coverage는 위 header를 가진 TSV 또는 동일 필드의 JSON array를 지원합니다. 업로드 원문은 case-scoped object storage에 보관하고, 서버가 exact UTF-8 content SHA-256을 다시 확인합니다.

- coverage 산출 pipeline 이름/version과 command/config version
- 원본 coverage export SHA-256
- reference build, panel version, specimen/run ID
- 전체 reads, mapped/on-target rate 등 기관 승인 QC metric
- 생성자, 전문가 승인자와 생성/승인 시각

Panel artifact는 승인 후, coverage는 validation 통과 후 immutable입니다. 수정이 필요하면 새 panel version 또는 새 case assay 결과로 관리합니다.

이 자료가 승인되기 전에는 full negative, not-tested, insufficient-coverage 결론을 활성화하지 않습니다.

### Somatic INDEL reference FASTA

INDEL 자동 후보 판정에는 panel build와 정확히 일치하는 기관 승인 reference FASTA가 필요합니다. GRCh37/GRCh38별로 다음을 준비합니다.

- 원본 FASTA와 `samtools faidx` 호환 `.fai`
- 정확한 reference 배포명/version과 출처
- 별도 검증한 전체 FASTA SHA-256
- contig naming(`1`/`chr1`)과 decoy/alternate contig 포함 정책
- FASTA 변경 시 change-control 및 기존 case 재해석 절차

서버에는 build별 `SOMATIC_REFERENCE_FASTA_GRCH37`/`GRCH38`, 대응 `_SHA256`, `_VERSION`을 설정합니다. 최초 사용 시 전체 digest를 확인하고 이후 같은 process에서 안전하게 재사용합니다. Submitted REF가 FASTA와 다르거나 build/contig/index/hash가 맞지 않으면 해당 INDEL은 실패 처리되어 자동 evidence lookup과 report 후보에서 제외됩니다. 설정이 없으면 기존과 같이 `reference_fasta_left_alignment_not_verified` manual-review 상태를 유지합니다.

검증된 INDEL은 repeat-aware left alignment 후 normalized ID, 이동한 base 수, FASTA version/hash/path provenance를 run analysis와 signed report snapshot에 보존합니다. 외부 evidence provider 조회에도 이 정규화 좌표를 사용하지만 원본 VCF 표현은 별도로 유지합니다.

## 3. CNV, Fusion, MSI, TMB, HRD 결과

Panel version의 assay capability와 기관 validation 범위 안에서만 입력합니다.

- 공통: assay/pipeline 이름과 version, source run ID, reference build, 원본 export SHA-256, 검토자와 검토 시각
- CNV: gene/target, copy number와 또는 log2 ratio, amplification/gain/loss/deletion cutoff, tumor purity 보정 방식
- Fusion: 5′/3′ gene, breakpoint/transcript, in-frame 여부, supporting read 수, 검출 limit
- MSI: numeric score, stable/low/high cutoff, 사용 marker와 최소 유효 marker 수
- TMB: mutations/Mb, 산정 가능한 territory 크기, 포함/제외 variant 규칙, low/intermediate/high cutoff
- HRD: score, positive/negative cutoff, method와 구성 지표(예: LOH/TAI/LST) 정의
- `not_detected`/`not_tested`: 활성 기관 policy, 승인된 Panel region, 해당 Case의 완전한 passed coverage가 모두 필요

모든 결과는 생성 시 non-reportable이며 clinician 승인 후에만 Clinical Report에 포함됩니다. Imported finding이 하나라도 미검토 상태이면 report review/sign을 차단합니다.

Workbench bulk import는 우선 vendor-neutral normalized JSON array 또는 strict TSV를 지원합니다. TSV header는 다음 순서로 고정합니다.

```text
findingType	status	result	sourceRunId	coverageSummaryId
```

`result`는 typed JSON object이며 detected 결과에는 필수입니다. 원문 파일은 exact SHA-256과 함께 case-scoped object storage에 보존되고, import된 모든 결과는 `reportable=false`로 시작합니다. 장비별 adapter를 추가하려면 실제 비식별 export 예시, 장비/software version, 필드 사전, unit/cutoff, null·failed-call 표현, 복수 결과 표현과 vendor schema version을 제공해야 합니다. 추측 기반 vendor column mapping은 구현하지 않습니다.

### Full-panel negative report

Full-panel negative 결론은 단순히 “승인된 변이가 없음”으로 생성되지 않습니다. 다음 조건이 동시에 충족되어야 합니다.

- Somatic interpretation run이 `ready_for_review`
- 승인된 reportable variant와 detected/not-tested/indeterminate assay finding이 없음
- 미검토 variant assertion 및 assay finding이 없음
- Panel reportable-region artifact가 승인되고 hash가 고정됨
- 최신 Case coverage가 모든 예상 region을 포함하며 `passed`
- coverage source/validation SHA-256이 모두 존재함
- active organization policy가 negative reporting을 허용하고 validation artifact hash를 가짐

조건이 하나라도 변경되면 draft review 또는 sign-out을 차단합니다. Report template에서 negative title, summary, interpretation, limitation 문구를 기관 SOP에 맞게 version별로 편집·게시할 수 있습니다. Signed snapshot에는 full-panel-negative conclusion type, Panel hash, coverage summary/validation hash, policy ID/version을 동결합니다. `not_tested`는 full-panel negative와 동일하지 않으며 검사 범위 제한으로 별도 표시해야 합니다.

## 4. Tumor ontology release

암종 문맥 매칭은 label 문자열이 아니라 version-pinned ontology concept로 수행합니다.

- 사용할 ontology system과 정확한 release/version
- 각 tumor의 code와 공식 label
- parent/ancestor hierarchy export와 SHA-256
- broader/narrower 관계를 임상 근거에 사용할 수 있는 기관 정책
- ontology 갱신 시 change-control 및 재해석 절차
- 배포 및 임상 사용 라이선스

Ontology version이 다르거나 hierarchy가 불완전하면 자동 관계 판정을 하지 않고 `unknown`으로 유지합니다.

## 5. 기관 정책과 보고서 문구

- Somatic interpretation SOP 문서명과 version
- AMP 판정 및 override 승인 절차
- analyst/clinician 역할과 sign-out 권한
- 승인된 methodology, limitation, recommendation 문구
- amendment 및 재해석 절차
- data retention, audit, backup 정책

원본 정책 문서 대신 승인된 version ID와 적용 가능한 발췌문을 제공할 수 있습니다.

## 6. CIViC offline release

Production Somatic run은 live CIViC API를 호출하지 않습니다. 기관별로 검증·승인·활성화된 정확히 하나의 offline release만 사용하며, 준비할 export에는 다음 항목이 필요합니다.

- 정확한 CIViC release/version과 release content SHA-256
- 임상 운영 및 내부 저장을 허용하는 provider license 정보
- normalized variant ID와 source record ID
- CIViC native evidence level, clinical domain, effect direction
- version-pinned disease ontology system/version/code/label
- 원본 record SHA-256과 허용되는 경우 source URL
- export 생성 시각, 생성 도구/version, 담당자
- 기관이 승인한 guideline rule key/version과 Tier/Level proposal 조건
- release validation 승인자, 승인 시각, change-control 기록

CIViC native level은 AMP Level로 직접 변환하지 않습니다. Release 변경 시 추가·삭제·변경 evidence와 영향 case를 검토하고, 자동 생성된 재해석 task를 기관 SOP에 따라 종결해야 합니다.

### GraphQL V2 snapshot import 운영

Governance의 CIViC import worker는 고정된 GraphQL V2 query로 draft release만 생성합니다. 입력 scope에는 `normalizedVariantId`, gene, build/coordinate, HGVS 등 비식별 variant 정보만 넣고 case ID, specimen, 이름, MRN, free-text 임상 정보는 넣지 않습니다. `CIVIC_API_KEY`는 선택적 secret이며 DB, audit, checkpoint, raw archive에 저장하지 않습니다.

운영 전 준비 항목:

- CI introspection으로 승인한 GraphQL schema SHA-256 (`CIVIC_SCHEMA_HASH`)
- snapshot에 포함할 비식별 normalized variant scope와 exact genome build
- raw response와 safe request envelope를 보존할 organization-scoped object storage
- CIViC 사용·내부 저장·임상 검증 범위를 확인한 기관 승인 기록
- import 완료 후 별도로 수행할 전문가 evidence 검토, release validation 및 activation 기록

Importer는 gene/variant/profile/evidence를 cursor pagination으로 모두 수집하고 `status: ACCEPTED`를 query와 importer 양쪽에서 확인합니다. Exact allele, protein, broad class, ambiguous match를 분리하며 complex molecular profile, flagged evidence, retracted source, deprecated/unknown enum은 `researchOnly` 및 review-required로 남깁니다. CIViC A–E, rating, direction, significance, origin, disease, therapy set/interaction, citation은 서로 독립된 source-native 사실로 보존하며 AMP Tier/Level로 자동 변환하지 않습니다.

429/5xx/network/timeout은 bounded retry하고, authentication/schema 계약 오류는 재시도하지 않습니다. 모든 page의 exact response body와 SHA-256, query/schema/adapter/snapshot hash, checkpoint가 보존됩니다. Partial/failed/cancelled job은 release validation과 activation을 차단하며, complete job도 자동 validation 또는 activation하지 않습니다.

## 7. 기타 외부 지식베이스

CIViC 외 provider를 사용할 경우 다음을 확인합니다.

- 임상 사용이 허용된 라이선스
- 조직이 사용할 수 있는 export/API 범위
- release/version 및 content hash
- 출처 표시 요구사항
- 검증용 fixture 생성 허용 여부
- 만료일과 change-control 담당자

OncoKB API adapter는 구현되어 있지만 runtime mode, token, provider license와 기관 policy가 모두 준비되기 전에는 비활성 상태를 유지합니다.

### OncoKB 확인 결과

2026-09-27 공식 정책 기준:

- 임상 또는 상업적 사용에는 유료 license agreement가 필요합니다.
- 학술기관의 연구 목적 이용은 무료일 수 있지만, programmatic API/Annotator 이용에는 기관 이메일 등록과 academic-use license 동의가 필요합니다.
- 일반 사용자가 전체 OncoKB database release 파일을 자유롭게 다운로드하는 방식은 제공되지 않습니다.
- Local database copy는 licensed user에게도 API 대안을 먼저 검토한 뒤 case-by-case로만 제공되며 추가 비용이 필요할 수 있습니다.
- Public API는 therapeutic data를 제외하고, demo API는 제한된 gene만 제공하므로 임상 CDS 근거로 사용할 수 없습니다.
- Production API는 최신 데이터만 제공하며 과거 전체 version 접근은 제한적입니다. 따라서 임상 재현성을 위해서는 계약상 허용되는 export/snapshot 저장, exact version/date, content hash와 재해석 change-control 조건을 라이선스에 포함해야 합니다.

공식 참고:

- https://faq.oncokb.org/licensing
- https://faq.oncokb.org/technical
- https://api.oncokb.org/oncokb-website/api
- https://www.oncokb.org/api-access

### OncoKB API 운영 모드

- `disabled`: 기본값이며 외부 호출을 하지 않습니다.
- `demo`: BRAF/TP53/ROS1 기반 adapter 검증용입니다. 인증 token 없이 사용할 수 있지만 결과는 `researchOnly`로 저장합니다.
- `research`: 승인된 Academic/Research token을 사용합니다. 결과와 raw-response provenance를 저장할 수 있지만 Clinical Report 검토·서명에는 사용할 수 없습니다.
- `commercial`: 상용/임상 사용 계약, organization provider 승인, license reference 및 active policy가 모두 확인된 경우에만 임상 검토 후보가 됩니다.

Token은 `ONCOKB_API_TOKEN` secret으로만 제공하며 DB, audit, source 또는 raw response에 저장하지 않습니다. 승인 전에는 빈 값으로 유지할 수 있습니다. Production과 Research API는 token이 없으면 `OncoKB:api_token_missing`, 401/403은 `OncoKB:auth_error`로 기록하고 retry하지 않습니다.

SNV/Indel은 protein change 또는 genomic change batch POST로 조회합니다. OncoTree로 명시적으로 version-pinned된 암종만 `tumorType`으로 전송하며 내부 label을 임의 매핑하지 않습니다. 응답은 source-native level, sensitivity/resistance, oncogenicity/actionability, data version, last update, request parameters와 raw-response hash를 분리 보존하며 OncoKB level을 AMP Tier/Level로 직접 변환하지 않습니다.

429, timeout, 5xx는 bounded exponential retry 대상이고 동일 variant/build/query/tumor/mode는 TTL cache를 사용합니다. Cache는 반복 호출 감소 목적이며 전체 OncoKB database replica로 사용하지 않습니다.

## 8. 런타임 및 패키지 업데이트

Node.js 지원 범위, 취약점 audit, 현재 package별 update 후보와 검증 순서는 `docs/dependency-update-register.md`에서 계속 관리합니다. 현재 production release 전 필수 항목은 Node.js 22 LTS 전환과 AWS XML parser, Tailwind tar, Vitest critical advisory 해소입니다.

## 9. Phase 4 운영 및 변경관리 자료

Knowledge release 활성화·재해석·rollback을 임상 운영에 사용하려면 다음 기관 자료가 필요합니다.

- release 및 policy change-control ID 발급 규칙과 승인 담당자
- validation 담당자와 activation 담당자의 역할 분리 여부
- 영향 case 재해석 task의 담당자 배정 규칙과 처리 기한
- `completed`와 `dismissed` 판정 기준 및 필수 사유
- 기존 signed report에 결론 변경이 생긴 경우 amendment·재통지 절차
- emergency rollback 승인 조건, 승인자, 사유 기록과 사후 검토 절차
- KB release monitoring 주기와 새 release 수령 방식
- 재해석 대상 환자·의료진 통지 및 audit 보존 기간

활성 Somatic policy가 교체되면 content hash, negative-reporting 허용, OncoKB 활성화 변경을 분류하고 현재 Somatic case별 재해석 task를 자동 생성합니다. Task에는 이전/대상 policy ID·version·hash와 변경 control이 동결되며, 동일 policy 변경에 대한 open/in-review task는 중복 생성되지 않습니다. 실제 재해석은 활성 validated knowledge release에 고정됩니다.

Panel version 변경은 동일 panel의 두 version만 비교하며 capability, artifact hash, reportable region 추가·삭제·threshold 변경과 기존 version에 고정된 case를 preview합니다. 대상 region artifact가 검증된 경우에만 승인자가 change-control ID와 preview hash를 확인해 task를 생성할 수 있습니다. 기존 case의 panel version은 자동 변경하지 않습니다.

새 assay artifact가 import되면 동일 case·finding type의 기존 reviewed reportable finding과 겹치는지 확인합니다. 새 finding은 계속 non-reportable이며, 승인자가 명시적으로 impact task를 만든 뒤 전문가가 재검토해야 합니다. Artifact/file hash, 신규·기존 finding ID와 change-control ID가 task provenance에 동결됩니다.

플랫폼은 release diff preview, release·policy·panel·assay 영향 case task 생성, durable rerun, task-run 연결 및 validated release rollback을 제공하지만 임상 task를 자동 완료하거나 signed report를 자동 수정하지 않습니다. 기관의 승인된 SOP에 따라 전문가가 결과를 검토하고 필요하면 amendment를 발행해야 합니다.

## 제공하지 않을 자료

- 이름, 생년월일, 주민번호, 병원 등록번호 등 직접 식별자
- 원본 EMR 문서
- 재식별 가능한 free-text
- 라이선스가 불명확한 HGMD/OMIM 원문
- 접근권한이 없는 OncoKB/NCCN/COSMIC export

자료 전달 전 기관의 비식별화 및 정보보안 절차를 먼저 적용합니다.
