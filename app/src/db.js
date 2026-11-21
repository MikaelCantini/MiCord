const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const { initDatabase, ensureCeoAccount, removeDefaultGeneralGroup, ensureBugReportsTable } = require('../../gestao/database/initDb');

const dbPath = config.DB_PATH;

if (!fs.existsSync(dbPath)) {
    console.log(`[App DB] Banco de dados em ${dbPath} não encontrado. Inicializando...`);
    initDatabase();
}

const db = new DatabaseSync(dbPath);

// Otimizações SQLite
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA foreign_keys = ON;');

// Garante que a conta CEO e a tabela de bugs existam e remove o Grupo Geral padrão
ensureCeoAccount(db);
removeDefaultGeneralGroup(db);
ensureBugReportsTable(db);

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
