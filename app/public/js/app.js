// ===================================================================
// ORQUESTRADOR PRINCIPAL DO CSGONADES CHAT APP
// ===================================================================

const App = {
    socket: null,
    audioCtx: null,

    async init() {
        console.log('[App] Inicializando CSGONADES Chat...');
        
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
    },

    onAuthenticated(user, token) {
        console.log(`[App] Usuário autenticado: ${user.username}`);
        
        // Conecta ao Socket.io
        this.connectSocket(token);

        // Carrega dados iniciais
        window.ServersManager.loadServers();
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
