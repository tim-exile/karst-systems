class KarstProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.ready = false;
        this.errorReported = false;
        this.port.onmessage = (e) => {
            if (e.data.type === 'init') {
                this._boot(e.data.wasmBuffer).catch(err =>
                    this.port.postMessage({ type: 'error', message: 'boot: ' + err.message })
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

        // Use malloc (heap) instead of stack alloc — more reliable across JS/WASM boundary
        const bufBytes = 128 * 4;
        this.outL = exp.malloc(bufBytes);
        this.outR = exp.malloc(bufBytes);

        const spNow = exp.emscripten_stack_get_current();
        this.port.postMessage({
            type: 'debug',
            sp: spNow,
            outL: this.outL,
            outR: this.outR,
            memBytes: memory.buffer.byteLength
        });

        exp.karst_init(sampleRate);

        this.exports = exp;
        this.memory  = memory;
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
        return true;
    }
}

registerProcessor('karst-processor', KarstProcessor);
