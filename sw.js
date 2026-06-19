/* ====================================================================
 * Pikafish WASM — Service Worker
 *   - 离线支持：首次访问把所有静态资源预缓存到 Cache Storage
 *   - 引擎文件（WASM/JS）→ Network First + cache:"reload"，
 *     强绕开 HTTP 缓存，确保引擎更新后用户立即获取新版
 *   - 其他资源 → stale-while-revalidate
 *   - 资源 URL 带 ?v=ENGINE_VERSION 防止任何代理/CDN 缓存命中旧版
 * ==================================================================== */

"use strict";

/* 引擎版本号：每次重新编译 WASM/JS 后必须同步更新 */
const ENGINE_VERSION = "20260619";
const CACHE_NAME = "pikafish-cache-" + ENGINE_VERSION;

/* 引擎文件路径（pathname 是绝对路径，不带 "./" 前缀） */
const ENGINE_FILES = [
  "/wasm/pikafish.js",
  "/wasm/pikafish.wasm"
];

/* 需要预缓存的静态资源（引擎文件带 ?v= 强绕 HTTP/代理 缓存） */
const ASSETS = [
  "./",
  "./index.html",
  "./worker.js",
  "./wasm/pikafish.js?v=" + ENGINE_VERSION,
  "./wasm/pikafish.wasm?v=" + ENGINE_VERSION
];

/* 判断是否为引擎文件 */
function isEngineFile(urlPath) {
  for (var i = 0; i < ENGINE_FILES.length; i++) {
    if (urlPath.indexOf(ENGINE_FILES[i]) >= 0) return true;
  }
  return false;
}

/* ---------- 安装：预缓存 + 跳过等待 ----------
 * 关键点：用 fetch(url, { cache: "reload" }) 替代 cache.addAll，
 * 强制绕开浏览器 HTTP 缓存（连 304 协商都不会发生），保证 precache 永远是最新版本。
 */
self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) {
        return Promise.all(ASSETS.map(function (url) {
          return fetch(url, { cache: "reload" })
            .then(function (resp) {
              if (resp && resp.ok) {
                return cache.put(url, resp);
              }
            })
            .catch(function () { /* 单个资源失败不阻塞整体 */ });
        }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

/* ---------- 激活：清理旧缓存 + 立刻接管所有打开的页面 ---------- */
self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (key) { return key !== CACHE_NAME; })
            .map(function (key) { return caches.delete(key); })
        );
      })
      .then(function () { return self.clients.claim(); })
  );
});

/* ---------- 抓取 ----------
 * 引擎文件 → Network First + cache:"reload"（强绕 HTTP 缓存）
 * 其他资源 → Cache First + stale-while-revalidate
 */
self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  /* 只处理同源请求；跨源资源（如 CDN）由浏览器自行处理 */
  if (url.origin !== self.location.origin) return;

  if (isEngineFile(url.pathname)) {
    /* ---- 引擎文件：Network First + cache:"reload" ---- */
    event.respondWith(
      caches.open(CACHE_NAME).then(function (cache) {
        return fetch(req, { cache: "reload" }).then(function (resp) {
          if (resp && resp.ok) {
            cache.put(req, resp.clone());
            return resp;
          }
          return cache.match(req);
        }).catch(function () {
          return cache.match(req);
        });
      })
    );
  } else {
    /* ---- 其他资源：Cache First + stale-while-revalidate ---- */
    event.respondWith(
      caches.open(CACHE_NAME).then(function (cache) {
        return cache.match(req).then(function (cached) {
          var networkUpdate = fetch(req, { cache: "no-cache" })
            .then(function (resp) {
              if (resp && resp.ok) {
                return cache.put(req, resp.clone()).then(function () { return resp; });
              }
              return resp;
            })
            .catch(function () { return cached; });

          return cached || networkUpdate;
        });
      })
    );
  }
});

/* ---------- 来自页面的指令 ---------- */
self.addEventListener("message", function (event) {
  var data = event.data || {};
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
  } else if (data.type === "CLEAR_CACHE") {
    event.waitUntil(
      caches.delete(CACHE_NAME)
        .then(function () {
          return self.clients.matchAll();
        })
        .then(function (list) {
          list.forEach(function (c) {
            c.postMessage({ type: "CACHE_CLEARED" });
          });
        })
    );
  }
});
