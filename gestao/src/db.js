const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.resolve(__dirname, '..', 'database', 'app.db');
const db = new DatabaseSync(dbPath);

// Otimizações SQLite para múltiplos processos simultâneos
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
