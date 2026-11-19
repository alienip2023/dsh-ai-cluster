export const FRAME_RTT_CAPACITY = 30

export class FrameRttRing {
  #samples = []

  push(ms) {
    this.#samples.push(ms)
    if (this.#samples.length > FRAME_RTT_CAPACITY) this.#samples.shift()
  }

  snapshot() {
    return this.#samples.slice()
  }
}
