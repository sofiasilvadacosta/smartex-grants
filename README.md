# Smartex Grants

Plataforma de gestão dos projetos financiados da Smartex: orçamento por
rubrica, faturas/investimentos com reconciliação orçamental, e (em fases
seguintes) pedidos de pagamento, recebimentos, projeções e deliverables. Ver
`/root/.claude/plans/refactored-giggling-kettle.md` para a arquitetura
completa e o plano faseado.

## Stack

Next.js (App Router) + TypeScript, Postgres via Prisma, Auth.js (Google OAuth
restrito a `@smartex.ai`), deploy alvo: Vercel.

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
