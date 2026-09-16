# Disparo

Gerenciamento de disparos de WhatsApp com **1 a 10 linhas**: cada linha tem controle individual (conectar, iniciar, pausar, retomar, desconectar), os contatos são distribuídos em ciclos entre as linhas selecionadas e tudo fica registrado em histórico, dashboard, analytics e relatórios CSV.

> **Estado atual:** o sistema usa um **provedor simulado** de WhatsApp (`mock`). Os envios, o QR Code e as conexões são simulados para teste. Nenhuma mensagem real é enviada. O provedor real entra implementando `WhatsAppProvider` (veja abaixo).

## Requisitos

- [Node.js 24 ou mais recente](https://nodejs.org/) (o banco SQLite já vem embutido no Node; não precisa instalar banco de dados)

## Testar no Windows (mais fácil)

1. Baixe e extraia o projeto.
2. Dê dois cliques em **`iniciar.bat`**.
   Na primeira vez ele instala as dependências e compila o painel (leva alguns minutos).
3. O painel abre em **http://127.0.0.1:3333**.

Para encerrar, feche a janela preta do terminal.

## Rodar pelo terminal (qualquer sistema)

```bash
npm install
npm run build:web   # compila o painel
npm start           # API + painel em http://127.0.0.1:3333
```

Desenvolvimento: `npm run dev:server` e, em outro terminal, `npm run dev:web` (http://localhost:5173).

- Testes: `npm test`
- Checagem de tipos: `npm run typecheck`
- Banco de dados: `data/disparo.db` (criado automaticamente; use `DISPARO_DB_PATH` para mudar). Para começar do zero, feche o sistema e apague a pasta `data`.
- Porta e endereço: `DISPARO_PORT` (padrão 3333) e `DISPARO_HOST` (padrão 127.0.0.1)

## Roteiro rápido de teste

1. **Linhas:** adicione uma ou mais linhas e clique em **Conectar** e depois **Iniciar** em cada uma.
2. **Mensagens:** preencha pelo menos uma das 5 posições (use `{{nome}}` para personalizar).
3. **Contatos:** cadastre contatos ou importe um CSV.
4. **Novo disparo:** escolha as linhas e os contatos e inicie.
5. Acompanhe em **Dashboard** e **Linhas**; pause e retome linhas individualmente durante o envio.
6. Veja os resultados em **Histórico**, **Analytics** e **Relatórios** (exportação CSV).

## Telas

Dashboard · Linhas · Mensagens · Contatos · Histórico · Analytics · Relatórios · Configurações · Ajuda

## Arquitetura

Stack gratuita: Node 24 + TypeScript (executado direto, sem build do servidor), SQLite embutido no Node (`node:sqlite`), API Fastify e painel React + Vite.

```
src/server
  app.ts                 raiz de composição (única que conhece as implementações)
  api/                   HTTP (Fastify): rotas por módulo, validação zod, eventos em tempo real (SSE) em /api/events
  db/                    wrapper do SQLite + migrações .sql versionadas
  shared/                erros de domínio, barramento de eventos, utilitários
  modules/
    lines/               entidade Linha: estado, provedor, comandos, reconexão, pausa programada
    providers/           contrato WhatsAppProvider + provedor simulado (mock)
    dispatch/            um worker por linha (pega da fila compartilhada)
    distribution/        ciclos: cota sorteada por linha e intervalo sorteado por ciclo
    campaigns/           disparos (linhas selecionadas, pausar/retomar/encerrar)
    queue/               fila persistente de envios
    history/             registro único e atômico de cada tentativa de envio
    contacts/            contatos únicos, importação CSV, rastreamento
    messages/            5 posições de mensagem com sorteio sem repetição consecutiva
    conversations/       mensagens recebidas por linha (base do Analytics)
    analytics/ stats/ exports/ settings/ logs/
web/                     painel React
tests/                   testes automatizados (node --test)
```

Não existe processo central de envio: cada linha tem o seu worker. Pausar, derrubar ou limitar uma linha afeta só ela; os contatos que ela não pegou continuam na fila para as outras.

## Provedor de WhatsApp

Hoje só existe o provedor `mock` (simulado). O transporte real entra implementando a interface `WhatsAppProvider` (`src/server/modules/providers/provider.types.ts`) e registrando-o em `app.ts`, sem alterar o restante do sistema.
