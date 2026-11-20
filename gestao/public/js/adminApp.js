// ===================================================================
// CONTROLADOR DO PAINEL DE GESTÃO - MiCord
// ===================================================================

const AdminApp = {
    token: null,
    admin: null,
    currentTab: 'overview',
    usersMap: {},

    init() {
        this.token = localStorage.getItem('micord_admin_token');
        this.initTheme();
        this.bindEvents();
        this.checkAuth();
    },

    initTheme() {
        const saved = localStorage.getItem('micord_admin_theme') || 'light';
        this.applyTheme(saved);

        document.getElementById('btn-theme-toggle')?.addEventListener('click', () => {
            const cur = document.documentElement.getAttribute('data-theme') || 'light';
            this.applyTheme(cur === 'dark' ? 'light' : 'dark');
        });
    },

    applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('micord_admin_theme', theme);
        const icon = document.getElementById('btn-theme-toggle');
        if (icon) icon.textContent = theme === 'dark' ? '☀️' : '🌙';
    },

    bindEvents() {
        // Login Submit
        document.getElementById('admin-login-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('admin-email').value;
            const password = document.getElementById('admin-password').value;
            await this.login(email, password);
        });

        // Logout
        document.getElementById('btn-admin-logout')?.addEventListener('click', () => this.logout());

        // Navegação de Abas
        document.querySelectorAll('.admin-nav .nav-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = btn.getAttribute('data-tab');
                this.switchTab(tab);
            });
        });

        // Botão de atualizar dados
        document.getElementById('btn-refresh-stats')?.addEventListener('click', () => {
            this.loadTabData();
            this.showToast('Dados atualizados!');
        });

        // Filtros da tabela de usuários
        document.getElementById('user-search-input')?.addEventListener('input', () => this.loadUsers());
        document.getElementById('user-role-filter')?.addEventListener('change', () => this.loadUsers());
        document.getElementById('user-banned-filter')?.addEventListener('change', () => this.loadUsers());

        // Modal de Usuário
        document.getElementById('btn-open-create-user')?.addEventListener('click', () => this.openUserModal());
        document.getElementById('modal-user-close')?.addEventListener('click', () => {
            document.getElementById('modal-user').style.display = 'none';
        });

        document.getElementById('form-user-edit')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.saveUser();
        });

        // Modal de Alterar Senha
        document.getElementById('modal-password-close')?.addEventListener('click', () => {
            document.getElementById('modal-password').style.display = 'none';
        });

        document.getElementById('form-user-password')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.saveUserPassword();
        });

        // Banco de Dados: Backup e Vacuum
        document.getElementById('btn-db-backup')?.addEventListener('click', async () => {
            await this.runBackup();
        });

        document.getElementById('btn-db-vacuum')?.addEventListener('click', async () => {
            await this.runVacuum();
        });
    },

    async checkAuth() {
        if (!this.token) {
            this.showLogin();
            return;
        }

        try {
            const res = await fetch('/api/admin/auth/me', {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });

            if (!res.ok) {
                this.showLogin();
                return;
            }

            const data = await res.json();
            this.admin = data.admin;
            this.showDashboard();
        } catch (e) {
            this.showLogin();
        }
    },

    async login(email, password) {
        const errorEl = document.getElementById('admin-login-error');
        errorEl.style.display = 'none';

        try {
            const res = await fetch('/api/admin/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });

            const data = await res.json();
            if (!res.ok) {
                errorEl.textContent = data.error || 'Credenciais inválidas.';
                errorEl.style.display = 'block';
                return;
            }

            this.token = data.token;
            this.admin = data.admin;
            localStorage.setItem('micord_admin_token', this.token);
            this.showDashboard();
        } catch (err) {
            errorEl.textContent = 'Erro ao conectar ao servidor de gestão.';
            errorEl.style.display = 'block';
        }
    },

    logout() {
        localStorage.removeItem('micord_admin_token');
        this.token = null;
        this.admin = null;
        this.showLogin();
    },

    showLogin() {
        document.getElementById('admin-login-screen').style.display = 'flex';
        document.getElementById('admin-dashboard-screen').style.display = 'none';
    },

    showDashboard() {
        document.getElementById('admin-login-screen').style.display = 'none';
        document.getElementById('admin-dashboard-screen').style.display = 'flex';

        if (this.admin) {
            document.getElementById('admin-name').textContent = this.admin.display_name || this.admin.username;
        }

        this.switchTab('overview');
    },

    switchTab(tab) {
        this.currentTab = tab;
        document.querySelectorAll('.admin-nav .nav-btn').forEach(b => {
            b.classList.toggle('active', b.getAttribute('data-tab') === tab);
        });

        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        const pane = document.getElementById(`tab-${tab}`);
        if (pane) pane.classList.add('active');

        // Atualiza títulos
        const titles = {
            overview: { title: 'Visão Geral', desc: 'Métricas do sistema e atividades em tempo real' },
            users: { title: 'Controle de Usuários', desc: 'Gerenciamento, papéis, suspensões e permissões' },
            servers: { title: 'Servidores & Grupos', desc: 'Grupos criados, canais e moderação de conteúdo' },
            logs: { title: 'Logs de Auditoria', desc: 'Histórico de ações e eventos do sistema' },
            database: { title: 'Banco de Dados', desc: 'Manutenção, backups e integridade do SQLite' }
        };

        if (titles[tab]) {
            document.getElementById('current-view-title').textContent = titles[tab].title;
            document.getElementById('current-view-desc').textContent = titles[tab].desc;
        }

        this.loadTabData();
    },

    loadTabData() {
        if (this.currentTab === 'overview') this.loadOverview();
        else if (this.currentTab === 'users') this.loadUsers();
        else if (this.currentTab === 'servers') this.loadServers();
        else if (this.currentTab === 'logs') this.loadLogs();
    },

    // 1. Visão Geral
    async loadOverview() {
        try {
            const res = await fetch('/api/admin/stats', {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });

            if (!res.ok) return;
            const data = await res.json();
            const { stats, recentUsers, recentMessages } = data;

            document.getElementById('stat-total-users').textContent = stats.totalUsers;
            document.getElementById('stat-online-users').textContent = stats.onlineUsers;
            document.getElementById('stat-banned-users').textContent = stats.bannedUsers;
            document.getElementById('stat-total-servers').textContent = stats.totalServers;
            document.getElementById('stat-total-messages').textContent = stats.totalMessages;
            document.getElementById('stat-db-size').textContent = `${stats.dbSizeKB} KB`;

            // Tabela de usuários recentes
            const usersTbody = document.getElementById('table-recent-users');
            usersTbody.innerHTML = '';
            recentUsers.forEach(u => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>#${u.id}</td>
                    <td><strong>${u.display_name || u.username}</strong> (@${u.username})</td>
                    <td>${u.email}</td>
                    <td><span class="badge-role ${u.role}">${u.role}</span></td>
                    <td><span class="badge-status ${u.is_banned ? 'banned' : 'active'}">${u.is_banned ? 'Banido' : u.status}</span></td>
                `;
                usersTbody.appendChild(tr);
            });

            // Tabela de mensagens recentes
            const msgsTbody = document.getElementById('table-recent-messages');
            msgsTbody.innerHTML = '';
            recentMessages.forEach(m => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><strong>${m.display_name || m.username}</strong></td>
                    <td>${m.channel_name ? `#${m.channel_name}` : 'DM Direta'}</td>
                    <td>${m.content ? m.content.substring(0, 45) + (m.content.length > 45 ? '...' : '') : '[Anexo/Foto]'}</td>
                    <td>${new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                `;
                msgsTbody.appendChild(tr);
            });
        } catch (e) {
            console.error('Erro ao carregar estatísticas:', e);
        }
    },

    // 2. Usuários
    async loadUsers() {
        const search = document.getElementById('user-search-input').value;
        const role = document.getElementById('user-role-filter').value;
        const banned = document.getElementById('user-banned-filter').value;

        const params = new URLSearchParams();
        if (search) params.append('search', search);
        if (role) params.append('role', role);
        if (banned !== '') params.append('banned', banned);

        try {
            const res = await fetch(`/api/admin/users?${params.toString()}`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });

            if (!res.ok) return;
            const users = await res.json();
            const tbody = document.getElementById('table-users-list');
            tbody.innerHTML = '';
            this.usersMap = {};

            users.forEach(u => {
                this.usersMap[u.id] = u;
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>#${u.id}</td>
                    <td><strong>${u.display_name || u.username}</strong><br><small>@${u.username}</small></td>
                    <td>${u.email}</td>
                    <td><span class="badge-role ${u.role}">${u.role}</span></td>
                    <td><span class="badge-status ${u.is_banned ? 'banned' : 'active'}">${u.is_banned ? 'Banido' : u.status}</span></td>
                    <td>${u.servers_count}</td>
                    <td>${u.messages_count}</td>
                    <td>
                        <button class="btn btn-sm btn-secondary" onclick="AdminApp.editUser(${u.id})">Editar</button>
                        <button class="btn btn-sm btn-secondary" title="Alterar Senha" onclick="AdminApp.openPasswordModal(${u.id})">🔑 Senha</button>
                        <button class="btn btn-sm ${u.is_banned ? 'btn-secondary' : 'btn-danger'}" onclick="AdminApp.toggleBan(${u.id}, ${u.is_banned})">
                            ${u.is_banned ? 'Desbanir' : 'Banir'}
                        </button>
                        <button class="btn btn-sm btn-icon" title="Excluir do Banco" onclick="AdminApp.deleteUser(${u.id}, '${escapeQuotes(u.username)}')">🗑️</button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        } catch (e) {
            console.error('Erro ao carregar usuários:', e);
        }
    },

    openUserModal() {
        document.getElementById('modal-user-title').textContent = 'Novo Usuário';
        document.getElementById('edit-user-id').value = '';
        document.getElementById('grp-username').style.display = 'flex';
        const usernameInput = document.getElementById('edit-username');
        usernameInput.value = '';
        usernameInput.required = true;
        document.getElementById('edit-display-name').value = '';
        document.getElementById('edit-email').value = '';
        const passwordInput = document.getElementById('edit-password');
        passwordInput.value = '';
        passwordInput.required = true;
        document.getElementById('lbl-password').textContent = 'Senha Provisória';
        document.getElementById('edit-role').value = 'user';
        document.getElementById('modal-user').style.display = 'flex';
    },

    editUser(userId) {
        const user = this.usersMap[userId];
        if (!user) return;
        document.getElementById('modal-user-title').textContent = `Editar Usuário #${user.id}`;
        document.getElementById('edit-user-id').value = user.id;
        document.getElementById('grp-username').style.display = 'none'; // username imutável
        const usernameInput = document.getElementById('edit-username');
        usernameInput.value = user.username || '';
        usernameInput.required = false;
        document.getElementById('edit-display-name').value = user.display_name || '';
        document.getElementById('edit-email').value = user.email || '';
        const passwordInput = document.getElementById('edit-password');
        passwordInput.value = '';
        passwordInput.required = false;
        document.getElementById('lbl-password').textContent = 'Nova Senha (deixe vazio se não quiser alterar)';
        document.getElementById('edit-role').value = user.role || 'user';
        document.getElementById('modal-user').style.display = 'flex';
    },

    openPasswordModal(userId) {
        const user = this.usersMap[userId];
        if (!user) return;
        document.getElementById('modal-password-title').textContent = `Alterar Senha — #${user.id}`;
        document.getElementById('pwd-user-id').value = user.id;
        document.getElementById('pwd-user-info').textContent = `Usuário: ${user.display_name || user.username} (@${user.username})`;
        document.getElementById('pwd-new-password').value = '';
        document.getElementById('pwd-confirm-password').value = '';
        const errBox = document.getElementById('pwd-error-box');
        errBox.style.display = 'none';
        errBox.textContent = '';
        document.getElementById('modal-password').style.display = 'flex';
    },

    async saveUserPassword() {
        const id = document.getElementById('pwd-user-id').value;
        const password = document.getElementById('pwd-new-password').value;
        const confirmPassword = document.getElementById('pwd-confirm-password').value;
        const errBox = document.getElementById('pwd-error-box');
        errBox.style.display = 'none';

        if (!password || password.trim().length < 4) {
            errBox.textContent = 'A nova senha deve ter no mínimo 4 caracteres.';
            errBox.style.display = 'block';
            return;
        }

        if (password !== confirmPassword) {
            errBox.textContent = 'As senhas não coincidem.';
            errBox.style.display = 'block';
            return;
        }

        try {
            const res = await fetch(`/api/admin/users/${id}/password`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify({ password })
            });

            const data = await res.json();
            if (res.ok) {
                document.getElementById('modal-password').style.display = 'none';
                this.showToast(data.message || 'Senha alterada com sucesso!');
            } else {
                errBox.textContent = data.error || 'Erro ao alterar senha.';
                errBox.style.display = 'block';
            }
        } catch (e) {
            errBox.textContent = 'Falha na comunicação com o servidor.';
            errBox.style.display = 'block';
        }
    },

    async saveUser() {
        const id = document.getElementById('edit-user-id').value;
        const display_name = document.getElementById('edit-display-name').value;
        const email = document.getElementById('edit-email').value;
        const password = document.getElementById('edit-password').value;
        const role = document.getElementById('edit-role').value;

        try {
            let res;
            if (id) {
                // Atualizar
                res = await fetch(`/api/admin/users/${id}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.token}`
                    },
                    body: JSON.stringify({ display_name, email, password: password || undefined, role })
                });
            } else {
                // Criar
                const username = document.getElementById('edit-username').value;
                res = await fetch('/api/admin/users', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.token}`
                    },
                    body: JSON.stringify({ username, display_name, email, password, role })
                });
            }

            const data = await res.json();
            if (res.ok) {
                document.getElementById('modal-user').style.display = 'none';
                this.loadUsers();
                this.showToast(id ? 'Usuário atualizado com sucesso!' : 'Usuário criado com sucesso!');
            } else {
                alert(data.error || 'Erro ao salvar usuário.');
            }
        } catch (e) {
            alert('Falha na comunicação com o servidor.');
        }
    },

    async toggleBan(userId, currentBanned) {
        const reason = !currentBanned ? prompt('Informe o motivo do banimento:', 'Violação das diretrizes da comunidade.') : null;
        if (!currentBanned && reason === null) return; // cancelou

        try {
            const res = await fetch(`/api/admin/users/${userId}/toggle-ban`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify({ reason })
            });

            const data = await res.json();
            if (res.ok) {
                this.loadUsers();
                this.showToast(data.message);
            } else {
                alert(data.error || 'Erro ao alterar banimento.');
            }
        } catch (e) {
            alert('Falha na requisição.');
        }
    },

    async deleteUser(userId, username) {
        if (!confirm(`Deseja EXCLUIR PERMANENTEMENTE o usuário "${username}" e todas as suas mensagens do banco de dados?`)) return;

        try {
            const res = await fetch(`/api/admin/users/${userId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${this.token}` }
            });

            const data = await res.json();
            if (res.ok) {
                this.loadUsers();
                this.showToast(data.message);
            } else {
                alert(data.error || 'Erro ao excluir usuário.');
            }
        } catch (e) {
            alert('Falha na requisição.');
        }
    },

    // 3. Servidores
    async loadServers() {
        try {
            const res = await fetch('/api/admin/servers', {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });

            if (!res.ok) return;
            const servers = await res.json();
            const tbody = document.getElementById('table-servers-list');
            tbody.innerHTML = '';

            servers.forEach(s => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>#${s.id}</td>
                    <td><strong>${s.name}</strong><br><small>${s.description || 'Sem descrição'}</small></td>
                    <td><code>${s.invite_code}</code></td>
                    <td>${s.owner_display_name || s.owner_username}</td>
                    <td>${s.member_count}</td>
                    <td>${s.channel_count}</td>
                    <td>${new Date(s.created_at).toLocaleDateString()}</td>
                    <td>
                        <button class="btn btn-sm btn-danger" onclick="AdminApp.deleteServer(${s.id}, '${escapeQuotes(s.name)}')">Excluir</button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        } catch (e) {
            console.error('Erro ao carregar servidores:', e);
        }
    },

    async deleteServer(serverId, name) {
        if (!confirm(`Deseja EXCLUIR o servidor "${name}" e todos os seus canais e mensagens?`)) return;

        try {
            const res = await fetch(`/api/admin/servers/${serverId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${this.token}` }
            });

            const data = await res.json();
            if (res.ok) {
                this.loadServers();
                this.showToast(data.message);
            }
        } catch (e) {}
    },

    // 4. Logs
    async loadLogs() {
        try {
            const res = await fetch('/api/admin/logs', {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });

            if (!res.ok) return;
            const logs = await res.json();
            const tbody = document.getElementById('table-logs-list');
            tbody.innerHTML = '';

            logs.forEach(l => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>#${l.id}</td>
                    <td><code>${l.action}</code></td>
                    <td>${l.target_type || '-'} (${l.target_id || '-'})</td>
                    <td>${l.admin_display_name || l.admin_username || 'Sistema'}</td>
                    <td>${l.details || '-'}</td>
                    <td>${new Date(l.created_at).toLocaleString()}</td>
                `;
                tbody.appendChild(tr);
            });
        } catch (e) {
            console.error('Erro ao carregar logs:', e);
        }
    },

    // 5. Banco de Dados
    async runBackup() {
        const feedback = document.getElementById('db-feedback');
        feedback.style.display = 'block';
        feedback.className = 'alert-box';
        feedback.textContent = 'Gerando backup do SQLite...';

        try {
            const res = await fetch('/api/admin/logs/backup', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${this.token}` }
            });

            const data = await res.json();
            if (res.ok) {
                feedback.className = 'alert-box success';
                feedback.textContent = `${data.message} Arquivo: ${data.filename}`;
                this.showToast('Backup gerado com sucesso!');
            } else {
                feedback.className = 'alert-box error';
                feedback.textContent = data.error || 'Erro ao gerar backup.';
            }
        } catch (e) {
            feedback.className = 'alert-box error';
            feedback.textContent = 'Erro ao conectar ao servidor.';
        }
    },

    async runVacuum() {
        const feedback = document.getElementById('db-feedback');
        feedback.style.display = 'block';
        feedback.className = 'alert-box';
        feedback.textContent = 'Executando otimização VACUUM...';

        try {
            const res = await fetch('/api/admin/logs/vacuum', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${this.token}` }
            });

            const data = await res.json();
            if (res.ok) {
                feedback.className = 'alert-box success';
                feedback.textContent = data.message;
                this.showToast('Banco SQLite otimizado!');
            } else {
                feedback.className = 'alert-box error';
                feedback.textContent = data.error || 'Erro na otimização.';
            }
        } catch (e) {
            feedback.className = 'alert-box error';
            feedback.textContent = 'Erro ao conectar ao servidor.';
        }
    },

    showToast(message) {
        const container = document.getElementById('admin-toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = message;
        container.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 3500);
    }
};

function escapeQuotes(str) {
    return (str || '').replace(/'/g, "\\'");
}

window.AdminApp = AdminApp;
document.addEventListener('DOMContentLoaded', () => AdminApp.init());
