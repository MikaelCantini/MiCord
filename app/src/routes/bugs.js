const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../middleware/authMiddleware');

// Reportar um bug pelo aplicativo
router.post('/', authMiddleware, (req, res) => {
    try {
        const { title, description } = req.body;

        if (!title || !title.trim() || !description || !description.trim()) {
            return res.status(400).json({ error: 'Informe um título e a descrição do bug.' });
        }

        const cleanTitle = title.trim().substring(0, 120);
        const cleanDesc = description.trim().substring(0, 2000);

        const result = db.run(`
            INSERT INTO bug_reports (user_id, title, description, status)
            VALUES (?, ?, ?, 'open')
        `, [req.user.id, cleanTitle, cleanDesc]);

        try {
            db.run(`
                INSERT INTO audit_logs (admin_id, action, target_type, target_id, details)
                VALUES (?, 'BUG_REPORTED', 'BUG', ?, ?)
            `, [req.user.id, result.lastInsertRowid.toString(), `Bug reportado por @${req.user.username}: ${cleanTitle}`]);
        } catch (e) {}

        return res.status(201).json({
            id: result.lastInsertRowid,
            message: 'Bug reportado com sucesso! Obrigado pelo aviso.'
        });
    } catch (err) {
        console.error('Erro ao registrar bug:', err);
        return res.status(500).json({ error: 'Erro interno ao enviar relatório de bug.' });
    }
});

module.exports = router;
