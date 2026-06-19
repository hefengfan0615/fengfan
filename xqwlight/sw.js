/* ====================================================================
 * Pikafish 象棋小巫师 — Service Worker
 *   预缓存所有静态资源，实现完全离线运行。
 *   引擎文件（WASM/JS）使用 Network First 策略 — 确保引擎更新后
 *   用户立即获取新版，仅在离线时回退到缓存。
 *   其他静态资源使用 Cache First + stale-while-revalidate。
 * ==================================================================== */

"use strict";

var CACHE_NAME = "pikafish-xqwlight-v2";

/* 引擎文件路径（需要 Network First 策略，保证即时更新） */
var ENGINE_FILES = [
  "./wasm/pikafish.js",
  "./wasm/pikafish.wasm"
];

/* 所有需要预缓存的静态资源 */
var ASSETS = [
  "./",
  "./pikafish.html",
  "./book.js",
  "./position.js",
  "./board.js",
  "./cchess.js",
  "./pikafish-engine.js",
  "./worker.js",
  /* -- 引擎文件也在预缓存列表中（用于离线回退） -- */
  "./wasm/pikafish.js",
  "./wasm/pikafish.wasm",
  /* -- 棋子/棋盘图片 -- */
  "./images/board.jpg",
  "./images/thinking.gif",
  "./images/rk.gif", "./images/rkm.gif",
  "./images/ra.gif", "./images/rb.gif", "./images/rn.gif",
  "./images/rr.gif", "./images/rc.gif", "./images/rp.gif",
  "./images/bk.gif", "./images/bkm.gif",
  "./images/ba.gif", "./images/bb.gif", "./images/bn.gif",
  "./images/br.gif", "./images/bc.gif", "./images/bp.gif",
  "./images/oo.gif", "./images/oos.gif",
  /* -- 音效 -- */
  "./sounds/move.wav", "./sounds/capture.wav", "./sounds/check.wav",
  "./sounds/move2.wav", "./sounds/capture2.wav", "./sounds/check2.wav",
  "./sounds/click.wav", "./sounds/illegal.wav",
  "./sounds/win.wav", "./sounds/loss.wav", "./sounds/draw.wav",
  "./sounds/newgame.wav"
];

/* 判断是否为引擎文件 */
function isEngineFile(urlPath) {
  for (var i = 0; i < ENGINE_FILES.length; i++) {
    if (urlPath.indexOf(ENGINE_FILES[i]) >= 0) return true;
  }
  return false;
}

/* ---------- 安装：预缓存 + 跳过等待 ---------- */
self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

/* ---------- 激活：清理旧缓存 + 立即接管 ---------- */
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
 * 引擎文件 → Network First（始终从网络获取，离线回退缓存）
 * 其他资源 → Cache First + stale-while-revalidate
 */
self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (isEngineFile(url.pathname)) {
    /* ---- 引擎文件：Network First ---- */
    event.respondWith(
      caches.open(CACHE_NAME).then(function (cache) {
        return fetch(req, { cache: "no-cache" }).then(function (resp) {
          if (resp && resp.ok) {
            // 检测是否与缓存不同
            return cache.match(req).then(function (cached) {
              var oldTag = cached
                ? (cached.headers.get("etag") || cached.headers.get("last-modified") || "")
                : "";
              var newTag = resp.headers.get("etag") || resp.headers.get("last-modified") || "";
              cache.put(req, resp.clone());
              if (cached && oldTag !== newTag) {
                // 通知页面引擎已更新
                self.clients.matchAll({ type: "window", includeUncontrolled: true })
                  .then(function (clients) {
                    clients.forEach(function (c) {
                      c.postMessage({ type: "ENGINE_UPDATED", url: req.url });
                    });
                  });
              }
              return resp;
            });
          }
          // 网络失败 → 回退缓存
          return cache.match(req);
        }).catch(function () {
          // 完全离线
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