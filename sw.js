/* ====================================================================
 * Pikafish WASM — Service Worker
 *   引擎文件（WASM/JS）不缓存，每次访问都重新下载，确保永远最新。
 *   其他资源仍然预缓存，保证离线可用。
 *   每次安装新 SW 都会清理旧缓存。
 * ==================================================================== */

"use strict";

/* 每次更新此版本号即可强制浏览器安装新 SW，清理旧缓存 */
const SW_VERSION = "20260619";
const CACHE_NAME = "pikafish-cache-" + SW_VERSION;

/* 需要预缓存的静态资源（引擎文件不在这里） */
const ASSETS = [
  "./",
  "./index.html",
  "./worker.js"
];

/* 判断是否为引擎文件 */
function isEngineFile(urlPath) {
  return urlPath.indexOf("/wasm/pikafish.js") >= 0 ||
         urlPath.indexOf("/wasm/pikafish.wasm") >= 0;
}

/* ---------- 安装：预缓存非引擎资源 + 跳过等待 ---------- */
self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(ASSETS); })
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
 * 引擎文件 → 不缓存，直接 fetch，不带缓存
 * 其他资源 → Cache First + stale-while-revalidate
 */
self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (isEngineFile(url.pathname)) {
    /* ---- 引擎文件：不缓存，每次重新下载 ---- */
    event.respondWith(
      fetch(req, { cache: "no-store" })
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
