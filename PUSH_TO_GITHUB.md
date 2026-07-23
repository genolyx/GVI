# GitHub 직접 푸시 안내

이 ZIP은 `.git`, `node_modules`, 빌드 산출물, 로그, 로컬 프로젝트 메타데이터와 비밀값을 제외한 소스 패키지다.

## 1. 압축 해제와 검증

```bash
unzip Genolyx-Variant-Interpreter-source.zip -d Genolyx-Variant-Interpreter
cd Genolyx-Variant-Interpreter
pnpm install
pnpm check
pnpm vitest run
pnpm build
```

테스트 실행을 위해 `GVI_GATEWAY_TOKEN`을 로컬에 만들 필요는 없다. 테스트는 격리된 전용 토큰을 사용하고 기존 환경을 복원한다. 실제 Gateway 런타임을 사용할 때만 배포 환경의 Secrets에 32자 이상의 강한 토큰을 별도로 설정한다.

## 2. 빈 GitHub 저장소에 최초 푸시

```bash
git init
git branch -M main
git add .
git commit -m "feat: implement Genolyx Variant Interpreter"
git remote add origin https://github.com/genolyx/GVI.git
git push -u origin main
```

이미 `origin`이 있다면 `git remote add` 대신 다음을 사용한다.

```bash
git remote set-url origin https://github.com/genolyx/GVI.git
```

## 보안 주의사항

`.env`나 API 키, 데이터베이스 URL, Gateway 토큰을 커밋하지 않는다. 운영 비밀값은 배포 환경의 Secrets 기능에서 별도로 설정한다. 실제 임상 사용 전에는 `README.md`, `docs/security-model.md`, `VALIDATION.md`의 제한사항과 운영 전 확인 항목을 검토한다.
