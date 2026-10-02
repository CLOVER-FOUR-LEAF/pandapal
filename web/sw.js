/* PandaButler service worker：装到桌面像 APP 一样打开，断网时还能翻已经看过的档案。
 *
 * 策略一律「网络优先、断网回缓存」——在线时永远是最新数据，AI 输出从不走缓存
 * （晨报/聊天/周报这些 LLM 端点不在白名单里，断网就如实失败，证明是实时生成）。
 *
 * 隐私：档案类 API 的缓存键带上 token 哈希，同一台设备上孩子和家长各看各的缓存，
 * 家长账号断网时拿不到孩子视角（含悄悄话）的响应。退出登录 token 即作废，旧缓存再也命中不了。
 */
const SHELL = "pb-shell-v1";
const DATA = "pb-data-v1";
// 只缓存只读档案端点；LLM 生成、鉴权、导出、调用记录一律不缓存
const API_CACHEABLE = /\/api\/(memory|affairs|graph|history|checklist\/|drafts|growth)/;
const DATA_MAX = 60;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL, DATA]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function tokenTag(req) {
  const auth = req.headers.get("Authorization") || "";
  if (!auth) return "anon";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(auth));
  return Array.from(new Uint8Array(buf).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - DATA_MAX; i++) await cache.delete(keys[i]);
}

async function networkFirst(req, cacheName, key) {
  const cache = await caches.open(cacheName);
  try {
    const resp = await fetch(req);
    if (resp.ok) {
      await cache.put(key, resp.clone());
      if (cacheName === DATA) trim(cache);
    }
    return resp;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if ((req.headers.get("accept") || "").includes("text/event-stream")) return;

  if (url.pathname.includes("/api/")) {
    if (!API_CACHEABLE.test(url.pathname)) return;
    e.respondWith((async () => {
      const tag = await tokenTag(req);
      const key = `${url.pathname}${url.search}${url.search ? "&" : "?"}__k=${tag}`;
      return networkFirst(req, DATA, key);
    })());
    return;
  }
  // 页面与静态资源（含 3D 依赖）：网络优先，断网用上次的版本把壳子撑起来
  if (req.mode === "navigate" || url.pathname.includes("/static/")) {
    const key = req.mode === "navigate" ? new URL("./", self.location).href : req.url;
    e.respondWith(networkFirst(req, SHELL, key));
  }
});
