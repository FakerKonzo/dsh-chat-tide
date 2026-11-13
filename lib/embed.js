// embedding 模块：优先 worker 线程跑 ONNX；失败回退主线程；再失败降级 null。
import { fileURLToPath } from 'node:url';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fork } from 'node:child_process';

export const DEFAULT_MODEL = 'Xenova/bge-small-zh-v1.5';
export const DEFAULT_DIM = 512;

let cached = null;
let loadError = null;

function defaultCacheDir() {
  return process.env.MODEL_CACHE_DIR ?? fileURLToPath(new URL('../.cache/models', import.meta.url));
}

function diag(opts, err) {
  try {
    if (!opts?.logFile) return;
    mkdirSync(dirname(opts.logFile), { recursive: true });
    appendFileSync(opts.logFile, `[${new Date().toISOString()}] ${err?.stack ?? err}\n`);
  } catch {
    /* 诊断失败不影响主流程 */
  }
}

/**
 * 子进程嵌入器：与宿主进程隔离。
 * 之所以不用 worker 线程：线程共享进程地址空间，transformers 会顺带加载它自带的
 * libvips（old sharp），与宿主自带的新版 sharp 撞 DLL 同名，导致宿主图像管线报
 * "The specified procedure could not be found"。
 */
function createChildEmbedder(opts) {
  const child = fork(new URL('./embed-child.mjs', import.meta.url), [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'advanced',
    // --input-type 不能带给子进程（文件入口会报 ERR_INPUT_TYPE_NOT_ALLOWED）
    execArgv: [],
    env: {
      ...process.env,
      TM_MODEL: opts.model ?? DEFAULT_MODEL,
      TM_DTYPE: opts.dtype ?? 'q8',
      TM_CACHE_DIR: opts.cacheDir ?? defaultCacheDir(),
      TM_REMOTE_HOST: opts.remoteHost ?? process.env.HF_ENDPOINT ?? '',
      TM_DIM: String(opts.dim ?? DEFAULT_DIM),
    },
  });

  let seq = 0;
  const pending = new Map();
  let ready = false;
  let fatal = null;
  let resolveReady;
  const readyPromise = new Promise((res) => {
    resolveReady = res;
  });

  child.on('message', (msg) => {
    if (msg?.type === 'ready') {
      ready = true;
      resolveReady(true);
      return;
    }
    if (msg?.type === 'fatal') {
      fatal = new Error(msg.error);
      resolveReady(false);
      return;
    }
    const slot = pending.get(msg?.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.type === 'result') slot.resolve(msg.vectors.map((v) => Float32Array.from(v)));
    else slot.reject(new Error(msg.error ?? 'embed failed'));
  });
  child.on('error', (err) => {
    fatal = err;
    resolveReady(false);
    for (const slot of pending.values()) slot.reject(err);
    pending.clear();
  });
  child.on('exit', (code) => {
    if (ready && !fatal) return;
    fatal = fatal ?? new Error('embedding child exited with code ' + code);
    resolveReady(false);
    for (const slot of pending.values()) slot.reject(fatal);
    pending.clear();
  });

  return {
    kind: 'child',
    name: opts.model ?? DEFAULT_MODEL,
    dim: opts.dim ?? DEFAULT_DIM,
    waitReady() {
      return readyPromise;
    },
    get error() {
      return fatal?.message ?? null;
    },
    get isReady() {
      return ready && !fatal;
    },
    embed(texts) {
      if (fatal) return Promise.reject(fatal);
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          child.send({ type: 'embed', id, texts: Array.from(texts) });
        } catch (err) {
          pending.delete(id);
          reject(err);
        }
      });
    },
    dispose() {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    },
  };
}

