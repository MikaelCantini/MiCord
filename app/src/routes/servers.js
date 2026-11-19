const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db');
const authMiddleware = require('../middleware/authMiddleware');

function generateInviteCode() {
    return crypto.randomBytes(4).toString('hex').toUpperCase();
}

// 1. Listar servidores dos quais o usuário participa
router.get('/', authMiddleware, (req, res) => {
    try {
        const userId = req.user.id;
        const servers = db.queryAll(`
            SELECT s.id, s.name, s.description, s.icon_url, s.owner_id, s.invite_code, s.created_at,
                   sm.role AS member_role,
                   (SELECT COUNT(*) FROM server_members WHERE server_id = s.id) AS member_count
            FROM servers s
            JOIN server_members sm ON sm.server_id = s.id
            WHERE sm.user_id = ?
            ORDER BY s.id ASC
        `, [userId]);

        return res.json(servers);
    } catch (err) {
        console.error('Erro ao listar servidores:', err);
        return res.status(500).json({ error: 'Erro ao listar servidores.' });
    }
});

// 2. Criar novo servidor
router.post('/', authMiddleware, (req, res) => {
    try {
        const { name, description, icon_url } = req.body;
        const userId = req.user.id;

        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'O nome do servidor é obrigatório.' });
        }

        const inviteCode = generateInviteCode();

        const result = db.run(`
            INSERT INTO servers (name, description, icon_url, owner_id, invite_code)
            VALUES (?, ?, ?, ?, ?)
        `, [name.trim(), description ? description.trim() : '', icon_url || null, userId, inviteCode]);

        const serverId = result.lastInsertRowid;

        // Adiciona criador como 'owner'
        db.run(`
            INSERT INTO server_members (server_id, user_id, role)
            VALUES (?, ?, 'owner')
        `, [serverId, userId]);

        // Cria canais padrão: 1 de texto e 1 de voz/vídeo
        db.run(`
            INSERT INTO channels (server_id, name, type, topic, position)
            VALUES (?, 'geral', 'text', 'Bate-papo geral do servidor', 1)
        `, [serverId]);

        db.run(`
            INSERT INTO channels (server_id, name, type, topic, position)
            VALUES (?, 'Sala de Voz & Vídeo', 'voice', 'Canal de voz, câmera e tela', 2)
        `, [serverId]);

        const newServer = db.queryOne(`
            SELECT s.id, s.name, s.description, s.icon_url, s.owner_id, s.invite_code, s.created_at,
                   'owner' AS member_role, 1 AS member_count
            FROM servers s WHERE s.id = ?
        `, [serverId]);

        return res.status(201).json(newServer);
    } catch (err) {
        console.error('Erro ao criar servidor:', err);
        return res.status(500).json({ error: 'Erro ao criar servidor.' });
    }
});

// 3. Obter detalhes do servidor (canais e membros)
router.get('/:id', authMiddleware, (req, res) => {
    try {
        const serverId = parseInt(req.params.id);
        const userId = req.user.id;

        // Verifica se o usuário é membro do servidor
        const membership = db.queryOne(`
            SELECT role FROM server_members WHERE server_id = ? AND user_id = ?
        `, [serverId, userId]);

        if (!membership) {
            return res.status(403).json({ error: 'Você não é membro deste servidor.' });
        }

        const server = db.queryOne(`
            SELECT id, name, description, icon_url, owner_id, invite_code, created_at
            FROM servers WHERE id = ?
        `, [serverId]);

        if (!server) {
            return res.status(404).json({ error: 'Servidor não encontrado.' });
        }

        // Canais do servidor
        const channels = db.queryAll(`
            SELECT id, server_id, name, type, topic, position
            FROM channels 
            WHERE server_id = ?
            ORDER BY position ASC, id ASC
        `, [serverId]);

        // Membros do servidor
        const members = db.queryAll(`
            SELECT u.id, u.username, u.display_name, u.avatar_url, u.status, u.custom_status, u.bio,
                   sm.role, sm.nickname, sm.joined_at
            FROM server_members sm
            JOIN users u ON u.id = sm.user_id
            WHERE sm.server_id = ? AND u.is_banned = 0
            ORDER BY 
                CASE sm.role 
                    WHEN 'owner' THEN 1 
                    WHEN 'admin' THEN 2 
                    WHEN 'moderator' THEN 3 
                    ELSE 4 
                END,
                CASE u.status 
                    WHEN 'online' THEN 1 
                    WHEN 'idle' THEN 2 
                    WHEN 'dnd' THEN 3 
                    ELSE 4 
                END,
                u.display_name ASC
        `, [serverId]);

        return res.json({
            ...server,
            role: membership.role,
            channels,
            members
        });
    } catch (err) {
        console.error('Erro ao obter detalhes do servidor:', err);
        return res.status(500).json({ error: 'Erro ao obter detalhes do servidor.' });
    }
});

