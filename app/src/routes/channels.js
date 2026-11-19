const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../middleware/authMiddleware');

// 1. Criar novo canal em um servidor
router.post('/server/:serverId', authMiddleware, (req, res) => {
    try {
        const serverId = parseInt(req.params.serverId);
        const { name, type, topic } = req.body;
        const userId = req.user.id;

        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'O nome do canal é obrigatório.' });
        }

        // Verifica permissão (owner ou admin do servidor)
        const member = db.queryOne(`
            SELECT role FROM server_members WHERE server_id = ? AND user_id = ?
        `, [serverId, userId]);

        if (!member || (member.role !== 'owner' && member.role !== 'admin' && req.user.role !== 'admin')) {
            return res.status(403).json({ error: 'Você não tem permissão para criar canais neste servidor.' });
        }

        const cleanType = (type === 'voice') ? 'voice' : 'text';
        // Formata nome para texto: minúsculo e hífens se for texto
        const cleanName = cleanType === 'text' 
            ? name.trim().toLowerCase().replace(/\s+/g, '-') 
            : name.trim();

        // Encontra a maior posição atual
        const maxPos = db.queryOne('SELECT MAX(position) AS maxp FROM channels WHERE server_id = ?', [serverId]);
        const nextPos = (maxPos && maxPos.maxp ? maxPos.maxp : 0) + 1;

        const result = db.run(`
            INSERT INTO channels (server_id, name, type, topic, position)
            VALUES (?, ?, ?, ?, ?)
        `, [serverId, cleanName, cleanType, topic ? topic.trim() : null, nextPos]);

        const newChannel = db.queryOne('SELECT * FROM channels WHERE id = ?', [result.lastInsertRowid]);
        return res.status(201).json(newChannel);
    } catch (err) {
        console.error('Erro ao criar canal:', err);
        return res.status(500).json({ error: 'Erro ao criar canal.' });
    }
});

// 2. Excluir canal
router.delete('/:id', authMiddleware, (req, res) => {
    try {
        const channelId = parseInt(req.params.id);
        const userId = req.user.id;

        const channel = db.queryOne('SELECT id, server_id FROM channels WHERE id = ?', [channelId]);
        if (!channel) {
            return res.status(404).json({ error: 'Canal não encontrado.' });
        }

        const member = db.queryOne(`
            SELECT role FROM server_members WHERE server_id = ? AND user_id = ?
        `, [channel.server_id, userId]);

        if (!member || (member.role !== 'owner' && member.role !== 'admin' && req.user.role !== 'admin')) {
            return res.status(403).json({ error: 'Você não tem permissão para excluir este canal.' });
        }

        db.run('DELETE FROM channels WHERE id = ?', [channelId]);
        return res.json({ message: 'Canal excluído com sucesso.' });
    } catch (err) {
        console.error('Erro ao excluir canal:', err);
        return res.status(500).json({ error: 'Erro ao excluir canal.' });
    }
});

module.exports = router;
