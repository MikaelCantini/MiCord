const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.resolve(__dirname, '..', '..', 'gestao', 'database', 'app.db');

if (!fs.existsSync(dbPath)) {
    console.log('[App DB] Banco de dados em gestao/database/app.db não encontrado. Inicializando...');
    const { initDatabase } = require('../../gestao/database/initDb');
    initDatabase();
}

const db = new DatabaseSync(dbPath);

// Otimizações SQLite
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA foreign_keys = ON;');

module.exports = {
    db,
    queryOne(sql, params = []) {
        const stmt = db.prepare(sql);
        return stmt.get(...params);
    },
    queryAll(sql, params = []) {
        const stmt = db.prepare(sql);
        return stmt.all(...params);
    },
    run(sql, params = []) {
        const stmt = db.prepare(sql);
        return stmt.run(...params);
    },
    exec(sql) {
        return db.exec(sql);
    }
};
