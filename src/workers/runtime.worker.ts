import { SyncNativeIO } from '../services/nativeMount';
import { executeWasm } from '../services/wasiRuntime';
import { ProcessOutput } from '../services/processOutput';

self.onmessage = async ({ data }) => {
  const control = new Int32Array(data.stdinControl);
  const input = new Uint8Array(data.stdinData);
  const output = new ProcessOutput(data.output);
  const stdin = () => {
    while (true) {
      const read = Atomics.load(control, 0), write = Atomics.load(control, 1);
      if (read !== write) { const byte = input[read]; Atomics.store(control, 0, (read + 1) % input.length); Atomics.notify(control, 0); return byte; }
      if (Atomics.load(control, 2)) return -1;
      Atomics.wait(control, 1, write);
    }
  };
  try {
    const code = await executeWasm(data.module || data.bytes, new SyncNativeIO(data.port), stdin, (fd, bytes) => output.write(fd, bytes), data.cwd, data.args, data.program);
    self.postMessage({ type: 'exit', code });
  } catch (error: any) { self.postMessage({ type: 'error', message: error.message || String(error) }); }
};
