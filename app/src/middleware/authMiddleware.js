const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');

function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    let token = null;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    } else if (req.query && req.query.token) {
        token = req.query.token;
    }

    if (!token) {
        return res.status(401).json({ error: 'Token de autenticação não fornecido.' });
    }

    try {
        const decoded = jwt.verify(token, config.JWT_SECRET);
        const user = db.queryOne(`
            SELECT id, username, email, display_name, avatar_url, bio, status, custom_status, role, is_banned, ban_reason
            FROM users WHERE id = ?
        `, [decoded.userId]);

        if (!user) {
            return res.status(401).json({ error: 'Usuário não encontrado.' });
        }

        if (user.is_banned) {
            return res.status(403).json({ 
                error: 'Sua conta foi suspensa pela administração.', 
                reason: user.ban_reason || 'Violação dos termos de uso.' 
            });
        }

        // Atualiza last_seen silenciosamente
        try {
            db.run('UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
        } catch (e) {
            // ignora erro pontual de concorrência
        }

        req.user = user;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Token inválido ou expirado.' });
    }
}

module.exports = authMiddleware;
