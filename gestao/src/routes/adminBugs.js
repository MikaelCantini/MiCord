const express = require('express');
const router = express.Router();
const db = require('../db');
const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');

// 1. Listar todos os bugs reportados
router.get('/', adminAuthMiddleware, (req, res) => {
    try {
        const bugs = db.queryAll(`
            SELECT b.id, b.title, b.description, b.status, b.created_at,
                   u.username, u.display_name, u.email
            FROM bug_reports b
            LEFT JOIN users u ON u.id = b.user_id
            ORDER BY CASE b.status WHEN 'open' THEN 1 ELSE 2 END, b.created_at DESC
        `);
        return res.json(bugs);
    } catch (err) {
        console.error('Erro ao listar bugs:', err);
        return res.status(500).json({ error: 'Erro ao listar bugs reportados.' });
    }
});

// 2. Alternar status do bug (open <-> resolved)
router.put('/:id/status', adminAuthMiddleware, (req, res) => {
    try {
        const bugId = parseInt(req.params.id);
        const bug = db.queryOne('SELECT id, title, status FROM bug_reports WHERE id = ?', [bugId]);
        if (!bug) {
            return res.status(404).json({ error: 'Relatório de bug não encontrado.' });
        }

        const nextStatus = bug.status === 'resolved' ? 'open' : 'resolved';
        db.run('UPDATE bug_reports SET status = ? WHERE id = ?', [nextStatus, bugId]);

        db.run(`
            INSERT INTO audit_logs (admin_id, action, target_type, target_id, details)
            VALUES (?, 'BUG_STATUS_UPDATED', 'BUG', ?, ?)
        `, [req.admin.id, bugId.toString(), `Bug #${bugId} (${bug.title}) marcado como ${nextStatus}.`]);

        return res.json({
            message: nextStatus === 'resolved' ? 'Bug marcado como resolvido!' : 'Bug reaberto!',
            status: nextStatus
        });
    } catch (err) {
        console.error('Erro ao atualizar status do bug:', err);
        return res.status(500).json({ error: 'Erro ao atualizar status do bug.' });
    }
});

// 3. Excluir relatório de bug
router.delete('/:id', adminAuthMiddleware, (req, res) => {
    try {
        const bugId = parseInt(req.params.id);
        const bug = db.queryOne('SELECT id, title FROM bug_reports WHERE id = ?', [bugId]);
        if (!bug) {
            return res.status(404).json({ error: 'Relatório de bug não encontrado.' });
        }

        db.run('DELETE FROM bug_reports WHERE id = ?', [bugId]);
        return res.json({ message: 'Relatório de bug excluído.' });
    } catch (err) {
        console.error('Erro ao excluir bug:', err);
        return res.status(500).json({ error: 'Erro ao excluir bug.' });
    }
});

module.exports = router;
