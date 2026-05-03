class KarstProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.ready      = false;
        this.exports    = null;
        this.memory     = null;
        this.outL       = 0;
        this.outR       = 0;
        this.pathBuf    = 0;
        this.peakSynth  = 0;
        this.peakDrum   = 0;
        this.peakHat    = 0;
        this.peakMaster = 0;
        this.blockCount = 0;

        this.port.onmessage = (e) => {
            switch (e.data.type) {
                case 'init':
                    this._boot(e.data.wasmBuffer).catch(err =>
                        this.port.postMessage({ type: 'error', message: err.message })
                    );
                    break;
                case 'setParam':
                    if (this.exports) {
                        try { this._setParam(e.data.path, e.data.value); }
                        catch(err) { this.port.postMessage({ type: 'error', message: 'setParam ' + e.data.path + ': ' + err.message }); }
                    }
                    break;
                case 'setPlaying':
                    if (this.exports) this.exports.karst_set_playing(e.data.value);
                    break;
            }
        };
    }

    _setParam(path, value) {
        const heap = new Uint8Array(this.memory.buffer);
        for (let j = 0; j < path.length; j++)
            heap[this.pathBuf + j] = path.charCodeAt(j);
        heap[this.pathBuf + path.length] = 0;
        this.exports.karst_set_param(this.pathBuf, value);
    }

    async _boot(wasmBuffer) {
        let mem = null;
        const stubs = {
            __assert_fail:          () => {},
            __cxa_throw:            () => {},
            _abort_js:              () => {},
            emscripten_resize_heap: (size) => {
                if (!mem) return 0;
                const pages = Math.ceil((size - mem.buffer.byteLength) / 65536);
                if (pages > 0) mem.grow(pages);
                return 1;
            }
        };

        const { instance } = await WebAssembly.instantiate(wasmBuffer, {
            env:                    { memory: new WebAssembly.Memory({ initial: 1 }), ...stubs },
            wasi_snapshot_preview1: {}
        });

        const exp = instance.exports;
        mem = exp.memory;
        exp.__wasm_call_ctors();

        const bufBytes   = 128 * 4;
        this.outL        = exp.malloc(bufBytes);
        this.outR        = exp.malloc(bufBytes);
        this.pathBuf     = exp.malloc(256);

        exp.karst_init(sampleRate);

        this.exports = exp;
        this.memory  = exp.memory;
        this.ready   = true;
        this.port.postMessage({ type: 'ready' });
    }

    process(inputs, outputs) {
        if (!this.ready) return true;
        const exp       = this.exports;
        const out       = outputs[0];
        const blockSize = out[0].length;

        exp.karst_process(this.outL, this.outR, blockSize);

        const heap = new Float32Array(this.memory.buffer);
        const lOff = this.outL >>> 2;
        const rOff = this.outR >>> 2;
        for (let i = 0; i < blockSize; i++) {
            out[0][i] = heap[lOff + i];
            if (out[1]) out[1][i] = heap[rOff + i];
        }

        const rawSynth  = exp.karst_get_peak_synth();
        const rawDrum   = exp.karst_get_peak_drum();
        const rawHat    = exp.karst_get_peak_hat();
        const rawMaster = exp.karst_get_peak_master();

        this.peakSynth  = Math.max(rawSynth,  this.peakSynth  * 0.92);
        this.peakDrum   = Math.max(rawDrum,   this.peakDrum   * 0.85);
        this.peakHat    = Math.max(rawHat,    this.peakHat    * 0.75);
        this.peakMaster = Math.max(rawMaster, this.peakMaster * 0.96);

        this.blockCount++;
        if (this.blockCount % 2 === 0) {
            this.port.postMessage({
                type:       'peaks',
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
