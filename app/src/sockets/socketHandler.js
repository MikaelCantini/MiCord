const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');

// Rastreamento em memória
// Map<userId, Set<socketId>>
const userSockets = new Map();
// Map<socketId, { userId, user }>
const socketUsers = new Map();
// Map<channelId, Set<{ socketId, user, isMuted, isDeafened, hasVideo, hasScreen, isSpeaking }>>
const voiceRooms = new Map();
// Controle de anti-spam por usuário: Map<userId, { timestamps: number[], cooldownUntil: number }>
const userSpamTracker = new Map();

function setupSocketIO(io) {
    // Middleware de autenticação Socket.io
    io.use((socket, next) => {
        const token = socket.handshake.auth.token || socket.handshake.query.token;
        if (!token) {
            return next(new Error('Autenticação necessária.'));
        }

        try {
            const decoded = jwt.verify(token, config.JWT_SECRET);
            const user = db.queryOne(`
                SELECT id, username, display_name, avatar_url, status, custom_status, role, is_banned
                FROM users WHERE id = ?
            `, [decoded.userId]);

            if (!user || user.is_banned) {
                return next(new Error('Acesso negado.'));
            }

            socket.user = user;
            next();
        } catch (err) {
            next(new Error('Token inválido.'));
        }
    });

    io.on('connection', (socket) => {
        const user = socket.user;
        const userId = user.id;

        // Registra conexão do usuário
        if (!userSockets.has(userId)) {
            userSockets.set(userId, new Set());
        }
        userSockets.get(userId).add(socket.id);
        socketUsers.set(socket.id, { userId, user });

        // Entra na sala pessoal do usuário
        socket.join(`user-${userId}`);

        // Atualiza status do usuário para online no banco
        db.run("UPDATE users SET status = 'online', last_seen = CURRENT_TIMESTAMP WHERE id = ?", [userId]);
        io.emit('user:status-changed', { userId, status: 'online' });

        // Envia confirmação de conexão
        socket.emit('ready', {
            userId,
            voiceRooms: getVoiceRoomsSnapshot()
        });

        // ----------------------------------------------------
        // 1. CANAIS DE TEXTO & DMS
        // ----------------------------------------------------
        socket.on('channel:join', (channelId) => {
            socket.join(`channel-${channelId}`);
        });

        socket.on('channel:leave', (channelId) => {
            socket.leave(`channel-${channelId}`);
        });

        socket.on('chat:typing', ({ channelId, recipientId, isTyping }) => {
            if (channelId) {
                socket.to(`channel-${channelId}`).emit('chat:user-typing', {
                    channelId,
                    user: { id: user.id, username: user.username, display_name: user.display_name },
                    isTyping
                });
            } else if (recipientId) {
                io.to(`user-${recipientId}`).emit('chat:user-typing', {
                    dmUserId: user.id,
                    user: { id: user.id, username: user.username, display_name: user.display_name },
                    isTyping
                });
            }
        });

        socket.on('chat:send-message', (data) => {
            try {
                const { channelId, recipientId, content, attachmentUrl, attachmentType, attachmentName } = data;
                
                if ((!content || !content.trim()) && !attachmentUrl) return;

                // Sistema Anti-Spam: 5 mensagens seguidas -> cooldown de 5 segundos
                const now = Date.now();
                let tracker = userSpamTracker.get(userId);
                if (!tracker) {
                    tracker = { timestamps: [], cooldownUntil: 0 };
                    userSpamTracker.set(userId, tracker);
                }

                if (now < tracker.cooldownUntil) {
                    const remainingMs = tracker.cooldownUntil - now;
                    socket.emit('chat:spam-cooldown', {
                        remainingMs,
                        message: `⏳ Anti-spam: aguarde ${Math.ceil(remainingMs / 1000)}s para enviar mais mensagens.`
                    });
                    return;
                }

                // Considera mensagens enviadas em sequência nos últimos 10 segundos
                tracker.timestamps = tracker.timestamps.filter(ts => now - ts < 10000);
                tracker.timestamps.push(now);

                let triggeredCooldown = false;
                if (tracker.timestamps.length >= 5) {
                    tracker.cooldownUntil = now + 5000;
                    tracker.timestamps = [];
                    triggeredCooldown = true;
                }

                const result = db.run(`
                    INSERT INTO messages (channel_id, recipient_id, sender_id, content, attachment_url, attachment_type, attachment_name)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [
                    channelId ? parseInt(channelId) : null,
                    recipientId ? parseInt(recipientId) : null,
                    userId,
                    content ? content.trim() : null,
                    attachmentUrl || null,
                    attachmentType || null,
                    attachmentName || null
                ]);

                const fullMsg = db.queryOne(`
                    SELECT m.id, m.channel_id, m.recipient_id, m.sender_id, m.content, 
                           m.attachment_url, m.attachment_type, m.attachment_name, m.created_at,
                           u.username, u.display_name, u.avatar_url, u.status
                    FROM messages m
                    JOIN users u ON u.id = m.sender_id
                    WHERE m.id = ?
                `, [result.lastInsertRowid]);

                if (channelId) {
                    io.to(`channel-${channelId}`).emit('chat:new-message', fullMsg);
                } else if (recipientId) {
                    // Notifica ambos os usuários da DM
                    io.to(`user-${recipientId}`).emit('chat:new-message', fullMsg);
                    io.to(`user-${userId}`).emit('chat:new-message', fullMsg);
                }

                if (triggeredCooldown) {
                    socket.emit('chat:spam-cooldown', {
                        remainingMs: 5000,
                        message: '⏳ Anti-spam: você enviou 5 mensagens seguidas. Aguarde 5 segundos.'
                    });
                }
            } catch (err) {
                console.error('Erro ao enviar mensagem via socket:', err);
            }
        });

        // ----------------------------------------------------
        // 2. SALAS DE VOZ, VÍDEO & COMPARTILHAMENTO DE TELA (WebRTC)
        // ----------------------------------------------------
        socket.on('voice:join-room', ({ channelId }) => {
            const parsedChannelId = parseInt(channelId);
            
            // Remove esta guia de qualquer outra sala de voz anterior
            leaveCurrentVoiceRoom(socket);

            // Impede duplicação da mesma conta em salas de voz: desconecta qualquer outra guia/dispositivo desta conta
            const mySockets = userSockets.get(userId);
            if (mySockets) {
                mySockets.forEach(otherSocketId => {
                    if (otherSocketId === socket.id) return;
                    const otherSocket = io.sockets.sockets.get(otherSocketId);
                    if (otherSocket && otherSocket.voiceChannelId) {
                        leaveCurrentVoiceRoom(otherSocket);
                        otherSocket.emit('voice:disconnected-elsewhere', {
                            reason: 'Você entrou na sala de voz em outra guia ou dispositivo.'
                        });
                    }
                });
            }

            if (!voiceRooms.has(parsedChannelId)) {
                voiceRooms.set(parsedChannelId, new Map());
            }

            const room = voiceRooms.get(parsedChannelId);
            const participantData = {
                socketId: socket.id,
                user: {
                    id: user.id,
                    username: user.username,
                    display_name: user.display_name,
                    avatar_url: user.avatar_url
                },
                isMuted: false,
                isDeafened: false,
                hasVideo: false,
                hasScreen: false,
                isSpeaking: false
            };

            // Notifica os participantes atuais que um novo entrou
            room.forEach((peer, peerSocketId) => {
                io.to(peerSocketId).emit('voice:peer-joined', {
                    channelId: parsedChannelId,
                    peer: participantData
                });
            });

            // Envia a lista dos membros que já estavam na sala para quem acabou de entrar
            const existingPeers = Array.from(room.values());
            socket.emit('voice:room-joined', {
                channelId: parsedChannelId,
                self: participantData,
                peers: existingPeers
            });

            // Adiciona na sala
            room.set(socket.id, participantData);
            socket.voiceChannelId = parsedChannelId;
            socket.join(`voice-room-${parsedChannelId}`);

            // Transmite atualização pública de quem está em quais salas de voz
            io.emit('voice:rooms-updated', getVoiceRoomsSnapshot());
        });

        socket.on('voice:leave-room', () => {
            leaveCurrentVoiceRoom(socket);
        });

        // Sinalização WebRTC (Offer, Answer, ICE Candidates mesh)
        socket.on('webrtc:signal', ({ toSocketId, signal }) => {
            io.to(toSocketId).emit('webrtc:signal', {
                fromSocketId: socket.id,
                user: {
                    id: user.id,
                    username: user.username,
                    display_name: user.display_name,
                    avatar_url: user.avatar_url
                },
                signal
            });
        });

        // Atualização de estado da voz/vídeo/tela (em sala de grupo OU chamada privada 1-a-1)
        socket.on('voice:state-update', (state) => {
            if (socket.voiceChannelId) {
                const room = voiceRooms.get(socket.voiceChannelId);
                if (!room || !room.has(socket.id)) return;

                const participant = room.get(socket.id);
                Object.assign(participant, state);

                socket.to(`voice-room-${socket.voiceChannelId}`).emit('voice:peer-state-updated', {
                    socketId: socket.id,
                    userId: user.id,
                    state
                });
            } else if (socket.directCallPeerSocketId) {
                io.to(socket.directCallPeerSocketId).emit('voice:peer-state-updated', {
                    socketId: socket.id,
                    userId: user.id,
                    state
                });
            }
        });

        // Moderação: CEO / Admin / Moderador pode encerrar transmissão ou câmera de um participante
        socket.on('voice:force-stop-media', ({ targetSocketId, mediaType }) => {
            if (!['ceo', 'admin', 'moderator'].includes(user.role)) return;
            if (!targetSocketId || !['screen', 'video'].includes(mediaType)) return;

            io.to(targetSocketId).emit('voice:force-stopped-media', {
                mediaType,
                byUser: user.display_name || user.username
            });
        });

        // Indicador de fala em tempo real (AudioContext detection)
        socket.on('voice:speaking', ({ isSpeaking }) => {
            if (socket.voiceChannelId) {
                const room = voiceRooms.get(socket.voiceChannelId);
                if (!room || !room.has(socket.id)) return;

                room.get(socket.id).isSpeaking = isSpeaking;
                socket.to(`voice-room-${socket.voiceChannelId}`).emit('voice:peer-speaking', {
                    socketId: socket.id,
                    userId: user.id,
                    isSpeaking
                });
            } else if (socket.directCallPeerSocketId) {
                io.to(socket.directCallPeerSocketId).emit('voice:peer-speaking', {
                    socketId: socket.id,
                    userId: user.id,
                    isSpeaking
                });
            }
        });

        // ----------------------------------------------------
        // 3. CHAMADAS DIRETAS 1-A-1 COM AMIGOS (Voice/Video/Screen)
        // ----------------------------------------------------
        socket.on('call:initiate', ({ recipientId, hasVideo }) => {
            io.to(`user-${recipientId}`).emit('call:incoming', {
                caller: {
                    id: user.id,
                    username: user.username,
                    display_name: user.display_name,
                    avatar_url: user.avatar_url
                },
                callerSocketId: socket.id,
                hasVideo
            });
        });

        socket.on('call:accept', ({ callerSocketId, hasVideo }) => {
            // Vincula os dois sockets na chamada privada 1-a-1
            socket.directCallPeerSocketId = callerSocketId;
            const callerSocket = io.sockets.sockets.get(callerSocketId);
            if (callerSocket) {
                callerSocket.directCallPeerSocketId = socket.id;
            }

            const callerUser = callerSocket?.user
                ? {
                    id: callerSocket.user.id,
                    username: callerSocket.user.username,
                    display_name: callerSocket.user.display_name,
                    avatar_url: callerSocket.user.avatar_url
                }
                : null;

            // Fecha o banner de chamada recebida em todas as guias de quem atendeu
            io.to(`user-${user.id}`).emit('call:dismiss-incoming');

            io.to(callerSocketId).emit('call:accepted', {
                peerSocketId: socket.id,
                peer: {
                    id: user.id,
                    username: user.username,
                    display_name: user.display_name,
                    avatar_url: user.avatar_url
                },
                hasVideo
            });

            socket.emit('call:connected', {
                peerSocketId: callerSocketId,
                peer: callerUser,
                hasVideo
            });
        });

        socket.on('call:reject', ({ callerSocketId, reason }) => {
            io.to(`user-${user.id}`).emit('call:dismiss-incoming');
            io.to(callerSocketId).emit('call:rejected', {
                reason: reason || 'Chamada recusada.',
                user: { id: user.id, display_name: user.display_name }
            });
        });

        socket.on('call:end', ({ peerSocketId }) => {
            const targetId = peerSocketId || socket.directCallPeerSocketId;
            socket.directCallPeerSocketId = null;
            if (targetId) {
                const peerSock = io.sockets.sockets.get(targetId);
                if (peerSock && peerSock.directCallPeerSocketId === socket.id) {
                    peerSock.directCallPeerSocketId = null;
                }
                io.to(targetId).emit('call:ended', {
                    userId: user.id
                });
            }
        });

        // ----------------------------------------------------
        // DESCONEXÃO DO USUÁRIO
        // ----------------------------------------------------
        socket.on('disconnect', () => {
            // Se estava em chamada privada 1-a-1, encerra para o outro lado
            if (socket.directCallPeerSocketId) {
                const peerId = socket.directCallPeerSocketId;
                socket.directCallPeerSocketId = null;
                const peerSock = io.sockets.sockets.get(peerId);
                if (peerSock && peerSock.directCallPeerSocketId === socket.id) {
                    peerSock.directCallPeerSocketId = null;
                }
                io.to(peerId).emit('call:ended', { userId: user.id });
            }

            // Se estava em sala de voz, remove
            leaveCurrentVoiceRoom(socket);

            // Remove do mapa de sockets
            socketUsers.delete(socket.id);
            const socketsSet = userSockets.get(userId);
            if (socketsSet) {
                socketsSet.delete(socket.id);
                if (socketsSet.size === 0) {
                    userSockets.delete(userId);
                    // Usuário offline
                    try {
                        db.run("UPDATE users SET status = 'offline', last_seen = CURRENT_TIMESTAMP WHERE id = ?", [userId]);
                        io.emit('user:status-changed', { userId, status: 'offline' });
                    } catch (e) {}
                }
            }
        });
    });

    function leaveCurrentVoiceRoom(socket) {
        if (!socket.voiceChannelId) return;
        const channelId = socket.voiceChannelId;
        const room = voiceRooms.get(channelId);

        if (room) {
            room.delete(socket.id);
            socket.to(`voice-room-${channelId}`).emit('voice:peer-left', {
                socketId: socket.id,
                userId: socket.user.id
            });

            if (room.size === 0) {
                voiceRooms.delete(channelId);
            }
        }

        socket.leave(`voice-room-${channelId}`);
        socket.voiceChannelId = null;

        io.emit('voice:rooms-updated', getVoiceRoomsSnapshot());
    }

    function getVoiceRoomsSnapshot() {
        const snapshot = {};
        voiceRooms.forEach((participants, channelId) => {
            snapshot[channelId] = Array.from(participants.values()).map(p => ({
                socketId: p.socketId,
                user: p.user,
                isMuted: p.isMuted,
                isDeafened: p.isDeafened,
                hasVideo: p.hasVideo,
                hasScreen: p.hasScreen,
                isSpeaking: p.isSpeaking
            }));
        });
        return snapshot;
    }
}

module.exports = { setupSocketIO };
