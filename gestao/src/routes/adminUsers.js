const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');

// 1. Listar usuários com busca e filtros
router.get('/', adminAuthMiddleware, (req, res) => {
    try {
        const search = (req.query.search || '').trim();
        const role = (req.query.role || '').trim();
        const status = (req.query.status || '').trim();
        const banned = req.query.banned;

        let sql = `
            SELECT id, username, email, display_name, avatar_url, role, status, custom_status, is_banned, ban_reason, created_at, last_seen,
                   (SELECT COUNT(*) FROM server_members WHERE user_id = users.id) AS servers_count,
                   (SELECT COUNT(*) FROM messages WHERE sender_id = users.id) AS messages_count
            FROM users
            WHERE 1=1
        `;
        const params = [];

        if (search) {
            sql += ` AND (username LIKE ? OR email LIKE ? OR display_name LIKE ?)`;
            const term = `%${search}%`;
            params.push(term, term, term);
        }

        if (role) {
            sql += ` AND role = ?`;
            params.push(role);
        }

        if (status) {
            sql += ` AND status = ?`;
            params.push(status);
        }

        if (banned !== undefined && banned !== '') {
            sql += ` AND is_banned = ?`;
            params.push(parseInt(banned));
        }

        sql += ` ORDER BY created_at DESC`;

        const users = db.queryAll(sql, params);
        return res.json(users);
    } catch (err) {
        console.error('Erro ao listar usuários no painel:', err);
        return res.status(500).json({ error: 'Erro ao listar usuários.' });
    }
});

// 2. Criar novo usuário pelo painel
router.post('/', adminAuthMiddleware, (req, res) => {
    try {
        const { username, email, password, display_name, role } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({ error: 'Campos username, email e senha são obrigatórios.' });
        }

        const trimmedUser = username.trim().toLowerCase();
        const trimmedEmail = email.trim().toLowerCase();
        const allowedRoles = req.admin.role === 'ceo' ? ['ceo', 'admin', 'moderator', 'user'] : ['admin', 'moderator', 'user'];
        const validRole = allowedRoles.includes(role) ? role : 'user';

        const existing = db.queryOne('SELECT id FROM users WHERE username = ? OR email = ?', [trimmedUser, trimmedEmail]);
        if (existing) {
            return res.status(400).json({ error: 'Nome de usuário ou e-mail já existente.' });
        }

        const hashedPassword = bcrypt.hashSync(password, 10);
        const result = db.run(`
            INSERT INTO users (username, email, password, display_name, role, status)
            VALUES (?, ?, ?, ?, ?, 'offline')
        `, [trimmedUser, trimmedEmail, hashedPassword, display_name ? display_name.trim() : username.trim(), validRole]);

        db.run(`
            INSERT INTO audit_logs (admin_id, action, target_type, target_id, details)
            VALUES (?, 'USER_CREATED', 'USER', ?, ?)
        `, [req.admin.id, result.lastInsertRowid.toString(), `Usuário ${trimmedUser} criado pelo admin.`]);

        const newUser = db.queryOne('SELECT id, username, email, display_name, role, created_at FROM users WHERE id = ?', [result.lastInsertRowid]);
        return res.status(201).json(newUser);
    } catch (err) {
        console.error('Erro ao criar usuário:', err);
        return res.status(500).json({ error: 'Erro ao criar usuário.' });
    }
});

// 3. Atualizar usuário
router.put('/:id', adminAuthMiddleware, (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const { display_name, email, role, password } = req.body;

        const user = db.queryOne('SELECT id, username, role FROM users WHERE id = ?', [userId]);
        if (!user) {
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }

        if (user.role === 'ceo' && req.admin.role !== 'ceo') {
            return res.status(403).json({ error: 'Apenas o CEO tem autorização para editar a conta CEO.' });
        }

        let passwordChanged = false;
        if (password && password.trim()) {
            if (password.trim().length < 4) {
                return res.status(400).json({ error: 'A nova senha deve ter no mínimo 4 caracteres.' });
            }
            const hashedPassword = bcrypt.hashSync(password.trim(), 10);
            db.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId]);
            passwordChanged = true;
        }

        const allowedRoles = req.admin.role === 'ceo' ? ['ceo', 'admin', 'moderator', 'user'] : ['admin', 'moderator', 'user'];
        const validRole = allowedRoles.includes(role) ? role : user.role;

        db.run(`
            UPDATE users
            SET display_name = COALESCE(?, display_name),
                email = COALESCE(?, email),
                role = ?
            WHERE id = ?
        `, [
            display_name ? display_name.trim() : null,
            email ? email.trim().toLowerCase() : null,
            validRole,
            userId
        ]);

        db.run(`
            INSERT INTO audit_logs (admin_id, action, target_type, target_id, details)
            VALUES (?, 'USER_UPDATED', 'USER', ?, ?)
        `, [
            req.admin.id,
            userId.toString(),
            `Dados do usuário ${user.username} atualizados${passwordChanged ? ' (incluindo senha)' : ''}.`
        ]);

        const updated = db.queryOne('SELECT id, username, email, display_name, role, is_banned, status FROM users WHERE id = ?', [userId]);
        return res.json(updated);
    } catch (err) {
        console.error('Erro ao atualizar usuário:', err);
        return res.status(500).json({ error: 'Erro ao atualizar usuário.' });
    }
});

