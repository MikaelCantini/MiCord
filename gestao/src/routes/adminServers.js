const express = require('express');
const router = express.Router();
const db = require('../db');
const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');

// 1. Listar todos os servidores
router.get('/', adminAuthMiddleware, (req, res) => {
    try {
        const servers = db.queryAll(`
            SELECT s.id, s.name, s.description, s.icon_url, s.invite_code, s.created_at,
                   u.username AS owner_username, u.display_name AS owner_display_name,
                   (SELECT COUNT(*) FROM server_members WHERE server_id = s.id) AS member_count,
                   (SELECT COUNT(*) FROM channels WHERE server_id = s.id) AS channel_count,
                   (SELECT COUNT(*) FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.server_id = s.id) AS message_count
            FROM servers s
            JOIN users u ON u.id = s.owner_id
            ORDER BY s.created_at DESC
        `);

        return res.json(servers);
    } catch (err) {
        console.error('Erro ao listar servidores na gestão:', err);
        return res.status(500).json({ error: 'Erro ao listar servidores.' });
    }
});

// 2. Detalhes de um servidor específico
router.get('/:id', adminAuthMiddleware, (req, res) => {
    try {
        const serverId = parseInt(req.params.id);
        const server = db.queryOne(`
            SELECT s.*, u.username AS owner_username, u.display_name AS owner_display_name
            FROM servers s
            JOIN users u ON u.id = s.owner_id
            WHERE s.id = ?
        `, [serverId]);

        if (!server) {
            return res.status(404).json({ error: 'Servidor não encontrado.' });
        }

        const channels = db.queryAll('SELECT * FROM channels WHERE server_id = ? ORDER BY position ASC', [serverId]);
        const members = db.queryAll(`
            SELECT u.id, u.username, u.display_name, u.avatar_url, u.status, sm.role, sm.joined_at
            FROM server_members sm
            JOIN users u ON u.id = sm.user_id
            WHERE sm.server_id = ?
            ORDER BY sm.joined_at ASC
        `, [serverId]);

        return res.json({ server, channels, members });
    } catch (err) {
        console.error('Erro ao obter servidor na gestão:', err);
        return res.status(500).json({ error: 'Erro ao obter dados do servidor.' });
    }
});

// 3. Excluir servidor pela administração
router.delete('/:id', adminAuthMiddleware, (req, res) => {
    try {
        const serverId = parseInt(req.params.id);
        const server = db.queryOne('SELECT id, name FROM servers WHERE id = ?', [serverId]);
        if (!server) {
            return res.status(404).json({ error: 'Servidor não encontrado.' });
        }

        db.run('DELETE FROM servers WHERE id = ?', [serverId]);

        db.run(`
            INSERT INTO audit_logs (admin_id, action, target_type, target_id, details)
            VALUES (?, 'SERVER_DELETED', 'SERVER', ?, ?)
        `, [req.admin.id, serverId.toString(), `Servidor "${server.name}" excluído pelo administrador.`]);

        return res.json({ message: `Servidor "${server.name}" excluído com sucesso.` });
    } catch (err) {
        console.error('Erro ao excluir servidor:', err);
        return res.status(500).json({ error: 'Erro ao excluir servidor.' });
    }
});

module.exports = router;
