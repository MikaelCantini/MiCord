const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../middleware/authMiddleware');

// Buscar usuários por termo (username, display_name ou email)
router.get('/search', authMiddleware, (req, res) => {
    try {
        const query = (req.query.q || '').trim();
        if (!query || query.length < 2) {
            return res.json([]);
        }

        const searchTerm = `%${query}%`;
        const users = db.queryAll(`
            SELECT id, username, email, display_name, avatar_url, status, custom_status, bio
            FROM users
            WHERE (username LIKE ? OR display_name LIKE ? OR email LIKE ?)
              AND id != ?
              AND is_banned = 0
            LIMIT 20
        `, [searchTerm, searchTerm, searchTerm, req.user.id]);

        return res.json(users);
    } catch (err) {
        console.error('Erro ao buscar usuários:', err);
        return res.status(500).json({ error: 'Erro ao buscar usuários.' });
    }
});

// Obter perfil detalhado de um usuário
router.get('/:id', authMiddleware, (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const user = db.queryOne(`
            SELECT id, username, display_name, avatar_url, bio, status, custom_status, role, created_at
            FROM users WHERE id = ? AND is_banned = 0
        `, [userId]);

        if (!user) {
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }

        return res.json(user);
    } catch (err) {
        console.error('Erro ao obter usuário:', err);
        return res.status(500).json({ error: 'Erro ao obter usuário.' });
    }
});

module.exports = router;
