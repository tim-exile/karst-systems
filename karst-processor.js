class KarstProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.ready   = false;
        this.exports = null;
        this.memory  = null;
        this.outL    = 0;
        this.outR    = 0;
        this.blockCount = 0;
        this.peakDrum   = 0;
        this.peakHat    = 0;
        this.peakSynth  = 0;
        this.peakMaster = 0;
        this.port.onmessage = (e) => {
            if (e.data.type === 'init') {
                this.exports = e.data.exports;
                this.memory  = e.data.memory;
                this.outL    = e.data.outL;
                this.outR    = e.data.outR;
                this.ready   = true;
            } else if (e.data.type === 'playing') {
                if (this.exports) this.exports.karst_set_playing(e.data.value);
            }
        };
    }

    process(inputs, outputs) {
        if (!this.ready) return true;
        const out = outputs[0];
        const blockSize = out[0].length;

        this.exports.karst_process(this.outL, this.outR, blockSize);

        const heap = new Float32Array(this.memory.buffer);
        const lOff = this.outL >>> 2;
        const rOff = this.outR >>> 2;
        for (let i = 0; i < blockSize; i++) {
            out[0][i] = heap[lOff + i];
            if (out[1]) out[1][i] = heap[rOff + i];
        }

        // Per-instrument peaks with envelope followers
        const rawSynth  = this.exports.karst_get_peak_synth();
        const rawDrum   = this.exports.karst_get_peak_drum();
        const rawHat    = this.exports.karst_get_peak_hat();
        const rawMaster = this.exports.karst_get_peak_master();

        this.peakSynth  = Math.max(rawSynth,  this.peakSynth  * 0.92);
        this.peakDrum   = Math.max(rawDrum,   this.peakDrum   * 0.85);
        this.peakHat    = Math.max(rawHat,    this.peakHat    * 0.75);
        this.peakMaster = Math.max(rawMaster, this.peakMaster * 0.96);

        this.blockCount++;
        if (this.blockCount % 2 === 0) {
            this.port.postMessage({
                type: 'peaks',
                peakSynth:  this.peakSynth,
                peakDrum:   this.peakDrum,
                peakHat:    this.peakHat,
                peakMaster: this.peakMaster
            });
        }
        return true;
    }
}
registerProcessor('karst-processor', KarstProcessor);
