/* ====================================================================
 * Pikafish WASM — Service Worker
 *   - 离线支持：首次访问把所有静态资源预缓存到 Cache Storage
 *   - 资源更新：使用 stale-while-revalidate
 *       命中缓存 → 立即返回旧版本给页面（保证离线可用）
 *       后台再 fetch 一次（cache:'no-cache' 强制重新校验）
 *       若服务器返回 200 且与缓存版本不同 → 写入新缓存并通知页面
 *   - 用户点击「刷新」后页面重新加载，引擎会用到最新 WASM
 * ==================================================================== */

"use strict";

const CACHE_NAME = "pikafish-cache-20260619";

/* 需要预缓存的静态资源（相对 SW 的 URL） */
const ASSETS = [
  "./",
  "./index.html",
  "./worker.js",
  "./wasm/pikafish.js",
  "./wasm/pikafish.wasm"
];

/* ---------- 安装：预缓存 + 立即进入等待状态以便快速激活 ---------- */
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

/* ---------- 抓取：stale-while-revalidate ---------- */
self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  /* 只处理同源请求；跨源资源（如 CDN）由浏览器自行处理 */
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.match(req).then(function (cached) {
        var networkUpdate = fetch(req, { cache: "no-cache" })
          .then(function (resp) {
            if (resp && resp.ok) {
              /* 比对 ETag / Last-Modified 以判断是否真的更新 */
              var oldTag = cached
                ? (cached.headers.get("etag") || cached.headers.get("last-modified") || "")
                : "";
              var newTag = resp.headers.get("etag") || resp.headers.get("last-modified") || "";
              if (cached && oldTag !== newTag) {
                /* 通知所有受控页面 */
                return self.clients.matchAll({ type: "window", includeUncontrolled: true })
                  .then(function (clients) {
                    clients.forEach(function (c) {
                      c.postMessage({ type: "CACHE_UPDATED", url: req.url });
                    });
                  })
                  .then(function () { return cache.put(req, resp.clone()); })
                  .then(function () { return resp; });
              }
              return cache.put(req, resp.clone()).then(function () { return resp; });
            }
            return resp;
          })
          .catch(function () { return cached; });

        /* 命中缓存立刻返回旧版本给页面，保证响应速度与离线可用 */
        return cached || networkUpdate;
      });
    })
  );
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
