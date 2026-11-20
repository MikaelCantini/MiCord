// ===================================================================
// GERENCIADOR DE VOZ, VÍDEO & COMPARTILHAMENTO DE TELA (WebRTC)
// ===================================================================

const WebRTCManager = {
    socket: null,
    currentChannelId: null,
    isDirectCall: false,
    
    // Streams locais
    localAudioStream: null,
    localVideoStream: null,
    localScreenStream: null,
    
    // Estados locais
    isMuted: false,
    isDeafened: false,
    isVideoOn: false,
    isScreenSharing: false,
    
    // WebRTC PeerConnections Map<peerSocketId, RTCPeerConnection>
    peerConnections: new Map(),
    // Informações dos peers Map<peerSocketId, { user, ... }>
    peersData: new Map(),
    // Fila de ICE candidates antes da remoteDescription
    pendingCandidates: new Map(),
    // Controle de negociação simultânea (glare)
    makingOffer: new Map(),
    // Volumes individuais por participante: Map<socketId, { voice: number, screen: number }>
    peerVolumes: new Map(),
    // Mídias ocultadas localmente por participante: Map<socketId, { screen: boolean, video: boolean }>
    hiddenMedia: new Map(),
    // Popover de volume aberto atualmente (socketId ou null)
    openVolumePopoverId: null,
    // Transmissão priorizada/fixada ('self', socketId ou null)
    pinnedSocketId: null,

    // Detecção de voz (AudioContext)
    audioContext: null,
    analyser: null,
    speechInterval: null,
    isSpeaking: false,

    // Configuração ICE STUN padrão
    rtcConfig: {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' }
        ]
    },

    init(socket) {
        this.socket = socket;
        this.bindSocketEvents();
        this.bindUIEvents();
    },

    bindUIEvents() {
        // Botões da barra inferior e barra WebRTC
        const micBtn = document.getElementById('btn-toggle-mic');
        const webrtcMicBtn = document.getElementById('webrtc-mic-btn');
        const deafenBtn = document.getElementById('btn-toggle-deafen');
        const videoBtn = document.getElementById('webrtc-video-btn');
        const screenBtn = document.getElementById('webrtc-screen-btn');
        const leaveBtn = document.getElementById('webrtc-leave-btn');

        micBtn?.addEventListener('click', () => this.toggleMute());
        webrtcMicBtn?.addEventListener('click', () => this.toggleMute());
        deafenBtn?.addEventListener('click', () => this.toggleDeafen());
        videoBtn?.addEventListener('click', () => this.toggleVideo());
        screenBtn?.addEventListener('click', () => this.toggleScreenShare());
        leaveBtn?.addEventListener('click', () => this.leaveRoom());

        // Botões de chamada recebida
        document.getElementById('btn-accept-call')?.addEventListener('click', () => {
            if (this.pendingCall) {
                this.acceptCall(this.pendingCall.callerSocketId, this.pendingCall.hasVideo);
            }
        });

        document.getElementById('btn-decline-call')?.addEventListener('click', () => {
            if (this.pendingCall) {
                this.socket.emit('call:reject', { callerSocketId: this.pendingCall.callerSocketId });
                document.getElementById('incoming-call-banner').style.display = 'none';
                this.pendingCall = null;
            }
        });
    },

    bindSocketEvents() {
        if (!this.socket) return;

        // Entrou em uma sala de voz
        this.socket.on('voice:room-joined', async ({ channelId, self, peers }) => {
            this.currentChannelId = channelId;
            this.peersData.clear();
            peers.forEach(p => this.peersData.set(p.socketId, p));

            // Renderiza tela da sala
            this.showRoomView(`Sala de Voz #${channelId}`);
            this.renderAllTiles();

            // Inicia áudio local e conecta com cada peer existente
            await this.startLocalAudio();
            for (const peer of peers) {
                await this.initiatePeerConnection(peer.socketId, true); // nós criamos a oferta
            }
        });

        // Novo peer entrou na sala
        this.socket.on('voice:peer-joined', ({ channelId, peer }) => {
            if (this.currentChannelId !== channelId) return;
            this.peersData.set(peer.socketId, peer);
            this.renderAllTiles();
            // O novo peer irá nos enviar oferta, apenas aguardamos
        });

        // Peer saiu da sala
        this.socket.on('voice:peer-left', ({ socketId }) => {
            this.removePeer(socketId);
        });

        // Sinalização WebRTC (Offer, Answer, Candidate)
        this.socket.on('webrtc:signal', async ({ fromSocketId, user, signal }) => {
            if (!this.peersData.has(fromSocketId)) {
                this.peersData.set(fromSocketId, { socketId: fromSocketId, user });
            }

            let pc = this.peerConnections.get(fromSocketId);
            if (!pc) {
                pc = await this.initiatePeerConnection(fromSocketId, false);
            }

            try {
                if (signal.type === 'offer') {
                    const isPolite = this.socket.id < fromSocketId;
                    const offerCollision = this.makingOffer.get(fromSocketId) || pc.signalingState !== 'stable';

                    if (offerCollision && !isPolite) {
                        return;
                    }

                    if (offerCollision && isPolite) {
                        await Promise.all([
                            pc.setLocalDescription({ type: 'rollback' }),
                            pc.setRemoteDescription(new RTCSessionDescription(signal))
                        ]);
                    } else {
                        await pc.setRemoteDescription(new RTCSessionDescription(signal));
                    }

                    await this.flushPendingCandidates(fromSocketId, pc);

                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    this.socket.emit('webrtc:signal', {
                        toSocketId: fromSocketId,
                        signal: pc.localDescription
                    });
                } else if (signal.type === 'answer') {
                    if (pc.signalingState === 'have-local-offer') {
                        await pc.setRemoteDescription(new RTCSessionDescription(signal));
                        await this.flushPendingCandidates(fromSocketId, pc);
                    }
                } else if (signal.candidate) {
                    if (pc.remoteDescription && pc.remoteDescription.type) {
                        await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
                    } else {
                        const queue = this.pendingCandidates.get(fromSocketId) || [];
                        queue.push(signal.candidate);
                        this.pendingCandidates.set(fromSocketId, queue);
                    }
                }
            } catch (err) {
                console.error('[WebRTC] Erro no processamento de sinal:', err);
            }
        });

        // Indicador de fala de um peer
        this.socket.on('voice:peer-speaking', ({ socketId, isSpeaking }) => {
            const tile = document.getElementById(`peer-tile-${socketId}`);
            if (tile) {
                if (isSpeaking) tile.classList.add('speaking');
                else tile.classList.remove('speaking');
            }
            // Atualiza também se houver item no sidebar
            const pill = document.getElementById(`voice-pill-${socketId}`);
            if (pill) {
                if (isSpeaking) pill.classList.add('speaking');
                else pill.classList.remove('speaking');
            }
        });

        // Atualização de estado de vídeo/tela/mudo de um peer
        this.socket.on('voice:peer-state-updated', ({ socketId, state }) => {
            const peer = this.peersData.get(socketId);
            if (peer) {
                Object.assign(peer, state);
                // Se o peer parou de compartilhar tela/câmera, reseta o estado de ocultação local
                const hidden = this.hiddenMedia.get(socketId);
                if (hidden) {
                    if (state.hasScreen === false) hidden.screen = false;
                    if (state.hasVideo === false) hidden.video = false;
                }
                this.renderAllTiles();
            }
        });

        // Moderação: CEO / Admin / Moderador encerrou nossa transmissão ou câmera
        this.socket.on('voice:force-stopped-media', async ({ mediaType, byUser }) => {
            if (mediaType === 'screen' && this.isScreenSharing) {
                await this.toggleScreenShare();
                if (window.App) window.App.showToast(`🛑 ${byUser} encerrou sua transmissão de tela.`);
            } else if (mediaType === 'video' && this.isVideoOn) {
                await this.toggleVideo();
                if (window.App) window.App.showToast(`🛑 ${byUser} desligou sua câmera.`);
            }
        });

        // Chamada direta recebida (1-on-1)
        this.socket.on('call:incoming', ({ caller, callerSocketId, hasVideo }) => {
            this.pendingCall = { caller, callerSocketId, hasVideo };
            document.getElementById('caller-name').textContent = caller.display_name || caller.username;
            document.getElementById('caller-type-desc').textContent = hasVideo ? 'Chamada de vídeo recebida...' : 'Chamada de voz recebida...';
            document.getElementById('caller-avatar').src = caller.avatar_url || '/assets/default-avatar.png';
            document.getElementById('incoming-call-banner').style.display = 'flex';
        });

        this.socket.on('call:accepted', async ({ peerSocketId, peer, hasVideo }) => {
            this.isDirectCall = true;
            this.peersData.set(peerSocketId, { socketId: peerSocketId, user: peer });
            this.showRoomView(`Chamada com ${peer.display_name || peer.username}`);
            this.renderAllTiles();
            await this.startLocalAudio();
            if (hasVideo) await this.toggleVideo();
            await this.initiatePeerConnection(peerSocketId, true);
        });

        this.socket.on('call:rejected', ({ reason, user }) => {
            if (window.App) window.App.showToast(`Chamada recusada por ${user.display_name}.`);
            this.leaveRoom();
        });

        this.socket.on('call:ended', () => {
            if (window.App) window.App.showToast('Chamada encerrada.');
            this.leaveRoom();
        });
    },

    // Inicia captura de microfone e detecção de fala
    async startLocalAudio() {
        if (this.localAudioStream) return;
        try {
            this.localAudioStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                video: false
            });

            this.setupVoiceActivityDetection(this.localAudioStream);
            this.attachTracksToAllPeers(this.localAudioStream);
        } catch (err) {
            console.warn('[WebRTC] Não foi possível acessar o microfone:', err);
            if (window.App) window.App.showToast('Aviso: microfone não encontrado ou permissão negada.');
        }
    },

    // Cria RTCPeerConnection para um socketId
    async initiatePeerConnection(targetSocketId, isInitiator) {
        let pc = this.peerConnections.get(targetSocketId);
        if (pc) return pc;

        pc = new RTCPeerConnection(this.rtcConfig);
        this.peerConnections.set(targetSocketId, pc);

        // Envia nossos tracks locais para o novo peer
        if (this.localAudioStream) {
            this.localAudioStream.getTracks().forEach(track => pc.addTrack(track, this.localAudioStream));
        }
        if (this.localVideoStream) {
            this.localVideoStream.getTracks().forEach(track => pc.addTrack(track, this.localVideoStream));
        }
        if (this.localScreenStream) {
            this.localScreenStream.getTracks().forEach(track => pc.addTrack(track, this.localScreenStream));
        }

        // Envio de ICE Candidates
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.socket.emit('webrtc:signal', {
                    toSocketId: targetSocketId,
                    signal: { candidate: event.candidate }
                });
            }
        };

        // Recebimento de Stream remoto (Áudio da voz, Áudio da transmissão, Vídeo ou Tela)
        pc.ontrack = (event) => {
            const track = event.track;
            const incomingStream = event.streams && event.streams[0];
            const incomingStreamId = incomingStream ? incomingStream.id : null;
            const peerData = this.peersData.get(targetSocketId);
            if (!peerData) return;

            if (!peerData.voiceAudioStream) peerData.voiceAudioStream = new MediaStream();
            if (!peerData.screenAudioStream) peerData.screenAudioStream = new MediaStream();
            if (!peerData.videoTracks) peerData.videoTracks = [];

            if (track.kind === 'audio') {
                track._streamId = incomingStreamId;

                // Limpa tracks encerrados ou mudos antigos
                peerData.voiceAudioStream.getAudioTracks().forEach(t => {
                    if (t.readyState !== 'live') peerData.voiceAudioStream.removeTrack(t);
                });
                peerData.screenAudioStream.getAudioTracks().forEach(t => {
                    if (t.readyState !== 'live') peerData.screenAudioStream.removeTrack(t);
                });

                const hasVideoInStream = incomingStream ? incomingStream.getVideoTracks().length > 0 : false;
                const matchesScreenStream = Boolean(
                    hasVideoInStream ||
                    (peerData.screenStreamId && incomingStreamId && peerData.screenStreamId === incomingStreamId)
                );
                const hasLiveVoiceTrack = peerData.voiceAudioStream.getAudioTracks().some(t => t.readyState === 'live' && !t.muted);

                const isAlreadyVoice = peerData.voiceAudioStream.getAudioTracks().some(t => t.id === track.id);
                const isAlreadyScreen = peerData.screenAudioStream.getAudioTracks().some(t => t.id === track.id);

                if (!isAlreadyVoice && !isAlreadyScreen) {
                    if (matchesScreenStream || hasLiveVoiceTrack) {
                        peerData.screenAudioStream.addTrack(track);
                        track.onended = () => {
                            peerData.screenAudioStream.removeTrack(track);
                            this.renderAllTiles();
                        };
                    } else {
                        peerData.voiceAudioStream.addTrack(track);
                        track.onended = () => {
                            peerData.voiceAudioStream.removeTrack(track);
                            this.renderAllTiles();
                        };
                    }
                }
            } else if (track.kind === 'video') {
                // Se o stream de vídeo também tem áudio (ou é a transmissão de tela), garante que o áudio vá para screenAudioStream
                if (incomingStreamId && (peerData.hasScreen || (incomingStream && incomingStream.getAudioTracks().length > 0))) {
                    peerData.screenStreamId = incomingStreamId;
                    peerData.voiceAudioStream.getAudioTracks().forEach(t => {
                        if (t._streamId === incomingStreamId) {
                            peerData.voiceAudioStream.removeTrack(t);
                            if (!peerData.screenAudioStream.getAudioTracks().some(st => st.id === t.id)) {
                                peerData.screenAudioStream.addTrack(t);
                            }
                        }
                    });
                }

                // Remove tracks encerrados e adiciona o novo track de vídeo/tela
                peerData.videoTracks = peerData.videoTracks.filter(t => t.readyState === 'live' && t.id !== track.id);
                peerData.videoTracks.push(track);
                peerData.videoStream = new MediaStream([track]);

                const handleVideoEnded = () => {
                    peerData.videoTracks = peerData.videoTracks.filter(t => t.id !== track.id && t.readyState === 'live');
                    const latestTrack = peerData.videoTracks[peerData.videoTracks.length - 1];
                    peerData.videoStream = latestTrack ? new MediaStream([latestTrack]) : null;
                    this.renderAllTiles();
                };

                track.onended = handleVideoEnded;
                track.onmute = () => {
                    const liveUnmuted = peerData.videoTracks.filter(t => t.readyState === 'live' && !t.muted);
                    const latestTrack = liveUnmuted[liveUnmuted.length - 1];
                    peerData.videoStream = latestTrack ? new MediaStream([latestTrack]) : null;
                    this.renderAllTiles();
                };
                track.onunmute = () => {
                    if (track.readyState === 'live') {
                        peerData.videoStream = new MediaStream([track]);
                        this.renderAllTiles();
                    }
                };
            }

            this.renderAllTiles();
        };

        // Se nós formos os iniciadores da chamada para este peer, criamos o offer
        if (isInitiator) {
            await this.renegotiatePeer(targetSocketId);
        }

        return pc;
    },

    async flushPendingCandidates(socketId, pc) {
        const queue = this.pendingCandidates.get(socketId);
        if (!queue || queue.length === 0) return;
        this.pendingCandidates.delete(socketId);
        for (const candidate of queue) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (err) {
                console.warn('[WebRTC] Erro ao aplicar ICE candidate enfileirado:', err);
            }
        }
    },

    async renegotiatePeer(targetSocketId) {
        const pc = this.peerConnections.get(targetSocketId);
        if (!pc) return;
        try {
            this.makingOffer.set(targetSocketId, true);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this.socket.emit('webrtc:signal', {
                toSocketId: targetSocketId,
                signal: pc.localDescription
            });
        } catch (err) {
            console.error('[WebRTC] Erro ao renegociar conexão com peer:', err);
        } finally {
            this.makingOffer.set(targetSocketId, false);
        }
    },

    // Detecção de voz em tempo real usando Web Audio API
    setupVoiceActivityDetection(stream) {
        try {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            this.audioContext = new AudioContextClass();
            const source = this.audioContext.createMediaStreamSource(stream);
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 512;
            source.connect(this.analyser);

            const buffer = new Uint8Array(this.analyser.frequencyBinCount);

            this.speechInterval = setInterval(() => {
                if (this.isMuted) return;
                this.analyser.getByteFrequencyData(buffer);
                let sum = 0;
                for (let i = 0; i < buffer.length; i++) {
                    sum += buffer[i];
                }
                const average = sum / buffer.length;
                const isSpeakingNow = average > 18; // Limiar de voz

                if (isSpeakingNow !== this.isSpeaking) {
                    this.isSpeaking = isSpeakingNow;
                    this.socket.emit('voice:speaking', { isSpeaking: this.isSpeaking });
                    
                    const selfTile = document.getElementById('peer-tile-self');
                    if (selfTile) {
                        if (this.isSpeaking) selfTile.classList.add('speaking');
                        else selfTile.classList.remove('speaking');
                    }
                }
            }, 100);
        } catch (e) {
            console.warn('[WebRTC] Analyser de fala não suportado:', e);
        }
    },

    // Alternar Mudo Microfone
    toggleMute() {
        this.isMuted = !this.isMuted;
        if (this.localAudioStream) {
            this.localAudioStream.getAudioTracks().forEach(track => {
                track.enabled = !this.isMuted;
            });
        }

        const micIcon = document.getElementById('mic-icon');
        if (micIcon) micIcon.textContent = this.isMuted ? '🔇' : '🎙️';
        
        const webrtcMic = document.getElementById('webrtc-mic-btn');
        if (webrtcMic) {
            webrtcMic.classList.toggle('danger', this.isMuted);
            webrtcMic.querySelector('.icon').textContent = this.isMuted ? '🔇' : '🎙️';
        }

        this.socket.emit('voice:state-update', { isMuted: this.isMuted });
        this.renderAllTiles();
    },

    // Alternar Ensordecer
    toggleDeafen() {
        this.isDeafened = !this.isDeafened;
        
        // Muta todos os áudios recebidos
        const audios = document.querySelectorAll('.remote-peer-audio');
        audios.forEach(a => a.muted = this.isDeafened);

        const deafenIcon = document.getElementById('deafen-icon');
        if (deafenIcon) deafenIcon.textContent = this.isDeafened ? '🚫' : '🎧';
        
        this.socket.emit('voice:state-update', { isDeafened: this.isDeafened });
    },

    // Ligar / Desligar Câmera Webcam
    async toggleVideo() {
        if (this.isVideoOn) {
            // Desligar câmera
            if (this.localVideoStream) {
                await this.removeTracksFromAllPeers(this.localVideoStream);
                this.localVideoStream.getTracks().forEach(t => t.stop());
                this.localVideoStream = null;
            }
            this.isVideoOn = false;
        } else {
            // Ligar câmera
            try {
                this.localVideoStream = await navigator.mediaDevices.getUserMedia({
                    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
                    audio: false
                });
                await this.attachTracksToAllPeers(this.localVideoStream);
                this.isVideoOn = true;
            } catch (err) {
                alert('Não foi possível acessar sua câmera.');
                return;
            }
        }

        const videoBtn = document.getElementById('webrtc-video-btn');
        if (videoBtn) videoBtn.classList.toggle('active', this.isVideoOn);

        this.socket.emit('voice:state-update', { hasVideo: this.isVideoOn });
        this.renderAllTiles();
    },

    // Compartilhar Tela
    async toggleScreenShare() {
        if (this.isScreenSharing) {
            // Parar compartilhamento de tela
            if (this.localScreenStream) {
                await this.removeTracksFromAllPeers(this.localScreenStream);
                this.localScreenStream.getTracks().forEach(t => t.stop());
                this.localScreenStream = null;
            }
            this.isScreenSharing = false;
        } else {
            // Iniciar compartilhamento de tela
            try {
                this.localScreenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: { cursor: 'always' },
                    audio: true
                });

                // Caso o usuário clique em "Parar Compartilhamento" nativo do navegador
                this.localScreenStream.getVideoTracks()[0].onended = () => {
                    if (this.isScreenSharing) {
                        this.toggleScreenShare();
                    }
                };

                await this.attachTracksToAllPeers(this.localScreenStream);
                this.isScreenSharing = true;
            } catch (err) {
                console.warn('[WebRTC] Compartilhamento de tela cancelado pelo usuário.');
                return;
            }
        }

        const screenBtn = document.getElementById('webrtc-screen-btn');
        if (screenBtn) screenBtn.classList.toggle('active', this.isScreenSharing);

        if (!this.isScreenSharing && this.pinnedSocketId === 'self') {
            this.pinnedSocketId = null;
        }

        this.socket.emit('voice:state-update', {
            hasScreen: this.isScreenSharing,
            screenStreamId: this.isScreenSharing && this.localScreenStream ? this.localScreenStream.id : null
        });
        this.renderAllTiles();
    },

    async attachTracksToAllPeers(stream) {
        const modifiedPeers = new Set();
        stream.getTracks().forEach(track => {
            this.peerConnections.forEach((pc, socketId) => {
                const senders = pc.getSenders();
                const exists = senders.some(s => s.track && s.track.id === track.id);
                if (!exists) {
                    pc.addTrack(track, stream);
                    modifiedPeers.add(socketId);
                }
            });
        });

        for (const socketId of modifiedPeers) {
            await this.renegotiatePeer(socketId);
        }
    },

    async removeTracksFromAllPeers(stream) {
        const modifiedPeers = new Set();
        stream.getTracks().forEach(track => {
            this.peerConnections.forEach((pc, socketId) => {
                const senders = pc.getSenders();
                senders.forEach(sender => {
                    if (sender.track && sender.track.id === track.id) {
                        pc.removeTrack(sender);
                        modifiedPeers.add(socketId);
                    }
                });
            });
        });

        for (const socketId of modifiedPeers) {
            await this.renegotiatePeer(socketId);
        }
    },

    // Renderiza todos os cards de vídeo / participantes
    renderAllTiles() {
        const grid = document.getElementById('video-grid-container');
        if (!grid) return;
        grid.innerHTML = '';

        const currentUser = window.AuthManager ? window.AuthManager.user : { username: 'Você', display_name: 'Você', role: 'user' };
        const canModerate = ['ceo', 'admin', 'moderator'].includes(currentUser.role);

        // Conta quantas telas estão visíveis ao mesmo tempo para evitar sobreposição
        let activeScreensCount = (this.isScreenSharing && this.localScreenStream) ? 1 : 0;
        this.peersData.forEach((peer, socketId) => {
            const hidden = this.hiddenMedia.get(socketId) || { screen: false, video: false };
            const activeVideoTracks = peer.videoStream
                ? peer.videoStream.getVideoTracks().filter(t => t.readyState === 'live' && !t.muted)
                : [];
            if (activeVideoTracks.length > 0 && peer.hasScreen && !hidden.screen) {
                activeScreensCount++;
            }
        });
        grid.classList.toggle('multi-screen', activeScreensCount >= 2);

        // 1. Nosso próprio tile
        const selfTile = document.createElement('div');
        selfTile.id = 'peer-tile-self';
        selfTile.className = `participant-tile ${this.isSpeaking ? 'speaking' : ''}`;
        
        let selfMediaHtml = '';
        let selfTopButtons = '';
        const selfIsPinned = this.pinnedSocketId === 'self';

        if (this.isScreenSharing && this.localScreenStream) {
            selfTile.classList.add('featured-screen');
            if (selfIsPinned) selfTile.classList.add('pinned-screen');
            selfMediaHtml = `<video class="participant-video screen-share" id="self-screen-video" autoplay muted playsinline></video>`;
            selfTopButtons += `<button type="button" class="tile-action-btn ${selfIsPinned ? 'pinned-active' : ''}" onclick="WebRTCManager.togglePinScreen('self')" title="${selfIsPinned ? 'Remover prioridade' : 'Priorizar esta transmissão (deixar maior)'}">${selfIsPinned ? '📌 Priorizada' : '📌 Priorizar'}</button>`;
            selfTopButtons += `<button type="button" class="tile-action-btn" onclick="WebRTCManager.toggleFullscreen('peer-tile-self')" title="Tela cheia">⛶ Tela Cheia</button>`;
        } else if (this.isVideoOn && this.localVideoStream) {
            selfMediaHtml = `<video class="participant-video" id="self-cam-video" autoplay muted playsinline></video>`;
            selfTopButtons += `<button type="button" class="tile-action-btn" onclick="WebRTCManager.toggleFullscreen('peer-tile-self')" title="Tela cheia">⛶</button>`;
        } else {
            selfMediaHtml = `
                <div class="participant-avatar-view">
                    <img src="${currentUser.avatar_url || '/assets/default-avatar.png'}" alt="Eu">
                </div>
            `;
        }

        selfTile.innerHTML = `
            ${selfMediaHtml}
            ${selfTopButtons ? `<div class="tile-top-actions">${selfTopButtons}</div>` : ''}
            <div class="participant-overlay">
                <span class="participant-tag">Você ${this.isScreenSharing ? '(Tela)' : ''}</span>
                <div class="participant-icons">
                    ${this.isMuted ? '<span class="state-pill">🔇</span>' : ''}
                    ${this.isVideoOn ? '<span class="state-pill">📹</span>' : ''}
                    ${this.isScreenSharing ? '<span class="state-pill">🖥️</span>' : ''}
                </div>
            </div>
        `;
        grid.appendChild(selfTile);

        // Atribui streams locais aos vídeos
        if (this.isScreenSharing) {
            const v = document.getElementById('self-screen-video');
            if (v) v.srcObject = this.localScreenStream;
        } else if (this.isVideoOn) {
            const v = document.getElementById('self-cam-video');
            if (v) v.srcObject = this.localVideoStream;
        }

        // 2. Tiles dos outros participantes
        this.peersData.forEach((peer, socketId) => {
            const pUser = peer.user || { username: 'Amigo', display_name: 'Amigo' };
            const peerTile = document.createElement('div');
            peerTile.id = `peer-tile-${socketId}`;
            peerTile.className = `participant-tile ${peer.isSpeaking ? 'speaking' : ''}`;

            const vols = this.peerVolumes.get(socketId) || { voice: 1, screen: 1 };
            const hidden = this.hiddenMedia.get(socketId) || { screen: false, video: false };

            const activeVideoTracks = peer.videoStream
                ? peer.videoStream.getVideoTracks().filter(t => t.readyState === 'live' && !t.muted)
                : [];
            const hasLiveVideo = activeVideoTracks.length > 0;
            const isScreen = Boolean(peer.hasScreen);
            const isHiddenLocally = isScreen ? hidden.screen : hidden.video;
            const showVideo = hasLiveVideo && !isHiddenLocally;
            const isPinned = this.pinnedSocketId === socketId && showVideo && isScreen;

            const hasScreenAudio = peer.screenAudioStream && peer.screenAudioStream.getAudioTracks().some(t => t.readyState === 'live');
            const profileClickAttr = pUser.id ? `onclick="window.App.openUserProfileModal(${pUser.id})"` : '';

            let peerMediaHtml = '';
            if (showVideo) {
                if (isScreen) peerTile.classList.add('featured-screen');
                if (isPinned) peerTile.classList.add('pinned-screen');
                peerMediaHtml = `<video class="participant-video ${isScreen ? 'screen-share' : ''}" id="video-${socketId}" autoplay muted playsinline></video>`;
            } else {
                peerMediaHtml = `
                    <div class="participant-avatar-view">
                        <img src="${pUser.avatar_url || '/assets/default-avatar.png'}" alt="${pUser.display_name}" class="clickable-user" title="Ver perfil" ${profileClickAttr}>
                        ${hasLiveVideo && isHiddenLocally ? `<small style="color: var(--text-muted); font-weight: 600;">${isScreen ? 'Transmissão oculta' : 'Câmera oculta'}</small>` : ''}
                    </div>
                `;
            }

            // Botões de ação no topo direito do tile (Priorizar, Tela Cheia, Volume, Fechar Tela / Câmera, e Moderação)
            let topButtonsHtml = '';
            if (hasLiveVideo) {
                if (isScreen) {
                    if (!hidden.screen) {
                        topButtonsHtml += `<button type="button" class="tile-action-btn ${isPinned ? 'pinned-active' : ''}" onclick="WebRTCManager.togglePinScreen('${socketId}')" title="${isPinned ? 'Remover prioridade' : 'Priorizar esta transmissão (deixar maior)'}">${isPinned ? '📌 Priorizada' : '📌 Priorizar'}</button>`;
                        topButtonsHtml += `<button type="button" class="tile-action-btn" onclick="WebRTCManager.toggleFullscreen('peer-tile-${socketId}')" title="Tela cheia">⛶ Tela Cheia</button>`;
                    }
                    topButtonsHtml += `<button type="button" class="tile-action-btn" onclick="WebRTCManager.toggleHidePeerMedia('${socketId}', 'screen')" title="${hidden.screen ? 'Abrir transmissão' : 'Fechar transmissão para mim'}">${hidden.screen ? '🖥️ Ver Tela' : '✕ Fechar Tela'}</button>`;
                    if (canModerate) {
                        topButtonsHtml += `<button type="button" class="tile-action-btn danger-action" onclick="WebRTCManager.forceStopPeerMedia('${socketId}', 'screen')" title="Encerrar transmissão para todos">🛑 Encerrar</button>`;
                    }
                } else {
                    if (!hidden.video) {
                        topButtonsHtml += `<button type="button" class="tile-action-btn" onclick="WebRTCManager.toggleFullscreen('peer-tile-${socketId}')" title="Tela cheia">⛶</button>`;
                    }
                    topButtonsHtml += `<button type="button" class="tile-action-btn" onclick="WebRTCManager.toggleHidePeerMedia('${socketId}', 'video')" title="${hidden.video ? 'Mostrar câmera' : 'Fechar câmera para mim'}">${hidden.video ? '📹 Ver Câmera' : '✕ Fechar Câmera'}</button>`;
                    if (canModerate) {
                        topButtonsHtml += `<button type="button" class="tile-action-btn danger-action" onclick="WebRTCManager.forceStopPeerMedia('${socketId}', 'video')" title="Desligar câmera para todos">🛑 Desligar</button>`;
                    }
                }
            }
            topButtonsHtml += `<button type="button" class="tile-action-btn" onclick="WebRTCManager.toggleVolumePopover('${socketId}')" title="Ajustar volume do usuário e da transmissão">🔊</button>`;

            const voicePct = Math.round(vols.voice * 100);
            const screenPct = Math.round(vols.screen * 100);
            const isPopoverOpen = this.openVolumePopoverId === socketId;

            const volumePopoverHtml = `
                <div class="tile-volume-popover ${isPopoverOpen ? 'open' : ''}" id="vol-popover-${socketId}">
                    <div class="volume-control-row">
                        <label><span>🎙️ Voz do Usuário</span><span id="vol-voice-label-${socketId}">${voicePct}%</span></label>
                        <input type="range" min="0" max="100" value="${voicePct}" class="volume-slider" oninput="WebRTCManager.setPeerVolume('${socketId}', 'voice', this.value)">
                    </div>
                    ${(isScreen || hasScreenAudio) ? `
                    <div class="volume-control-row">
                        <label><span>🖥️ Transmissão</span><span id="vol-screen-label-${socketId}">${screenPct}%</span></label>
                        <input type="range" min="0" max="100" value="${screenPct}" class="volume-slider" oninput="WebRTCManager.setPeerVolume('${socketId}', 'screen', this.value)">
                    </div>` : ''}
                </div>
            `;

            // Áudio remoto separado (Voz e Áudio da Transmissão)
            const audioHtml = `
                <audio class="remote-peer-audio" id="audio-voice-${socketId}" autoplay playsinline></audio>
                <audio class="remote-peer-audio" id="audio-screen-${socketId}" autoplay playsinline></audio>
            `;

            peerTile.innerHTML = `
                ${peerMediaHtml}
                ${audioHtml}
                <div class="tile-top-actions">${topButtonsHtml}</div>
                ${volumePopoverHtml}
                <div class="participant-overlay">
                    <span class="participant-tag clickable-user" title="Ver perfil" ${profileClickAttr}>${pUser.display_name || pUser.username} ${peer.hasScreen ? '(Tela)' : ''}</span>
                    <div class="participant-icons">
                        ${peer.isMuted ? '<span class="state-pill">🔇</span>' : ''}
                        ${peer.hasVideo ? '<span class="state-pill">📹</span>' : ''}
                        ${peer.hasScreen ? '<span class="state-pill">🖥️</span>' : ''}
                    </div>
                </div>
            `;
            grid.appendChild(peerTile);

            // Vincula streams remotos (vídeo, áudio da voz e áudio da transmissão)
            if (showVideo && peer.videoStream) {
                const vid = document.getElementById(`video-${socketId}`);
                if (vid) {
                    vid.srcObject = peer.videoStream;
                    vid.play().catch(() => {});
                }
            }

            if (peer.voiceAudioStream) {
                const audVoice = document.getElementById(`audio-voice-${socketId}`);
                if (audVoice) {
                    audVoice.srcObject = peer.voiceAudioStream;
                    audVoice.volume = vols.voice;
                    audVoice.muted = this.isDeafened || vols.voice === 0;
                    audVoice.play().catch(() => {});
                }
            }

            if (peer.screenAudioStream) {
                const audScreen = document.getElementById(`audio-screen-${socketId}`);
                if (audScreen) {
                    audScreen.srcObject = peer.screenAudioStream;
                    audScreen.volume = vols.screen;
                    audScreen.muted = this.isDeafened || hidden.screen || vols.screen === 0;
                    audScreen.play().catch(() => {});
                }
            }
        });

        // Atualiza contador de participantes
        const count = 1 + this.peersData.size;
        const countBadge = document.getElementById('webrtc-participants-count');
        if (countBadge) {
            countBadge.textContent = `${count} participante${count > 1 ? 's' : ''}`;
        }
    },

    togglePinScreen(targetId) {
        this.pinnedSocketId = this.pinnedSocketId === targetId ? null : targetId;
        this.renderAllTiles();
    },

    toggleFullscreen(tileId) {
        const el = document.getElementById(tileId);
        if (!el) return;

        if (document.fullscreenElement || document.webkitFullscreenElement) {
            if (document.exitFullscreen) document.exitFullscreen();
            else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        } else {
            if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
            else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
        }
    },

    toggleVolumePopover(socketId) {
        this.openVolumePopoverId = this.openVolumePopoverId === socketId ? null : socketId;
        document.querySelectorAll('.tile-volume-popover').forEach(el => {
            el.classList.toggle('open', el.id === `vol-popover-${this.openVolumePopoverId}`);
        });
    },

    setPeerVolume(socketId, kind, percentValue) {
        const vol = Math.max(0, Math.min(1, parseInt(percentValue, 10) / 100));
        const current = this.peerVolumes.get(socketId) || { voice: 1, screen: 1 };
        current[kind] = vol;
        this.peerVolumes.set(socketId, current);

        const labelEl = document.getElementById(`vol-${kind}-label-${socketId}`);
        if (labelEl) labelEl.textContent = `${Math.round(vol * 100)}%`;

        const hidden = this.hiddenMedia.get(socketId) || { screen: false, video: false };
        const audioEl = document.getElementById(`audio-${kind}-${socketId}`);
        if (audioEl) {
            audioEl.volume = vol;
            audioEl.muted = this.isDeafened || vol === 0 || (kind === 'screen' && hidden.screen);
        }
    },

    toggleHidePeerMedia(socketId, kind) {
        const current = this.hiddenMedia.get(socketId) || { screen: false, video: false };
        current[kind] = !current[kind];
        this.hiddenMedia.set(socketId, current);
        if (kind === 'screen' && current.screen && this.pinnedSocketId === socketId) {
            this.pinnedSocketId = null;
        }
        this.renderAllTiles();
    },

    forceStopPeerMedia(socketId, mediaType) {
        if (!this.socket) return;
        const label = mediaType === 'screen' ? 'transmissão de tela' : 'câmera';
        if (!confirm(`Deseja encerrar a ${label} deste participante para todos na sala?`)) return;
        this.socket.emit('voice:force-stop-media', { targetSocketId: socketId, mediaType });
        if (window.App) window.App.showToast(`Solicitação enviada para encerrar a ${label}.`);
    },

    removePeer(socketId) {
        const pc = this.peerConnections.get(socketId);
        if (pc) {
            pc.close();
            this.peerConnections.delete(socketId);
        }
        this.pendingCandidates.delete(socketId);
        this.makingOffer.delete(socketId);
        this.peerVolumes.delete(socketId);
        this.hiddenMedia.delete(socketId);
        if (this.openVolumePopoverId === socketId) this.openVolumePopoverId = null;
        if (this.pinnedSocketId === socketId) this.pinnedSocketId = null;
        this.peersData.delete(socketId);
        this.renderAllTiles();
    },

    showRoomView(title) {
        document.getElementById('friends-hub-view').style.display = 'none';
        document.getElementById('chat-messages-view').style.display = 'none';
        document.getElementById('voice-video-room-view').style.display = 'flex';
        document.getElementById('webrtc-room-name').textContent = title;
        document.getElementById('active-title').textContent = title;
        document.getElementById('active-symbol').textContent = '🔊';
    },

    leaveRoom() {
        if (this.currentChannelId) {
            this.socket.emit('voice:leave-room');
            this.currentChannelId = null;
        }

        if (this.isDirectCall) {
            this.peersData.forEach((_, socketId) => {
                this.socket.emit('call:end', { peerSocketId: socketId });
            });
            this.isDirectCall = false;
        }

        // Para streams e fecha conexões
        if (this.localAudioStream) {
            this.localAudioStream.getTracks().forEach(t => t.stop());
            this.localAudioStream = null;
        }
        if (this.localVideoStream) {
            this.localVideoStream.getTracks().forEach(t => t.stop());
            this.localVideoStream = null;
            this.isVideoOn = false;
        }
        if (this.localScreenStream) {
            this.localScreenStream.getTracks().forEach(t => t.stop());
            this.localScreenStream = null;
            this.isScreenSharing = false;
        }

        if (this.speechInterval) clearInterval(this.speechInterval);
        if (this.audioContext) this.audioContext.close();

        this.peerConnections.forEach(pc => pc.close());
        this.peerConnections.clear();
        this.pendingCandidates.clear();
        this.makingOffer.clear();
        this.peerVolumes.clear();
        this.hiddenMedia.clear();
        this.openVolumePopoverId = null;
        this.pinnedSocketId = null;
        this.peersData.clear();

        // Volta para a visualização padrão
        if (window.App) window.App.showHomeView();
    },

    // Iniciar chamada 1-a-1 com amigo
    startDirectCall(friendId, hasVideo) {
        this.isDirectCall = true;
        this.socket.emit('call:initiate', { recipientId: friendId, hasVideo });
        this.showRoomView(`Chamando amigo...`);
        if (window.App) window.App.showToast(`Iniciando chamada com ${hasVideo ? 'câmera' : 'voz'}...`);
    },

    // Aceitar chamada 1-a-1 recebida
    async acceptCall(callerSocketId, hasVideo) {
        document.getElementById('incoming-call-banner').style.display = 'none';
        this.isDirectCall = true;
        this.socket.emit('call:accept', { callerSocketId, hasVideo });
    }
};

window.WebRTCManager = WebRTCManager;
