// Подменяет window.storage на версию поверх localStorage.
// Форма методов такая же, как в артефактах Claude (get/set/delete/list,
// async, результат {key, value, shared}), поэтому весь твой useShiftsStore
// (очередь мутаций, offline-логика, pump()) переносится без изменений —
// он просто продолжает звать window.storage.get/set как раньше.
//
// Важно: как и в оригинальном API, get() на отсутствующий ключ бросает
// ошибку, а не возвращает null — это уже учтено в твоём load() через try/catch.

const PREFIX = "wm:";

function readRaw(key) {
  return localStorage.getItem(PREFIX + key);
}

window.storage = {
  async get(key, shared = false) {
    const raw = readRaw(key);
    if (raw === null) {
      throw new Error(`Key not found: ${key}`);
    }
    return JSON.parse(raw);
  },

  async set(key, value, shared = false) {
    const result = { key, value, shared: !!shared };
    localStorage.setItem(PREFIX + key, JSON.stringify(result));
    return result;
  },

  async delete(key, shared = false) {
    const existed = readRaw(key) !== null;
    localStorage.removeItem(PREFIX + key);
    return { key, deleted: existed, shared: !!shared };
  },

  async list(prefix = "", shared = false) {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX + prefix)) {
        keys.push(k.slice(PREFIX.length));
      }
    }
    return { keys, prefix, shared: !!shared };
  },
};
