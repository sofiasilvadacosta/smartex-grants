# Smartex Grants

Plataforma de gestão dos projetos financiados da Smartex: orçamento por
rubrica, faturas e RH com reconciliação orçamental, pedidos de pagamento e
decisões do financiador, recebimentos e projeções, deliverables e milestones.
Ver
[`DEPLOY.md`](DEPLOY.md) para pôr a plataforma no ar e
[`scripts/import/README.md`](scripts/import/README.md) para os dados.

## Stack

Next.js (App Router) + TypeScript, Postgres via Prisma, Auth.js (Google OAuth
restrito a `@smartex.ai`), Vercel.

## Pôr no ar

Ver [`DEPLOY.md`](DEPLOY.md) — base de dados, credenciais Google, variáveis de
ambiente e como carregar os dados a partir da tua máquina.

## Desenvolvimento local

1. `npm install`
2. Copiar `.env.example` para `.env` e preencher:
   - `DATABASE_URL` — Postgres local ou gerido (Neon/Vercel Postgres)
   - `AUTH_SECRET` — gerar com `npx auth secret`
   - `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` — credenciais OAuth do Google
     Cloud Console (Authorized redirect URI: `<url>/api/auth/callback/google`)
3. `npx prisma migrate dev` — aplica o schema
4. `npm run dev`

O primeiro utilizador a fazer login torna-se automaticamente Admin.

## Importação dos dados históricos

Ver [`scripts/import/README.md`](scripts/import/README.md). Resumo: colocar os
excéis de origem em `imports/` (gitignored — contêm salários e NIFs de
fornecedores) e correr `npm run db:import`.

## Scripts

- `npm run dev` — servidor de desenvolvimento
- `npm run build` — build de produção
- `npm run lint` — ESLint
- `npm run db:import` — importação (idempotente) dos excéis históricos
