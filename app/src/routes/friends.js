const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../middleware/authMiddleware');

// 1. Listar amigos confirmados
router.get('/', authMiddleware, (req, res) => {
    try {
        const userId = req.user.id;
        
        // Busca amigos aceitos (tanto onde sou user_id quanto friend_id)
        const friends = db.queryAll(`
            SELECT DISTINCT 
                u.id, u.username, u.display_name, u.avatar_url, u.status, u.custom_status, u.bio, u.last_seen,
                f.id AS friendship_id, f.created_at AS friends_since
            FROM friends f
            JOIN users u ON (u.id = CASE WHEN f.user_id = ? THEN f.friend_id ELSE f.user_id END)
            WHERE (f.user_id = ? OR f.friend_id = ?)
              AND f.status = 'accepted'
              AND u.is_banned = 0
            ORDER BY 
                CASE u.status 
                    WHEN 'online' THEN 1 
                    WHEN 'idle' THEN 2 
                    WHEN 'dnd' THEN 3 
                    ELSE 4 
                END,
                u.display_name ASC
        `, [userId, userId, userId]);

        return res.json(friends);
    } catch (err) {
        console.error('Erro ao listar amigos:', err);
        return res.status(500).json({ error: 'Erro ao listar amigos.' });
    }
});

// 2. Listar solicitações pendentes (recebidas e enviadas)
router.get('/requests', authMiddleware, (req, res) => {
    try {
        const userId = req.user.id;

        // Solicitações que outros enviaram para mim
        const incoming = db.queryAll(`
            SELECT f.id AS request_id, f.created_at,
                   u.id AS user_id, u.username, u.display_name, u.avatar_url, u.status
            FROM friends f
            JOIN users u ON u.id = f.user_id
            WHERE f.friend_id = ? AND f.status = 'pending' AND u.is_banned = 0
            ORDER BY f.created_at DESC
        `, [userId]);

        // Solicitações que eu enviei para outros
        const outgoing = db.queryAll(`
            SELECT f.id AS request_id, f.created_at,
                   u.id AS user_id, u.username, u.display_name, u.avatar_url, u.status
            FROM friends f
            JOIN users u ON u.id = f.friend_id
            WHERE f.user_id = ? AND f.status = 'pending' AND u.is_banned = 0
            ORDER BY f.created_at DESC
        `, [userId]);

        return res.json({ incoming, outgoing });
    } catch (err) {
        console.error('Erro ao listar solicitações:', err);
        return res.status(500).json({ error: 'Erro ao listar solicitações.' });
    }
});

// 3. Enviar solicitação de amizade (por username ou email)
router.post('/request', authMiddleware, (req, res) => {
    try {
        const { target } = req.body; // pode ser username ou email
        const myId = req.user.id;

        if (!target || !target.trim()) {
            return res.status(400).json({ error: 'Informe o nome de usuário ou e-mail do amigo.' });
        }

        const cleanTarget = target.trim().toLowerCase();

        // Procura o usuário alvo
        const targetUser = db.queryOne(`
            SELECT id, username, display_name, email, is_banned 
            FROM users 
            WHERE (LOWER(username) = ? OR LOWER(email) = ?)
        `, [cleanTarget, cleanTarget]);

        if (!targetUser) {
            return res.status(404).json({ error: 'Usuário não encontrado. Verifique o nome ou e-mail digitado.' });
        }

        if (targetUser.id === myId) {
            return res.status(400).json({ error: 'Você não pode adicionar a si mesmo como amigo.' });
        }

        if (targetUser.is_banned) {
            return res.status(400).json({ error: 'Este usuário está indisponível.' });
        }

        // Verifica se já existe algum relacionamento
        const existing = db.queryOne(`
            SELECT id, user_id, friend_id, status 
            FROM friends 
            WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)
        `, [myId, targetUser.id, targetUser.id, myId]);

        if (existing) {
            if (existing.status === 'accepted') {
                return res.status(400).json({ error: 'Vocês já são amigos!' });
            }
            if (existing.status === 'pending') {
                if (existing.user_id === myId) {
                    return res.status(400).json({ error: 'Você já enviou uma solicitação para este amigo.' });
                } else {
                    // O outro já me enviou pedido! Auto-aceita!
                    db.run("UPDATE friends SET status = 'accepted', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [existing.id]);
                    return res.json({ 
                        message: `Você aceitou a solicitação pendente de ${targetUser.display_name || targetUser.username}!`,
                        status: 'accepted'
                    });
                }
            }
            if (existing.status === 'blocked') {
                return res.status(400).json({ error: 'Não é possível enviar solicitação para este usuário.' });
            }
        }

        // Insere a solicitação
        db.run(`
            INSERT INTO friends (user_id, friend_id, status)
            VALUES (?, ?, 'pending')
        `, [myId, targetUser.id]);

        return res.status(201).json({
            message: `Solicitação de amizade enviada com sucesso para ${targetUser.display_name || targetUser.username}!`,
            targetUser: {
                id: targetUser.id,
                username: targetUser.username,
                display_name: targetUser.display_name
            }
        });
    } catch (err) {
        console.error('Erro ao enviar solicitação:', err);
        return res.status(500).json({ error: 'Erro ao enviar solicitação de amizade.' });
    }
});

// 4. Aceitar ou recusar solicitação
router.post('/respond', authMiddleware, (req, res) => {
    try {
        const { requestId, action } = req.body; // action: 'accept' ou 'decline'
        const myId = req.user.id;

        if (!requestId || !action) {
            return res.status(400).json({ error: 'Parâmetros incompletos.' });
        }

        const request = db.queryOne(`
            SELECT f.id, f.user_id, f.friend_id, f.status, u.username, u.display_name
            FROM friends f
            JOIN users u ON u.id = f.user_id
            WHERE f.id = ? AND f.friend_id = ?
        `, [requestId, myId]);

        if (!request) {
            return res.status(404).json({ error: 'Solicitação não encontrada.' });
        }

        if (action === 'accept') {
            db.run("UPDATE friends SET status = 'accepted', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [requestId]);
            return res.json({ 
                message: `Amizade com ${request.display_name || request.username} aceita com sucesso!`,
                action: 'accepted'
            });
        } else if (action === 'decline') {
            db.run('DELETE FROM friends WHERE id = ?', [requestId]);
            return res.json({ message: 'Solicitação recusada.', action: 'declined' });
        } else {
            return res.status(400).json({ error: 'Ação inválida. Use accept ou decline.' });
        }
    } catch (err) {
        console.error('Erro ao responder solicitação:', err);
        return res.status(500).json({ error: 'Erro ao processar solicitação.' });
    }
});

// 5. Remover amigo ou cancelar solicitação enviada
router.delete('/:id', authMiddleware, (req, res) => {
    try {
        const friendId = parseInt(req.params.id);
        const myId = req.user.id;

        const result = db.run(`
            DELETE FROM friends 
            WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)
        `, [myId, friendId, friendId, myId]);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Amizade não encontrada.' });
        }

        return res.json({ message: 'Amizade desfeita com sucesso.' });
    } catch (err) {
        console.error('Erro ao remover amigo:', err);
        return res.status(500).json({ error: 'Erro ao remover amigo.' });
    }
});

module.exports = router;
