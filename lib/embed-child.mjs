// embedding 子进程：把 transformers/ONNX 放进独立进程，避免与宿主的原生库撞名
import { env, pipeline } from '@huggingface/transformers';

const model = process.env.TM_MODEL || 'Xenova/bge-small-zh-v1.5';
const dtype = process.env.TM_DTYPE || 'q8';
const cacheDir = process.env.TM_CACHE_DIR || '';
const remoteHost = process.env.TM_REMOTE_HOST || '';
const allowRemote = process.env.TM_ALLOW_REMOTE !== '0';
const dim = Number(process.env.TM_DIM || 512);

const send = (msg) => {
  try {
    process.send?.(msg);
  } catch {
    /* 父进程已退出 */
  }
};

try {
  if (cacheDir) env.cacheDir = cacheDir;
  if (remoteHost) env.remoteHost = String(remoteHost).replace(/\/+$/, '');
  if (!allowRemote) env.allowRemoteModels = false;
  const pipe = await pipeline('feature-extraction', model, { dtype });
  send({ type: 'ready', dim });

  process.on('message', async (msg) => {
    if (msg?.type !== 'embed') return;
    try {
      const out = await pipe(Array.from(msg.texts), { pooling: 'mean', normalize: true });
      const rows = out.dims[0];
      const d = out.dims[1];
      const buf = out.data;
      const vectors = [];
      for (let r = 0; r < rows; r++) vectors.push(Array.from(buf.subarray(r * d, (r + 1) * d)));
      send({ type: 'result', id: msg.id, vectors });
    } catch (err) {
      send({ type: 'error', id: msg.id, error: String(err?.message ?? err) });
    }
  });
} catch (err) {
  send({ type: 'fatal', error: String(err?.message ?? err), stack: String(err?.stack ?? '') });
  setTimeout(() => process.exit(1), 50);
}
