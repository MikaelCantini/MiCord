// ===================================================================
// GERENCIADOR DE CHAT, MENSAGENS, UPLOADS E EMOJIS
// ===================================================================

const ChatManager = {
    currentChannelId: null,
    currentDMUserId: null,
    pendingAttachment: null,
    typingTimeout: null,

    init() {
        this.bindEvents();
    },

    bindEvents() {
        const input = document.getElementById('message-input');
        const sendBtn = document.getElementById('btn-send-message');
        const attachBtn = document.getElementById('btn-attachment');
        const fileInput = document.getElementById('file-input');
        const emojiBtn = document.getElementById('btn-emoji-toggle');
        const emojiPicker = document.getElementById('emoji-picker');
        const cancelAttachBtn = document.getElementById('btn-cancel-attachment');

        // Enviar com Enter (sem shift)
        input?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        // Detecção de Digitação (Typing Indicator)
        input?.addEventListener('input', () => {
            this.handleTyping();
        });

        sendBtn?.addEventListener('click', () => this.sendMessage());

        // Upload de Arquivo / Imagem
        attachBtn?.addEventListener('click', () => fileInput?.click());
        fileInput?.addEventListener('change', (e) => this.handleFileSelect(e));
        cancelAttachBtn?.addEventListener('click', () => this.clearAttachment());

        // Drag and drop de imagens no chat
        const dropArea = document.getElementById('chat-messages-view');
        dropArea?.addEventListener('dragover', (e) => e.preventDefault());
        dropArea?.addEventListener('drop', (e) => {
            e.preventDefault();
            if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                this.uploadFile(e.dataTransfer.files[0]);
            }
        });

        // Emojis rápidos
        emojiBtn?.addEventListener('click', () => {
            emojiPicker.style.display = emojiPicker.style.display === 'none' ? 'block' : 'none';
        });

        document.querySelectorAll('.emoji-grid span').forEach(el => {
            el.addEventListener('click', () => {
                input.value += el.textContent;
                emojiPicker.style.display = 'none';
                input.focus();
            });
        });

        // Fechar lightbox
        document.getElementById('lightbox-close-btn')?.addEventListener('click', () => {
            document.getElementById('modal-lightbox').style.display = 'none';
        });
    },

    async openChannel(channel) {
        this.currentChannelId = channel.id;
        this.currentDMUserId = null;
        this.clearAttachment();

        document.getElementById('dm-call-actions').style.display = 'none';
        document.getElementById('message-input').placeholder = `Conversar em #${channel.name}...`;

        // Notifica Socket para entrar na sala do canal
        if (window.App.socket) {
            window.App.socket.emit('channel:join', channel.id);
        }

        await this.loadMessages(`/api/messages/channel/${channel.id}`);
    },

    async openDM(friendId, friendName) {
        this.currentChannelId = null;
        this.currentDMUserId = friendId;
        this.clearAttachment();

        document.getElementById('dm-call-actions').style.display = 'flex';
        document.getElementById('message-input').placeholder = `Conversar com @${friendName}...`;

        await this.loadMessages(`/api/messages/dm/${friendId}`);
    },

    async loadMessages(url) {
        const token = window.AuthManager ? window.AuthManager.token : null;
        const container = document.getElementById('messages-container');
        if (!container) return;
        container.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 20px;">Carregando histórico...</div>';

        try {
            const res = await fetch(url, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (res.ok) {
                const messages = await res.json();
                container.innerHTML = '';
                if (messages.length === 0) {
                    container.innerHTML = `
                        <div style="text-align: center; color: var(--text-muted); padding: 40px;">
                            <p style="font-size: 1.8rem; margin-bottom: 6px;">💬</p>
                            <p style="font-weight: 600;">Início das mensagens!</p>
                            <small>Envie a primeira mensagem ou compartilhe uma foto.</small>
                        </div>
                    `;
                } else {
                    messages.forEach(msg => this.appendMessage(msg));
                }
                this.scrollToBottom();
            }
        } catch (err) {
            console.error('Erro ao carregar mensagens:', err);
        }
    },

    appendMessage(msg) {
        const container = document.getElementById('messages-container');
        if (!container) return;

        // Se estava a mensagem de "Início das mensagens" ou carregando, limpa
        if (container.querySelector('div[style*="text-align: center"]')) {
            container.innerHTML = '';
        }

        const date = new Date(msg.created_at);
        const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        const div = document.createElement('div');
        div.className = 'message-item';
        div.id = `msg-${msg.id}`;

        let attachmentHtml = '';
        if (msg.attachment_url) {
            if (msg.attachment_type === 'image') {
                attachmentHtml = `
                    <img src="${msg.attachment_url}" class="message-attachment-img" alt="Anexo" onclick="ChatManager.openLightbox('${msg.attachment_url}')">
                `;
            } else {
                attachmentHtml = `
                    <div style="margin-top: 6px;">
                        <a href="${msg.attachment_url}" download="${msg.attachment_name || 'arquivo'}" class="btn btn-sm btn-chip">
                            📁 Baixar ${msg.attachment_name || 'Arquivo'}
                        </a>
                    </div>
                `;
            }
        }

        div.innerHTML = `
            <img src="${msg.avatar_url || '/assets/default-avatar.png'}" class="message-avatar" alt="${msg.display_name}">
            <div class="message-body">
                <div class="message-header">
                    <span class="message-author">${msg.display_name || msg.username}</span>
                    <span class="message-time">${timeStr}</span>
                </div>
                ${msg.content ? `<div class="message-text">${this.formatMessageText(msg.content)}</div>` : ''}
                ${attachmentHtml}
            </div>
        `;

        container.appendChild(div);
        this.scrollToBottom();
    },

    formatMessageText(text) {
        // Sanitização básica e quebras de linha
        const sanitized = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        return sanitized.replace(/\n/g, '<br>');
    },

    async sendMessage() {
        const input = document.getElementById('message-input');
        const content = input.value.trim();

        if (!content && !this.pendingAttachment) return;

        const data = {
            channelId: this.currentChannelId,
            recipientId: this.currentDMUserId,
            content: content || null,
            attachmentUrl: this.pendingAttachment ? this.pendingAttachment.url : null,
            attachmentType: this.pendingAttachment ? this.pendingAttachment.type : null,
            attachmentName: this.pendingAttachment ? this.pendingAttachment.name : null
        };

        // Envia via Socket.io para entrega instantânea
        if (window.App && window.App.socket) {
            window.App.socket.emit('chat:send-message', data);
        } else {
            // Fallback REST
            const token = window.AuthManager ? window.AuthManager.token : null;
            await fetch('/api/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(data)
            });
        }

        input.value = '';
        this.clearAttachment();
        this.stopTyping();
    },

    async handleFileSelect(e) {
        const file = e.target.files[0];
        if (!file) return;
        await this.uploadFile(file);
    },

    async uploadFile(file) {
        const token = window.AuthManager ? window.AuthManager.token : null;
        const formData = new FormData();
        formData.append('file', file);

        try {
            if (window.App) window.App.showToast('Enviando arquivo...');
            const res = await fetch('/api/upload', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: formData
            });

            if (res.ok) {
                const data = await res.json();
                this.pendingAttachment = data;
                
                // Exibe barra de anexo
                const bar = document.getElementById('attachment-preview-bar');
                document.getElementById('attachment-name').textContent = `Anexo pronto: ${data.name}`;
                bar.style.display = 'flex';
                if (window.App) window.App.showToast('Anexo carregado!');
            }
        } catch (err) {
            alert('Falha ao enviar arquivo.');
        }
    },

    clearAttachment() {
        this.pendingAttachment = null;
        const bar = document.getElementById('attachment-preview-bar');
        if (bar) bar.style.display = 'none';
        const fileInput = document.getElementById('file-input');
        if (fileInput) fileInput.value = '';
    },

    handleTyping() {
        if (!window.App.socket) return;

        window.App.socket.emit('chat:typing', {
            channelId: this.currentChannelId,
            recipientId: this.currentDMUserId,
            isTyping: true
        });

        clearTimeout(this.typingTimeout);
        this.typingTimeout = setTimeout(() => this.stopTyping(), 2500);
    },

    stopTyping() {
        if (!window.App.socket) return;
        window.App.socket.emit('chat:typing', {
            channelId: this.currentChannelId,
            recipientId: this.currentDMUserId,
            isTyping: false
        });
    },

    showTypingIndicator(user, isTyping) {
        const bar = document.getElementById('typing-indicator');
        const text = document.getElementById('typing-text');
        if (!bar || !text) return;

        if (isTyping) {
            text.textContent = `${user.display_name || user.username} está digitando...`;
            bar.style.display = 'flex';
        } else {
            bar.style.display = 'none';
        }
    },

    openLightbox(imageUrl) {
        const modal = document.getElementById('modal-lightbox');
        const img = document.getElementById('lightbox-img');
        const downloadBtn = document.getElementById('lightbox-download-btn');
        if (!modal || !img) return;

        img.src = imageUrl;
        if (downloadBtn) downloadBtn.href = imageUrl;
        modal.style.display = 'flex';
    },

    scrollToBottom() {
        const scroller = document.getElementById('messages-container');
        if (scroller) {
            scroller.scrollTop = scroller.scrollHeight;
        }
    }
};

window.ChatManager = ChatManager;
