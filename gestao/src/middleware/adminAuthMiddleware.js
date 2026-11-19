const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');

function adminAuthMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    let token = null;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    } else if (req.query && req.query.token) {
        token = req.query.token;
    }

    if (!token) {
        return res.status(401).json({ error: 'Acesso restrito ao Painel de Gestão. Token não fornecido.' });
    }

    try {
        const decoded = jwt.verify(token, config.JWT_SECRET);
        const user = db.queryOne(`
            SELECT id, username, email, display_name, role, is_banned
            FROM users WHERE id = ?
        `, [decoded.userId]);

        if (!user) {
            return res.status(401).json({ error: 'Administrador não encontrado.' });
        }

        if (user.is_banned) {
            return res.status(403).json({ error: 'Esta conta de administrador foi bloqueada.' });
        }

        if (user.role !== 'admin') {
            return res.status(403).json({ error: 'Permissão negada. Apenas administradores têm acesso ao Painel de Gestão.' });
        }

        req.admin = user;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Sessão administrativa expirada ou inválida.' });
    }
}

module.exports = adminAuthMiddleware;
