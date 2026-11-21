const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

const dbPath = process.env.DB_PATH || path.resolve(__dirname, 'app.db');
const schemaPath = path.resolve(__dirname, 'schema.sql');

function initDatabase() {
    console.log(`[DB] Inicializando banco de dados em: ${dbPath}`);
    
    // Garante que o diretório exista
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }

    const db = new DatabaseSync(dbPath);
    
    // Habilita WAL mode e chaves estrangeiras
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');

    // Executa schema SQL
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    db.exec(schemaSql);

    // Verifica se já existe um usuário Administrador
    const checkAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
    if (!checkAdmin) {
        console.log('[DB] Criando conta de Administrador padrão...');
        const hashedPassword = bcrypt.hashSync('admin123', 10);
        const insertAdmin = db.prepare(`
            INSERT INTO users (username, email, password, display_name, role, status, bio, avatar_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        insertAdmin.run(
            'admin',
            'admin@micord.local',
            hashedPassword,
            'Administrador do Sistema',
            'admin',
            'online',
            'Administrador geral do sistema MiCord.',
            '/assets/default-avatar-admin.png'
        );

        // Cria também um usuário demo para testes imediatos com amigos
        const hashedUserPass = bcrypt.hashSync('amigo123', 10);
        insertAdmin.run(
            'amigo_demo',
            'amigo@micord.local',
            hashedUserPass,
            'Amigo Demo',
            'user',
            'online',
            'Conta de teste para conversar em grupo e testar chamada.',
            '/assets/default-avatar.png'
        );

        // Obter os IDs criados
        const adminUser = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
        const demoUser = db.prepare("SELECT id FROM users WHERE username = 'amigo_demo'").get();

        // Criar amizade aceita entre admin e amigo_demo
        const insertFriend = db.prepare(`
            INSERT INTO friends (user_id, friend_id, status)
            VALUES (?, ?, 'accepted')
        `);
        insertFriend.run(adminUser.id, demoUser.id);
        insertFriend.run(demoUser.id, adminUser.id);

        // Registrar log de auditoria
        const insertLog = db.prepare(`
            INSERT INTO audit_logs (admin_id, action, target_type, details)
            VALUES (?, ?, ?, ?)
        `);
        insertLog.run(adminUser.id, 'INIT_DATABASE', 'SYSTEM', 'Banco de dados inicializado com sucesso.');
        console.log('[DB] Dados iniciais criados com sucesso!');
    }

    ensureCeoAccount(db);
    removeDefaultGeneralGroup(db);
    ensureBugReportsTable(db);

    db.close();
    console.log('[DB] Banco de dados pronto para uso.');
}

function ensureCeoAccount(db) {
    try {
        const ceoEmail = 'mkl@ceo.com';
        const existingCeo = db.prepare('SELECT id, role, is_banned FROM users WHERE LOWER(email) = ?').get(ceoEmail);

        let ceoId;
        if (!existingCeo) {
            const hashedPassword = bcrypt.hashSync('mklceo159', 10);
            const result = db.prepare(`
                INSERT INTO users (username, email, password, display_name, role, status, bio, avatar_url)
                VALUES (?, ?, ?, ?, 'ceo', 'online', ?, ?)
            `).run(
                'mkl_ceo',
                ceoEmail,
                hashedPassword,
                'MKL CEO',
                'CEO e Administrador Máximo do MiCord.',
                '/assets/default-avatar-admin.png'
            );
            ceoId = result.lastInsertRowid;
            console.log('[DB] Conta CEO (mkl@ceo.com) criada com sucesso!');
        } else {
            ceoId = existingCeo.id;
            if (existingCeo.role !== 'ceo' || existingCeo.is_banned) {
                db.prepare("UPDATE users SET role = 'ceo', is_banned = 0 WHERE id = ?").run(ceoId);
            }
        }
    } catch (err) {
        console.error('[DB] Erro ao garantir conta CEO:', err);
    }
}

function removeDefaultGeneralGroup(db) {
    try {
        const res = db.prepare("DELETE FROM servers WHERE invite_code = 'GERAL2026'").run();
        if (res.changes > 0) {
            console.log('[DB] Grupo Geral padrão (GERAL2026) excluído com sucesso.');
        }
    } catch (err) {
        console.error('[DB] Erro ao remover Grupo Geral padrão:', err);
    }
}

function ensureBugReportsTable(db) {
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS bug_reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                status TEXT DEFAULT 'open',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
            );
        `);
    } catch (err) {
        console.error('[DB] Erro ao garantir tabela bug_reports:', err);
    }
}

if (require.main === module) {
    initDatabase();
}

module.exports = { initDatabase, ensureCeoAccount, removeDefaultGeneralGroup, ensureBugReportsTable, dbPath };
