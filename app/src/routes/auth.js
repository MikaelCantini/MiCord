const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');
const authMiddleware = require('../middleware/authMiddleware');

// 1. Cadastro de novo usuário
router.post('/register', (req, res) => {
    try {
        const { username, email, password, display_name } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({ error: 'Nome de usuário, e-mail e senha são obrigatórios.' });
        }

        const trimmedUser = username.trim().toLowerCase();
        const trimmedEmail = email.trim().toLowerCase();

        if (trimmedUser.length < 3 || trimmedUser.length > 30) {
            return res.status(400).json({ error: 'O nome de usuário deve ter entre 3 e 30 caracteres.' });
        }

        if (password.length < 4) {
            return res.status(400).json({ error: 'A senha deve ter no mínimo 4 caracteres.' });
        }

        // Verifica duplicidade
        const existing = db.queryOne('SELECT id, username, email FROM users WHERE username = ? OR email = ?', [trimmedUser, trimmedEmail]);
        if (existing) {
            if (existing.email.toLowerCase() === trimmedEmail) {
                return res.status(400).json({ error: 'Este e-mail já está cadastrado.' });
            }
            return res.status(400).json({ error: 'Este nome de usuário já está em uso.' });
        }

        const hashedPassword = bcrypt.hashSync(password, 10);
        const nameToUse = display_name ? display_name.trim() : username.trim();

        const result = db.run(`
            INSERT INTO users (username, email, password, display_name, status, role)
            VALUES (?, ?, ?, ?, 'online', 'user')
        `, [trimmedUser, trimmedEmail, hashedPassword, nameToUse]);

        const newUser = db.queryOne(`
            SELECT id, username, email, display_name, avatar_url, bio, status, role
            FROM users WHERE id = ?
        `, [result.lastInsertRowid]);

        // Auto-adiciona o novo usuário ao servidor 'Comunidade Geral' caso ele exista
        const defaultServer = db.queryOne("SELECT id FROM servers WHERE invite_code = 'GERAL2026' LIMIT 1");
        if (defaultServer) {
            try {
                db.run('INSERT OR IGNORE INTO server_members (server_id, user_id, role) VALUES (?, ?, ?)', [
                    defaultServer.id,
                    newUser.id,
                    'member'
                ]);
            } catch (e) {
                console.error('Falha ao adicionar novo usuário ao servidor geral:', e);
            }
        }

        const token = jwt.sign({ userId: newUser.id }, config.JWT_SECRET, { expiresIn: '30d' });

        return res.status(201).json({
            message: 'Cadastro realizado com sucesso!',
            token,
            user: newUser
        });
    } catch (err) {
        console.error('Erro no cadastro:', err);
        return res.status(500).json({ error: 'Erro interno ao realizar cadastro.' });
    }
});

// 2. Login com e-mail e senha
router.post('/login', (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
        }

        const trimmedEmail = email.trim().toLowerCase();
        // Permite login também caso o usuário tenha digitado o username no campo de e-mail
        const user = db.queryOne(`
            SELECT id, username, email, password, display_name, avatar_url, bio, status, custom_status, role, is_banned, ban_reason
            FROM users 
            WHERE email = ? OR username = ?
        `, [trimmedEmail, trimmedEmail]);

        if (!user) {
            return res.status(401).json({ error: 'Credenciais inválidas. Verifique seu e-mail e senha.' });
        }

        if (user.is_banned) {
            return res.status(403).json({ 
                error: 'Sua conta foi suspensa pela administração.', 
                reason: user.ban_reason || 'Violação dos termos de uso.' 
            });
        }

        const isMatch = bcrypt.compareSync(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ error: 'Credenciais inválidas. Verifique seu e-mail e senha.' });
        }

        // Atualiza status para online e last_seen
        db.run("UPDATE users SET status = 'online', last_seen = CURRENT_TIMESTAMP WHERE id = ?", [user.id]);

        const token = jwt.sign({ userId: user.id }, config.JWT_SECRET, { expiresIn: '30d' });

        // Remove a senha do objeto de retorno
        delete user.password;

        return res.json({
            message: 'Login realizado com sucesso!',
            token,
            user
        });
    } catch (err) {
        console.error('Erro no login:', err);
        return res.status(500).json({ error: 'Erro interno ao realizar login.' });
    }
});

// 3. Verificação de sessão (Ao entrar no app)
router.get('/me', authMiddleware, (req, res) => {
    return res.json({ user: req.user });
});

// 4. Atualizar perfil do usuário conectado
router.put('/profile', authMiddleware, (req, res) => {
    try {
        const { display_name, bio, status, custom_status, avatar_url } = req.body;
        const userId = req.user.id;

        const allowedStatuses = ['online', 'idle', 'dnd', 'offline'];
        const validStatus = allowedStatuses.includes(status) ? status : req.user.status;

        db.run(`
            UPDATE users
            SET display_name = COALESCE(?, display_name),
                bio = COALESCE(?, bio),
                status = ?,
                custom_status = COALESCE(?, custom_status),
                avatar_url = COALESCE(?, avatar_url)
            WHERE id = ?
        `, [
            display_name !== undefined ? display_name.trim() : null,
            bio !== undefined ? bio.trim() : null,
            validStatus,
            custom_status !== undefined ? custom_status.trim() : null,
            avatar_url !== undefined ? avatar_url : null,
            userId
        ]);

        const updatedUser = db.queryOne(`
            SELECT id, username, email, display_name, avatar_url, bio, status, custom_status, role
            FROM users WHERE id = ?
        `, [userId]);

        return res.json({ user: updatedUser });
    } catch (err) {
        console.error('Erro ao atualizar perfil:', err);
        return res.status(500).json({ error: 'Erro interno ao atualizar perfil.' });
    }
});

module.exports = router;
