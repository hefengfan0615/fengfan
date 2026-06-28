/* ====================================================================
 * Pikafish 象棋小巫师 — Service Worker
 *   引擎文件（WASM/JS）也缓存，使用 Cache First + stale-while-revalidate。
 *   后台会用 no-cache 重新校验引擎；若服务器返回新版（URL 的 v= 参数
 *   或内容发生变化），自动更新缓存并通过 postMessage 通知页面刷新。
 *   其他静态资源预缓存，实现离线运行。
 *   每次安装新 SW 都会清理旧缓存。
 * ==================================================================== */

"use strict";

/* 引擎版本：workflow 每次构建会自动同步为最新 wasm 的版本字符串 */
var ENGINE_VERSION = "20260628-132232";
var ENGINE_QUERY   = "?v=" + ENGINE_VERSION;

/* 每次更新此版本号即可强制浏览器安装新 SW，清理旧缓存 */
var SW_VERSION = ENGINE_VERSION;
var CACHE_NAME = "pikafish-xqwlight-" + SW_VERSION;

/* 需要预缓存的静态资源（包含引擎文件） */
var ASSETS = [
  "./",
  "./pikafish.html",
  "./book.js",
  "./position.js",
  "./board.js",
  "./cchess.js",
  "./pikafish-engine.js",
  "./worker.js",
  /* -- 引擎文件：分两个变体，前端按浏览器支持情况选择加载 --
   *  pikafish.relaxed.{js,wasm}    => wasm32-relaxed-simd（更快；要求 Chrome 119+ / Firefox 121+ / Safari 17.4+）
   *  pikafish.{js,wasm}            => wasm32（兼容老浏览器，作为回退） */
  "./wasm/pikafish.relaxed.js" + ENGINE_QUERY,
  "./wasm/pikafish.relaxed.wasm" + ENGINE_QUERY,
  "./wasm/pikafish.js" + ENGINE_QUERY,
  "./wasm/pikafish.wasm" + ENGINE_QUERY,
  "./wasm/pikafish.nnue",   // NNUE 固定 URL，引擎更新时不变，命中离线缓存
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

/* 判断是否为引擎文件（含 relaxed 与非 relaxed 两个变体） */
function isEngineFile(urlPath) {
  return urlPath.indexOf("/wasm/pikafish.relaxed.js") >= 0 ||
         urlPath.indexOf("/wasm/pikafish.relaxed.wasm") >= 0 ||
         urlPath.indexOf("/wasm/pikafish.js") >= 0 ||
         urlPath.indexOf("/wasm/pikafish.wasm") >= 0 ||
         urlPath.indexOf("/wasm/pikafish.nnue") >= 0;
}

/* ---------- 安装：预缓存资源 + 跳过等待 ---------- */
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

/* 通知所有页面：有新版本可用 */
function notifyUpdate() {
  self.clients.matchAll({ type: "window" }).then(function (clients) {
    clients.forEach(function (client) {
      client.postMessage({ type: "CACHE_UPDATED" });
    });
  });
}

/* ---------- 抓取 ----------
 * 引擎文件 → Cache First + stale-while-revalidate
 *             命中缓存立即返回，同时后台 fetch 校验并自动替换新版。
 * 其他资源 → Cache First + stale-while-revalidate
 */
self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (isEngineFile(url.pathname)) {
    /* ---- 引擎文件：Cache First + 后台重新校验 ---- */
    event.respondWith(
      caches.open(CACHE_NAME).then(function (cache) {
        return cache.match(req).then(function (cached) {
          var networkUpdate = fetch(req, { cache: "no-cache" })
            .then(function (resp) {
              if (resp && resp.ok) {
                /* 如果和缓存里的不一样，就替换并通知刷新 */
                if (cached) {
                  var h1 = cached.headers.get("ETag") || cached.headers.get("Last-Modified");
                  var h2 = resp.headers.get("ETag") || resp.headers.get("Last-Modified");
                  if (h1 !== h2) {
                    notifyUpdate();
                  }
                } else {
                  notifyUpdate();
                }
                return cache.put(req, resp.clone()).then(function () { return resp; });
              }
              return cached || resp || new Response("Engine unavailable", { status: 503 });
            })
            .catch(function () { return cached || new Response("Engine unavailable", { status: 503 }); });

          return cached || networkUpdate;
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
              return cached || resp || new Response("Resource unavailable", { status: 503 });
            })
            .catch(function () { return cached || new Response("Resource unavailable", { status: 503 }); });

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
