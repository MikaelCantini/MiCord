// ===================================================================
// SUPRESSOR DE RUÍDO ESPECTRAL EM TEMPO REAL (AudioWorkletProcessor)
// Algoritmo: STFT (512 pts, 50% overlap, sqrt-Hann) + Filtro de Wiener
// com SNR A-Priori (Decision-Directed) otimizado para ruído de ventilador,
// ar-condicionado e chiado estacionário de microfone.
// ===================================================================

class SpectralNoiseSuppressorProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            {
                name: 'enabled',
                defaultValue: 1,
                minValue: 0,
                maxValue: 1,
                automationRate: 'k-rate'
            }
        ];
    }

    constructor() {
        super();
        this.N = 512;
        this.HOP = 256;
        this.BINS = this.N / 2 + 1; // 257 bins (DC até Nyquist)

        // Janela sqrt-Hann para reconstrução perfeita (COLA) em análise + síntese
        this.window = new Float32Array(this.N);
        for (let i = 0; i < this.N; i++) {
            this.window[i] = Math.sqrt(0.5 * (1 - Math.cos((2 * Math.PI * i) / this.N)));
        }

        // Tabelas pré-calculadas para FFT radix-2 (N = 512)
        this.bitRev = new Uint16Array(this.N);
        const bits = 9; // log2(512)
        for (let i = 0; i < this.N; i++) {
            let x = i;
            let r = 0;
            for (let b = 0; b < bits; b++) {
                r = (r << 1) | (x & 1);
                x >>= 1;
            }
            this.bitRev[i] = r;
        }
        this.cosTable = new Float32Array(this.N / 2);
        this.sinTable = new Float32Array(this.N / 2);
        for (let i = 0; i < this.N / 2; i++) {
            const angle = (-2 * Math.PI * i) / this.N;
            this.cosTable[i] = Math.cos(angle);
            this.sinTable[i] = Math.sin(angle);
        }

        // Buffers de entrada/saída para Overlap-Add
        this.inBuffer = new Float32Array(this.N);
        this.inFill = 0;
        this.outOverlap = new Float32Array(this.N);
        this.outQueue = new Float32Array(this.N * 2);
        this.outRead = 0;
        this.outWrite = 0;
        this.outCount = 0;

        // Buffers de trabalho da FFT
        this.re = new Float32Array(this.N);
        this.im = new Float32Array(this.N);

        // Estado do estimador de ruído estacionário (ventilador / ar-condicionado)
        this.noisePsd = new Float32Array(this.BINS);
        this.prevGain = new Float32Array(this.BINS);
        this.prevPower = new Float32Array(this.BINS);
        this.smoothGain = new Float32Array(this.BINS);
        this.frameCount = 0;
        this.prevGain.fill(1.0);
        this.smoothGain.fill(1.0);
    }

    fft(re, im, inverse) {
        const N = this.N;
        for (let i = 0; i < N; i++) {
            const j = this.bitRev[i];
            if (j > i) {
                let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
                tmp = im[i]; im[i] = im[j]; im[j] = tmp;
            }
        }

        for (let size = 2; size <= N; size <<= 1) {
            const half = size >> 1;
            const step = N / size;
            for (let i = 0; i < N; i += size) {
                let k = 0;
                for (let j = 0; j < half; j++) {
                    const cos = this.cosTable[k];
                    const sin = inverse ? -this.sinTable[k] : this.sinTable[k];
                    const idx1 = i + j;
                    const idx2 = idx1 + half;
                    const tRe = re[idx2] * cos - im[idx2] * sin;
                    const tIm = re[idx2] * sin + im[idx2] * cos;
                    re[idx2] = re[idx1] - tRe;
                    im[idx2] = im[idx1] - tIm;
                    re[idx1] += tRe;
                    im[idx1] += tIm;
                    k += step;
                }
            }
        }

        if (inverse) {
            const invN = 1 / N;
            for (let i = 0; i < N; i++) {
                re[i] *= invN;
                im[i] *= invN;
            }
        }
    }

    processFrame(isEnabled) {
        const N = this.N;
        const BINS = this.BINS;

        // Aplica janela de análise sqrt-Hann
        for (let i = 0; i < N; i++) {
            this.re[i] = this.inBuffer[i] * this.window[i];
            this.im[i] = 0;
        }

        if (isEnabled) {
            this.fft(this.re, this.im, false);
            this.frameCount++;

            const eps = 1e-10;
            const alphaDD = 0.92;       // Decision-directed smoothing (evita "musical noise")
            const overSub = 2.4;        // Subtração agressiva para ruído constante de ventilador
            const gainFloor = 0.015;    // Atenuação máxima ~ -36 dB em bins de ruído puro

            // Calcula energia média na faixa de fala (bins 3..40 ≈ 280 Hz - 3750 Hz) para detectar silêncio global
            let speechBandRatioSum = 0;
            let speechBandCount = 0;

            for (let k = 0; k < BINS; k++) {
                const power = this.re[k] * this.re[k] + this.im[k] * this.im[k];

                // Calibração rápida inicial (~20 frames = ~100ms) para travar no ruído do ventilador
                if (this.frameCount <= 20) {
                    const w = 1 / this.frameCount;
                    this.noisePsd[k] = this.noisePsd[k] * (1 - w) + power * w;
                } else {
                    const ratio = power / (this.noisePsd[k] + eps);
                    if (k >= 3 && k <= 40) {
                        speechBandRatioSum += Math.min(ratio, 20);
                        speechBandCount++;
                    }

                    // Atualização adaptativa do perfil de ruído (acompanha ventilador ligado/mudança de velocidade)
                    if (ratio < 2.2) {
                        // Provavelmente ruído estacionário (sem fala neste bin) -> atualiza perfil mais rápido
                        this.noisePsd[k] = this.noisePsd[k] * 0.94 + power * 0.06;
                    } else if (power < this.noisePsd[k]) {
                        this.noisePsd[k] = this.noisePsd[k] * 0.90 + power * 0.10;
                    } else {
                        // Fala presente neste bin -> acompanha muito devagar para não engolir a voz
                        this.noisePsd[k] = this.noisePsd[k] * 0.9985 + power * 0.0015;
                    }
                }

                const noise = this.noisePsd[k] + eps;
                const snrPost = power / noise;
                const prevSnr = (this.prevGain[k] * this.prevGain[k] * this.prevPower[k]) / noise;
                const instSnr = Math.max(snrPost - 1.0, 0.0);
                const snrPrior = alphaDD * prevSnr + (1.0 - alphaDD) * instSnr;

                // Ganho espectral de Wiener com oversubtraction para ventilador
                let gain = snrPrior / (snrPrior + overSub);

                // Atenuação extra abaixo de 120 Hz (bins 0..1) onde mora o motor do ventilador
                if (k <= 1) {
                    gain *= 0.1;
                }

                if (gain < gainFloor) gain = gainFloor;
                if (gain > 1.0) gain = 1.0;

                // Suavização temporal do ganho (ataque rápido, queda suave)
                const smoothCoeff = gain > this.smoothGain[k] ? 0.55 : 0.25;
                this.smoothGain[k] = this.smoothGain[k] * (1 - smoothCoeff) + gain * smoothCoeff;
                const g = this.smoothGain[k];

                this.prevGain[k] = g;
                this.prevPower[k] = power;

                // Aplica ganho simétrico na FFT real
                this.re[k] *= g;
                this.im[k] *= g;
                if (k > 0 && k < N / 2) {
                    this.re[N - k] *= g;
                    this.im[N - k] *= g;
                }
            }

            this.fft(this.re, this.im, true);
        }

        // Janela de síntese sqrt-Hann + Overlap-Add
        for (let i = 0; i < N; i++) {
            this.outOverlap[i] += this.re[i] * this.window[i];
        }

        // Move os primeiros HOP samples prontos para a fila de saída
        const qLen = this.outQueue.length;
        for (let i = 0; i < this.HOP; i++) {
            this.outQueue[this.outWrite] = this.outOverlap[i];
            this.outWrite = (this.outWrite + 1) % qLen;
            this.outCount++;
        }

        // Desloca o overlap restante para o início
        this.outOverlap.copyWithin(0, this.HOP);
        this.outOverlap.fill(0, N - this.HOP);
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];
        if (!input || !input[0] || !output || !output[0]) {
            return true;
        }

        const inChan = input[0];
        const outChan = output[0];
        const isEnabled = parameters.enabled[0] >= 0.5;
        const qLen = this.outQueue.length;

        for (let i = 0; i < inChan.length; i++) {
            this.inBuffer[this.inFill++] = inChan[i];

            if (this.inFill === this.N) {
                this.processFrame(isEnabled);
                // Desloca metade da janela (overlap 50%)
                this.inBuffer.copyWithin(0, this.HOP);
                this.inFill = this.N - this.HOP;
            }

            if (this.outCount > 0) {
                outChan[i] = this.outQueue[this.outRead];
                this.outRead = (this.outRead + 1) % qLen;
                this.outCount--;
            } else {
                outChan[i] = 0;
            }
        }

        return true;
    }
}

registerProcessor('spectral-noise-suppressor', SpectralNoiseSuppressorProcessor);
