const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');
const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');

// 1. Login Administrativo
router.post('/login', (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
        }

        const trimmed = email.trim().toLowerCase();
        const user = db.queryOne(`
            SELECT id, username, email, password, display_name, role, is_banned, ban_reason
            FROM users 
            WHERE email = ? OR username = ?
        `, [trimmed, trimmed]);

        if (!user) {
            return res.status(401).json({ error: 'Credenciais inválidas.' });
        }

        if (!['ceo', 'admin'].includes(user.role)) {
            return res.status(403).json({ error: 'Acesso restrito. Esta conta não possui privilégios de CEO ou Administrador.' });
        }

        if (user.is_banned) {
            return res.status(403).json({ error: 'Esta conta está suspensa.' });
        }

        const isMatch = bcrypt.compareSync(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ error: 'Credenciais inválidas.' });
        }

        const token = jwt.sign({ userId: user.id, role: user.role }, config.JWT_SECRET, { expiresIn: '7d' });

        // Registrar auditoria
        try {
            db.run(`
                INSERT INTO audit_logs (admin_id, action, target_type, details)
                VALUES (?, 'ADMIN_LOGIN', 'AUTH', 'Login no Painel de Gestão')
            `, [user.id]);
        } catch (e) {}

        delete user.password;
        return res.json({
            message: 'Acesso administrativo autorizado com sucesso!',
            token,
            admin: user
        });
    } catch (err) {
        console.error('Erro no login administrativo:', err);
        return res.status(500).json({ error: 'Erro interno ao realizar login.' });
    }
});

// 2. Verificar sessão do admin
router.get('/me', adminAuthMiddleware, (req, res) => {
    return res.json({ admin: req.admin });
});

module.exports = router;
