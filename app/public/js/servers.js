// ===================================================================
// GERENCIADOR DE SERVIDORES / GRUPOS & CANAIS
// ===================================================================

const ServersManager = {
    servers: [],
    currentServer: null,
    currentChannel: null,
    voiceRoomsState: {},

    init() {
        this.bindEvents();
    },

    bindEvents() {
        // Botão de início (Home / Amigos)
        document.getElementById('btn-nav-home')?.addEventListener('click', () => {
            this.currentServer = null;
            this.currentChannel = null;
            document.querySelectorAll('.server-btn').forEach(b => b.classList.remove('active'));
            document.getElementById('btn-nav-home')?.classList.add('active');
            window.App.showHomeView();
        });

        // Botão de adicionar servidor (+)
        document.getElementById('btn-add-server')?.addEventListener('click', () => {
            document.getElementById('modal-server').style.display = 'flex';
        });

        // Abas do modal de servidor (Criar / Entrar)
        const tabCreate = document.getElementById('tab-create-server');
        const tabJoin = document.getElementById('tab-join-server');
        const formCreate = document.getElementById('form-create-server');
        const formJoin = document.getElementById('form-join-server');

        tabCreate?.addEventListener('click', () => {
            tabCreate.classList.add('active');
            tabJoin.classList.remove('active');
            formCreate.style.display = 'flex';
            formJoin.style.display = 'none';
        });

        tabJoin?.addEventListener('click', () => {
            tabJoin.classList.add('active');
            tabCreate.classList.remove('active');
            formJoin.style.display = 'flex';
            formCreate.style.display = 'none';
        });

        // Submit Criar Servidor
        formCreate?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = document.getElementById('server-name-input').value;
            const description = document.getElementById('server-desc-input').value;
            await this.createServer(name, description);
        });

        // Submit Entrar em Servidor
        formJoin?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const invite_code = document.getElementById('server-invite-input').value;
            await this.joinServer(invite_code);
        });

        // Botões de Sair / Excluir Grupo
        document.getElementById('btn-leave-server')?.addEventListener('click', () => this.leaveCurrentServer());
        document.getElementById('btn-delete-server')?.addEventListener('click', () => this.deleteCurrentServer());

        // Botões de criar canais
        document.getElementById('btn-create-text-channel')?.addEventListener('click', () => {
            this.openCreateChannelModal('text');
        });

        document.getElementById('btn-create-voice-channel')?.addEventListener('click', () => {
            this.openCreateChannelModal('voice');
        });

        // Submit Criar Canal
        document.getElementById('form-create-channel')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const type = document.querySelector('input[name="channel-type"]:checked').value;
            const name = document.getElementById('channel-name-input').value;
            await this.createChannel(name, type);
        });

        // Fechamento de modais
        document.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', () => {
                const modalId = btn.getAttribute('data-close');
                if (modalId) document.getElementById(modalId).style.display = 'none';
            });
        });
    },

    async loadServers() {
        const token = window.AuthManager ? window.AuthManager.token : null;
        if (!token) return;

        try {
            const res = await fetch('/api/servers', {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (res.ok) {
                this.servers = await res.json();
                this.renderServersRail();
            }
        } catch (err) {
            console.error('Erro ao buscar servidores:', err);
        }
    },

    renderServersRail() {
        const container = document.getElementById('servers-list-container');
        if (!container) return;
        container.innerHTML = '';

        this.servers.forEach(server => {
            const btn = document.createElement('button');
            btn.className = `server-btn ${this.currentServer && this.currentServer.id === server.id ? 'active' : ''}`;
            btn.id = `server-rail-${server.id}`;
            btn.title = `${server.name} (Código: ${server.invite_code})`;
            
            // Iniciais do nome do servidor
            const initials = server.name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
            btn.textContent = initials;

            btn.addEventListener('click', () => this.selectServer(server.id));
            container.appendChild(btn);
        });
    },

    async selectServer(serverId) {
        const token = window.AuthManager ? window.AuthManager.token : null;
        if (!token) return;

        try {
            const res = await fetch(`/api/servers/${serverId}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (!res.ok) return;

            const serverData = await res.json();
            this.currentServer = serverData;

            // Atualiza destaque no rail
            document.querySelectorAll('.server-btn').forEach(b => b.classList.remove('active'));
            document.getElementById(`server-rail-${serverId}`)?.classList.add('active');

            // Alterna sidebar para modo servidor
            document.getElementById('home-sidebar-view').style.display = 'none';
            document.getElementById('server-sidebar-view').style.display = 'flex';
            document.getElementById('sidebar-title').textContent = serverData.name;
            
            // Botão de convite no cabeçalho do servidor
            const actionsHeader = document.getElementById('sidebar-header-actions');
            actionsHeader.innerHTML = `
                <button class="btn-icon-tiny" title="Código de Convite: ${serverData.invite_code} (Clique para copiar)" onclick="ServersManager.copyInvite('${serverData.invite_code}')">
                    🔗
                </button>
            `;

            // Renderiza canais
            this.renderChannels(serverData.channels);

            // Renderiza membros do servidor na coluna da direita
            this.renderMembers(serverData.members);

            // Atualiza visibilidade dos botões Sair / Excluir Grupo
            const myId = window.AuthManager?.user?.id;
            const isOwner = myId && serverData.owner_id === myId;
            const leaveBtn = document.getElementById('btn-leave-server');
            const deleteBtn = document.getElementById('btn-delete-server');
            if (leaveBtn) leaveBtn.style.display = isOwner ? 'none' : 'block';
            if (deleteBtn) deleteBtn.style.display = isOwner ? 'block' : 'none';

            // Seleciona o primeiro canal de texto por padrão
            const firstText = serverData.channels.find(c => c.type === 'text');
            if (firstText) {
                this.selectChannel(firstText);
            }
        } catch (err) {
            console.error('Erro ao selecionar servidor:', err);
        }
    },

    async leaveCurrentServer() {
        if (!this.currentServer) return;
        const server = this.currentServer;
        if (!confirm(`Tem certeza que deseja sair do grupo "${server.name}"?`)) return;

        const token = window.AuthManager ? window.AuthManager.token : null;
        try {
            const res = await fetch(`/api/servers/${server.id}/leave`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();
            if (res.ok) {
                this.currentServer = null;
                this.currentChannel = null;
                if (window.WebRTCManager && window.WebRTCManager.currentChannelId) {
                    window.WebRTCManager.leaveRoom();
                }
                await this.loadServers();
                if (window.App) {
                    window.App.showHomeView();
                    window.App.showToast(data.message || `Você saiu de "${server.name}".`);
                }
            } else {
                alert(data.error || 'Não foi possível sair do grupo.');
            }
        } catch (err) {
            alert('Erro de conexão ao tentar sair do grupo.');
        }
    },

    async deleteCurrentServer() {
        if (!this.currentServer) return;
        const server = this.currentServer;
        if (!confirm(`Deseja EXCLUIR PERMANENTEMENTE o grupo "${server.name}" e todos os seus canais e mensagens?`)) return;

        const token = window.AuthManager ? window.AuthManager.token : null;
        try {
            const res = await fetch(`/api/servers/${server.id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();
            if (res.ok) {
                this.currentServer = null;
                this.currentChannel = null;
                if (window.WebRTCManager && window.WebRTCManager.currentChannelId) {
                    window.WebRTCManager.leaveRoom();
                }
                await this.loadServers();
                if (window.App) {
                    window.App.showHomeView();
                    window.App.showToast(data.message || `Grupo "${server.name}" excluído.`);
                }
            } else {
                alert(data.error || 'Não foi possível excluir o grupo.');
            }
        } catch (err) {
            alert('Erro de conexão ao tentar excluir o grupo.');
        }
    },

    renderChannels(channels) {
        const textContainer = document.getElementById('server-text-channels');
        const voiceContainer = document.getElementById('server-voice-channels');
        if (!textContainer || !voiceContainer) return;

        textContainer.innerHTML = '';
        voiceContainer.innerHTML = '';

        channels.forEach(ch => {
            const item = document.createElement('div');
            item.className = `channel-item ${this.currentChannel && this.currentChannel.id === ch.id ? 'active' : ''}`;
            item.id = `channel-item-${ch.id}`;

            if (ch.type === 'text') {
                item.innerHTML = `
                    <span class="channel-symbol">#</span>
                    <span>${ch.name}</span>
                `;
                item.addEventListener('click', () => this.selectChannel(ch));
                textContainer.appendChild(item);
            } else {
                item.innerHTML = `
                    <span class="channel-symbol">🔊</span>
                    <span>${ch.name}</span>
                `;
                item.addEventListener('click', () => this.joinVoiceChannel(ch));

                // Container para pessoas conectadas nesta sala de voz
                const membersDiv = document.createElement('div');
                membersDiv.className = 'voice-channel-members';
                membersDiv.id = `voice-room-members-${ch.id}`;
                
                voiceContainer.appendChild(item);
                voiceContainer.appendChild(membersDiv);
            }
        });

        // Atualiza avatares nas salas de voz
        this.updateVoiceRoomsUI();
    },

    selectChannel(channel) {
        this.currentChannel = channel;
        document.querySelectorAll('.channel-item').forEach(i => i.classList.remove('active'));
        document.getElementById(`channel-item-${channel.id}`)?.classList.add('active');

        // Abre o chat de texto
        window.App.openChannelChat(channel);
    },

    joinVoiceChannel(channel) {
        if (!window.App.socket) return;

        // Se já está conectado nesta mesma sala de voz, apenas volta para a tela da sala sem reconectar nem bugar o áudio
        if (window.WebRTCManager && window.WebRTCManager.currentChannelId === channel.id) {
            window.WebRTCManager.showRoomView(channel.name || `Sala de Voz #${channel.id}`);
            window.WebRTCManager.renderAllTiles();
            return;
        }

        if (window.WebRTCManager) {
            window.WebRTCManager.currentChannelName = channel.name || `Sala de Voz #${channel.id}`;
        }
        window.App.socket.emit('voice:join-room', { channelId: channel.id });
    },

    renderMembers(members) {
        const container = document.getElementById('members-list-container');
        const badge = document.getElementById('members-count');
        if (!container) return;

        container.innerHTML = '';
        if (badge) badge.textContent = members.length;

        members.forEach(member => {
            const item = document.createElement('div');
            item.className = 'member-item clickable-user';
            item.title = 'Ver perfil';
            item.innerHTML = `
                <div class="avatar-wrapper" style="width: 30px; height: 30px;">
                    <img src="${member.avatar_url || '/assets/default-avatar.png'}" alt="${member.display_name}">
                    <span class="status-indicator ${member.status || 'offline'}"></span>
                </div>
                <div style="overflow: hidden;">
                    <div style="font-size: 0.86rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap;">${member.display_name || member.username}</div>
                    <div style="font-size: 0.7rem; color: var(--text-muted); text-transform: capitalize;">${member.role}</div>
                </div>
            `;
            item.addEventListener('click', () => {
                if (window.App) window.App.openUserProfileModal(member.id);
            });
            container.appendChild(item);
        });
    },

    openCreateChannelModal(type) {
        const radios = document.querySelectorAll('input[name="channel-type"]');
        radios.forEach(r => r.checked = (r.value === type));
        document.getElementById('channel-name-input').value = '';
        document.getElementById('modal-channel').style.display = 'flex';
    },

    async createServer(name, description) {
        const token = window.AuthManager ? window.AuthManager.token : null;
        try {
            const res = await fetch('/api/servers', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ name, description })
            });

            if (res.ok) {
                const newServer = await res.json();
                document.getElementById('modal-server').style.display = 'none';
                await this.loadServers();
                this.selectServer(newServer.id);
                if (window.App) window.App.showToast(`Servidor "${newServer.name}" criado com sucesso!`);
            }
        } catch (e) {
            alert('Erro ao criar servidor.');
        }
    },

    async joinServer(invite_code) {
        const token = window.AuthManager ? window.AuthManager.token : null;
        try {
            const res = await fetch('/api/servers/join', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ invite_code })
            });

            const data = await res.json();
            if (res.ok) {
                document.getElementById('modal-server').style.display = 'none';
                await this.loadServers();
                this.selectServer(data.serverId);
                if (window.App) window.App.showToast(data.message);
            } else {
                alert(data.error || 'Erro ao entrar no servidor.');
            }
        } catch (e) {
            alert('Erro ao conectar ao servidor.');
        }
    },

    async createChannel(name, type) {
        if (!this.currentServer) return;
        const token = window.AuthManager ? window.AuthManager.token : null;
        try {
            const res = await fetch(`/api/channels/server/${this.currentServer.id}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ name, type })
            });

            if (res.ok) {
                document.getElementById('modal-channel').style.display = 'none';
                await this.selectServer(this.currentServer.id);
                if (window.App) window.App.showToast('Canal criado!');
            }
        } catch (e) {
            alert('Erro ao criar canal.');
        }
    },

    copyInvite(code) {
        navigator.clipboard.writeText(code);
        if (window.App) window.App.showToast(`Código de convite copiado: ${code}`);
    },

    updateVoiceRoomsUI(snapshot) {
        if (snapshot) this.voiceRoomsState = snapshot;

        Object.keys(this.voiceRoomsState).forEach(channelId => {
            const container = document.getElementById(`voice-room-members-${channelId}`);
            if (!container) return;

            const participants = this.voiceRoomsState[channelId] || [];
            container.innerHTML = '';

            participants.forEach(p => {
                const pill = document.createElement('div');
                pill.className = `voice-peer-pill ${p.isSpeaking ? 'speaking' : ''}`;
                pill.id = `voice-pill-${p.socketId}`;
                pill.innerHTML = `
                    <img src="${p.user.avatar_url || '/assets/default-avatar.png'}" class="peer-avatar" alt="${p.user.display_name}">
                    <span>${p.user.display_name || p.user.username}</span>
                    ${p.isMuted ? '<span>🔇</span>' : ''}
                    ${p.hasVideo ? '<span>📹</span>' : ''}
                    ${p.hasScreen ? '<span>🖥️</span>' : ''}
                `;
                container.appendChild(pill);
            });
        });
    }
};

window.ServersManager = ServersManager;
