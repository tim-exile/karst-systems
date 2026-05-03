class KarstProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.ready = false;
        this.port.onmessage = (e) => {
            if (e.data.type === 'init') {
                this.exports = e.data.exports;
                this.memory = e.data.memory;
                this.outL = e.data.outL;
                this.outR = e.data.outR;
                this.ready = true;
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
        return true;
    }
}

registerProcessor('karst-processor', KarstProcessor);
