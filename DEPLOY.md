# Pôr a Smartex Grants no ar (Vercel)

Do princípio ao fim demora cerca de meia hora. Precisas de três coisas que só tu
podes criar: uma base de dados Postgres, credenciais Google e o projeto Vercel.
O código já está preparado para as três.

Os ficheiros de origem (`imports/`) **nunca saem da tua máquina**. Os dados vão
diretamente do teu computador para a base de dados de produção, no passo 6.

---

## 1. Base de dados Postgres

No painel do Vercel, **Storage → Create Database → Neon (Postgres)**. Qualquer
Postgres 14+ serve; o Neon é o mais direto porque o Vercel injeta as variáveis
sozinho.

Duas coisas a confirmar:

- **Usa a connection string com pooling** (no Neon é a que tem `-pooler` no
  host). A app corre em funções serverless: cada instância abre a sua própria
  ligação, e sem pooler o Postgres acaba por recusar ligações. O código já
  limita o pool a 2 ligações por instância em produção.
- A extensão **`pg_trgm`** tem de estar disponível. É criada automaticamente
  pela primeira migração; o Neon e o Vercel Postgres permitem-na. Se usares
  outro fornecedor e a migração falhar aqui, é preciso ativá-la primeiro.

Guarda a connection string — é o `DATABASE_URL`.

## 2. Credenciais Google

Em <https://console.cloud.google.com> → **APIs & Services → Credentials →
Create Credentials → OAuth client ID**, tipo *Web application*.

Em **Authorized redirect URIs** põe, com o domínio real que o Vercel te der:

```
https://<o-teu-dominio>.vercel.app/api/auth/callback/google
```

Se mais tarde ligares um domínio próprio, acrescenta também o dele — podem
coexistir. Guarda o *Client ID* e o *Client secret*.

Nota: a app já rejeita, no servidor, qualquer conta que não termine em
`@smartex.ai`, mesmo que o cliente OAuth esteja aberto a mais domínios.

## 3. Chave de sessão

Gera uma chave aleatória:

```bash
openssl rand -base64 32
```

O valor impresso é o `AUTH_SECRET`. (`npx auth secret` também serve, mas escreve
o valor num ficheiro `.env.local` em vez de o mostrar.)

## 4. Projeto no Vercel

**Add New → Project**, importa `sofiasilvadacosta/smartex-grants`. O Vercel
deteta Next.js sozinho; não mexas nos comandos de build.

Em **Settings → Environment Variables**, define para **Production**:

| Variável | Valor |
|---|---|
| `DATABASE_URL` | a connection string com pooling do passo 1 |
| `AUTH_SECRET` | o valor do passo 3 |
| `AUTH_GOOGLE_ID` | o Client ID do passo 2 |
| `AUTH_GOOGLE_SECRET` | o Client secret do passo 2 |

> Se algum dia usares *Preview deployments*, dá-lhes uma base de dados
> diferente. Partilhar o `DATABASE_URL` com produção significa que qualquer
> branch escreve nos dados reais.

O repositório só tem um branch (`claude/funded-projects-webapp-i9qjju`), que é
por isso o branch de produção. Se preferires um `main`, muda-o em **Settings →
Git → Production Branch** depois de o criares.

Faz **Deploy**. O build corre `prisma generate` sozinho (o cliente gerado não
está no repositório) e não precisa da base de dados para compilar.

## 5. Reunir os ficheiros de origem

`imports/` é gitignored — contém salários, NIFs e faturas, e por isso nada disto
está no repositório. Antes do import tens de juntar os ficheiros nessa pasta.
Seis são teus, tal como estão; sete geram-se dos PDFs do portal; dois foram
transcritos à mão e têm de ser guardados.

**Os que já tens** (copia para `imports/`):

| Ficheiro | Origem |
|---|---|
| `Grants_Approved_Execution_v3.xlsx` | o teu `.xls` convertido — ver `scripts/import/README.md` |
| `Smartex_Gestao_Projetos_V4.xlsx` | tal como está |
| `FPP012270004_Movimentos.xlsx` | export "Lista geral de movimentos" do portal |
| `TexPact_Pedidos_Pagamento.xlsx` | o teu ficheiro de pedidos do TexP@ct |
| `DefectFree_Decisao_PP3.pdf` | "Fundamentação da análise 12270_3_3" |
| `TexPact_Decisao_PP11.pdf` | "DecisaoPagamentoProj_61_21" |

