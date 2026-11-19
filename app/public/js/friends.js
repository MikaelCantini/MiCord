// ===================================================================
// GERENCIADOR DE AMIGOS E CONVITES (FRIENDS HUB)
// ===================================================================

const FriendsManager = {
    friends: [],
    requests: { incoming: [], outgoing: [] },
    currentTab: 'online',

    init() {
        this.bindEvents();
    },

    bindEvents() {
        // Alternância de abas de amigos
        const tabs = ['online', 'all', 'pending', 'add'];
        tabs.forEach(tab => {
            const btn = document.getElementById(`tab-nav-${tab}`);
            btn?.addEventListener('click', () => this.switchTab(tab));
        });

        // Formulário de adicionar amigo
        const addForm = document.getElementById('add-friend-form');
        addForm?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const target = document.getElementById('add-friend-input').value;
            await this.sendRequest(target);
        });

        // Campo de busca rápida de amigos
        const searchInput = document.getElementById('filter-friends-input');
        searchInput?.addEventListener('input', (e) => {
            this.filterFriends(e.target.value);
        });
    },

    async loadFriendsData() {
        const token = window.AuthManager ? window.AuthManager.token : null;
        if (!token) return;

        try {
            const [friendsRes, requestsRes] = await Promise.all([
                fetch('/api/friends', { headers: { 'Authorization': `Bearer ${token}` } }),
                fetch('/api/friends/requests', { headers: { 'Authorization': `Bearer ${token}` } })
            ]);

            if (friendsRes.ok) this.friends = await friendsRes.json();
            if (requestsRes.ok) this.requests = await requestsRes.json();

            this.updatePendingBadge();
            this.renderTabContent();
            this.renderDMList();
        } catch (err) {
            console.error('Erro ao carregar dados de amigos:', err);
        }
    },

    switchTab(tab) {
        this.currentTab = tab;
        ['online', 'all', 'pending', 'add'].forEach(t => {
            const btn = document.getElementById(`tab-nav-${t}`);
            if (btn) btn.classList.toggle('active', t === tab);
        });

        const hubSearch = document.querySelector('.hub-search-bar');
        const tabContent = document.getElementById('friends-tab-content');
        const addPanel = document.getElementById('add-friend-panel');

        if (tab === 'add') {
            if (hubSearch) hubSearch.style.display = 'none';
            if (tabContent) tabContent.style.display = 'none';
            if (addPanel) addPanel.style.display = 'block';
        } else {
            if (hubSearch) hubSearch.style.display = 'block';
            if (tabContent) tabContent.style.display = 'flex';
            if (addPanel) addPanel.style.display = 'none';
            this.renderTabContent();
        }
    },

    renderTabContent() {
        const container = document.getElementById('friends-tab-content');
        if (!container) return;
        container.innerHTML = '';

        let listToShow = [];
        if (this.currentTab === 'online') {
            listToShow = this.friends.filter(f => f.status !== 'offline');
        } else if (this.currentTab === 'all') {
            listToShow = this.friends;
        } else if (this.currentTab === 'pending') {
            this.renderPendingRequests(container);
            return;
        }

        if (listToShow.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; padding: 40px; color: var(--text-muted);">
                    <p style="font-size: 2.2rem; margin-bottom: 8px;">🌸</p>
                    <p style="font-weight: 600;">Nenhum amigo encontrado nesta lista.</p>
                    <small>Que tal adicionar novos amigos usando o botão acima?</small>
                </div>
            `;
            return;
        }

        listToShow.forEach(friend => {
            const row = document.createElement('div');
            row.className = 'friend-row';
            row.innerHTML = `
                <div class="friend-info">
                    <div class="avatar-wrapper">
                        <img src="${friend.avatar_url || '/assets/default-avatar.png'}" class="friend-avatar" alt="${friend.display_name}">
                        <span class="status-indicator ${friend.status}"></span>
                    </div>
                    <div>
                        <strong style="font-size: 0.95rem;">${friend.display_name || friend.username}</strong>
                        <div style="font-size: 0.78rem; color: var(--text-muted);">@${friend.username}</div>
                    </div>
                </div>
                <div class="friend-actions">
                    <button class="btn btn-sm btn-primary" onclick="window.App.openDM(${friend.id}, '${escapeQuotes(friend.display_name || friend.username)}')">
                        💬 Conversar
                    </button>
                    <button class="btn btn-sm btn-chip" title="Chamada de Voz" onclick="window.WebRTCManager.startDirectCall(${friend.id}, false)">
                        📞
                    </button>
                    <button class="btn btn-sm btn-chip" title="Chamada de Vídeo" onclick="window.WebRTCManager.startDirectCall(${friend.id}, true)">
                        📹
                    </button>
                    <button class="btn btn-sm" style="color: var(--text-muted);" title="Remover Amigo" onclick="FriendsManager.removeFriend(${friend.id})">
                        ✕
                    </button>
                </div>
            `;
            container.appendChild(row);
        });
    },

    renderPendingRequests(container) {
        const { incoming, outgoing } = this.requests;
        if (incoming.length === 0 && outgoing.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; padding: 40px; color: var(--text-muted);">
                    <p style="font-size: 2rem;">📭</p>
                    <p style="font-weight: 600;">Nenhuma solicitação de amizade pendente.</p>
                </div>
            `;
            return;
        }

        // Solicitações recebidas
        if (incoming.length > 0) {
            const title = document.createElement('h4');
            title.style.cssText = 'font-size: 0.8rem; color: var(--accent-pink); margin: 8px 0; text-transform: uppercase;';
            title.textContent = `RECEBIDAS — ${incoming.length}`;
            container.appendChild(title);

            incoming.forEach(req => {
                const row = document.createElement('div');
                row.className = 'friend-row';
                row.innerHTML = `
                    <div class="friend-info">
                        <img src="${req.avatar_url || '/assets/default-avatar.png'}" class="friend-avatar" alt="${req.display_name}">
                        <div>
                            <strong>${req.display_name || req.username}</strong>
                            <div style="font-size: 0.78rem; color: var(--text-muted);">@${req.username} quer ser seu amigo</div>
                        </div>
                    </div>
                    <div class="friend-actions">
                        <button class="btn btn-sm btn-success" onclick="FriendsManager.respondRequest(${req.request_id}, 'accept')">
                            ✓ Aceitar
                        </button>
                        <button class="btn btn-sm btn-danger" onclick="FriendsManager.respondRequest(${req.request_id}, 'decline')">
                            ✕ Recusar
                        </button>
                    </div>
                `;
                container.appendChild(row);
            });
        }

        // Solicitações enviadas
        if (outgoing.length > 0) {
            const title = document.createElement('h4');
            title.style.cssText = 'font-size: 0.8rem; color: var(--text-muted); margin: 16px 0 8px 0; text-transform: uppercase;';
            title.textContent = `ENVIADAS — ${outgoing.length}`;
            container.appendChild(title);

            outgoing.forEach(req => {
                const row = document.createElement('div');
                row.className = 'friend-row';
                row.innerHTML = `
                    <div class="friend-info">
                        <img src="${req.avatar_url || '/assets/default-avatar.png'}" class="friend-avatar" alt="${req.display_name}">
                        <div>
                            <strong>${req.display_name || req.username}</strong>
                            <div style="font-size: 0.78rem; color: var(--text-muted);">Solicitação de amizade pendente</div>
                        </div>
                    </div>
                    <div class="friend-actions">
                        <span style="font-size: 0.8rem; color: var(--text-muted); padding: 4px 8px;">Aguardando...</span>
                    </div>
                `;
                container.appendChild(row);
            });
        }
    },

    renderDMList() {
        const container = document.getElementById('dm-list-container');
        if (!container) return;
        container.innerHTML = '';

        this.friends.forEach(friend => {
            const item = document.createElement('div');
            item.className = 'dm-item';
            item.id = `dm-item-${friend.id}`;
            item.innerHTML = `
                <div class="avatar-wrapper" style="width: 28px; height: 28px;">
                    <img src="${friend.avatar_url || '/assets/default-avatar.png'}" alt="${friend.display_name}">
                    <span class="status-indicator ${friend.status}"></span>
                </div>
                <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${friend.display_name || friend.username}</span>
            `;
            item.addEventListener('click', () => {
                window.App.openDM(friend.id, friend.display_name || friend.username);
            });
            container.appendChild(item);
        });
    },

    updatePendingBadge() {
        const badge = document.getElementById('pending-count-badge');
        if (badge) {
            const count = this.requests.incoming.length;
            badge.textContent = count;
            badge.style.display = count > 0 ? 'inline-block' : 'none';
        }
    },

    async sendRequest(target) {
        const token = window.AuthManager ? window.AuthManager.token : null;
        const feedback = document.getElementById('add-friend-feedback');

        try {
            const res = await fetch('/api/friends/request', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ target })
            });

            const data = await res.json();
            feedback.style.display = 'block';

            if (!res.ok) {
                feedback.style.color = '#e74c3c';
                feedback.textContent = data.error || 'Erro ao enviar pedido.';
            } else {
                feedback.style.color = '#2ecc71';
                feedback.textContent = data.message;
                document.getElementById('add-friend-input').value = '';
                this.loadFriendsData();
            }
        } catch (e) {
            feedback.style.display = 'block';
            feedback.style.color = '#e74c3c';
            feedback.textContent = 'Erro ao conectar ao servidor.';
        }
    },

    async respondRequest(requestId, action) {
        const token = window.AuthManager ? window.AuthManager.token : null;
        try {
            const res = await fetch('/api/friends/respond', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ requestId, action })
            });

            if (res.ok) {
                this.loadFriendsData();
                if (window.App) window.App.showToast(action === 'accept' ? 'Amizade aceita!' : 'Solicitação recusada.');
            }
        } catch (e) {}
    },

    async removeFriend(friendId) {
        if (!confirm('Deseja realmente desfazer esta amizade?')) return;
        const token = window.AuthManager ? window.AuthManager.token : null;
        try {
            const res = await fetch(`/api/friends/${friendId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (res.ok) {
                this.loadFriendsData();
                if (window.App) window.App.showToast('Amizade desfeita.');
            }
        } catch (e) {}
    },

    filterFriends(query) {
        const q = query.toLowerCase();
        const rows = document.querySelectorAll('.friend-row');
        rows.forEach(row => {
            const text = row.textContent.toLowerCase();
            row.style.display = text.includes(q) ? 'flex' : 'none';
        });
    }
};

function escapeQuotes(str) {
    return (str || '').replace(/'/g, "\\'");
}

window.FriendsManager = FriendsManager;
