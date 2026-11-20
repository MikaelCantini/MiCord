# 🌸 CSGONADES Chat — Aplicativo de Conversa, Voz, Vídeo \& Grupos

Aplicativo completo estilo Discord/Skype/TeamSpeak, com tema branco e rosa claro + modo escuro.

\---

## 🚀 Como Iniciar

### Iniciar tudo de uma vez (recomendado)

```bash
# No diretório csgonades, execute:
node start-both.js

# Ou dê duplo-clique no arquivo:
start-all.bat
```

### Ou iniciar separadamente

```bash
node app/server.js      # Chat App     → http://localhost:3000
node gestao/server.js   # Painel Admin → http://localhost:3001
```

\---

## 🔗 URLs Principais

|Serviço|URL|Descrição|
|-|-|-|
|**Chat App**|[http://localhost:3000](http://localhost:3000)|Interface principal do usuário|
|**Painel de Gestão**|[http://localhost:3001](http://localhost:3001)|Administração e banco de dados|

\---

## 🔑 Contas Pré-Criadas

|Conta|E-mail|Senha|Papel|
|-|-|-|-|
|Admin|`admin@csgonades.local`|`admin123`|Administrador|
|Amigo Demo|`amigo@csgonades.local`|`amigo123`|Usuário|

> \\\[!TIP]
> Na tela de login do Chat App existem botões de \\\*\\\*login rápido\\\*\\\* que preenchem os dados automaticamente.

\---

## ✅ Funcionalidades Implementadas

### Autenticação

* ✅ Verificação automática de sessão ao entrar no app (se já logado, vai direto)
* ✅ Tela de Login com e-mail/usuário e senha
* ✅ Tela de Cadastro (nome de usuário, nome de exibição, e-mail, senha)
* ✅ JWT com 30 dias de validade
* ✅ Perfil editável (nome, bio, status)

### Amigos

* ✅ Adicionar amigos por username ou e-mail
* ✅ Lista de amigos online / todos / pendentes
* ✅ Aceitar ou recusar solicitações de amizade
* ✅ Remover amigo
* ✅ Busca rápida de amigos

### Servidores \& Grupos

* ✅ Criar servidor com nome e descrição
* ✅ Código de convite exclusivo (ex: `GERAL2026`)
* ✅ Entrar em servidor via código de convite
* ✅ Sair / Excluir servidor
* ✅ Servidor padrão "Comunidade Geral" criado automaticamente

### Canais / Salas

* ✅ Canais de **texto** (chat de mensagens)
* ✅ Salas de **voz \& vídeo** (WebRTC)
* ✅ Criar novos canais de qualquer tipo
* ✅ 4 canais pré-criados: `#geral`, `#fotos-e-memes`, `🔊 Bate-papo Voz`, `🔊 Jogos \\\& Transmissão`

### Chat de Mensagens

* ✅ Mensagens em tempo real via Socket.IO
* ✅ Histórico de mensagens persistido no banco
* ✅ Upload de imagens e arquivos (até 25MB)
* ✅ Visualizador de imagens (lightbox com zoom)
* ✅ Drag \& drop de arquivos no chat
* ✅ Indicador de "está digitando..."
* ✅ Emojis rápidos
* ✅ Mensagens diretas (DM) com amigos

### Voz, Vídeo \& Compartilhamento de Tela (WebRTC)

* ✅ Chat de voz em salas de grupo (mesh P2P)
* ✅ Webcam / câmera ligável/desligável
* ✅ Compartilhamento de tela em tempo real
* ✅ Detecção visual de fala (glow verde ao redor do avatar/vídeo)
* ✅ Mutar/Ensordecer microfone
* ✅ Grid adaptável de vídeos dos participantes
* ✅ Chamadas diretas 1-a-1 com amigos (voz ou vídeo)
* ✅ Notificação de chamada recebida com aceitar/recusar
* ✅ Som de notificação (sintetizado com Web Audio API)

### Tema Visual

* ✅ Tema **branco com rosa claro** (padrão)
* ✅ **Modo escuro** com alternância por botão
* ✅ Fonte: Plus Jakarta Sans
* ✅ Interface estilo Discord (layout de 4 colunas)

\---

## 🛡️ Painel de Gestão (porta 3001)

|Funcionalidade|Descrição|
|-|-|
|**Visão Geral**|Dashboard com métricas: total de usuários, online, banidos, servidores, mensagens, tamanho do DB|
|**Controle de Usuários**|Listar, buscar, criar, editar, banir/desbanir, excluir permanentemente|
|**Servidores \& Grupos**|Visualizar todos os servidores, membros, canais e excluir|
|**Logs de Auditoria**|Histórico de todas as ações administrativas|
|**Banco de Dados**|Backup imediato do SQLite e otimização VACUUM|

\---

## 📁 Estrutura de Pastas

```
csgonades/
├── start-both.js          # Inicia ambos os servidores
├── start-all.bat          # Script Windows para abrir tudo
├── package.json           # Scripts npm raiz
│
├── app/                   # 🌸 APLICATIVO DE CHAT (porta 3000)
│   ├── server.js          # Servidor Express + Socket.IO
│   ├── package.json
│   ├── uploads/           # Arquivos e imagens enviados
│   ├── src/
│   │   ├── config.js
│   │   ├── db.js          # Conexão com o banco (gestao/database/app.db)
│   │   ├── middleware/
│   │   │   └── authMiddleware.js
│   │   ├── routes/
│   │   │   ├── auth.js       # Login, cadastro, perfil
│   │   │   ├── users.js      # Busca de usuários
│   │   │   ├── friends.js    # Amizades e solicitações
│   │   │   ├── servers.js    # CRUD de servidores/grupos
│   │   │   ├── channels.js   # Canais de texto e voz
│   │   │   ├── messages.js   # Chat e DMs
│   │   │   └── upload.js     # Upload de arquivos
│   │   └── sockets/
│   │       └── socketHandler.js  # WebRTC signaling, voz, vídeo, tela
│   └── public/
│       ├── index.html     # SPA principal
│       ├── css/
│       │   ├── style.css     # Tema branco/rosa + dark mode
│       │   └── webrtc.css    # Estilos de voz/vídeo
│       ├── js/
│       │   ├── app.js        # Orquestrador principal
│       │   ├── auth.js       # Login, cadastro, sessão
│       │   ├── friends.js    # Hub de amigos
│       │   ├── servers.js    # Servidores e canais
│       │   ├── chat.js       # Mensagens, uploads, emojis
│       │   ├── webrtc.js     # Voz, webcam, tela, chamadas
│       │   └── theme.js      # Alternância de tema
│       └── assets/
│           ├── default-avatar.svg
│           └── default-avatar-admin.svg
│
└── gestao/                # 🛡️ PAINEL DE GESTÃO (porta 3001)
    ├── server.js          # Servidor Express administrativo
    ├── package.json
    ├── database/
    │   ├── schema.sql     # Schema completo do banco
    │   ├── initDb.js      # Inicializador + dados padrão
    │   └── app.db         # 💾 BANCO DE DADOS SQLite
    ├── src/
    │   ├── config.js
    │   ├── db.js
    │   ├── middleware/
    │   │   └── adminAuthMiddleware.js
    │   └── routes/
    │       ├── adminAuth.js      # Login administrativo
    │       ├── adminStats.js     # Métricas do dashboard
    │       ├── adminUsers.js     # CRUD de usuários
    │       ├── adminServers.js   # Gestão de servidores
    │       └── adminLogs.js      # Logs e backup do DB
    └── public/
        ├── index.html     # Painel de gestão SPA
        ├── css/admin.css
        └── js/adminApp.js
```

\---

## 🗄️ Banco de Dados

* **Engine:** SQLite 3 nativo (`node:sqlite` do Node.js 26 — sem dependências externas)
* **Localização:** `gestao/database/app.db`
* **Modo Journal:** WAL (suporta leitura/escrita simultânea)
* **Tabelas:** `users`, `friends`, `servers`, `server\\\_members`, `channels`, `messages`, `audit\\\_logs`

> \\\[!IMPORTANT]
> Ambos os apps (`app/` e `gestao/`) compartilham o \\\*\\\*mesmo banco de dados\\\*\\\* em `gestao/database/app.db`. Qualquer alteração feita no painel de gestão reflete imediatamente no app de chat e vice-versa.

