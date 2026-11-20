// Gerenciador de Autenticação e Sessão
const AuthManager = {
    user: null,
    token: null,
    pendingAvatarUrl: null,

    init() {
        this.token = localStorage.getItem('micord_token');
        this.bindEvents();
    },

    bindEvents() {
        // Alternância de abas de login / cadastro
        const tabLogin = document.getElementById('tab-login-btn');
        const tabRegister = document.getElementById('tab-register-btn');
        const formLogin = document.getElementById('login-form');
        const formRegister = document.getElementById('register-form');
        const authTitle = document.getElementById('auth-title');
        const authSubtitle = document.getElementById('auth-subtitle');

        tabLogin?.addEventListener('click', () => {
            tabLogin.classList.add('active');
            tabRegister.classList.remove('active');
            formLogin.style.display = 'flex';
            formRegister.style.display = 'none';
            authTitle.textContent = 'Bem-vindo de volta!';
            authSubtitle.textContent = 'Estamos muito animados em ver você de novo!';
            this.clearAlert();
        });

        tabRegister?.addEventListener('click', () => {
            tabRegister.classList.add('active');
            tabLogin.classList.remove('active');
            formRegister.style.display = 'flex';
            formLogin.style.display = 'none';
            authTitle.textContent = 'Criar uma conta';
            authSubtitle.textContent = 'Junte-se aos seus amigos agora mesmo!';
            this.clearAlert();
        });

        // Submit do Login
        formLogin?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('login-email').value;
            const password = document.getElementById('login-password').value;
            await this.login(email, password);
        });

        // Submit do Cadastro
        formRegister?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('reg-username').value;
            const display_name = document.getElementById('reg-display-name').value;
            const email = document.getElementById('reg-email').value;
            const password = document.getElementById('reg-password').value;
            await this.register(username, display_name, email, password);
        });

        // Modal de Perfil e Logout
        document.getElementById('btn-open-settings')?.addEventListener('click', () => this.openProfileModal());
        document.getElementById('btn-open-profile')?.addEventListener('click', () => this.openProfileModal());
        document.getElementById('btn-logout')?.addEventListener('click', () => this.logout());

        document.getElementById('form-edit-profile')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.saveProfile();
        });

        // Upload de imagem de perfil (avatar)
        const avatarInput = document.getElementById('profile-avatar-input');
        document.getElementById('btn-change-avatar')?.addEventListener('click', () => avatarInput?.click());
        avatarInput?.addEventListener('change', (e) => this.handleAvatarUpload(e));
    },

    // Verifica se já está logado ao entrar no app
    async checkSession() {
        if (!this.token) {
            this.showAuthScreen();
            return false;
        }

        try {
            const res = await fetch('/api/auth/me', {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });

            if (!res.ok) {
                this.logoutSilently();
                return false;
            }

            const data = await res.json();
            this.user = data.user;
            this.showMainScreen();
            return true;
        } catch (err) {
            console.error('Erro ao verificar sessão:', err);
            this.showAuthScreen();
            return false;
        }
    },

    async login(email, password) {
        try {
            this.clearAlert();
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });

            const data = await res.json();
            if (!res.ok) {
                this.showAlert(data.error || 'Falha ao autenticar.');
                return;
            }

            this.token = data.token;
            this.user = data.user;
            localStorage.setItem('micord_token', this.token);

            this.showMainScreen();
            if (window.App) window.App.onAuthenticated(this.user, this.token);
        } catch (err) {
            this.showAlert('Erro de conexão com o servidor.');
        }
    },

    async register(username, display_name, email, password) {
        try {
            this.clearAlert();
            const res = await fetch('/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, display_name, email, password })
            });

            const data = await res.json();
            if (!res.ok) {
                this.showAlert(data.error || 'Falha ao realizar cadastro.');
                return;
            }

            this.token = data.token;
            this.user = data.user;
            localStorage.setItem('micord_token', this.token);

            this.showMainScreen();
            if (window.App) window.App.onAuthenticated(this.user, this.token);
        } catch (err) {
            this.showAlert('Erro ao conectar ao servidor de cadastro.');
        }
    },

    showAuthScreen() {
        document.getElementById('auth-screen').style.display = 'flex';
        document.getElementById('main-screen').style.display = 'none';
    },

    showMainScreen() {
        document.getElementById('auth-screen').style.display = 'none';
        document.getElementById('main-screen').style.display = 'flex';
        this.updateUserTray();
    },

    updateUserTray() {
        if (!this.user) return;
        document.getElementById('my-display-name').textContent = this.user.display_name || this.user.username;
        document.getElementById('my-username').textContent = `@${this.user.username}`;
        
        const avatarEl = document.getElementById('my-avatar');
        if (avatarEl) {
            avatarEl.src = this.user.avatar_url || '/assets/default-avatar.png';
        }

        const indicator = document.getElementById('my-status-indicator');
        if (indicator) {
            indicator.className = `status-indicator ${this.user.status || 'online'}`;
        }
    },

    openProfileModal() {
        if (!this.user) return;
        this.pendingAvatarUrl = null;
        const preview = document.getElementById('profile-avatar-preview');
        if (preview) preview.src = this.user.avatar_url || '/assets/default-avatar.png';
        const avatarInput = document.getElementById('profile-avatar-input');
        if (avatarInput) avatarInput.value = '';
        document.getElementById('profile-display-name').value = this.user.display_name || '';
        document.getElementById('profile-bio').value = this.user.bio || '';
        document.getElementById('profile-status-select').value = this.user.status || 'online';
        document.getElementById('modal-profile').style.display = 'flex';
    },

    async handleAvatarUpload(e) {
        const file = e.target.files?.[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            if (window.App) window.App.showToast('Selecione um arquivo de imagem válido.');
            return;
        }

        const formData = new FormData();
        formData.append('file', file);

        try {
            if (window.App) window.App.showToast('Enviando imagem de perfil...');
            const res = await fetch('/api/upload', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${this.token}` },
                body: formData
            });

            const data = await res.json();
            if (res.ok && data.url) {
                this.pendingAvatarUrl = data.url;
                const preview = document.getElementById('profile-avatar-preview');
                if (preview) preview.src = data.url;
                if (window.App) window.App.showToast('Foto carregada! Clique em "Salvar Alterações".');
            } else {
                alert(data.error || 'Erro ao enviar imagem.');
            }
        } catch (err) {
            alert('Falha ao enviar imagem de perfil.');
        }
    },

    async saveProfile() {
        const display_name = document.getElementById('profile-display-name').value;
        const bio = document.getElementById('profile-bio').value;
        const status = document.getElementById('profile-status-select').value;
        const payload = { display_name, bio, status };
        if (this.pendingAvatarUrl) {
            payload.avatar_url = this.pendingAvatarUrl;
        }

        try {
            const res = await fetch('/api/auth/profile', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            if (res.ok) {
                this.user = data.user;
                this.pendingAvatarUrl = null;
                this.updateUserTray();
                document.getElementById('modal-profile').style.display = 'none';
                if (window.App) window.App.showToast('Perfil atualizado com sucesso!');
            }
        } catch (e) {
            alert('Erro ao atualizar perfil.');
        }
    },

    logout() {
        localStorage.removeItem('micord_token');
        this.token = null;
        this.user = null;
        window.location.reload();
    },

    logoutSilently() {
        localStorage.removeItem('micord_token');
        this.token = null;
        this.user = null;
        this.showAuthScreen();
    },

    showAlert(msg) {
        const el = document.getElementById('auth-alert');
        if (el) {
            el.className = 'alert-box error';
            el.textContent = msg;
            el.style.display = 'block';
        }
    },

    clearAlert() {
        const el = document.getElementById('auth-alert');
        if (el) el.style.display = 'none';
    }
};

window.AuthManager = AuthManager;
