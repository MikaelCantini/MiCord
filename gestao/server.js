const express = require('express');
const path = require('path');
const cors = require('cors');

const config = require('./src/config');
const adminAuthRoutes = require('./src/routes/adminAuth');
const adminStatsRoutes = require('./src/routes/adminStats');
const adminUsersRoutes = require('./src/routes/adminUsers');
const adminServersRoutes = require('./src/routes/adminServers');
const adminLogsRoutes = require('./src/routes/adminLogs');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Arquivos estáticos do painel administrativo
app.use(express.static(path.join(__dirname, 'public')));

// Rotas da API da Gestão
app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/admin/stats', adminStatsRoutes);
app.use('/api/admin/users', adminUsersRoutes);
app.use('/api/admin/servers', adminServersRoutes);
app.use('/api/admin/logs', adminLogsRoutes);

// Fallback SPA
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(config.PORT, () => {
    console.log(`=======================================================`);
    console.log(`🛡️ PAINEL DE GESTÃO E BANCO DE DADOS está rodando!`);
    console.log(`📡 URL da Gestão: http://localhost:${config.PORT}`);
    console.log(`💾 Banco de Dados SQLite: ${config.DB_PATH}`);
    console.log(`🔑 Login padrão: admin@csgonades.local / admin123`);
    console.log(`=======================================================`);
});

module.exports = app;
