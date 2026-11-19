// Inicia ambos os servidores: Chat App (3000) e Gestão (3001)
const { fork } = require('child_process');
const path = require('path');

console.log('================================================================');
console.log('🌸 INICIANDO AMBIENTE COMPLETO CSGONADES 🌸');
console.log('================================================================');

// 1. Inicia o Painel de Gestão (Banco de Dados e Administração)
const gestaoPath = path.resolve(__dirname, 'gestao', 'server.js');
const gestaoProcess = fork(gestaoPath, [], { stdio: 'inherit' });

// 2. Inicia o Chat App (Interface do Usuário, Voz, Vídeo, Grupos)
const appPath = path.resolve(__dirname, 'app', 'server.js');
const appProcess = fork(appPath, [], { stdio: 'inherit' });

function shutdown() {
    console.log('\n[CSGONADES] Encerrando servidores...');
    gestaoProcess.kill();
    appProcess.kill();
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
