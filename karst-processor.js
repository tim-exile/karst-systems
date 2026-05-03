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
                    this._boot(e.data.wasmBuffer, e.data.patchJson || null).catch(err =>
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

    _readString(ptr, len) {
        const bytes = new Uint8Array(this.memory.buffer, ptr, len);
        let s = '';
        for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[i]);
        return s;
    }

    async _boot(wasmBuffer, patchJson) {
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

        // Load patch if provided
        if (patchJson) {
            const jsonBuf = exp.malloc(patchJson.length + 1);
            const heap    = new Uint8Array(exp.memory.buffer);
            for (let i = 0; i < patchJson.length; i++)
                heap[jsonBuf + i] = patchJson.charCodeAt(i);
            heap[jsonBuf + patchJson.length] = 0;
            exp.karst_load_patch(jsonBuf, patchJson.length);
            exp.free(jsonBuf);
        }

        // Read param paths (registry order) → build path→index map
        const pathsBufSize = 32768;
        const pathsBuf     = exp.malloc(pathsBufSize);
        const pathsLen     = exp.karst_get_registry_paths_json(pathsBuf, pathsBufSize);
        const paramPaths   = pathsLen > 0 ? JSON.parse(this._readString(pathsBuf, pathsLen)) : [];
        exp.free(pathsBuf);

        // Read scenes
        const sceneCount   = exp.karst_get_scene_count();
        const scenes       = [];
        const sceneBufSize = 65536;
        const sceneBuf     = exp.malloc(sceneBufSize);
        for (let si = 0; si < sceneCount; si++) {
            const len = exp.karst_get_scene_json(si, sceneBuf, sceneBufSize);
            if (len > 0)
                scenes.push(JSON.parse(this._readString(sceneBuf, len)));
        }
        exp.free(sceneBuf);

        this.ready = true;
        this.port.postMessage({ type: 'ready', scenes, paramPaths });
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

        const snapshotPtr = exp.karst_get_param_snapshot();
        const heap32      = new Float32Array(this.memory.buffer);
        const snapOff     = snapshotPtr >>> 2;
        const snap        = [];
        for (let i = 0; i < 12; i++) snap.push(heap32[snapOff + i]);

        this.blockCount++;
        if (this.blockCount % 2 === 0) {
            this.port.postMessage({
                type:       'peaks',
                peakSynth:  this.peakSynth,
                peakDrum:   this.peakDrum,
                peakHat:    this.peakHat,
                peakMaster: this.peakMaster,
                snap
            });
        }
        return true;
    }
}

registerProcessor('karst-processor', KarstProcessor);
