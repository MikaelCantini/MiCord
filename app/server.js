const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { Server } = require('socket.io');

const config = require('./src/config');
const { setupSocketIO } = require('./src/sockets/socketHandler');
//nao sabe nada
const authRoutes = require('./src/routes/auth');
const usersRoutes = require('./src/routes/users');
const friendsRoutes = require('./src/routes/friends');
const serversRoutes = require('./src/routes/servers');
const channelsRoutes = require('./src/routes/channels');
const messagesRoutes = require('./src/routes/messages');
const uploadRoutes = require('./src/routes/upload');

const app = express();
const server = http.createServer(app);

// Configuração do Socket.IO com suporte a WebRTC signaling e mensagens em tempo real
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },
    maxHttpBufferSize: 1e8 // 100MB buffer
});

setupSocketIO(io);

// Middlewares
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Arquivos estáticos do frontend e uploads
app.get('/assets/default-avatar.png', (req, res) => {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.sendFile(path.join(__dirname, 'public', 'assets', 'default-avatar.svg'));
});

app.get('/assets/default-avatar-admin.png', (req, res) => {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.sendFile(path.join(__dirname, 'public', 'assets', 'default-avatar-admin.svg'));
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Rotas da API
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/friends', friendsRoutes);
app.use('/api/servers', serversRoutes);
app.use('/api/channels', channelsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/upload', uploadRoutes);

// Fallback SPA
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(config.PORT, () => {
    console.log(`=======================================================`);
    console.log(`🚀 CSGONADES CHAT APP está rodando com sucesso!`);
    console.log(`📡 URL Principal: http://localhost:${config.PORT}`);
    console.log(`💾 Conectado ao banco de dados em gestao/database/app.db`);
    console.log(`=======================================================`);
});

module.exports = { app, server };