function createWorkerEmbedder(opts) {
  const worker = new Worker(new URL('./embed-worker.mjs', import.meta.url), {
    workerData: {
      model: opts.model ?? DEFAULT_MODEL,
      dtype: opts.dtype ?? 'q8',
      cacheDir: opts.cacheDir ?? defaultCacheDir(),
      remoteHost: opts.remoteHost ?? process.env.HF_ENDPOINT ?? '',
      dim: opts.dim ?? DEFAULT_DIM,
    },
  });

  let seq = 0;
  const pending = new Map();
  let ready = false;
  let fatal = null;
  let resolveReady;
  const readyPromise = new Promise((res) => {
    resolveReady = res;
  });

  worker.on('message', (msg) => {
    if (msg?.type === 'ready') {
      ready = true;
      resolveReady(true);
      return;
    }
    if (msg?.type === 'fatal') {
      fatal = new Error(msg.error);
      resolveReady(false);
      return;
    }
    const slot = pending.get(msg?.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.type === 'result') slot.resolve(msg.vectors.map((v) => Float32Array.from(v)));
    else slot.reject(new Error(msg.error ?? 'embed failed'));
  });
  worker.on('error', (err) => {
    fatal = err;
    resolveReady(false);
    for (const slot of pending.values()) slot.reject(err);
    pending.clear();
  });

  return {
    kind: 'worker',
    name: opts.model ?? DEFAULT_MODEL,
    dim: opts.dim ?? DEFAULT_DIM,
    waitReady() {
      return readyPromise;
    },
    get error() {
      return fatal?.message ?? null;
    },
    get isReady() {
      return ready && !fatal;
    },
    embed(texts) {
      if (fatal) return Promise.reject(fatal);
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ type: 'embed', id, texts: Array.from(texts) });
      });
    },
    dispose() {
      void worker.terminate();
    },
  };
}

async function createInlineEmbedder(opts) {
  const { env, pipeline } = await import('@huggingface/transformers');
  env.cacheDir = opts.cacheDir ?? defaultCacheDir();
  const host = opts.remoteHost || process.env.HF_ENDPOINT;
  if (host) env.remoteHost = String(host).replace(/\/+$/, '');
  const pipe = await pipeline('feature-extraction', opts.model ?? DEFAULT_MODEL, { dtype: opts.dtype ?? 'q8' });
  return {
    kind: 'inline',
    name: opts.model ?? DEFAULT_MODEL,
    dim: opts.dim ?? DEFAULT_DIM,
    isReady: true,
    error: null,
    async waitReady() {
      return true;
    },
    async embed(texts) {
      const out = await pipe(Array.from(texts), { pooling: 'mean', normalize: true });
      const rows = out.dims[0];
      const d = out.dims[1];
      const buf = out.data;
      const vecs = [];
      for (let r = 0; r < rows; r++) vecs.push(Float32Array.from(buf.subarray(r * d, (r + 1) * d)));
      return vecs;
    },
    dispose() {},
  };
}

/**
 * 惰性加载单例。返回 { ready, embed, dim, name, error }。
 * ready 为同步快照；调用方应 await waitReady() 再判断。
 */
export async function getEmbedder(opts = {}) {
  const key = `${opts.model ?? DEFAULT_MODEL}:${opts.dtype ?? 'q8'}`;
  if (cached && cached.key === key) return cached.value;

  const state = {
    ready: false,
    dim: opts.dim ?? DEFAULT_DIM,
    name: opts.model ?? DEFAULT_MODEL,
    error: null,
    embed: null,
    waitReady: async () => false,
    dispose() {},
  };

  let impl = null;
  // 优先子进程：独立地址空间，不会把 transformers 自带的 libvips 带进宿主进程
  if (opts.useChild !== false) {
    try {
      impl = createChildEmbedder(opts);
      const ok = await impl.waitReady();
      if (!ok) {
        diag(opts, new Error(`child embedder 未就绪: ${impl.error ?? 'unknown'}`));
        impl.dispose();
        impl = null;
      }
    } catch (err) {
      diag(opts, err);
      impl?.dispose?.();
      impl = null;
    }
  }

  // worker 线程与宿主共享地址空间，会加载同名 libvips 与宿主 sharp 冲突，仅显式要求时启用
  if (!impl && opts.useWorker === true) {
    try {
      impl = createWorkerEmbedder(opts);
      const ok = await impl.waitReady();
      if (!ok) {
        diag(opts, new Error(`worker embedder 未就绪: ${impl.error ?? 'unknown'}`));
        impl.dispose();
        impl = null;
      }
    } catch (err) {
      diag(opts, err);
      impl?.dispose?.();
      impl = null;
    }
  }

  if (!impl) {
    try {
      impl = await createInlineEmbedder(opts);
    } catch (err) {
      state.error = err?.message ?? String(err);
      state.waitReady = async () => false;
      loadError = state.error;
      diag(opts, err);
      cached = null;
      return state;
    }
  }

  state.ready = true;
  state.kind = impl.kind;
  state.name = impl.name;
  state.dim = impl.dim;
  state.embed = (texts) => impl.embed(texts);
  state.waitReady = async () => true;
  state.dispose = () => impl.dispose?.();
  cached = { key, value: state };
  return state;
}

export function embedderError() {
  return loadError;
}

export function resetEmbedder() {
  cached?.value?.dispose?.();
  cached = null;
  loadError = null;
}
