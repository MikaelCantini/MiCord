const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../middleware/authMiddleware');

// 1. Mensagens de um canal do servidor
router.get('/channel/:channelId', authMiddleware, (req, res) => {
    try {
        const channelId = parseInt(req.params.channelId);
        const userId = req.user.id;

        // Verifica canal e associação ao servidor
        const channel = db.queryOne('SELECT id, server_id, type FROM channels WHERE id = ?', [channelId]);
        if (!channel) {
            return res.status(404).json({ error: 'Canal não encontrado.' });
        }

        const member = db.queryOne('SELECT id FROM server_members WHERE server_id = ? AND user_id = ?', [channel.server_id, userId]);
        if (!member) {
            return res.status(403).json({ error: 'Você não tem acesso a este canal.' });
        }

        const limit = parseInt(req.query.limit) || 100;
        const messages = db.queryAll(`
            SELECT m.id, m.channel_id, m.sender_id, m.content, 
                   m.attachment_url, m.attachment_type, m.attachment_name, m.created_at,
                   u.username, u.display_name, u.avatar_url, u.status
            FROM messages m
            JOIN users u ON u.id = m.sender_id
            WHERE m.channel_id = ?
            ORDER BY m.created_at ASC
            LIMIT ?
        `, [channelId, limit]);

        return res.json(messages);
    } catch (err) {
        console.error('Erro ao buscar mensagens do canal:', err);
        return res.status(500).json({ error: 'Erro ao buscar mensagens.' });
    }
});

// 2. Mensagens diretas (DM) com um amigo
router.get('/dm/:friendId', authMiddleware, (req, res) => {
    try {
        const friendId = parseInt(req.params.friendId);
        const myId = req.user.id;

        const limit = parseInt(req.query.limit) || 100;
        const messages = db.queryAll(`
            SELECT m.id, m.recipient_id, m.sender_id, m.content, 
                   m.attachment_url, m.attachment_type, m.attachment_name, m.created_at,
                   u.username, u.display_name, u.avatar_url, u.status
            FROM messages m
            JOIN users u ON u.id = m.sender_id
            WHERE m.channel_id IS NULL
              AND ((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?))
            ORDER BY m.created_at ASC
            LIMIT ?
        `, [myId, friendId, friendId, myId, limit]);

        return res.json(messages);
    } catch (err) {
        console.error('Erro ao buscar mensagens diretas:', err);
        return res.status(500).json({ error: 'Erro ao buscar mensagens diretas.' });
    }
});

// 3. Enviar mensagem via REST (fallback para Socket.io)
router.post('/', authMiddleware, (req, res) => {
    try {
        const { channel_id, recipient_id, content, attachment_url, attachment_type, attachment_name } = req.body;
        const senderId = req.user.id;

        if ((!content || !content.trim()) && !attachment_url) {
            return res.status(400).json({ error: 'A mensagem não pode estar vazia.' });
        }

        let cleanChannelId = channel_id ? parseInt(channel_id) : null;
        let cleanRecipientId = recipient_id ? parseInt(recipient_id) : null;

        if (cleanChannelId) {
            // Verifica permissão no canal
            const channel = db.queryOne('SELECT server_id FROM channels WHERE id = ?', [cleanChannelId]);
            if (!channel) return res.status(404).json({ error: 'Canal não encontrado.' });
            
            const member = db.queryOne('SELECT id FROM server_members WHERE server_id = ? AND user_id = ?', [channel.server_id, senderId]);
            if (!member) return res.status(403).json({ error: 'Você não tem acesso a este servidor.' });
        }

        const result = db.run(`
            INSERT INTO messages (channel_id, recipient_id, sender_id, content, attachment_url, attachment_type, attachment_name)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
            cleanChannelId,
            cleanRecipientId,
            senderId,
            content ? content.trim() : null,
            attachment_url || null,
            attachment_type || null,
            attachment_name || null
        ]);

        const fullMsg = db.queryOne(`
            SELECT m.id, m.channel_id, m.recipient_id, m.sender_id, m.content, 
                   m.attachment_url, m.attachment_type, m.attachment_name, m.created_at,
                   u.username, u.display_name, u.avatar_url, u.status
            FROM messages m
            JOIN users u ON u.id = m.sender_id
            WHERE m.id = ?
        `, [result.lastInsertRowid]);

        return res.status(201).json(fullMsg);
    } catch (err) {
        console.error('Erro ao enviar mensagem:', err);
        return res.status(500).json({ error: 'Erro ao enviar mensagem.' });
    }
});

// 4. Excluir mensagem
router.delete('/:id', authMiddleware, (req, res) => {
    try {
        const messageId = parseInt(req.params.id);
        const userId = req.user.id;

        const msg = db.queryOne('SELECT sender_id FROM messages WHERE id = ?', [messageId]);
        if (!msg) {
            return res.status(404).json({ error: 'Mensagem não encontrada.' });
        }

        if (msg.sender_id !== userId && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Você não tem permissão para excluir esta mensagem.' });
        }

        db.run('DELETE FROM messages WHERE id = ?', [messageId]);
        return res.json({ message: 'Mensagem apagada com sucesso.' });
    } catch (err) {
        console.error('Erro ao excluir mensagem:', err);
        return res.status(500).json({ error: 'Erro ao excluir mensagem.' });
    }
});

module.exports = router;
