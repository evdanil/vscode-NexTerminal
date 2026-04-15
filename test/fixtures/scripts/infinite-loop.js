/**
 * @nexus-script
 * @name Infinite loop fixture
 * @description Drives the termination-latency test — a tight loop the runtime must be able to kill within ~100 ms.
 */

while (true) {
  // busy loop — no awaits, no I/O. worker.terminate() must interrupt this.
}
