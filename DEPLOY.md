# Pôr a Smartex Grants no ar (Vercel)

Do princípio ao fim demora cerca de meia hora. Precisas de três coisas que só tu
podes criar: o projeto Vercel, uma base de dados Postgres e credenciais Google.
O código já está preparado para as três.

**A ordem importa.** Cria o projeto Vercel *primeiro*: a base de dados liga-se a
um projeto existente, e o URL do projeto é o que o Google precisa de saber. Fazer
pela ordem inversa leva a becos sem saída.

Os ficheiros de origem (`imports/`) **nunca saem da tua máquina**. Os dados vão
diretamente do teu computador para a base de dados de produção, no passo 6.

---

## 1. Projeto no Vercel

**Add New → Project**, importa `sofiasilvadacosta/smartex-grants`. O Vercel
deteta Next.js sozinho; não mexas nos comandos de build. Faz **Deploy**.

O build passa (corre `prisma generate` sozinho e não precisa de base de dados
para compilar), mas **a app vai dar erro ao abrir** — ainda não tem base de dados
nem credenciais. É esperado; por agora só precisamos que o projeto exista e que
te dê um URL.

Anota o URL que o Vercel atribuiu (algo como
`https://smartex-grants.vercel.app`) — é preciso no passo 3.

O branch de produção é o `main`. O branch de trabalho
(`claude/funded-projects-webapp-i9qjju`) aponta para o mesmo commit; quando
divergirem, faz merge para `main` para publicar.

## 2. Base de dados Postgres

Agora que o projeto existe, o caminho mais curto é dentro do próprio Vercel:
**Storage → Create Database → Neon**. Não precisas de outra conta e a base de
dados fica ligada ao projeto sozinha.

Nesse ecrã:

| Campo | O que escolher |
|---|---|
| Project | `smartex-grants` |
| Environments | **só Production** — com Preview marcado, qualquer branch passa a escrever nos dados reais |
| Create database branch for deployment | deixar as duas caixas vazias |
| Custom Prefix | deixar vazio, para a variável ficar chamada `DATABASE_URL` |

O integrador cria várias variáveis (`POSTGRES_URL`, `DATABASE_URL_UNPOOLED`,
entre outras). A app usa apenas a **`DATABASE_URL`**; confirma em
**Settings → Environment Variables** que ela existe, e ignora as restantes.

O integrador marca essas variáveis como **Sensitive**, e no Vercel uma variável
sensível **não se pode voltar a ler** — nem no painel nem no CLI. Isso é bom para
os segredos, mas significa que a connection string de que precisas no passo 6 não
sai de lá. Vais buscá-la ao Neon: **Storage → a base de dados → "Open in Neon"**,
e no painel do Neon está a string de ligação. É a mesma.

Na página da base de dados (**Storage → Settings**) há também uma opção
**Allowed Environments**; deixa-a como está.

Este ecrã só oferece projetos que já existam — é por isso que o passo 1 vem
primeiro. Em alternativa podes criar a base de dados diretamente em
<https://neon.tech> e colar a *connection string* à mão no passo 4.

Duas notas sobre a string:

- Se tiver **`-pooler`** no nome do servidor, tanto melhor. Um *pooler* é um
  intermediário que reaproveita ligações entre as funções serverless, em vez de
  cada uma abrir a sua. Sem ele a base de dados pode recusar ligações quando há
  muitos pedidos ao mesmo tempo. Para uma equipa pequena qualquer das duas serve
  — o código já limita a 2 ligações por instância — por isso não fiques presa
  aqui.
- A extensão **`pg_trgm`** tem de estar disponível. É criada automaticamente pela
  primeira migração; o Neon e o Vercel Postgres permitem-na. Com outro fornecedor,
  se a migração falhar aqui, é preciso ativá-la primeiro.

## 3. Credenciais Google

Em <https://console.cloud.google.com> → **APIs & Services → Credentials →
Create Credentials → OAuth client ID**, tipo *Web application*.

Em **Authorized redirect URIs** põe o URL do passo 1 seguido de
`/api/auth/callback/google`:

```
https://smartex-grants.vercel.app/api/auth/callback/google
```

Tem de bater exatamente — `https://`, o domínio certo, e esse caminho. Se mais
tarde ligares um domínio próprio, acrescenta também o dele; podem coexistir.
Guarda o *Client ID* e o *Client secret*.

Nota: a app já rejeita, no servidor, qualquer conta que não termine em
`@smartex.ai`, mesmo que o cliente OAuth esteja aberto a mais domínios.

## 4. Variáveis de ambiente

Gera a chave de sessão. Em macOS ou Linux:

```bash
openssl rand -base64 32
```

Em Windows, o `openssl` não vem instalado; no PowerShell:

```powershell
$b = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
[Convert]::ToBase64String($b)
```

Qualquer dos dois imprime 44 caracteres acabados em `=`.

No Vercel, em **Settings → Environment Variables** do projeto, define as quatro
para **Production**:

| Variável | Valor |
|---|---|
| `DATABASE_URL` | criada pelo integrador do passo 2, ou colada à mão se usaste o neon.tech |
| `AUTH_SECRET` | o valor que o comando acima imprimiu — o campo *Value* mostra um exemplo em cinzento, tem de ficar preenchido a preto |
| `AUTH_GOOGLE_ID` | o Client ID do passo 3 |
| `AUTH_GOOGLE_SECRET` | o Client secret do passo 3 |

Se usaste o integrador do Vercel no passo 2, o `DATABASE_URL` já lá está — não o
dupliques; só faltam as outras três.

Depois de as guardar, faz **Deployments → ⋯ → Redeploy** no último deploy. As
variáveis só entram em vigor num deploy novo.

> Se algum dia usares *Preview deployments*, dá-lhes uma base de dados
> diferente. Partilhar o `DATABASE_URL` com produção significa que qualquer
> branch escreve nos dados reais.

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
export DATABASE_URL="<a connection string, tirada do painel do Neon>"

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

Se o login falhar com um erro de `redirect_uri_mismatch`, o URI do passo 3 não
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
