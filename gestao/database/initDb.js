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

        // Criar Servidor Padrão
        const insertServer = db.prepare(`
            INSERT INTO servers (name, description, owner_id, invite_code)
            VALUES (?, ?, ?, ?)
        `);
        insertServer.run(
            'Comunidade Geral',
            'Servidor principal para bater papo, jogar e compartilhar telas!',
            adminUser.id,
            'GERAL2026'
        );

        const defaultServer = db.prepare("SELECT id FROM servers WHERE invite_code = 'GERAL2026'").get();

        // Adicionar admin e demo ao servidor
        const insertMember = db.prepare(`
            INSERT INTO server_members (server_id, user_id, role)
            VALUES (?, ?, ?)
        `);
        insertMember.run(defaultServer.id, adminUser.id, 'owner');
        insertMember.run(defaultServer.id, demoUser.id, 'member');

        // Criar canais padrão de texto e voz/vídeo
        const insertChannel = db.prepare(`
            INSERT INTO channels (server_id, name, type, topic, position)
            VALUES (?, ?, ?, ?, ?)
        `);
        insertChannel.run(defaultServer.id, 'geral', 'text', 'Bate-papo geral da galera', 1);
        insertChannel.run(defaultServer.id, 'fotos-e-memes', 'text', 'Envio de imagens, prints e memes', 2);
        insertChannel.run(defaultServer.id, 'Bate-papo Voz', 'voice', 'Sala de voz livre', 3);
        insertChannel.run(defaultServer.id, 'Jogos & Transmissão', 'voice', 'Sala para jogar e compartilhar tela', 4);

        // Criar mensagem inicial de boas-vindas
        const textChannel = db.prepare("SELECT id FROM channels WHERE server_id = ? AND name = 'geral'").get(defaultServer.id);
        if (textChannel) {
            const insertMsg = db.prepare(`
                INSERT INTO messages (channel_id, sender_id, content)
                VALUES (?, ?, ?)
            `);
            insertMsg.run(
                textChannel.id,
                adminUser.id,
                'Bem-vindo ao nosso aplicativo de conversa e grupos! Sinta-se à vontade para convidar amigos, mandar mensagens, fotos, abrir webcam e compartilhar sua tela! 🚀✨'
            );
        }

        // Registrar log de auditoria
        const insertLog = db.prepare(`
            INSERT INTO audit_logs (admin_id, action, target_type, details)
            VALUES (?, ?, ?, ?)
        `);
        insertLog.run(adminUser.id, 'INIT_DATABASE', 'SYSTEM', 'Banco de dados inicializado com sucesso.');
        console.log('[DB] Dados iniciais (admin, amigo demo, servidor e canais) criados com sucesso!');
    }

    ensureCeoAccount(db);
    ensureDefaultGeneralGroup(db);
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

        // Garante que o CEO também esteja no servidor padrão se existir
        const defaultServer = db.prepare("SELECT id FROM servers WHERE invite_code = 'GERAL2026'").get();
        if (defaultServer && ceoId) {
            const isMember = db.prepare('SELECT id FROM server_members WHERE server_id = ? AND user_id = ?').get(defaultServer.id, ceoId);
            if (!isMember) {
                db.prepare("INSERT INTO server_members (server_id, user_id, role) VALUES (?, ?, 'owner')").run(defaultServer.id, ceoId);
            }
        }
    } catch (err) {
        console.error('[DB] Erro ao garantir conta CEO:', err);
    }
}

function ensureDefaultGeneralGroup(db) {
    try {
        let generalServer = db.prepare("SELECT id, name FROM servers WHERE invite_code = 'GERAL2026' LIMIT 1").get();

        // Define o proprietário (prioriza CEO, senão primeiro admin, senão primeiro usuário)
        const owner = db.prepare("SELECT id FROM users WHERE role = 'ceo' LIMIT 1").get()
            || db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get()
            || db.prepare("SELECT id FROM users ORDER BY id ASC LIMIT 1").get();

        if (!owner) return;

        if (!generalServer) {
            const created = db.prepare(`
                INSERT INTO servers (name, description, owner_id, invite_code)
                VALUES (?, ?, ?, 'GERAL2026')
            `).run(
                'Grupo Geral',
                'Grupo geral oficial do MiCord onde todo mundo pode entrar, conversar e entrar em call!',
                owner.id
            );
            generalServer = { id: created.lastInsertRowid };

            // Cria canais padrão de texto e voz
            const insertChannel = db.prepare(`
                INSERT INTO channels (server_id, name, type, topic, position)
                VALUES (?, ?, ?, ?, ?)
            `);
            insertChannel.run(generalServer.id, 'geral', 'text', 'Bate-papo geral da galera', 1);
            insertChannel.run(generalServer.id, 'fotos-e-memes', 'text', 'Envio de imagens, prints e memes', 2);
            insertChannel.run(generalServer.id, 'Bate-papo Voz', 'voice', 'Sala de voz livre', 3);
            insertChannel.run(generalServer.id, 'Jogos & Transmissão', 'voice', 'Sala para jogar e compartilhar tela', 4);

            const textChannel = db.prepare("SELECT id FROM channels WHERE server_id = ? AND name = 'geral'").get(generalServer.id);
            if (textChannel) {
                db.prepare('INSERT INTO messages (channel_id, sender_id, content) VALUES (?, ?, ?)').run(
                    textChannel.id,
                    owner.id,
                    'Bem-vindo ao Grupo Geral do MiCord! Todos os usuários já começam aqui — fiquem à vontade para conversar e entrar nas salas de voz! 🚀✨'
                );
            }
            console.log('[DB] Grupo Geral (GERAL2026) criado com sucesso!');
        }

        // Garante que todos os usuários ativos estejam no Grupo Geral
        const allUsers = db.prepare('SELECT id, role FROM users WHERE is_banned = 0').all();
        const insertMember = db.prepare('INSERT OR IGNORE INTO server_members (server_id, user_id, role) VALUES (?, ?, ?)');
        for (const u of allUsers) {
            const memberRole = u.role === 'ceo' ? 'owner' : (u.role === 'admin' ? 'admin' : 'member');
            insertMember.run(generalServer.id, u.id, memberRole);
        }
    } catch (err) {
        console.error('[DB] Erro ao garantir Grupo Geral:', err);
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

module.exports = { initDatabase, ensureCeoAccount, ensureDefaultGeneralGroup, ensureBugReportsTable, dbPath };
