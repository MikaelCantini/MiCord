// ===================================================================
// GERENCIADOR DE VOZ, VÍDEO & COMPARTILHAMENTO DE TELA (WebRTC)
// ===================================================================

const WebRTCManager = {
    socket: null,
    currentChannelId: null,
    isDirectCall: false,
    
    // Streams locais
    rawMicStream: null,
    localAudioStream: null,
    localVideoStream: null,
    localScreenStream: null,
    
    // Estados locais
    isMuted: false,
    isDeafened: false,
    isVideoOn: false,
    isScreenSharing: false,
    isNoiseSuppressionOn: true,
    isMicTestOn: false,
    
    // Nós Web Audio API para supressão de ruído espectral (AudioWorklet), noise gate adaptativo e retorno de voz (teste)
    highpassFilter: null,
    highpassFilter2: null,
    spectralWorkletNode: null,
    presenceFilter: null,
    lowpassFilter: null,
    noiseGateGain: null,
    micTestGain: null,
    lastSpeechTime: 0,
    gateIsOpen: false,
    ambientNoiseFloor: 0.008,
    
    // WebRTC PeerConnections Map<peerSocketId, RTCPeerConnection>
    peerConnections: new Map(),
    // Informações dos peers Map<peerSocketId, { user, ... }>
    peersData: new Map(),
    // Fila de ICE candidates antes da remoteDescription
    pendingCandidates: new Map(),
    // Controle de negociação simultânea (glare)
    makingOffer: new Map(),
    // Volumes individuais por participante (persistidos no localStorage por userId)
    peerVolumes: new Map(),
    savedUserVolumes: {},
    // Mídias ocultadas localmente por participante: Map<socketId, { screen: boolean, video: boolean }>
    hiddenMedia: new Map(),
    // Popover de volume aberto atualmente (id do popover ou null)
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
        this.loadSavedVolumes();
        const savedNs = localStorage.getItem('micord_noise_suppression');
        this.isNoiseSuppressionOn = savedNs === null ? true : savedNs === 'true';
        this.updateNoiseBtnUI();
        this.bindSocketEvents();
        this.bindUIEvents();
    },

    loadSavedVolumes() {
        try {
            const raw = localStorage.getItem('micord_peer_volumes');
            this.savedUserVolumes = raw ? JSON.parse(raw) : {};
        } catch (e) {
            this.savedUserVolumes = {};
        }
    },

    saveUserVolumePref(userId, vols) {
        if (!userId) return;
        this.savedUserVolumes[String(userId)] = {
            voice: vols.voice,
            screen: vols.screen
        };
        try {
            localStorage.setItem('micord_peer_volumes', JSON.stringify(this.savedUserVolumes));
        } catch (e) {}
    },

    getPeerVolume(socketId) {
        const existing = this.peerVolumes.get(socketId);
        if (existing) return existing;

        const peer = this.peersData.get(socketId);
        const userId = peer?.user?.id;
        if (userId && this.savedUserVolumes[String(userId)]) {
            const saved = this.savedUserVolumes[String(userId)];
            const vols = {
                voice: typeof saved.voice === 'number' ? saved.voice : 1,
                screen: typeof saved.screen === 'number' ? saved.screen : 1
            };
            this.peerVolumes.set(socketId, vols);
            return vols;
        }

        const def = { voice: 1, screen: 1 };
        this.peerVolumes.set(socketId, def);
        return def;
    },

    bindUIEvents() {
        // Botões da barra inferior e barra WebRTC
        const micBtn = document.getElementById('btn-toggle-mic');
        const webrtcMicBtn = document.getElementById('webrtc-mic-btn');
        const noiseBtn = document.getElementById('webrtc-noise-btn');
        const micTestBtn = document.getElementById('webrtc-mic-test-btn');
        const deafenBtn = document.getElementById('btn-toggle-deafen');
        const videoBtn = document.getElementById('webrtc-video-btn');
        const screenBtn = document.getElementById('webrtc-screen-btn');
        const leaveBtn = document.getElementById('webrtc-leave-btn');

        micBtn?.addEventListener('click', () => this.toggleMute());
        webrtcMicBtn?.addEventListener('click', () => this.toggleMute());
        noiseBtn?.addEventListener('click', () => this.toggleNoiseSuppression());
        micTestBtn?.addEventListener('click', () => this.toggleMicTest());
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
            if (window.App) window.App.stopRinging();
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
            if (window.App) {
                window.App.stopRinging();
                window.App.playSound('join');
            }
            // Fecha conexões antigas de sala anterior (evita RTCPeerConnection morta ao trocar de sala)
            this.peerConnections.forEach(pc => pc.close());
            this.peerConnections.clear();
            this.pendingCandidates.clear();
            this.makingOffer.clear();
            this.peersData.clear();

            this.currentChannelId = channelId;
            peers.forEach(p => this.peersData.set(p.socketId, p));

            // Renderiza tela da sala
            this.showRoomView(this.currentChannelName || `Sala de Voz #${channelId}`);
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
            if (window.App) window.App.playSound('peer-join');
            this.renderAllTiles();
            // O novo peer irá nos enviar oferta, apenas aguardamos
        });

        // Peer saiu da sala
        this.socket.on('voice:peer-left', ({ socketId }) => {
            if (window.App) window.App.playSound('peer-leave');
            this.removePeer(socketId);
        });

        // Mesma conta entrou na sala de voz em outra guia/dispositivo
        this.socket.on('voice:disconnected-elsewhere', ({ reason }) => {
            this.currentChannelId = null;
            this.leaveRoom();
            if (window.App) {
                window.App.showToast(`ℹ️ ${reason || 'Você entrou na sala de voz em outra guia.'}`);
            }
        });

        // Sinalização WebRTC (Offer, Answer, Candidate)
        this.socket.on('webrtc:signal', async ({ fromSocketId, user, signal }) => {
            if (!this.peersData.has(fromSocketId)) {
                this.peersData.set(fromSocketId, { socketId: fromSocketId, user });
            }

            let pc = this.peerConnections.get(fromSocketId);
            const wasNewConnection = !pc;
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
                    try {
                        await pc.setLocalDescription({
                            type: answer.type,
                            sdp: this.enhanceSdpMedia(answer.sdp)
                        });
                    } catch (sdpErr) {
                        console.warn('[WebRTC] Fallback para SDP padrão na resposta:', sdpErr);
                        await pc.setLocalDescription(answer);
                    }
                    this.socket.emit('webrtc:signal', {
                        toSocketId: fromSocketId,
                        signal: pc.localDescription
                    });

                    // Se o novo peer enviou oferta só de áudio e nós já estamos com webcam ou tela ativa,
                    // renegociamos enviando uma nova oferta para entregar nossos tracks de vídeo/tela
                    if (wasNewConnection && (this.isVideoOn || this.isScreenSharing)) {
                        this.socket.emit('voice:state-update', {
                            micStreamId: this.localAudioStream ? this.localAudioStream.id : null,
                            camStreamId: this.isVideoOn && this.localVideoStream ? this.localVideoStream.id : null,
                            screenStreamId: this.isScreenSharing && this.localScreenStream ? this.localScreenStream.id : null,
                            hasScreen: this.isScreenSharing,
                            hasVideo: this.isVideoOn
                        });
                        setTimeout(() => this.renegotiatePeer(fromSocketId), 150);
                    }
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
                if (state.hasScreen === false) {
                    peer.screenStreamId = null;
                }
                if (state.hasVideo === false) {
                    peer.camStreamId = null;
                }
                this.syncPeerAudioStreams(peer);
                this.syncPeerVideoStreams(peer);
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
            if (window.App) window.App.startRinging('incoming');
        });

        this.socket.on('call:accepted', async ({ peerSocketId, peer, hasVideo }) => {
            if (window.App) {
                window.App.stopRinging();
                window.App.playSound('join');
            }
            this.isDirectCall = true;
            this.peersData.set(peerSocketId, { socketId: peerSocketId, user: peer });
            this.showRoomView(`Chamada com ${peer.display_name || peer.username}`);
            this.renderAllTiles();
            await this.startLocalAudio();
            if (hasVideo) await this.toggleVideo();
            await this.initiatePeerConnection(peerSocketId, true);
        });

        this.socket.on('call:rejected', ({ reason, user }) => {
            if (window.App) {
                window.App.stopRinging();
                window.App.showToast(`Chamada recusada por ${user.display_name}.`);
            }
            this.leaveRoom();
        });

        this.socket.on('call:ended', () => {
            if (window.App) {
                window.App.stopRinging();
                window.App.showToast('Chamada encerrada.');
            }
            this.leaveRoom();
        });
    },

    // Inicia captura de microfone com Supressor de Ruído (DSP do navegador + filtros Web Audio API + Noise Gate)
    async startLocalAudio() {
        if (this.localAudioStream) return;
        try {
            this.rawMicStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: this.isNoiseSuppressionOn,
                    autoGainControl: true,
                    channelCount: 1,
                    sampleRate: 48000,
                    sampleSize: 16
                },
                video: false
            });

            // Cria pipeline limpo de alta fidelidade (High-Pass 80 Hz + Noise Gate suave + detecção de fala)
            const processedStream = await this.setupNoiseSuppressionAndVAD(this.rawMicStream);
            this.localAudioStream = processedStream || this.rawMicStream;

            // Respeita estado de mudo atual
            this.localAudioStream.getAudioTracks().forEach(t => { t.enabled = !this.isMuted; });

            this.updateNoiseBtnUI();
            this.socket?.emit('voice:state-update', { micStreamId: this.localAudioStream.id });
            await this.attachTracksToAllPeers(this.localAudioStream);
        } catch (err) {
            console.warn('[WebRTC] Não foi possível acessar o microfone:', err);
            if (window.App) window.App.showToast('Aviso: microfone não encontrado ou permissão negada.');
        }
    },

    updateNoiseBtnUI() {
        const noiseBtn = document.getElementById('webrtc-noise-btn');
        if (noiseBtn) {
            noiseBtn.classList.toggle('active', this.isNoiseSuppressionOn);
            noiseBtn.title = this.isNoiseSuppressionOn
                ? 'Supressor de Ruído ATIVO (clique para desativar)'
                : 'Supressor de Ruído DESATIVADO (clique para ativar)';
        }
    },

    async toggleNoiseSuppression() {
        this.isNoiseSuppressionOn = !this.isNoiseSuppressionOn;
        try {
            localStorage.setItem('micord_noise_suppression', String(this.isNoiseSuppressionOn));
        } catch (e) {}

        this.updateNoiseBtnUI();

        // Atualiza constraints no microfone nativo
        if (this.rawMicStream) {
            const rawTrack = this.rawMicStream.getAudioTracks()[0];
            if (rawTrack && rawTrack.applyConstraints) {
                try {
                    await rawTrack.applyConstraints({
                        echoCancellation: true,
                        noiseSuppression: this.isNoiseSuppressionOn,
                        autoGainControl: true
                    });
                } catch (e) {}
            }
        }

        // Atualiza filtros Web Audio API em tempo real sem derrubar a call
        if (this.audioContext) {
            const now = this.audioContext.currentTime;
            if (this.highpassFilter) {
                this.highpassFilter.frequency.setTargetAtTime(this.isNoiseSuppressionOn ? 80 : 10, now, 0.02);
            }
            if (this.noiseGateGain && !this.isNoiseSuppressionOn) {
                this.noiseGateGain.gain.setTargetAtTime(1.0, now, 0.02);
            }
        }

        if (window.App) {
            window.App.showToast(
                this.isNoiseSuppressionOn
                    ? '✨ Supressor de ruído ativado!'
                    : 'Supressor de ruído desativado.'
            );
        }
    },

    // Ativa / Desativa retorno da própria voz para testar o microfone e o supressor de ruído
    toggleMicTest() {
        this.isMicTestOn = !this.isMicTestOn;

        if (this.audioContext && this.audioContext.state === 'suspended') {
            this.audioContext.resume().catch(() => {});
        }

        if (this.micTestGain && this.audioContext) {
            const now = this.audioContext.currentTime;
            this.micTestGain.gain.setTargetAtTime(this.isMicTestOn ? 1.0 : 0.0, now, 0.02);
        }

        const btn = document.getElementById('webrtc-mic-test-btn');
        if (btn) {
            btn.classList.toggle('active', this.isMicTestOn);
        }

        if (window.App) {
            window.App.showToast(
                this.isMicTestOn
                    ? '👂 Teste de voz ATIVO — fale para ouvir seu microfone (alterne o Supressor para comparar).'
                    : 'Teste de voz desativado.'
            );
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

            if (!peerData.remoteAudioTracks) peerData.remoteAudioTracks = new Map();
            if (!peerData.remoteVideoTracks) peerData.remoteVideoTracks = new Map();

            if (track.kind === 'audio') {
                const isFromVideoStream = Boolean(incomingStream && incomingStream.getVideoTracks().length > 0);
                peerData.remoteAudioTracks.set(track.id, {
                    track,
                    streamId: incomingStreamId,
                    isFromVideoStream
                });

                track.onended = () => {
                    peerData.remoteAudioTracks.delete(track.id);
                    this.syncPeerAudioStreams(peerData);
                    this.renderAllTiles();
                };
                track.onmute = () => {
                    this.syncPeerAudioStreams(peerData);
                };
                track.onunmute = () => {
                    this.syncPeerAudioStreams(peerData);
                    this.renderAllTiles();
                };

                this.syncPeerAudioStreams(peerData);
            } else if (track.kind === 'video') {
                // Se o stream de vídeo tem áudio (ou corresponde ao screenStreamId), marca os tracks de áudio desse stream como áudio da transmissão
                if (incomingStreamId && ((peerData.screenStreamId && peerData.screenStreamId === incomingStreamId) || (incomingStream && incomingStream.getAudioTracks().length > 0))) {
                    peerData.screenStreamId = incomingStreamId;
                    peerData.remoteAudioTracks.forEach(entry => {
                        if (entry.streamId === incomingStreamId) {
                            entry.isFromVideoStream = true;
                        }
                    });
                    this.syncPeerAudioStreams(peerData);
                }

                peerData.remoteVideoTracks.set(track.id, {
                    track,
                    streamId: incomingStreamId
                });

                track.onended = () => {
                    peerData.remoteVideoTracks.delete(track.id);
                    this.syncPeerVideoStreams(peerData);
                    this.renderAllTiles();
                };
                track.onmute = () => {
                    this.syncPeerVideoStreams(peerData);
                    this.renderAllTiles();
                };
                track.onunmute = () => {
                    this.syncPeerVideoStreams(peerData);
                    this.renderAllTiles();
                };

                this.syncPeerVideoStreams(peerData);
            }

            this.renderAllTiles();
        };

        // Se nós formos os iniciadores da chamada para este peer, criamos o offer
        if (isInitiator) {
            await this.renegotiatePeer(targetSocketId);
        }

        // Compartilha IDs atuais dos nossos streams de áudio/câmera/tela para classificação correta nos peers
        if (this.localAudioStream || this.localVideoStream || this.localScreenStream) {
            this.socket?.emit('voice:state-update', {
                micStreamId: this.localAudioStream ? this.localAudioStream.id : null,
                camStreamId: this.isVideoOn && this.localVideoStream ? this.localVideoStream.id : null,
                screenStreamId: this.isScreenSharing && this.localScreenStream ? this.localScreenStream.id : null,
                hasScreen: this.isScreenSharing,
                hasVideo: this.isVideoOn
            });
        }

        return pc;
    },

    // Classifica tracks de vídeo recebidos separando Webcam e Compartilhamento de Tela (permite ambos simultâneos)
    syncPeerVideoStreams(peerData) {
        if (!peerData || !peerData.remoteVideoTracks) return;

        let camTrack = null;
        let screenTrack = null;

        for (const [trackId, entry] of peerData.remoteVideoTracks.entries()) {
            if (!entry.track || entry.track.readyState !== 'live') {
                peerData.remoteVideoTracks.delete(trackId);
            }
        }

        const liveEntries = Array.from(peerData.remoteVideoTracks.values())
            .filter(e => e.track && e.track.readyState === 'live' && !e.track.muted);

        liveEntries.forEach(entry => {
            const matchesScreenId = Boolean(peerData.screenStreamId && entry.streamId && entry.streamId === peerData.screenStreamId);
            const matchesCamId = Boolean(peerData.camStreamId && entry.streamId && entry.streamId === peerData.camStreamId);

            if (matchesScreenId) {
                screenTrack = entry.track;
            } else if (matchesCamId) {
                camTrack = entry.track;
            } else if (peerData.hasScreen && !peerData.hasVideo) {
                screenTrack = entry.track;
            } else if (peerData.hasVideo && !peerData.hasScreen) {
                camTrack = entry.track;
            } else if (!camTrack) {
                camTrack = entry.track;
            } else {
                screenTrack = entry.track;
            }
        });

        peerData.camVideoStream = camTrack ? new MediaStream([camTrack]) : null;
        peerData.screenVideoStream = screenTrack ? new MediaStream([screenTrack]) : null;
    },

    // Classifica com precisão os tracks de áudio recebidos entre Voz do Usuário e Áudio da Transmissão
    syncPeerAudioStreams(peerData) {
        if (!peerData || !peerData.remoteAudioTracks) return;

        const voiceTracks = [];
        const screenTracks = [];

        // Remove tracks que já encerraram
        for (const [trackId, entry] of peerData.remoteAudioTracks.entries()) {
            if (!entry.track || entry.track.readyState !== 'live') {
                peerData.remoteAudioTracks.delete(trackId);
            }
        }

        const entries = Array.from(peerData.remoteAudioTracks.values());
        entries.forEach((entry, index) => {
            const matchesScreenId = Boolean(peerData.screenStreamId && entry.streamId && entry.streamId === peerData.screenStreamId);
            const matchesMicId = Boolean(peerData.micStreamId && entry.streamId && entry.streamId === peerData.micStreamId);
            const differsFromMicId = Boolean(peerData.micStreamId && entry.streamId && entry.streamId !== peerData.micStreamId);

            const isScreenAudio = !matchesMicId && (
                matchesScreenId ||
                entry.isFromVideoStream ||
                differsFromMicId ||
                (index > 0 && voiceTracks.length > 0)
            );

            if (isScreenAudio) {
                screenTracks.push(entry.track);
            } else {
                voiceTracks.push(entry.track);
            }
        });

        peerData.voiceAudioStream = voiceTracks.length > 0 ? new MediaStream(voiceTracks) : null;
        peerData.screenAudioStream = screenTracks.length > 0 ? new MediaStream(screenTracks) : null;
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
            try {
                await pc.setLocalDescription({
                    type: offer.type,
                    sdp: this.enhanceSdpMedia(offer.sdp)
                });
            } catch (sdpErr) {
                console.warn('[WebRTC] Fallback para SDP padrão na oferta:', sdpErr);
                await pc.setLocalDescription(offer);
            }
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

    // Aplica otimizações de Áudio (Opus Estéreo 192 kbps) e Vídeo (720p/1080p nítido 1.5–6 Mbps) no SDP
    enhanceSdpMedia(sdp) {
        return this.enhanceSdpVideo(this.enhanceSdpAudio(sdp));
    },

    // Força bitrate inicial (2.5 Mbps) e mínimo (1.5 Mbps) no vídeo para eliminar pixelização na transmissão
    enhanceSdpVideo(sdp) {
        if (!sdp) return sdp;
        try {
            const lines = sdp.split('\r\n');
            const videoPayloadTypes = new Set();

            for (const line of lines) {
                const match = line.match(/^a=rtpmap:(\d+)\s+(VP8|VP9|H264|AV1)\/90000/i);
                if (match) {
                    videoPayloadTypes.add(match[1]);
                }
            }

            if (videoPayloadTypes.size === 0) return sdp;

            const videoBitrateParams = {
                'x-google-min-bitrate': '1500',
                'x-google-start-bitrate': '2500',
                'x-google-max-bitrate': '6000'
            };

            const fmtpSeen = new Set();
            const result = [];

            for (let i = 0; i < lines.length; i++) {
                let line = lines[i];

                // Garante b=AS:6000 na seção de vídeo
                if (line.startsWith('m=video ')) {
                    result.push(line);
                    continue;
                }

                const fmtpMatch = line.match(/^a=fmtp:(\d+)\s+(.*)$/);
                if (fmtpMatch && videoPayloadTypes.has(fmtpMatch[1])) {
                    const pt = fmtpMatch[1];
                    fmtpSeen.add(pt);
                    const paramMap = new Map();
                    fmtpMatch[2].trim().split(';').forEach(pair => {
                        const trimmed = pair.trim();
                        if (!trimmed) return;
                        const eqIdx = trimmed.indexOf('=');
                        if (eqIdx > 0) {
                            paramMap.set(trimmed.slice(0, eqIdx).trim(), trimmed.slice(eqIdx + 1).trim());
                        }
                    });
                    Object.entries(videoBitrateParams).forEach(([k, v]) => paramMap.set(k, v));
                    const serialized = Array.from(paramMap.entries()).map(([k, v]) => `${k}=${v}`).join(';');
                    result.push(`a=fmtp:${pt} ${serialized}`);
                    continue;
                }

                result.push(line);
            }

            // Adiciona fmtp para codecs de vídeo que ainda não tinham linha fmtp
            const finalLines = [];
            for (const line of result) {
                finalLines.push(line);
                const rtpmapMatch = line.match(/^a=rtpmap:(\d+)\s+(VP8|VP9|H264|AV1)\/90000/i);
                if (rtpmapMatch && !fmtpSeen.has(rtpmapMatch[1])) {
                    const pt = rtpmapMatch[1];
                    fmtpSeen.add(pt);
                    const serialized = Object.entries(videoBitrateParams).map(([k, v]) => `${k}=${v}`).join(';');
                    finalLines.push(`a=fmtp:${pt} ${serialized}`);
                }
            }

            return finalLines.join('\r\n');
        } catch (e) {
            return sdp;
        }
    },

    // Melhora qualidade do codec Opus no SDP (Estéreo + 192 kbps + 48 kHz + FEC) sem duplicar parâmetros
    enhanceSdpAudio(sdp) {
        if (!sdp) return sdp;
        try {
            const lines = sdp.split('\r\n');
            let opusPayloadType = null;

            for (const line of lines) {
                const match = line.match(/^a=rtpmap:(\d+)\s+opus\/48000\/2/i);
                if (match) {
                    opusPayloadType = match[1];
                    break;
                }
            }

            if (!opusPayloadType) return sdp;

            const fmtpPrefix = `a=fmtp:${opusPayloadType} `;
            const desiredParams = {
                stereo: '1',
                'sprop-stereo': '1',
                maxaveragebitrate: '192000',
                maxplaybackrate: '48000',
                useinbandfec: '1',
                usedtx: '0'
            };

            let foundFmtp = false;
            const updatedLines = lines.map(line => {
                if (line.startsWith(fmtpPrefix)) {
                    foundFmtp = true;
                    const existingPart = line.slice(fmtpPrefix.length).trim();
                    const paramMap = new Map();

                    if (existingPart) {
                        existingPart.split(';').forEach(pair => {
                            const trimmed = pair.trim();
                            if (!trimmed) return;
                            const eqIdx = trimmed.indexOf('=');
                            if (eqIdx > 0) {
                                const k = trimmed.slice(0, eqIdx).trim().toLowerCase();
                                const v = trimmed.slice(eqIdx + 1).trim();
                                paramMap.set(k, v);
                            }
                        });
                    }

                    Object.entries(desiredParams).forEach(([k, v]) => paramMap.set(k, v));
                    const serialized = Array.from(paramMap.entries()).map(([k, v]) => `${k}=${v}`).join(';');
                    return `${fmtpPrefix}${serialized}`;
                }
                return line;
            });

            if (!foundFmtp) {
                const rtpmapIndex = updatedLines.findIndex(l => l.startsWith(`a=rtpmap:${opusPayloadType} `));
                if (rtpmapIndex !== -1) {
                    const serialized = Object.entries(desiredParams).map(([k, v]) => `${k}=${v}`).join(';');
                    updatedLines.splice(rtpmapIndex + 1, 0, `${fmtpPrefix}${serialized}`);
                }
            }

            return updatedLines.join('\r\n');
        } catch (e) {
            return sdp;
        }
    },

    // Pipeline Limpo de Alta Fidelidade (Supressor Neural nativo do navegador + High-Pass suave 80 Hz + Noise Gate natural)
    async setupNoiseSuppressionAndVAD(rawStream) {
        try {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            this.audioContext = new AudioContextClass({ sampleRate: 48000 });
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume().catch(() => {});
            }

            const source = this.audioContext.createMediaStreamSource(rawStream);

            // 1. Filtro High-Pass suave (80 Hz, 2ª ordem): corta zumbido grave do ventilador mantendo 100% do timbre natural da voz
            this.highpassFilter = this.audioContext.createBiquadFilter();
            this.highpassFilter.type = 'highpass';
            this.highpassFilter.frequency.value = this.isNoiseSuppressionOn ? 80 : 10;
            this.highpassFilter.Q.value = 0.707;

            // 2. Noise Gate suave (mantém voz 100% pura e limpa ao falar, e silencia o ventilador nas pausas)
            this.noiseGateGain = this.audioContext.createGain();
            this.noiseGateGain.gain.value = 1.0;

            // 3. Retorno de voz para teste do microfone (desligado por padrão)
            this.micTestGain = this.audioContext.createGain();
            this.micTestGain.gain.value = this.isMicTestOn ? 1.0 : 0.0;

            // Analyser para detecção de voz e controle suave do Noise Gate
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 1024;
            this.analyser.smoothingTimeConstant = 0.55;

            const destination = this.audioContext.createMediaStreamDestination();

            // Cadeia ultra-transparente: sem dupla compressão nem distorção espectral
            source.connect(this.highpassFilter);
            this.highpassFilter.connect(this.analyser);
            this.highpassFilter.connect(this.noiseGateGain);
            this.noiseGateGain.connect(destination);
            this.noiseGateGain.connect(this.micTestGain);
            this.micTestGain.connect(this.audioContext.destination);

            const sampleRate = this.audioContext.sampleRate || 48000;
            const binHz = sampleRate / this.analyser.fftSize;
            const voiceBinStart = Math.max(1, Math.floor(180 / binHz));
            const voiceBinEnd = Math.min(this.analyser.frequencyBinCount - 1, Math.ceil(3800 / binHz));

            const timeData = new Float32Array(this.analyser.fftSize);
            const freqBuffer = new Uint8Array(this.analyser.frequencyBinCount);
            this.ambientNoiseFloor = 0.006;
            this.gateIsOpen = true;
            this.lastSpeechTime = Date.now();

            if (this.speechInterval) clearInterval(this.speechInterval);
            this.speechInterval = setInterval(() => {
                if (!this.analyser || !this.audioContext) return;

                if (this.isMuted) {
                    if (this.isSpeaking) {
                        this.isSpeaking = false;
                        this.socket?.emit('voice:speaking', { isSpeaking: false });
                        document.getElementById('peer-tile-self')?.classList.remove('speaking');
                    }
                    return;
                }

                this.analyser.getFloatTimeDomainData(timeData);
                let rmsSum = 0;
                for (let i = 0; i < timeData.length; i++) {
                    rmsSum += timeData[i] * timeData[i];
                }
                const rms = Math.sqrt(rmsSum / timeData.length);

                this.analyser.getByteFrequencyData(freqBuffer);
                let voiceSum = 0;
                const voiceCount = Math.max(1, voiceBinEnd - voiceBinStart + 1);
                for (let i = voiceBinStart; i <= voiceBinEnd; i++) {
                    voiceSum += freqBuffer[i];
                }
                const voiceAvg = (voiceSum / voiceCount) / 255;
                const signalLevel = (voiceAvg * 0.6) + (rms * 0.4);

                const nowMs = Date.now();
                const nowCtx = this.audioContext.currentTime;

                if (this.isNoiseSuppressionOn && this.noiseGateGain) {
                    const openThreshold = Math.max(this.ambientNoiseFloor * 2.1, 0.015);
                    const holdThreshold = Math.max(this.ambientNoiseFloor * 1.4, 0.010);

                    if ((!this.gateIsOpen && signalLevel > openThreshold) || (this.gateIsOpen && signalLevel > holdThreshold)) {
                        this.gateIsOpen = true;
                        this.lastSpeechTime = nowMs;
                        // Ataque instantâneo (5ms) -> zero corte no começo das palavras
                        this.noiseGateGain.gain.setTargetAtTime(1.0, nowCtx, 0.005);
                    } else if (nowMs - this.lastSpeechTime > 550) {
                        this.gateIsOpen = false;
                        this.ambientNoiseFloor = (this.ambientNoiseFloor * 0.97) + (Math.min(signalLevel, 0.035) * 0.03);
                        // Fecha suavemente para silêncio nas pausas
                        this.noiseGateGain.gain.setTargetAtTime(0.0, nowCtx, 0.09);
                    }
                } else if (this.noiseGateGain) {
                    this.gateIsOpen = true;
                    this.noiseGateGain.gain.setTargetAtTime(1.0, nowCtx, 0.02);
                }

                const isSpeakingNow = this.isNoiseSuppressionOn
                    ? this.gateIsOpen
                    : (signalLevel > 0.020);

                if (isSpeakingNow !== this.isSpeaking) {
                    this.isSpeaking = isSpeakingNow;
                    this.socket?.emit('voice:speaking', { isSpeaking: this.isSpeaking });

                    const selfTile = document.getElementById('peer-tile-self');
                    if (selfTile) {
                        selfTile.classList.toggle('speaking', this.isSpeaking);
                    }
                }
            }, 16);

            return destination.stream;
        } catch (e) {
            console.warn('[WebRTC] Pipeline Web Audio não suportado, usando microfone padrão:', e);
            return rawStream;
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
        if (window.App) window.App.playSound(this.isMuted ? 'mute' : 'unmute');
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
                this.isVideoOn = true;
                this.socket.emit('voice:state-update', {
                    hasVideo: true,
                    camStreamId: this.localVideoStream.id
                });
                await this.attachTracksToAllPeers(this.localVideoStream);
            } catch (err) {
                alert('Não foi possível acessar sua câmera.');
                return;
            }
        }

        const videoBtn = document.getElementById('webrtc-video-btn');
        if (videoBtn) videoBtn.classList.toggle('active', this.isVideoOn);

        this.socket.emit('voice:state-update', {
            hasVideo: this.isVideoOn,
            camStreamId: this.isVideoOn && this.localVideoStream ? this.localVideoStream.id : null
        });
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
            // Iniciar compartilhamento de tela em 720p/1080p NÍTIDO (30fps estáveis) e ÁUDIO ESTÉREO HQ
            try {
                try {
                    this.localScreenStream = await navigator.mediaDevices.getDisplayMedia({
                        video: {
                            cursor: 'always',
                            width: { min: 1280, ideal: 1920, max: 1920 },
                            height: { min: 720, ideal: 1080, max: 1080 },
                            frameRate: { ideal: 30, max: 60 }
                        },
                        audio: {
                            echoCancellation: false,
                            noiseSuppression: false,
                            autoGainControl: false,
                            channelCount: 2,
                            sampleRate: 48000,
                            sampleSize: 16
                        }
                    });
                } catch (constraintErr) {
                    // Fallback caso o navegador não aceite constraints avançadas
                    this.localScreenStream = await navigator.mediaDevices.getDisplayMedia({
                        video: { cursor: 'always', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
                        audio: true
                    });
                }

                // Define contentHint = 'motion' para o encoder priorizar fluidez (FPS alto) em jogos e vídeos em vez de slides
                const screenVideoTrack = this.localScreenStream.getVideoTracks()[0];
                if (screenVideoTrack) {
                    try {
                        if ('contentHint' in screenVideoTrack) {
                            screenVideoTrack.contentHint = 'motion';
                        }
                    } catch (e) {}

                    // Caso o usuário clique em "Parar Compartilhamento" nativo do navegador
                    screenVideoTrack.onended = () => {
                        if (this.isScreenSharing) {
                            this.toggleScreenShare();
                        }
                    };
                }

                this.isScreenSharing = true;
                // Avisa os peers o screenStreamId ANTES de renegociar os tracks para separar o áudio da transmissão corretamente
                this.socket.emit('voice:state-update', {
                    hasScreen: true,
                    screenStreamId: this.localScreenStream.id,
                    micStreamId: this.localAudioStream ? this.localAudioStream.id : null
                });

                await this.attachTracksToAllPeers(this.localScreenStream);
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
        const screenAudioSenders = [];
        const voiceAudioSenders = [];
        const screenVideoSenders = [];
        stream.getTracks().forEach(track => {
            this.peerConnections.forEach((pc, socketId) => {
                const senders = pc.getSenders();
                const exists = senders.some(s => s.track && s.track.id === track.id);
                if (!exists) {
                    const sender = pc.addTrack(track, stream);
                    if (stream === this.localScreenStream && sender) {
                        if (track.kind === 'audio') screenAudioSenders.push(sender);
                        if (track.kind === 'video') screenVideoSenders.push(sender);
                    } else if (stream === this.localAudioStream && track.kind === 'audio' && sender) {
                        voiceAudioSenders.push(sender);
                    }
                    modifiedPeers.add(socketId);
                }
            });
        });

        for (const socketId of modifiedPeers) {
            await this.renegotiatePeer(socketId);
        }

        // Garante alta qualidade (128 kbps Opus 48 kHz) na voz dos participantes
        for (const sender of voiceAudioSenders) {
            if (sender && sender.getParameters) {
                try {
                    const params = sender.getParameters();
                    if (!params.encodings || params.encodings.length === 0) {
                        params.encodings = [{}];
                    }
                    params.encodings[0].maxBitrate = 128000;
                    params.encodings[0].networkPriority = 'high';
                    await sender.setParameters(params).catch(() => {});
                } catch (e) {}
            }
        }

        // Otimiza vídeo da transmissão para manter resolução HD (720p/1080p sem pixelizar, até 6 Mbps, 30 fps)
        for (const sender of screenVideoSenders) {
            if (sender && sender.getParameters) {
                try {
                    const params = sender.getParameters();
                    if (!params.encodings || params.encodings.length === 0) {
                        params.encodings = [{}];
                    }
                    params.degradationPreference = 'maintain-resolution';
                    params.encodings[0].scaleResolutionDownBy = 1.0;
                    params.encodings[0].maxBitrate = 6000000;
                    params.encodings[0].maxFramerate = 30;
                    params.encodings[0].networkPriority = 'high';
                    await sender.setParameters(params).catch(() => {});
                } catch (e) {}
            }
        }

        // Aplica bitrate de 192 kbps no áudio da transmissão após a renegociação
        for (const sender of screenAudioSenders) {
            if (sender && sender.getParameters) {
                try {
                    const params = sender.getParameters();
                    if (params.encodings && params.encodings.length > 0) {
                        params.encodings[0].maxBitrate = 192000;
                        await sender.setParameters(params).catch(() => {});
                    }
                } catch (e) {}
            }
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

    // Renderiza todos os cards de vídeo / participantes (preservando o elemento em Tela Cheia)
    renderAllTiles() {
        const grid = document.getElementById('video-grid-container');
        if (!grid) return;

        // Preserva o tile que estiver em Tela Cheia para não sair do fullscreen quando outros entrarem/saírem/compartilharem
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        const preserveFsTile = (fsEl && grid.contains(fsEl)) ? fsEl : null;
        const preserveFsId = preserveFsTile ? preserveFsTile.id : null;
        let preservedTileStillValid = false;

        Array.from(grid.children).forEach(child => {
            if (child !== preserveFsTile) child.remove();
        });

        const currentUser = window.AuthManager ? window.AuthManager.user : { username: 'Você', display_name: 'Você', role: 'user' };
        const canModerate = ['ceo', 'admin', 'moderator'].includes(currentUser.role);

        // Conta quantas telas estão visíveis ao mesmo tempo para evitar sobreposição
        let activeScreensCount = (this.isScreenSharing && this.localScreenStream) ? 1 : 0;
        this.peersData.forEach((peer, socketId) => {
            const hidden = this.hiddenMedia.get(socketId) || { screen: false, video: false };
            const hasLiveScreen = peer.screenVideoStream
                && peer.screenVideoStream.getVideoTracks().some(t => t.readyState === 'live' && !t.muted);
            if (hasLiveScreen && !hidden.screen) {
                activeScreensCount++;
            }
        });
        grid.classList.toggle('multi-screen', activeScreensCount >= 2);

        // 1A. Tile dedicado à nossa própria TRANSMISSÃO DE TELA (quando ativa)
        if (this.isScreenSharing && this.localScreenStream) {
            if (preserveFsId === 'peer-tile-self-screen') {
                preservedTileStillValid = true;
                const vScreen = document.getElementById('self-screen-video');
                if (vScreen && vScreen.srcObject !== this.localScreenStream) {
                    vScreen.srcObject = this.localScreenStream;
                }
            } else {
                const selfScreenTile = document.createElement('div');
                selfScreenTile.id = 'peer-tile-self-screen';
                const selfIsPinned = this.pinnedSocketId === 'self';
                selfScreenTile.className = `participant-tile featured-screen ${selfIsPinned ? 'pinned-screen' : ''}`;
                selfScreenTile.innerHTML = `
                    <video class="participant-video screen-share" id="self-screen-video" autoplay muted playsinline></video>
                    <div class="tile-top-actions">
                        <button type="button" class="tile-action-btn ${selfIsPinned ? 'pinned-active' : ''}" onclick="WebRTCManager.togglePinScreen('self')" title="${selfIsPinned ? 'Remover prioridade' : 'Priorizar esta transmissão (deixar maior)'}">${selfIsPinned ? '📌 Priorizada' : '📌 Priorizar'}</button>
                        <button type="button" class="tile-action-btn" onclick="WebRTCManager.captureScreenshot('self-screen-video', 'tela', 'self')" title="Tirar print desta transmissão">📸 Print</button>
                        <button type="button" class="tile-action-btn" onclick="WebRTCManager.toggleFullscreen('peer-tile-self-screen')" title="Tela cheia">⛶ Tela Cheia</button>
                    </div>
                    <div class="participant-overlay">
                        <span class="participant-tag">Você (Tela)</span>
                        <div class="participant-icons">
                            <span class="state-pill">🖥️</span>
                        </div>
                    </div>
                `;
                grid.appendChild(selfScreenTile);
                const vScreen = document.getElementById('self-screen-video');
                if (vScreen) vScreen.srcObject = this.localScreenStream;
            }
        }

        // 1B. Nosso próprio tile (Webcam ou Avatar — funciona junto com a transmissão de tela!)
        if (preserveFsId === 'peer-tile-self' && this.isVideoOn && this.localVideoStream) {
            preservedTileStillValid = true;
            const vCam = document.getElementById('self-cam-video');
            if (vCam && vCam.srcObject !== this.localVideoStream) {
                vCam.srcObject = this.localVideoStream;
            }
        } else {
            const selfTile = document.createElement('div');
            selfTile.id = 'peer-tile-self';
            selfTile.className = `participant-tile ${this.isSpeaking ? 'speaking' : ''}`;
            
            let selfMediaHtml = '';
            let selfTopButtons = '';

            if (this.isVideoOn && this.localVideoStream) {
                selfMediaHtml = `<video class="participant-video" id="self-cam-video" autoplay muted playsinline></video>`;
                selfTopButtons += `<button type="button" class="tile-action-btn" onclick="WebRTCManager.captureScreenshot('self-cam-video', 'webcam', 'self')" title="Tirar print da câmera">📸</button>`;
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
                    <span class="participant-tag">Você</span>
                    <div class="participant-icons">
                        ${this.isMuted ? '<span class="state-pill">🔇</span>' : ''}
                        ${this.isVideoOn ? '<span class="state-pill">📹</span>' : ''}
                        ${this.isScreenSharing ? '<span class="state-pill">🖥️</span>' : ''}
                    </div>
                </div>
            `;
            grid.appendChild(selfTile);

            if (this.isVideoOn && this.localVideoStream) {
                const vCam = document.getElementById('self-cam-video');
                if (vCam) vCam.srcObject = this.localVideoStream;
            }
        }

        // 2. Tiles dos outros participantes
        this.peersData.forEach((peer, socketId) => {
            const pUser = peer.user || { username: 'Amigo', display_name: 'Amigo' };
            const vols = this.getPeerVolume(socketId);
            const hidden = this.hiddenMedia.get(socketId) || { screen: false, video: false };

            const hasLiveCam = Boolean(
                peer.camVideoStream && peer.camVideoStream.getVideoTracks().some(t => t.readyState === 'live' && !t.muted)
            );
            const hasLiveScreen = Boolean(
                peer.screenVideoStream && peer.screenVideoStream.getVideoTracks().some(t => t.readyState === 'live' && !t.muted)
            );

            const profileClickAttr = pUser.id ? `onclick="window.App.openUserProfileModal(${pUser.id})"` : '';
            const voicePct = Math.round(vols.voice * 100);
            const screenPct = Math.round(vols.screen * 100);
            const isVoicePopoverOpen = this.openVolumePopoverId === `voice-${socketId}`;
            const isScreenPopoverOpen = this.openVolumePopoverId === `screen-${socketId}`;

            // 2A. Tile dedicado à TRANSMISSÃO DE TELA do participante (quando ativa e não oculta)
            if (hasLiveScreen && !hidden.screen) {
                const screenTileId = `peer-tile-${socketId}-screen`;
                if (preserveFsId === screenTileId) {
                    preservedTileStillValid = true;
                    const vidScreen = document.getElementById(`video-screen-${socketId}`);
                    if (vidScreen && vidScreen.srcObject !== peer.screenVideoStream) {
                        vidScreen.srcObject = peer.screenVideoStream;
                        vidScreen.play().catch(() => {});
                    }
                } else {
                    const screenTile = document.createElement('div');
                    screenTile.id = screenTileId;
                    const isPinned = this.pinnedSocketId === socketId;
                    screenTile.className = `participant-tile featured-screen ${isPinned ? 'pinned-screen' : ''}`;

                    let screenButtons = `
                        <button type="button" class="tile-action-btn ${isPinned ? 'pinned-active' : ''}" onclick="WebRTCManager.togglePinScreen('${socketId}')" title="${isPinned ? 'Remover prioridade' : 'Priorizar esta transmissão (deixar maior)'}">${isPinned ? '📌 Priorizada' : '📌 Priorizar'}</button>
                        <button type="button" class="tile-action-btn" onclick="WebRTCManager.captureScreenshot('video-screen-${socketId}', 'tela', '${socketId}')" title="Tirar print desta transmissão">📸 Print</button>
                        <button type="button" class="tile-action-btn" onclick="WebRTCManager.toggleFullscreen('${screenTileId}')" title="Tela cheia">⛶ Tela Cheia</button>
                        <button type="button" class="tile-action-btn" onclick="WebRTCManager.toggleVolumePopover('screen-${socketId}')" title="Ajustar volume da transmissão">🔊 ${screenPct}%</button>
                        <button type="button" class="tile-action-btn" onclick="WebRTCManager.toggleHidePeerMedia('${socketId}', 'screen')" title="Fechar transmissão para mim">✕ Fechar Tela</button>
                    `;
                    if (canModerate) {
                        screenButtons += `<button type="button" class="tile-action-btn danger-action" onclick="WebRTCManager.forceStopPeerMedia('${socketId}', 'screen')" title="Encerrar transmissão para todos">🛑 Encerrar</button>`;
                    }

                    const screenVolumePopoverHtml = `
                        <div class="tile-volume-popover ${isScreenPopoverOpen ? 'open' : ''}" id="vol-popover-screen-${socketId}">
                            <div class="volume-control-row">
                                <label><span>🖥️ Volume da Transmissão</span><span class="vol-screen-label-${socketId}">${screenPct}%</span></label>
                                <input type="range" min="0" max="100" value="${screenPct}" class="volume-slider vol-screen-slider-${socketId}" oninput="WebRTCManager.setPeerVolume('${socketId}', 'screen', this.value)">
                            </div>
                        </div>
                    `;

                    screenTile.innerHTML = `
                        <video class="participant-video screen-share" id="video-screen-${socketId}" autoplay muted playsinline></video>
                        <div class="tile-top-actions">${screenButtons}</div>
                        ${screenVolumePopoverHtml}
                        <div class="participant-overlay">
                            <span class="participant-tag clickable-user" title="Ver perfil" ${profileClickAttr}>${pUser.display_name || pUser.username} (Tela)</span>
                            <div class="participant-icons">
                                <span class="state-pill">🖥️</span>
                            </div>
                        </div>
                    `;
                    grid.appendChild(screenTile);

                    const vidScreen = document.getElementById(`video-screen-${socketId}`);
                    if (vidScreen) {
                        vidScreen.srcObject = peer.screenVideoStream;
                        vidScreen.play().catch(() => {});
                    }
                }
            }

            // 2B. Tile principal do participante (Webcam ou Avatar + Áudio da Voz e da Transmissão)
            const peerTileId = `peer-tile-${socketId}`;
            const showCam = hasLiveCam && !hidden.video;

            if (preserveFsId === peerTileId && showCam) {
                preservedTileStillValid = true;
                const vidCam = document.getElementById(`video-cam-${socketId}`);
                if (vidCam && vidCam.srcObject !== peer.camVideoStream) {
                    vidCam.srcObject = peer.camVideoStream;
                    vidCam.play().catch(() => {});
                }
            } else {
                const peerTile = document.createElement('div');
                peerTile.id = peerTileId;
                peerTile.className = `participant-tile ${peer.isSpeaking ? 'speaking' : ''}`;

                let peerMediaHtml = '';
                if (showCam) {
                    peerMediaHtml = `<video class="participant-video" id="video-cam-${socketId}" autoplay muted playsinline></video>`;
                } else {
                    peerMediaHtml = `
                        <div class="participant-avatar-view">
                            <img src="${pUser.avatar_url || '/assets/default-avatar.png'}" alt="${pUser.display_name}" class="clickable-user" title="Ver perfil" ${profileClickAttr}>
                            ${hasLiveCam && hidden.video ? `<small style="color: var(--text-muted); font-weight: 600;">Câmera oculta</small>` : ''}
                        </div>
                    `;
                }

                let topButtonsHtml = '';
                if (hasLiveScreen && hidden.screen) {
                    topButtonsHtml += `<button type="button" class="tile-action-btn" onclick="WebRTCManager.toggleHidePeerMedia('${socketId}', 'screen')" title="Abrir transmissão">🖥️ Ver Tela</button>`;
                }
                if (hasLiveCam) {
                    if (!hidden.video) {
                        topButtonsHtml += `<button type="button" class="tile-action-btn" onclick="WebRTCManager.captureScreenshot('video-cam-${socketId}', 'webcam', '${socketId}')" title="Tirar print da câmera">📸</button>`;
                        topButtonsHtml += `<button type="button" class="tile-action-btn" onclick="WebRTCManager.toggleFullscreen('${peerTileId}')" title="Tela cheia">⛶</button>`;
                    }
                    topButtonsHtml += `<button type="button" class="tile-action-btn" onclick="WebRTCManager.toggleHidePeerMedia('${socketId}', 'video')" title="${hidden.video ? 'Mostrar câmera' : 'Fechar câmera para mim'}">${hidden.video ? '📹 Ver Câmera' : '✕ Fechar Câmera'}</button>`;
                    if (canModerate) {
                        topButtonsHtml += `<button type="button" class="tile-action-btn danger-action" onclick="WebRTCManager.forceStopPeerMedia('${socketId}', 'video')" title="Desligar câmera para todos">🛑 Desligar</button>`;
                    }
                }
                topButtonsHtml += `<button type="button" class="tile-action-btn" onclick="WebRTCManager.toggleVolumePopover('voice-${socketId}')" title="Ajustar volume do usuário e da transmissão">🔊</button>`;

                const volumePopoverHtml = `
                    <div class="tile-volume-popover ${isVoicePopoverOpen ? 'open' : ''}" id="vol-popover-voice-${socketId}">
                        <div class="volume-control-row">
                            <label><span>🎙️ Voz do Usuário</span><span class="vol-voice-label-${socketId}">${voicePct}%</span></label>
                            <input type="range" min="0" max="100" value="${voicePct}" class="volume-slider vol-voice-slider-${socketId}" oninput="WebRTCManager.setPeerVolume('${socketId}', 'voice', this.value)">
                        </div>
                        <div class="volume-control-row">
                            <label><span>🖥️ Transmissão</span><span class="vol-screen-label-${socketId}">${screenPct}%</span></label>
                            <input type="range" min="0" max="100" value="${screenPct}" class="volume-slider vol-screen-slider-${socketId}" oninput="WebRTCManager.setPeerVolume('${socketId}', 'screen', this.value)">
                        </div>
                    </div>
                `;

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
                        <span class="participant-tag clickable-user" title="Ver perfil" ${profileClickAttr}>${pUser.display_name || pUser.username}</span>
                        <div class="participant-icons">
                            ${peer.isMuted ? '<span class="state-pill">🔇</span>' : ''}
                            ${peer.hasVideo ? '<span class="state-pill">📹</span>' : ''}
                            ${peer.hasScreen ? '<span class="state-pill">🖥️</span>' : ''}
                        </div>
                    </div>
                `;
                grid.appendChild(peerTile);

                if (showCam && peer.camVideoStream) {
                    const vidCam = document.getElementById(`video-cam-${socketId}`);
                    if (vidCam) {
                        vidCam.srcObject = peer.camVideoStream;
                        vidCam.play().catch(() => {});
                    }
                }
            }

            if (peer.voiceAudioStream) {
                const audVoice = document.getElementById(`audio-voice-${socketId}`);
                if (audVoice) {
                    if (audVoice.srcObject !== peer.voiceAudioStream) {
                        audVoice.srcObject = peer.voiceAudioStream;
                    }
                    audVoice.volume = vols.voice;
                    audVoice.muted = this.isDeafened || vols.voice === 0;
                    audVoice.play().catch(() => {});
                }
            }

            if (peer.screenAudioStream) {
                const audScreen = document.getElementById(`audio-screen-${socketId}`);
                if (audScreen) {
                    if (audScreen.srcObject !== peer.screenAudioStream) {
                        audScreen.srcObject = peer.screenAudioStream;
                    }
                    audScreen.volume = vols.screen;
                    audScreen.muted = this.isDeafened || hidden.screen || vols.screen === 0;
                    audScreen.play().catch(() => {});
                }
            }
        });

        // Se o tile que estava em tela cheia não existe mais (transmissão acabou ou pessoa saiu), remove-o
        if (preserveFsTile && !preservedTileStillValid) {
            preserveFsTile.remove();
        }

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

    // Tira print (captura de tela PNG) de um vídeo de transmissão ou webcam
    async captureScreenshot(videoId, mediaType = 'tela', ownerKey = 'self') {
        const videoEl = document.getElementById(videoId);
        if (!videoEl || videoEl.readyState < 2 || !videoEl.videoWidth || !videoEl.videoHeight) {
            if (window.App) window.App.showToast('Aguarde o vídeo carregar para tirar o print.');
            return;
        }

        try {
            const canvas = document.createElement('canvas');
            canvas.width = videoEl.videoWidth;
            canvas.height = videoEl.videoHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

            // Efeito visual rápido de flash no tile
            const tile = videoEl.closest('.participant-tile');
            if (tile) {
                const flash = document.createElement('div');
                flash.className = 'screenshot-flash';
                tile.appendChild(flash);
                setTimeout(() => flash.remove(), 400);
            }

            // Monta nome limpo para o arquivo
            let rawName = 'voce';
            if (ownerKey === 'self') {
                const currentUser = window.AuthManager?.user;
                rawName = currentUser?.username || currentUser?.display_name || 'voce';
            } else {
                const peer = this.peersData.get(ownerKey);
                rawName = peer?.user?.username || peer?.user?.display_name || 'usuario';
            }
            const safeName = String(rawName)
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '') || 'usuario';

            const now = new Date();
            const pad = n => String(n).padStart(2, '0');
            const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
            const fileName = `print-${mediaType}-${safeName}-${timestamp}.png`;

            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            if (!blob) {
                if (window.App) window.App.showToast('Não foi possível gerar o print.');
                return;
            }

            // Download automático do PNG
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);

            // Tenta copiar também para a área de transferência (Ctrl+V)
            let copiedToClipboard = false;
            if (navigator.clipboard && window.ClipboardItem) {
                try {
                    await navigator.clipboard.write([
                        new ClipboardItem({ 'image/png': blob })
                    ]);
                    copiedToClipboard = true;
                } catch (e) {
                    // Ignora silenciosamente se não houver permissão/HTTPS
                }
            }

            if (window.App) {
                window.App.showToast(
                    copiedToClipboard
                        ? '📸 Print salvo e copiado para a área de transferência!'
                        : '📸 Print salvo com sucesso!'
                );
            }
        } catch (err) {
            console.error('[WebRTC] Erro ao tirar print:', err);
            if (window.App) window.App.showToast('Erro ao capturar print da transmissão.');
        }
    },

    toggleVolumePopover(popoverKey) {
        this.openVolumePopoverId = this.openVolumePopoverId === popoverKey ? null : popoverKey;
        document.querySelectorAll('.tile-volume-popover').forEach(el => {
            el.classList.toggle('open', el.id === `vol-popover-${this.openVolumePopoverId}`);
        });
    },

    setPeerVolume(socketId, kind, percentValue) {
        const vol = Math.max(0, Math.min(1, parseInt(percentValue, 10) / 100));
        const pct = Math.round(vol * 100);
        const current = this.getPeerVolume(socketId);
        current[kind] = vol;
        this.peerVolumes.set(socketId, current);

        // Salva no localStorage pelo ID do usuário para lembrar nas próximas calls
        const peer = this.peersData.get(socketId);
        if (peer?.user?.id) {
            this.saveUserVolumePref(peer.user.id, current);
        }

        // Sincroniza labels e sliders em ambos os popovers (card do usuário e card da transmissão)
        document.querySelectorAll(`.vol-${kind}-label-${socketId}`).forEach(el => {
            el.textContent = `${pct}%`;
        });
        document.querySelectorAll(`.vol-${kind}-slider-${socketId}`).forEach(el => {
            if (el.value !== String(pct)) el.value = String(pct);
        });

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
        if (this.rawMicStream) {
            this.rawMicStream.getTracks().forEach(t => t.stop());
            this.rawMicStream = null;
        }
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
        if (this.audioContext) {
            this.audioContext.close().catch(() => {});
            this.audioContext = null;
        }
        this.highpassFilter = null;
        this.highpassFilter2 = null;
        this.spectralWorkletNode = null;
        this.presenceFilter = null;
        this.lowpassFilter = null;
        this.noiseGateGain = null;
        this.micTestGain = null;
        this.gateIsOpen = false;
        this.isMicTestOn = false;
        document.getElementById('webrtc-mic-test-btn')?.classList.remove('active');

        this.peerConnections.forEach(pc => pc.close());
        this.peerConnections.clear();
        this.pendingCandidates.clear();
        this.makingOffer.clear();
        this.peerVolumes.clear();
        this.hiddenMedia.clear();
        this.openVolumePopoverId = null;
        this.pinnedSocketId = null;
        this.peersData.clear();

        // Para toque de chamada se estiver tocando e toca som de desconexão
        if (window.App) {
            window.App.stopRinging();
            window.App.playSound('leave');
            window.App.showHomeView();
        }
    },

    // Iniciar chamada 1-a-1 com amigo
    startDirectCall(friendId, hasVideo) {
        this.isDirectCall = true;
        this.socket.emit('call:initiate', { recipientId: friendId, hasVideo });
        this.showRoomView(`Chamando amigo...`);
        if (window.App) {
            window.App.startRinging('outgoing');
            window.App.showToast(`Iniciando chamada com ${hasVideo ? 'câmera' : 'voz'}...`);
        }
    },

    // Aceitar chamada 1-a-1 recebida
    async acceptCall(callerSocketId, hasVideo) {
        document.getElementById('incoming-call-banner').style.display = 'none';
        if (window.App) {
            window.App.stopRinging();
            window.App.playSound('join');
        }
        this.isDirectCall = true;
        this.socket.emit('call:accept', { callerSocketId, hasVideo });
    }
};

window.WebRTCManager = WebRTCManager;