// 4. Entrar em servidor via código de convite
router.post('/join', authMiddleware, (req, res) => {
    try {
        const { invite_code } = req.body;
        const userId = req.user.id;

        if (!invite_code || !invite_code.trim()) {
            return res.status(400).json({ error: 'Código de convite obrigatório.' });
        }

        const code = invite_code.trim().toUpperCase();
        const server = db.queryOne('SELECT id, name FROM servers WHERE invite_code = ?', [code]);

        if (!server) {
            return res.status(404).json({ error: 'Código de convite inválido ou expirado.' });
        }

        // Verifica se já é membro
        const alreadyMember = db.queryOne('SELECT id FROM server_members WHERE server_id = ? AND user_id = ?', [server.id, userId]);
        if (alreadyMember) {
            return res.status(400).json({ error: 'Você já faz parte deste servidor!', serverId: server.id });
        }

        db.run(`
            INSERT INTO server_members (server_id, user_id, role)
            VALUES (?, ?, 'member')
        `, [server.id, userId]);

        return res.json({
            message: `Você entrou no servidor "${server.name}" com sucesso!`,
            serverId: server.id
        });
    } catch (err) {
        console.error('Erro ao entrar no servidor:', err);
        return res.status(500).json({ error: 'Erro ao entrar no servidor.' });
    }
});

// 5. Excluir servidor (apenas proprietário)
router.delete('/:id', authMiddleware, (req, res) => {
    try {
        const serverId = parseInt(req.params.id);
        const userId = req.user.id;

        const server = db.queryOne('SELECT id, owner_id FROM servers WHERE id = ?', [serverId]);
        if (!server) {
            return res.status(404).json({ error: 'Servidor não encontrado.' });
        }

        if (server.owner_id !== userId && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Apenas o proprietário pode excluir este servidor.' });
        }

        db.run('DELETE FROM servers WHERE id = ?', [serverId]);
        return res.json({ message: 'Servidor excluído com sucesso.' });
    } catch (err) {
        console.error('Erro ao excluir servidor:', err);
        return res.status(500).json({ error: 'Erro ao excluir servidor.' });
    }
});

// 6. Sair do servidor
router.post('/:id/leave', authMiddleware, (req, res) => {
    try {
        const serverId = parseInt(req.params.id);
        const userId = req.user.id;

        const server = db.queryOne('SELECT id, owner_id FROM servers WHERE id = ?', [serverId]);
        if (!server) {
            return res.status(404).json({ error: 'Servidor não encontrado.' });
        }

        if (server.owner_id === userId) {
            return res.status(400).json({ error: 'O proprietário não pode sair do servidor. Transfira a posse ou exclua o servidor.' });
        }

        db.run('DELETE FROM server_members WHERE server_id = ? AND user_id = ?', [serverId, userId]);
        return res.json({ message: 'Você saiu do servidor.' });
    } catch (err) {
        console.error('Erro ao sair do servidor:', err);
        return res.status(500).json({ error: 'Erro ao sair do servidor.' });
    }
});

module.exports = router;
