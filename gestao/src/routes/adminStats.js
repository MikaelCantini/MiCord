const express = require('express');
const router = express.Router();
const fs = require('fs');
const config = require('../config');
const db = require('../db');
const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');

router.get('/', adminAuthMiddleware, (req, res) => {
    try {
        const totalUsers = db.queryOne('SELECT COUNT(*) AS total FROM users').total;
        const onlineUsers = db.queryOne("SELECT COUNT(*) AS total FROM users WHERE status != 'offline' AND is_banned = 0").total;
        const bannedUsers = db.queryOne('SELECT COUNT(*) AS total FROM users WHERE is_banned = 1').total;
        
        const totalServers = db.queryOne('SELECT COUNT(*) AS total FROM servers').total;
        const totalChannels = db.queryOne('SELECT COUNT(*) AS total FROM channels').total;
        const textChannels = db.queryOne("SELECT COUNT(*) AS total FROM channels WHERE type = 'text'").total;
        const voiceChannels = db.queryOne("SELECT COUNT(*) AS total FROM channels WHERE type = 'voice'").total;

        const totalMessages = db.queryOne('SELECT COUNT(*) AS total FROM messages').total;
        const totalUploads = db.queryOne('SELECT COUNT(*) AS total FROM messages WHERE attachment_url IS NOT NULL').total;

        // Tamanho do arquivo de banco de dados
        let dbSizeBytes = 0;
        try {
            const stats = fs.statSync(config.DB_PATH);
            dbSizeBytes = stats.size;
        } catch (e) {}

        const dbSizeKB = (dbSizeBytes / 1024).toFixed(2);
        const dbSizeMB = (dbSizeBytes / (1024 * 1024)).toFixed(2);

        // Usuários recentes
        const recentUsers = db.queryAll(`
            SELECT id, username, email, display_name, role, status, is_banned, created_at
            FROM users
            ORDER BY created_at DESC
            LIMIT 5
        `);

        // Mensagens recentes
        const recentMessages = db.queryAll(`
            SELECT m.id, m.content, m.attachment_type, m.created_at,
                   u.username, u.display_name,
                   c.name AS channel_name, s.name AS server_name
            FROM messages m
            JOIN users u ON u.id = m.sender_id
            LEFT JOIN channels c ON c.id = m.channel_id
            LEFT JOIN servers s ON s.id = c.server_id
            ORDER BY m.created_at DESC
            LIMIT 5
        `);

        return res.json({
            stats: {
                totalUsers,
                onlineUsers,
                bannedUsers,
                totalServers,
                totalChannels,
                textChannels,
                voiceChannels,
                totalMessages,
                totalUploads,
                dbSizeBytes,
                dbSizeKB,
                dbSizeMB
            },
            recentUsers,
            recentMessages
        });
    } catch (err) {
        console.error('Erro ao buscar estatísticas do painel:', err);
        return res.status(500).json({ error: 'Erro ao buscar estatísticas.' });
    }
});

module.exports = router;
