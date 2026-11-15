// embedding worker：在独立线程里跑 transformers/ONNX，避开宿主主线程的模块钩子。
import { parentPort, workerData } from 'node:worker_threads';
import { env, pipeline } from '@huggingface/transformers';

const { model, dtype, cacheDir, remoteHost, allowRemote = true, dim = 512 } = workerData ?? {};

function post(msg) {
  parentPort.postMessage(msg);
}

try {
  if (cacheDir) env.cacheDir = cacheDir;
  if (remoteHost) env.remoteHost = String(remoteHost).replace(/\/+$/, '');
  if (!allowRemote) env.allowRemoteModels = false;
  const pipe = await pipeline('feature-extraction', model, { dtype });
  post({ type: 'ready', dim });

  parentPort.on('message', async (msg) => {
    if (msg?.type !== 'embed') return;
    try {
      const out = await pipe(Array.from(msg.texts), { pooling: 'mean', normalize: true });
      const rows = out.dims[0];
      const d = out.dims[1];
      const buf = out.data;
      const vectors = [];
      for (let r = 0; r < rows; r++) {
        vectors.push(Array.from(buf.subarray(r * d, (r + 1) * d)));
      }
      post({ type: 'result', id: msg.id, vectors });
    } catch (err) {
      post({ type: 'error', id: msg.id, error: String(err?.message ?? err) });
    }
  });
} catch (err) {
  post({ type: 'fatal', error: String(err?.message ?? err), stack: String(err?.stack ?? '') });
}