// 3b. Alterar senha de um usuário
router.put('/:id/password', adminAuthMiddleware, (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const { password } = req.body;

        if (!password || !password.trim() || password.trim().length < 4) {
            return res.status(400).json({ error: 'A nova senha deve ter no mínimo 4 caracteres.' });
        }

        const user = db.queryOne('SELECT id, username, role FROM users WHERE id = ?', [userId]);
        if (!user) {
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }

        if (user.role === 'ceo' && req.admin.role !== 'ceo') {
            return res.status(403).json({ error: 'Apenas o CEO pode alterar a senha da conta CEO.' });
        }

        const hashedPassword = bcrypt.hashSync(password.trim(), 10);
        db.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId]);

        db.run(`
            INSERT INTO audit_logs (admin_id, action, target_type, target_id, details)
            VALUES (?, 'PASSWORD_CHANGED', 'USER', ?, ?)
        `, [req.admin.id, userId.toString(), `Senha do usuário ${user.username} alterada pelo administrador.`]);

        return res.json({ message: `Senha do usuário ${user.username} alterada com sucesso!` });
    } catch (err) {
        console.error('Erro ao alterar senha do usuário:', err);
        return res.status(500).json({ error: 'Erro ao alterar senha do usuário.' });
    }
});

// 4. Banir ou desbanir usuário
router.post('/:id/toggle-ban', adminAuthMiddleware, (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const { reason } = req.body;

        if (userId === req.admin.id) {
            return res.status(400).json({ error: 'Você não pode banir a sua própria conta de administrador!' });
        }

        const user = db.queryOne('SELECT id, username, role, is_banned FROM users WHERE id = ?', [userId]);
        if (!user) {
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }

        if (user.role === 'ceo') {
            return res.status(403).json({ error: 'A conta CEO não pode ser banida!' });
        }

        const newBanStatus = user.is_banned ? 0 : 1;
        const banReason = newBanStatus === 1 ? (reason || 'Violação das regras do aplicativo.') : null;

        db.run(`
            UPDATE users
            SET is_banned = ?,
                ban_reason = ?,
                status = CASE WHEN ? = 1 THEN 'offline' ELSE status END
            WHERE id = ?
        `, [newBanStatus, banReason, newBanStatus, userId]);

        const actionText = newBanStatus === 1 ? 'BAN_USER' : 'UNBAN_USER';
        db.run(`
            INSERT INTO audit_logs (admin_id, action, target_type, target_id, details)
            VALUES (?, ?, 'USER', ?, ?)
        `, [req.admin.id, actionText, userId.toString(), `${newBanStatus === 1 ? 'Banido' : 'Desbanido'}. Motivo: ${banReason || 'Nenhum'}`]);

        return res.json({
            message: `Usuário ${user.username} foi ${newBanStatus === 1 ? 'banido' : 'desbanido'} com sucesso!`,
            is_banned: newBanStatus,
            ban_reason: banReason
        });
    } catch (err) {
        console.error('Erro ao alternar ban:', err);
        return res.status(500).json({ error: 'Erro ao processar banimento.' });
    }
});

// 5. Excluir usuário permanentemente
router.delete('/:id', adminAuthMiddleware, (req, res) => {
    try {
        const userId = parseInt(req.params.id);

        if (userId === req.admin.id) {
            return res.status(400).json({ error: 'Você não pode excluir sua própria conta de administrador!' });
        }

        const user = db.queryOne('SELECT id, username, role FROM users WHERE id = ?', [userId]);
        if (!user) {
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }

        if (user.role === 'ceo') {
            return res.status(403).json({ error: 'A conta CEO não pode ser excluída!' });
        }

        db.run('DELETE FROM users WHERE id = ?', [userId]);

        db.run(`
            INSERT INTO audit_logs (admin_id, action, target_type, target_id, details)
            VALUES (?, 'USER_DELETED', 'USER', ?, ?)
        `, [req.admin.id, userId.toString(), `Usuário ${user.username} excluído do banco de dados.`]);

        return res.json({ message: `Usuário ${user.username} excluído com sucesso.` });
    } catch (err) {
        console.error('Erro ao excluir usuário:', err);
        return res.status(500).json({ error: 'Erro ao excluir usuário.' });
    }
});

module.exports = router;
