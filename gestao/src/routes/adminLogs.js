const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db');
const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');

// 1. Listar logs de auditoria
router.get('/', adminAuthMiddleware, (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const logs = db.queryAll(`
            SELECT a.id, a.action, a.target_type, a.target_id, a.details, a.ip_address, a.created_at,
                   u.username AS admin_username, u.display_name AS admin_display_name
            FROM audit_logs a
            LEFT JOIN users u ON u.id = a.admin_id
            ORDER BY a.created_at DESC
            LIMIT ?
        `, [limit]);

        return res.json(logs);
    } catch (err) {
        console.error('Erro ao listar logs:', err);
        return res.status(500).json({ error: 'Erro ao buscar logs de auditoria.' });
    }
});

// 2. Criar backup do banco de dados SQLite
router.post('/backup', adminAuthMiddleware, (req, res) => {
    try {
        const backupDir = path.join(path.dirname(config.DB_PATH), 'backups');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFileName = `backup-app-${timestamp}.db`;
        const backupPath = path.join(backupDir, backupFileName);

        // Executa vacuum e cópia segura
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        fs.copyFileSync(config.DB_PATH, backupPath);

        db.run(`
            INSERT INTO audit_logs (admin_id, action, target_type, details)
            VALUES (?, 'DB_BACKUP', 'DATABASE', ?)
        `, [req.admin.id, `Backup criado em: ${backupFileName}`]);

        return res.json({
            message: 'Backup do banco de dados realizado com sucesso!',
            filename: backupFileName,
            path: backupPath
        });
    } catch (err) {
        console.error('Erro ao realizar backup do banco:', err);
        return res.status(500).json({ error: 'Erro ao criar backup do banco de dados.' });
    }
});

// 3. Otimizar banco (VACUUM)
router.post('/vacuum', adminAuthMiddleware, (req, res) => {
    try {
        db.exec('VACUUM;');
        db.run(`
            INSERT INTO audit_logs (admin_id, action, target_type, details)
            VALUES (?, 'DB_VACUUM', 'DATABASE', 'Otimização VACUUM executada com sucesso.')
        `, [req.admin.id]);

        return res.json({ message: 'Banco de dados otimizado com sucesso!' });
    } catch (err) {
        console.error('Erro no vacuum:', err);
        return res.status(500).json({ error: 'Erro ao otimizar o banco de dados.' });
    }
});

module.exports = router;
