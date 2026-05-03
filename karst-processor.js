class KarstProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.ready = false;
        this.port.onmessage = (e) => {
            if (e.data.type === 'init') {
                this._boot(e.data.wasmBuffer).catch(err =>
                    this.port.postMessage({ type: 'error', message: err.message })
                );
            }
        };
    }

    async _boot(wasmBuffer) {
        const memory = new WebAssembly.Memory({ initial: 512 });

        const stubs = {
            __assert_fail:        () => {},
            __cxa_throw:          () => {},
            _abort_js:            () => {},
            emscripten_resize_heap: (size) => {
                const pages = Math.ceil((size - memory.buffer.byteLength) / 65536);
                if (pages > 0) memory.grow(pages);
                return 1;
            }
        };

        const { instance } = await WebAssembly.instantiate(wasmBuffer, {
            env:                    { memory, ...stubs },
            wasi_snapshot_preview1: {}
        });

        const exp = instance.exports;
        exp.__wasm_call_ctors();

        // Carve output buffers from stack before karst_init
        const bufBytes = 128 * 4;
        this.outR = exp._emscripten_stack_alloc(bufBytes);
        this.outL = exp._emscripten_stack_alloc(bufBytes);

        exp.karst_init(sampleRate);

        this.exports = exp;
        this.memory  = memory;
        this.ready   = true;
        this.port.postMessage({ type: 'ready' });
    }

    process(inputs, outputs) {
        if (!this.ready) return true;
        const out       = outputs[0];
        const blockSize = out[0].length;
        this.exports.karst_process(this.outL, this.outR, blockSize);
        const heap = new Float32Array(this.memory.buffer);
        const lOff = this.outL >>> 2;
        const rOff = this.outR >>> 2;
        for (let i = 0; i < blockSize; i++) {
            out[0][i] = heap[lOff + i];
            if (out[1]) out[1][i] = heap[rOff + i];
        }
        return true;
    }
}

registerProcessor('karst-processor', KarstProcessor);
