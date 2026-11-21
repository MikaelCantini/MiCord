// ===================================================================
// ORQUESTRADOR PRINCIPAL DO MiCord CHAT APP
// ===================================================================

const App = {
    socket: null,
    audioCtx: null,

    async init() {
        console.log('[App] Inicializando MiCord Chat...');
        
        // Inicializa gerenciadores
        window.AuthManager.init();
        window.FriendsManager.init();
        window.ServersManager.init();
        window.ChatManager.init();

        this.bindGlobalEvents();

        // Verifica sessão ao entrar no app
        const isLogged = await window.AuthManager.checkSession();
        if (isLogged) {
            this.onAuthenticated(window.AuthManager.user, window.AuthManager.token);
        }
    },

    bindGlobalEvents() {
        // Toggle da barra lateral de membros
        document.getElementById('btn-toggle-member-sidebar')?.addEventListener('click', () => {
            const sidebar = document.getElementById('members-sidebar');
            if (sidebar) {
                sidebar.style.display = sidebar.style.display === 'none' ? 'flex' : 'none';
            }
        });

        // Botões de chamada 1-a-1 na barra superior de DM
        document.getElementById('btn-start-voice-call')?.addEventListener('click', () => {
            if (window.ChatManager.currentDMUserId) {
                window.WebRTCManager.startDirectCall(window.ChatManager.currentDMUserId, false);
            }
        });

        document.getElementById('btn-start-video-call')?.addEventListener('click', () => {
            if (window.ChatManager.currentDMUserId) {
                window.WebRTCManager.startDirectCall(window.ChatManager.currentDMUserId, true);
            }
        });

        // Botão flutuante e modal de Reportar Bug
        document.getElementById('btn-report-bug')?.addEventListener('click', () => {
            document.getElementById('bug-title-input').value = '';
            document.getElementById('bug-desc-input').value = '';
            document.getElementById('modal-bug-report').style.display = 'flex';
        });

        document.getElementById('form-bug-report')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.submitBugReport();
        });
    },

    async submitBugReport() {
        const token = window.AuthManager ? window.AuthManager.token : null;
        if (!token) return;

        const title = document.getElementById('bug-title-input').value.trim();
        const description = document.getElementById('bug-desc-input').value.trim();
        if (!title || !description) return;

        try {
            const res = await fetch('/api/bugs', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ title, description })
            });

            const data = await res.json();
            if (res.ok) {
                document.getElementById('modal-bug-report').style.display = 'none';
                this.showToast('🐛 Bug reportado com sucesso! Obrigado pelo aviso.');
            } else {
                this.showToast(data.error || 'Erro ao enviar relatório de bug.');
            }
        } catch (err) {
            this.showToast('Erro de conexão ao reportar bug.');
        }
    },

    async onAuthenticated(user, token, options = {}) {
        console.log(`[App] Usuário autenticado: ${user.username}`);
        const bugBtn = document.getElementById('btn-report-bug');
        if (bugBtn) bugBtn.style.display = 'flex';
        
        // Conecta ao Socket.io
        this.connectSocket(token);

        // Carrega dados iniciais
        await window.ServersManager.loadServers();
        window.FriendsManager.loadFriendsData();

        // Exibe Hub de Amigos inicial
        this.showHomeView();
    },

    connectSocket(token) {
        if (this.socket) {
            this.socket.disconnect();
        }

        this.socket = io({
            auth: { token },
            transports: ['websocket', 'polling']
        });

        // Repassa o socket para o WebRTC Manager
        window.WebRTCManager.init(this.socket);

        this.socket.on('connect', () => {
            console.log('[Socket] Conectado ao servidor de tempo real com ID:', this.socket.id);
        });

        this.socket.on('ready', ({ voiceRooms }) => {
            window.ServersManager.updateVoiceRoomsUI(voiceRooms);
        });

        // Nova mensagem de chat em tempo real
        this.socket.on('chat:new-message', (msg) => {
            const isCurrentChannel = window.ChatManager.currentChannelId && msg.channel_id === window.ChatManager.currentChannelId;
            const isCurrentDM = window.ChatManager.currentDMUserId && 
                (msg.sender_id === window.ChatManager.currentDMUserId || msg.recipient_id === window.ChatManager.currentDMUserId);

            if (isCurrentChannel || isCurrentDM) {
                window.ChatManager.appendMessage(msg);
                // Toca som discreto se não for mensagem enviada por mim
                if (msg.sender_id !== window.AuthManager.user.id) {
                    this.playNotificationSound();
                }
            } else {
                // Notificação Toast
                this.showToast(`Nova mensagem de ${msg.display_name || msg.username}`);
                this.playNotificationSound();
            }
        });

        // Digitação
        this.socket.on('chat:user-typing', ({ channelId, dmUserId, user, isTyping }) => {
            if (channelId && channelId === window.ChatManager.currentChannelId) {
                window.ChatManager.showTypingIndicator(user, isTyping);
            } else if (dmUserId && dmUserId === window.ChatManager.currentDMUserId) {
                window.ChatManager.showTypingIndicator(user, isTyping);
            }
        });

        // Notificação em tempo real de convite de amizade e atualizações
        this.socket.on('friends:request-received', ({ fromUser }) => {
            if (window.FriendsManager) {
                window.FriendsManager.loadFriendsData();
            }
            const senderName = fromUser?.display_name || fromUser?.username || 'Alguém';
            this.showToast(`🤝 ${senderName} enviou um convite de amizade!`);
            this.playNotificationSound();
        });

        this.socket.on('friends:updated', ({ message } = {}) => {
            if (window.FriendsManager) {
                window.FriendsManager.loadFriendsData();
            }
            if (message) {
                this.showToast(`🤝 ${message}`);
                this.playNotificationSound();
            }
        });

        // Anti-spam cooldown vindo do servidor
        this.socket.on('chat:spam-cooldown', ({ remainingMs, message }) => {
            if (window.ChatManager) {
                window.ChatManager.startSpamCooldown(remainingMs || 5000);
            }
            if (message) {
                this.showToast(message);
            }
        });

        // Mudança de status de usuário
        this.socket.on('user:status-changed', ({ userId, status }) => {
            // Atualiza na lista de amigos
            const friend = window.FriendsManager.friends.find(f => f.id === userId);
            if (friend) {
                friend.status = status;
                window.FriendsManager.renderTabContent();
                window.FriendsManager.renderDMList();
            }
        });

        // Atualização global de salas de voz
        this.socket.on('voice:rooms-updated', (snapshot) => {
            window.ServersManager.updateVoiceRoomsUI(snapshot);
        });

        this.socket.on('connect_error', (err) => {
            console.warn('[Socket] Erro de conexão:', err.message);
        });
    },

    showHomeView() {
        document.getElementById('home-sidebar-view').style.display = 'flex';
        document.getElementById('server-sidebar-view').style.display = 'none';
        document.getElementById('friends-hub-view').style.display = 'flex';
        document.getElementById('chat-messages-view').style.display = 'none';
        document.getElementById('voice-video-room-view').style.display = 'none';
        document.getElementById('members-sidebar').style.display = 'none';
        document.getElementById('dm-call-actions').style.display = 'none';

        document.getElementById('sidebar-title').textContent = 'Mensagens Diretas';
        document.getElementById('sidebar-header-actions').innerHTML = '';
        document.getElementById('active-symbol').textContent = '👥';
        document.getElementById('active-title').textContent = 'Amigos';
        document.getElementById('active-desc').textContent = 'Seu hub de amigos e conexões';

        window.FriendsManager.switchTab('online');
    },

    openChannelChat(channel) {
        document.getElementById('friends-hub-view').style.display = 'none';
        document.getElementById('chat-messages-view').style.display = 'flex';
        document.getElementById('voice-video-room-view').style.display = 'none';
        document.getElementById('members-sidebar').style.display = 'flex';

        document.getElementById('active-symbol').textContent = '#';
        document.getElementById('active-title').textContent = channel.name;
        document.getElementById('active-desc').textContent = channel.topic || 'Sem tópico definido.';

        window.ChatManager.openChannel(channel);
    },

    openDM(friendId, friendName) {
        document.querySelectorAll('.dm-item').forEach(i => i.classList.remove('active'));
        document.getElementById(`dm-item-${friendId}`)?.classList.add('active');

        document.getElementById('friends-hub-view').style.display = 'none';
        document.getElementById('chat-messages-view').style.display = 'flex';
        document.getElementById('voice-video-room-view').style.display = 'none';
        document.getElementById('members-sidebar').style.display = 'none';

        document.getElementById('active-symbol').textContent = '@';
        document.getElementById('active-title').textContent = friendName;
        document.getElementById('active-desc').textContent = 'Conversa direta com seu amigo';

        window.ChatManager.openDM(friendId, friendName);
    },

    // Abre o cartão de perfil ao clicar em um usuário (foto, bio, Adicionar Amigo / Enviar Mensagem)
    async openUserProfileModal(userId) {
        const token = window.AuthManager ? window.AuthManager.token : null;
        if (!token || !userId) return;

        try {
            const res = await fetch(`/api/users/${userId}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) return;
            const user = await res.json();

            const avatarEl = document.getElementById('user-card-avatar');
            const avatarSrc = user.avatar_url || '/assets/default-avatar.png';
            if (avatarEl) {
                avatarEl.src = avatarSrc;
                avatarEl.onclick = () => {
                    if (window.ChatManager) window.ChatManager.openLightbox(avatarSrc);
                };
            }

            const statusDot = document.getElementById('user-card-status-dot');
            if (statusDot) statusDot.className = `status-indicator ${user.status || 'offline'}`;

            document.getElementById('user-card-display-name').textContent = user.display_name || user.username;
            document.getElementById('user-card-username').textContent = `@${user.username}`;

            const roleBadge = document.getElementById('user-card-role-badge');
            if (roleBadge) {
                if (user.role === 'ceo') {
                    roleBadge.textContent = '👑 CEO';
                    roleBadge.className = 'user-card-role ceo';
                    roleBadge.style.display = 'inline-block';
                } else if (user.role === 'admin') {
                    roleBadge.textContent = '🛡️ Admin';
                    roleBadge.className = 'user-card-role admin';
                    roleBadge.style.display = 'inline-block';
                } else if (user.role === 'moderator') {
                    roleBadge.textContent = '⭐ Moderador';
                    roleBadge.className = 'user-card-role moderator';
                    roleBadge.style.display = 'inline-block';
                } else {
                    roleBadge.style.display = 'none';
                }
            }

            document.getElementById('user-card-bio').textContent = user.bio && user.bio.trim() ? user.bio : 'Sem descrição.';

            const actionsEl = document.getElementById('user-card-actions');
            actionsEl.innerHTML = '';

            if (user.friendshipStatus === 'self') {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'btn btn-primary btn-block';
                btn.textContent = '⚙️ Editar Meu Perfil';
                btn.onclick = () => {
                    document.getElementById('modal-user-card').style.display = 'none';
                    window.AuthManager.openProfileModal();
                };
                actionsEl.appendChild(btn);
            } else if (user.friendshipStatus === 'accepted') {
                const msgBtn = document.createElement('button');
                msgBtn.type = 'button';
                msgBtn.className = 'btn btn-primary btn-block';
                msgBtn.textContent = '💬 Enviar Mensagem';
                msgBtn.onclick = () => {
                    document.getElementById('modal-user-card').style.display = 'none';
                    this.openDM(user.id, user.display_name || user.username);
                };
                actionsEl.appendChild(msgBtn);
            } else if (user.friendshipStatus === 'pending_sent') {
                const pendingBtn = document.createElement('button');
                pendingBtn.type = 'button';
                pendingBtn.className = 'btn btn-secondary btn-block';
                pendingBtn.disabled = true;
                pendingBtn.textContent = '⏳ Solicitação de Amizade Enviada';
                actionsEl.appendChild(pendingBtn);
            } else if (user.friendshipStatus === 'pending_received') {
                const acceptBtn = document.createElement('button');
                acceptBtn.type = 'button';
                acceptBtn.className = 'btn btn-primary btn-block';
                acceptBtn.textContent = '✓ Aceitar Convite de Amizade';
                acceptBtn.onclick = async () => {
                    await window.FriendsManager.respondRequest(user.requestId, 'accept');
                    await this.openUserProfileModal(user.id);
                };
                actionsEl.appendChild(acceptBtn);
            } else {
                const addBtn = document.createElement('button');
                addBtn.type = 'button';
                addBtn.className = 'btn btn-primary btn-block';
                addBtn.textContent = '🤝 Adicionar Amigo';
                addBtn.onclick = async () => {
                    addBtn.disabled = true;
                    addBtn.textContent = 'Enviando...';
                    try {
                        const r = await fetch('/api/friends/request', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${token}`
                            },
                            body: JSON.stringify({ target: user.username })
                        });
                        const data = await r.json();
                        if (r.ok) {
                            this.showToast(data.message || 'Solicitação de amizade enviada!');
                            if (window.FriendsManager) window.FriendsManager.loadFriendsData();
                            await this.openUserProfileModal(user.id);
                        } else {
                            this.showToast(data.error || 'Não foi possível enviar solicitação.');
                            addBtn.disabled = false;
                            addBtn.textContent = '🤝 Adicionar Amigo';
                        }
                    } catch (err) {
                        addBtn.disabled = false;
                        addBtn.textContent = '🤝 Adicionar Amigo';
                    }
                };
                actionsEl.appendChild(addBtn);
            }

            document.getElementById('modal-user-card').style.display = 'flex';
        } catch (err) {
            console.error('Erro ao abrir perfil do usuário:', err);
        }
    },

    showToast(message) {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = message;
        container.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    },

    // Sintetizador de Som de Notificação Suave com Web Audio API
    playNotificationSound() {
        try {
            if (!this.audioCtx) {
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                this.audioCtx = new AudioContextClass();
            }

            if (this.audioCtx.state === 'suspended') {
                this.audioCtx.resume();
            }

            const osc = this.audioCtx.createOscillator();
            const gain = this.audioCtx.createGain();

            osc.type = 'sine';
            osc.frequency.setValueAtTime(587.33, this.audioCtx.currentTime); // D5
            osc.frequency.exponentialRampToValueAtTime(880.00, this.audioCtx.currentTime + 0.12); // A5

            gain.gain.setValueAtTime(0.08, this.audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + 0.25);

            osc.connect(gain);
            gain.connect(this.audioCtx.destination);

            osc.start();
            osc.stop(this.audioCtx.currentTime + 0.25);
        } catch (e) {}
    }
};

window.App = App;
document.addEventListener('DOMContentLoaded', () => App.init());
