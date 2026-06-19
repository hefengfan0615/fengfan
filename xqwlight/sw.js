/* ====================================================================
 * Pikafish 象棋小巫师 — Service Worker
 *   预缓存所有静态资源，实现完全离线运行。
 *   引擎文件（WASM/JS）使用 Network First + cache:'reload' 策略 —
 *   强制绕开浏览器 HTTP 缓存，确保引擎更新后用户立即获取新版。
 *   其他静态资源使用 Cache First + stale-while-revalidate。
 *   资源 URL 带 ?v=ENGINE_VERSION 防止任何代理/CDN 缓存命中旧版。
 * ==================================================================== */

"use strict";

/* 引擎版本号：每次重新编译 WASM/JS 后必须同步更新 */
var ENGINE_VERSION = "20260619";
var CACHE_NAME = "pikafish-xqwlight-" + ENGINE_VERSION;

/* 引擎文件路径（注意：pathname 是绝对路径，形如 /xqwlight/wasm/pikafish.wasm，
 * 不带 "./" 前缀，否则 indexOf 永远匹配不到） */
var ENGINE_FILES = [
  "/wasm/pikafish.js",
  "/wasm/pikafish.wasm"
];

/* 所有需要预缓存的静态资源（引擎文件带版本号，避免命中代理/CDN 旧缓存） */
var ASSETS = [
  "./",
  "./pikafish.html",
  "./book.js",
  "./position.js",
  "./board.js",
  "./cchess.js",
  "./pikafish-engine.js",
  "./worker.js",
  /* -- 引擎文件（带 ?v= 强绕 HTTP/代理 缓存） -- */
  "./wasm/pikafish.js?v=" + ENGINE_VERSION,
  "./wasm/pikafish.wasm?v=" + ENGINE_VERSION,
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

/* 判断是否为引擎文件（pathname 形如 /xqwlight/wasm/pikafish.wasm） */
function isEngineFile(urlPath) {
  for (var i = 0; i < ENGINE_FILES.length; i++) {
    if (urlPath.indexOf(ENGINE_FILES[i]) >= 0) return true;
  }
  return false;
}

/* ---------- 安装：预缓存 + 跳过等待 ----------
 * 关键点：用 fetch(url, { cache: "reload" }) 替代 cache.addAll，
 * 强制绕开浏览器 HTTP 缓存（包括 304 协商缓存），确保 precache 永远是最新版本。
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
 * 引擎文件 → Network First + cache:"reload"（始终从网络拉取，绕开 HTTP 缓存）
 * 其他资源 → Cache First + stale-while-revalidate
 */
self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
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
          // 网络返回非 2xx → 回退缓存
          return cache.match(req);
        }).catch(function () {
          // 离线/网络异常 → 回退缓存
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
