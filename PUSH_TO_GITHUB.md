# Push to GitHub — Instructions

This ZIP is a source package excluding `.git`, `node_modules`, build artifacts, logs, local project metadata, and secrets.

## 1. Extract and verify

```bash
unzip Genolyx-Variant-Interpreter-source.zip -d Genolyx-Variant-Interpreter
cd Genolyx-Variant-Interpreter
pnpm install
pnpm check
pnpm vitest run
pnpm build
```

There is no need to create a local `GVI_GATEWAY_TOKEN` to run tests. Tests use an isolated, dedicated token and restore the original environment. Only set a strong token (32+ characters) in the deployment environment's Secrets when using the real Gateway runtime.

## 2. Initial push to an empty GitHub repository

```bash
git init
git branch -M main
git add .
git commit -m "feat: implement Genolyx Variant Interpreter"
git remote add origin https://github.com/genolyx/GVI.git
git push -u origin main
```

If `origin` already exists, use the following instead of `git remote add`:

```bash
git remote set-url origin https://github.com/genolyx/GVI.git
```

## Security notes

Do not commit `.env` files, API keys, database URLs, or Gateway tokens. Set production secrets separately in the deployment environment's Secrets feature. Before real clinical use, review the limitations and pre-production checklist in `README.md`, `docs/security-model.md`, and `VALIDATION.md`.