**Os que se geram dos PDFs do portal** (uma vez, com `pip install pdfplumber`):

```bash
python3 scripts/import/extract-pp-quadro.py \
  Pedido_de_Pagamento_Defect_Free.pdf imports/DefectFree_Quadro_Investimentos.csv
python3 scripts/import/extract-pp-quadro.py \
  Quadro_de_Invesitmentos_Internacionalizacao.pdf \
  imports/Internacionalizacao_Quadro_Investimentos.csv
python3 scripts/import/extract-pp-quadro.py \
  QUadro_de_Investimentos_Texia.pdf imports/Texia_Quadro_Investimentos.csv
python3 scripts/import/extract-pp-quadro.py \
  Quadro_investimentos_Texqualis.pdf imports/TexQualis_Quadro_Investimentos.csv

python3 scripts/import/extract-pp-pessoas.py \
  Pedido_de_Pagamento_defect_free_pessoas.pdf imports/DefectFree_Pessoal.csv
python3 scripts/import/extract-pp-pessoas.py \
  Pedido_de_pagamento_Texia_pessoas.pdf imports/Texia_Pessoal.csv
python3 scripts/import/extract-pp-pessoas.py \
  Pedido_de_Pagamento_Texqualis.pdf imports/TexQualis_Pessoal.csv
```

Cada extrator confere as somas contra a linha Total do próprio documento e
recusa-se a escrever o CSV se não baterem — se correr sem erro, os números estão
certos.

**Os dois que não se geram de nada.** `DefectFree_Pessoal_Atividades.txt` e
`DefectFree_Deslocacoes.csv` foram transcritos à mão dos ecrãs do portal (os
"Movimentos de despesa" por técnico, e o ecrã de Deslocações), porque essa
informação não existe em nenhum PDF nem export. Guarda-os em sítio seguro: sem o
primeiro, as 232 linhas de pessoal do Defect Free voltam todas a ficar por
reconciliar; sem o segundo faltam 6 224,00 € de viagens e o import **falha** na
verificação, de propósito.

O import salta em silêncio um ficheiro que não encontre, por isso confirma no fim
que os totais são os esperados — estão listados em `scripts/import/README.md`.

## 6. Criar as tabelas e carregar os dados

Isto corre a partir da tua máquina, apontando à base de dados de produção. No
repositório, com os ficheiros de origem em `imports/`:

```bash
# Aponta à produção só para estes comandos, sem mexer no teu .env
export DATABASE_URL="<a connection string do passo 1>"

npm run db:deploy   # cria as tabelas (prisma migrate deploy)
npm run db:import   # carrega projetos, orçamentos, faturas, RH e pedidos
```

O import é repetível: podes voltar a corrê-lo sempre que atualizares os
ficheiros de origem. Nunca duplica linhas e **nunca desfaz uma rubrica que
alguém já tenha reconciliado na app**.

## 7. Primeiro acesso

Abre o URL do Vercel e entra com a tua conta `@smartex.ai`. **A primeira conta a
entrar fica automaticamente como Admin**; as seguintes entram como Editor e um
Admin pode promovê-las.

Se o login falhar com um erro de `redirect_uri_mismatch`, o URI do passo 2 não
corresponde exatamente ao domínio — tem de incluir `https://` e o caminho
`/api/auth/callback/google`.

---

## Depois

- **Atualizar o código:** basta fazer push para o branch de produção; o Vercel
  reconstrói sozinho.
- **Atualizar os dados:** volta a correr o passo 6 a partir da tua máquina.
- **Novas migrações:** o build *não* corre migrações, de propósito, para que um
  deploy nunca altere a base de dados sem querer. Quando uma alteração ao
  esquema for feita, corre `npm run db:deploy` antes de o deploy ficar ativo.
- **Documentos anexados** ficam guardados na própria base de dados, não num
  serviço à parte. O limite por ficheiro é de 4 MB, abaixo do limite de 4,5 MB
  que o Vercel impõe aos pedidos.
- **Cópias de segurança:** ficam a cargo do fornecedor da base de dados. No Neon
  o *point-in-time restore* vem incluído; vale a pena confirmar a janela de
  retenção do plano que escolheres.
