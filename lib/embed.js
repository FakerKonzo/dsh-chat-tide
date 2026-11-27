// embedding 模块：优先 fork 子进程跑 ONNX（独立地址空间，避开原生库撞名）；主进程兜底默认关闭，默认不跑 ONNX。
import { defaultModelsDir } from './const.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Worker } from 'node:worker_threads';
import { fork } from 'node:child_process';

export const DEFAULT_MODEL = 'Xenova/bge-small-zh-v1.5';
export const DEFAULT_DIM = 512;

function defaultCacheDir() {
  // 放在数据目录而不是包内：重装/升级不会把模型一起删掉，也不用每次重新下载
  return process.env.MODEL_CACHE_DIR ?? defaultModelsDir();
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
      TM_ALLOW_REMOTE: opts.allowRemote === false ? '0' : '1',
      TM_DIM: String(opts.dim ?? DEFAULT_DIM),
    },
  });

  let seq = 0;
  const pending = new Map();
  let ready = false;
  let fatal = null;
  let closing = false;
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
      fail(new Error(msg.error));
      return;
    }
    const slot = pending.get(msg?.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.type === 'result') slot.resolve(msg.vectors.map((v) => Float32Array.from(v)));
    else slot.reject(new Error(msg.error ?? 'embed failed'));
  });
  const fail = (error) => {
    fatal ??= error;
    resolveReady(false);
    for (const slot of pending.values()) slot.reject(fatal);
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', (code, signal) => fail(new Error(`embedding child exited (code=${code}, signal=${signal ?? '-'})`)));

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
      if (closing) return;
      closing = true;
      fail(new Error('embedding child disposed'));
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
      allowRemote: opts.allowRemote !== false,
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
      fail(new Error(msg.error));
      return;
    }
    const slot = pending.get(msg?.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.type === 'result') slot.resolve(msg.vectors.map((v) => Float32Array.from(v)));
    else slot.reject(new Error(msg.error ?? 'embed failed'));
  });
  const fail = (err) => {
    fatal ??= err;
    resolveReady(false);
    for (const slot of pending.values()) slot.reject(err);
    pending.clear();
  };
  worker.on('error', fail);
  worker.on('exit', (code) => fail(new Error(`embedding worker exited (code=${code})`)));

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
      fail(new Error('embedding worker disposed'));
      void worker.terminate();
    },
  };
}

async function createInlineEmbedder(opts) {
  const { env, pipeline } = await import('@huggingface/transformers');
  env.cacheDir = opts.cacheDir ?? defaultCacheDir();
  const host = opts.remoteHost || process.env.HF_ENDPOINT;
  if (host) env.remoteHost = String(host).replace(/\/+$/, '');
  if (opts.allowRemote === false) env.allowRemoteModels = false;
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
    dispose() { void pipe.dispose(); },
  };
}

/** 每个插件实例持有自己的模型，重载时旧实例只能释放自己的子进程。 */
export function createEmbedderManager() {
  let cached = null;
  let loading = null;
  let lastError = null;
  function resetEmbedder() {
    if (loading) {
      loading.cancelled = true;
      loading.impl?.dispose();
      loading = null;
    }
    cached?.value.dispose();
    cached = null;
    lastError = null;
  }
  async function getEmbedder(opts = {}) {
    const key = JSON.stringify([opts.model ?? DEFAULT_MODEL, opts.dtype ?? 'q8', opts.cacheDir ?? defaultCacheDir(),
      opts.dim ?? DEFAULT_DIM, opts.remoteHost, opts.allowRemote, opts.useChild, opts.useWorker, opts.allowInline]);
    if (cached?.key === key && cached.value.ready) return cached.value;
    if (loading?.key === key) return loading.promise;
    resetEmbedder();
    const ticket = { key, impl: null, cancelled: false };
    loading = ticket;
    ticket.promise = loadEmbedder(opts, ticket).then((value) => {
      if (loading === ticket) {
        if (value.ready) cached = { key, value };
        lastError = value.error;
      } else if (value.ready) {
        value.dispose();
      }
      return value;
    }).finally(() => {
      if (loading === ticket) loading = null;
    });
    return ticket.promise;
  }
  return { getEmbedder, resetEmbedder, embedderError: () => lastError };
}
export const { getEmbedder, resetEmbedder, embedderError } = createEmbedderManager();

async function loadEmbedder(opts, ticket) {
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
  let lastError = null;
  // 优先子进程：独立地址空间，不会把 transformers 自带的 libvips 带进宿主进程
  if (opts.useChild !== false) {
    try {
      impl = ticket.impl = createChildEmbedder(opts);
      const ok = await impl.waitReady();
      if (!ok) {
        lastError = impl.error ?? 'child embedder 未就绪';
        diag(opts, new Error(`child embedder 未就绪: ${impl.error ?? 'unknown'}`));
        impl.dispose();
        impl = null;
      }
    } catch (err) {
      lastError = err?.message ?? String(err);
      diag(opts, err);
      impl?.dispose?.();
      impl = null;
    }
  }

  // worker 线程与宿主共享地址空间，会加载同名 libvips 与宿主 sharp 冲突，仅显式要求时启用
  if (!ticket.cancelled && !impl && opts.useWorker === true) {
    try {
      impl = ticket.impl = createWorkerEmbedder(opts);
      const ok = await impl.waitReady();
      if (!ok) {
        lastError = impl.error ?? 'worker embedder 未就绪';
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

  if (!ticket.cancelled && !impl && opts.allowInline === true) {
    // 主进程兜底是最后手段：一旦它加载 onnxruntime，原生库就被宿主占住，
    // 之后卸载本插件会删不掉文件（插件页升级会卡在「移除旧插件」）。
    try {
      impl = await createInlineEmbedder(opts);
    } catch (err) {
      diag(opts, err);
      impl = null;
    }
  }

  if (ticket.cancelled) {
    if (impl && impl !== ticket.impl) impl.dispose();
    state.error = 'embedding load cancelled';
    return state;
  }
  if (!impl) {
    // 拉不起来就明说，不要偷偷换个实现把原生库拖进宿主进程
    const why = String(lastError ?? '未知原因').split('\n')[0].trim().replace(/[。．.\s]+$/, '');
    state.error = `向量模型不可用：${why}。模型 ${opts.model ?? DEFAULT_MODEL} 需要先在 ${opts.cacheDir ?? defaultCacheDir()} 可用；` +
      `可以联网下载一次，或把模型文件放进该目录。主进程兜底默认关闭（embedding.allowInline）。`;
    state.waitReady = async () => false;
    diag(opts, new Error(state.error));
    return state;
  }

  Object.defineProperty(state, 'ready', { get: () => impl.isReady });
  state.kind = impl.kind;
  state.name = impl.name;
  state.dim = impl.dim;
  state.embed = (texts) => impl.embed(texts);
  state.waitReady = async () => impl.isReady;
  state.dispose = () => impl.dispose?.();
  return state;
}
