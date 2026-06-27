/* ======================================================================
 *  pikafish-engine.js — Pikafish UCI 引擎桥接层
 *
 *  提供与 board.js 兼容的 Search 接口，
 *  内部通过 Web Worker 与 Pikafish WASM 引擎通信（UCI 协议）。
 *
 *  用法：
 *    var search = new PikafishUciSearch(pos, hashLevel);
 *    search.init(wasmBinary, engineJs).then(() => { ... });
 *    // 然后 board.js 会调用 search.searchMain(depth, millis)
 * ====================================================================== */

"use strict";

/* ---------- 坐标转换 (xqwlight ↔ UCI) ----------
 *
 * xqwlight:
 *   棋盘 256 格 (16x16)，有效范围: x=3..11, y=3..12
 *   COORD_XY(x, y) = x + (y << 4)
 *   FILE_X(sq) = sq & 15,  RANK_Y(sq) = sq >> 4
 *   FEN: y=3 对应第 1 行（黑方底线 rank9）
 *        y=12 对应第 10 行（红方底线 rank0）
 *
 * Pikafish (UCI):
 *   Square: 0..89, make_square(f, r) = r * 9 + f
 *   file: 0='a'..8='i', rank: 0='0'..9='9'
 *   UCI 坐标: 'a'+file + '0'+rank  例如 "e2"
 *   FEN 第 1 行 = rank9, 第 10 行 = rank0
 *
 * 映射:
 *   uciFile = xqwX - 3           (3→0, 11→8)
 *   uciRank = 12 - xqwY          (3→9, 12→0)
 *   xqwX = uciFile + 3
 *   xqwY = 12 - uciRank
 * ====================================================================== */

/* 将 xqwlight 内部 move 转为 UCI 字符串 (如 "e2e4") */
function xqwMoveToUci(mv) {
  if (!mv) return "";
  var sqSrc = mv & 255;
  var sqDst = mv >> 8;
  var srcFile = (sqSrc & 15) - 3;       // FILE_X - FILE_LEFT
  var srcRank = 12 - (sqSrc >> 4);      // 12 - RANK_Y
  var dstFile = (sqDst & 15) - 3;
  var dstRank = 12 - (sqDst >> 4);
  return String.fromCharCode(97 + srcFile) + String.fromCharCode(48 + srcRank) +
         String.fromCharCode(97 + dstFile) + String.fromCharCode(48 + dstRank);
}

/* 将 UCI 字符串 (如 "e2e4") 转为 xqwlight 内部 move */
function uciToXqwMove(uciStr) {
  if (!uciStr || uciStr.length < 4) return 0;
  var srcFile = uciStr.charCodeAt(0) - 97;     // 'a' → 0
  var srcRank = uciStr.charCodeAt(1) - 48;      // '0' → 0
  var dstFile = uciStr.charCodeAt(2) - 97;
  var dstRank = uciStr.charCodeAt(3) - 48;
  var sqSrc = (srcFile + 3) + ((12 - srcRank) << 4);
  var sqDst = (dstFile + 3) + ((12 - dstRank) << 4);
  return sqSrc + (sqDst << 8);  // MOVE(sqSrc, sqDst)
}

/* ---------- UCI 提醒消息 ---------- */
function getRuleReminders() {
  return [
    "本对局使用 Pikafish 引擎，遵守中国象棋竞赛规则。",
    "━━━ 棋规提醒 ━━━",
    "1. 长将、长捉、长杀等长打着法作负。",
    "2. 双方均为长打，或一方长打一方非长打，长打方作负。",
    "3. 双方均为非长打，不变作和。",
    "4. 一打一闲，非长打方变着，不变作和。",
    "5. 自然限着为 60 回合（未吃子）。",
    "6. 禁止着法：长将、长捉（无根子）、长杀。",
    "7. 允许着法：长拦、长跟、长兑、长献。",
    "8. 将帅对面视为\"将\"，长将帅对面亦为长打。",
    "9. 送吃不属于捉。",
    "10. 兵（卒）捉子不按捉处理，但长兵捉车除外。",
    "━━━ 引擎信息 ━━━",
  ];
}

/* ---------- PikafishUciSearch ----------
 *  兼容 board.js 中 Search 类的接口
 *  提供 searchMain(depth, millis) 方法
 *  采用"每次搜索重启 Worker"模式
 */
function PikafishUciSearch(pos, hashLevel) {
  this.pos = pos;
  this.hashLevel = hashLevel || 16;
  this.wasmBinary = null;
  this.engineJs = null;
  this.nnueData = null;    // NNUE 权重（独立加载，与 wasm 分离缓存）
  this.worker = null;
  this.engineReady = false;
  this.pendingCallback = null;
  this.stdoutBuffer = [];
  this.bestmove = "";
  this.onUciStdout = null;   // 外部可设置此回调显示 UCI 输出
  this.onUciStderr = null;
  this.onUciDebug = null;
  this.uciReminders = getRuleReminders();
  this.lastInfo = null;      // 存储最后一次 info depth score nodes pv
  this.onInfo = null;        // info 更新回调（实时）
  this.startFen = null;      // 开局 FEN，用于构建含完整历史着法的 UCI position 命令
  // 请求取消机制：每次 searchUci 分配一个递增的 requestId
  // worker.onmessage 中如果发现消息来自旧 requestId（已被取代）则直接丢弃
  // 解决"老 worker 终止时 onAbort 消息污染新搜索"的竞态
  this._nextRequestId = 0;
  this._currentRequestId = -1;   // 当前活跃请求的 id，-1 表示无
  this._currentReject = null;    // 当前活跃请求的 reject 函数
  this._currentTimeoutId = null; // 当前活跃请求的超时定时器
}

/* 设置开局 FEN */
PikafishUciSearch.prototype.setStartFen = function(fen) {
  this.startFen = fen;
};

/* 初始化：下载引擎 WASM/JS/NNUE（如果未缓存）或接受已有缓存 */
PikafishUciSearch.prototype.init = function(wasmBinary, engineJs, nnueData) {
  var self = this;
  if (wasmBinary && engineJs && nnueData) {
    self.wasmBinary = wasmBinary;
    self.engineJs = engineJs;
    self.nnueData = nnueData;
    return Promise.resolve();
  }
  // 如果没有传入，从服务器加载
  return self._downloadEngine();
};

/* 引擎版本：与 sw.js / xqwlight/sw.js 保持一致 */
var ENGINE_VERSION = "20260624-003220";
var ENGINE_QUERY = "?v=" + ENGINE_VERSION;

PikafishUciSearch.prototype._downloadEngine = function() {
  var self = this;
  var base = getAssetBaseXqw();

  return fetch(base + 'wasm/pikafish.wasm' + ENGINE_QUERY).then(function(resp) {
    if (!resp.ok) throw new Error('WASM 下载失败: HTTP ' + resp.status);
    return resp.arrayBuffer();
  }).then(function(ab) {
    self.wasmBinary = ab;
    return fetch(base + 'wasm/pikafish.js' + ENGINE_QUERY);
  }).then(function(resp) {
    if (!resp.ok) throw new Error('JS 下载失败: HTTP ' + resp.status);
    return resp.text();
  }).then(function(txt) {
    self.engineJs = txt;
    // NNUE 使用固定 URL（无版本号），保证权重不变时命中离线缓存
    return fetch(base + 'wasm/pikafish.nnue');
  }).then(function(resp) {
    if (!resp.ok) throw new Error('NNUE 下载失败: HTTP ' + resp.status);
    return resp.arrayBuffer();
  }).then(function(ab) {
    self.nnueData = ab;
  });
};

function getAssetBaseXqw() {
  var path = location.pathname;
  path = path.substring(0, path.lastIndexOf('/') + 1);
  return location.origin + path;
}

/* 启动引擎并发送初始化命令 (uci / isready) */
PikafishUciSearch.prototype.startEngine = function() {
  var self = this;
  return new Promise(function(resolve, reject) {
    if (self.engineReady && self.worker) {
      resolve();
      return;
    }

    // 终止旧的 worker
    if (self.worker) {
      try { self.worker.terminate(); } catch(e) {}
      self.worker = null;
    }

    self.stdoutBuffer = [];
    self.bestmove = "";

    var worker = new Worker('worker.js');
    self.worker = worker;

    worker.onmessage = function(ev) {
      var msg = ev.data;
      if (!msg || !msg.type) return;

      switch (msg.type) {
        case 'stdout':
          self.stdoutBuffer.push(msg.text);
          if (self.onUciStdout) self.onUciStdout(msg.text);
          // 检测 bestmove
          if (msg.text.indexOf('bestmove ') === 0) {
            self.bestmove = msg.text;
          }
          break;
        case 'stderr':
          if (self.onUciStderr) self.onUciStderr(msg.text);
          break;
        case 'debug':
          if (self.onUciDebug) self.onUciDebug(msg.text);
          break;
        case 'ready':
          self.engineReady = true;
          resolve();
          break;
        case 'done':
          self.engineReady = false;
          break;
        case 'error':
          self.engineReady = false;
          reject(new Error(msg.text));
          break;
      }
    };

    worker.onerror = function(ev) {
      reject(new Error('Worker 错误: ' + ev.message));
    };

    // 发送初始化命令
    worker.postMessage({
      type: 'init',
      wasmBinary: self.wasmBinary,
      engineJs: self.engineJs,
      nnueData: self.nnueData,
      sab: null,
      sabAvailable: false,
      commands: ["uci", "isready"]
    });
  });
};

/* 执行 UCI 搜索，返回 bestmove 对应的 xqwlight move */
PikafishUciSearch.prototype.searchUci = function(fen, movesList, movetimeMs, hasStartFen) {
  var self = this;

  // 1) 先作废上一次未结束的请求（如果有）
  //    —— 上一个 worker 会被下面的代码 terminate，对应 Promise 主动 reject
  //       避免旧请求长时间挂起，同时不向用户暴露"onAbort"误报
  if (self._currentReject) {
    var prevReject = self._currentReject;
    var prevTimeoutId = self._currentTimeoutId;
    if (prevTimeoutId) { clearTimeout(prevTimeoutId); self._currentTimeoutId = null; }
    self._currentReject = null;
    try { prevReject(new Error('__superseded__')); } catch (e) {}
  }

  return new Promise(function(resolve, reject) {
    // 2) 为本次请求分配唯一 id，并在闭包内捕获
    var myRequestId = ++self._nextRequestId;
    self._currentRequestId = myRequestId;
    self._currentReject = reject;

    // 构建 UCI 命令
    var commands = [];

    // 必须有开局 FEN 才能附加 moves 历史（否则 moves 会从当前局面重复走棋）
    // 附带 moves 历史让引擎能检测与历史局面的重复（长将/长捉违规）
    var posCmd = "position fen " + fen;
    if (hasStartFen && movesList && movesList.length > 0) {
      posCmd += " moves " + movesList.join(" ");
    }
    commands.push(posCmd);
    commands.push("go movetime " + movetimeMs);

    // 显示 FEN 供调试
    if (self.onUciStdout) {
      var debugMoves = (hasStartFen && movesList && movesList.length > 0) ? movesList.join(',') : '无';
      self.onUciStdout('[调试] fen=' + fen + '  moves=' + debugMoves + '  hasStartFen=' + hasStartFen);
    }

    // 发送 UCI 命令提醒
    var reminders = self.uciReminders;
    for (var i = 0; i < reminders.length; i++) {
      if (self.onUciStdout) self.onUciStdout('[棋规] ' + reminders[i]);
    }
    for (var i = 0; i < commands.length; i++) {
      if (self.onUciStdout) self.onUciStdout('[UCI→] ' + commands[i]);
    }

    // 3) 终止旧 worker；它可能仍处于 WASM 初始化或搜索中
    //    terminate() 后其残留消息（包括 onAbort）会被下面的 requestId 守卫过滤
    if (self.worker) {
      try { self.worker.terminate(); } catch(e) {}
      self.worker = null;
    }
    self.engineReady = false;
    self.stdoutBuffer = [];
    self.bestmove = "";

    var worker = new Worker('worker.js');
    self.worker = worker;

    // 4) 包裹 resolve / reject：仅当本请求仍为"当前"请求时才真正结算状态
    var settled = false;
    function settleOnce(fn, arg) {
      if (settled) return;
      settled = true;
      if (self._currentRequestId === myRequestId) {
        self._currentRequestId = -1;
        self._currentReject = null;
        if (self._currentTimeoutId) { clearTimeout(self._currentTimeoutId); self._currentTimeoutId = null; }
      }
      try { fn(arg); } catch (e) { /* swallow */ }
    }

    worker.onmessage = function(ev) {
      // 守卫：如果本 worker 已被新请求取代，丢弃这条残留消息
      // 这是修复 onAbort 误报的关键 —— 旧 worker 终止时 Emscripten 仍可能
      // postMessage 出 'onAbort:' 之类的 error，如果不被丢弃就会污染新搜索
      if (self._currentRequestId !== myRequestId) return;
      // 双重保险：worker 实例必须仍是当前激活的 worker
      if (self.worker !== worker) return;

      var msg = ev.data;
      if (!msg || !msg.type) return;

      switch (msg.type) {
        case 'stdout':
          self.stdoutBuffer.push(msg.text);
          // 解析 info 行
          if (msg.text.indexOf('info ') === 0) {
            self._parseInfo(msg.text);
          }
          if (self.onUciStdout) self.onUciStdout(msg.text);
          if (msg.text.indexOf('bestmove ') === 0) {
            self.bestmove = msg.text;
          }
          break;
        case 'stderr':
          if (self.onUciStderr) self.onUciStderr(msg.text);
          break;
        case 'debug':
          if (self.onUciDebug) self.onUciDebug(msg.text);
          break;
        case 'ready':
          self.engineReady = true;
          break;
        case 'done':
          self.engineReady = false;
          // 解析 bestmove
          var uciMove = self._parseBestmove(self.bestmove);
          if (uciMove) {
            if (self.onUciStdout) self.onUciStdout('[UCI←] bestmove ' + uciMove);
            var xqwMove = uciToXqwMove(uciMove);
            if (self.onUciStdout) self.onUciStdout('[调试] xqwMove=' + xqwMove + '  src=' + (xqwMove & 255) + '  dst=' + (xqwMove >> 8));
            settleOnce(resolve, xqwMove);
          } else {
            settleOnce(reject, new Error('未获取到 bestmove'));
          }
          break;
        case 'error':
          self.engineReady = false;
          // 若是 "onAbort" 且本请求已被取代，丢弃（不向用户报错）
          if (self._currentRequestId !== myRequestId) return;
          settleOnce(reject, new Error(msg.text));
          break;
      }
    };

    worker.onerror = function(ev) {
      if (self._currentRequestId !== myRequestId) return;
      if (self.worker !== worker) return;
      settleOnce(reject, new Error('Worker 错误: ' + ev.message));
    };

    worker.postMessage({
      type: 'init',
      wasmBinary: self.wasmBinary,
      engineJs: self.engineJs,
      nnueData: self.nnueData,
      sab: null,
      sabAvailable: false,
      commands: commands
    });

    // 添加超时保护：防止 Promise 永不 resolve
    var timeoutMs = Math.max(movetimeMs + 15000, 30000);
    var timeoutId = setTimeout(function() {
      if (self._currentRequestId !== myRequestId) return; // 已被新搜索取代
      if (self.onUciStderr) self.onUciStderr('[错误] 搜索超时 (' + timeoutMs + 'ms)，强制终止');
      try { worker.terminate(); } catch(e) {}
      if (self.worker === worker) self.worker = null;
      settleOnce(reject, new Error('搜索超时'));
    }, timeoutMs);
    self._currentTimeoutId = timeoutId;
  });
};

/* 从 stdout 中解析 info depth/score/nodes/pv 并存储到 lastInfo */
PikafishUciSearch.prototype._parseInfo = function(line) {
  if (line.indexOf('info ') !== 0) return;
  // 只处理包含 pv 的 info 行
  if (line.indexOf(' pv ') < 0) return;
  var self = this;
  var info = { depth: '?', score: '?', nodes: '?', pv: [] };

  // depth N
  var m = line.match(/\bdepth\s+(\d+)/);
  if (m) info.depth = m[1];

  // score cp N 或 score mate N
  var m2 = line.match(/\bscore\s+(cp|mate)\s+([-\d]+)/);
  if (m2) {
    if (m2[1] === 'mate') {
      info.score = '#' + m2[2];
    } else {
      var cp = parseInt(m2[2]);
      info.score = (cp >= 0 ? '+' : '') + cp;
    }
  }

  // nodes N
  var m3 = line.match(/\bnodes\s+(\d+)/);
  if (m3) info.nodes = m3[1];

  // pv ... (从 pv 开始到行尾)
  var pvIdx = line.indexOf(' pv ');
  if (pvIdx >= 0) {
    var pvStr = line.substring(pvIdx + 4).trim();
    info.pv = pvStr.split(/\s+/).filter(function(s) { return s.length >= 4; });
  }

  self.lastInfo = info;

  // 实时通知外部（UI 更新）
  if (self.onInfo) {
    self.onInfo(info);
  }
};

/* 从 stdout 中解析 bestmove */
PikafishUciSearch.prototype._parseBestmove = function(bestmoveLine) {
  if (!bestmoveLine) return "";
  // "bestmove e2e4" 或 "bestmove e2e4 ponder e7e5"
  var parts = bestmoveLine.split(/\s+/);
  if (parts.length >= 2 && parts[0] === 'bestmove') {
    return parts[1];
  }
  return "";
};

/* 获取开局 FEN 和全部历史着法（用于 UCI position 命令的完整历史重放） */
PikafishUciSearch.prototype._getFenWithMoves = function() {
  var pos = this.pos;

  // 使用开局 FEN（如果未设置则回退到当前局面 FEN）
  var fen = this.startFen;
  if (!fen) {
    // 从当前局面构建 FEN
    fen = "";
    for (var y = 3; y <= 12; y++) {
      var emptyCount = 0;
      for (var x = 3; x <= 11; x++) {
        var sq = x + (y << 4);
        var pc = pos.squares[sq];
        if (pc === 0) {
          emptyCount++;
        } else {
          if (emptyCount > 0) {
            fen += emptyCount;
            emptyCount = 0;
          }
          var pieceChar = "";
          var pieceType = pc & 7;
          var side = pc >> 3;
          switch (pieceType) {
            case 0: pieceChar = "K"; break;
            case 1: pieceChar = "A"; break;
            case 2: pieceChar = "B"; break;
            case 3: pieceChar = "N"; break;
            case 4: pieceChar = "R"; break;
            case 5: pieceChar = "C"; break;
            case 6: pieceChar = "P"; break;
          }
          if (pieceChar) {
            fen += (side === 1 ? pieceChar : pieceChar.toLowerCase());
          }
        }
      }
      if (emptyCount > 0) fen += emptyCount;
      if (y < 12) fen += "/";
    }
    fen += " " + (pos.sdPlayer === 0 ? "w" : "b");
  }

  // 构建 moves 列表（从初始位置到当前走法）
  var moves = [];
  var mvList = pos.mvList;
  if (mvList && mvList.length > 1) {
    for (var i = 1; i < mvList.length; i++) {
      var mv = mvList[i];
      if (mv > 0) {
        moves.push(xqwMoveToUci(mv));
      }
    }
  }

  return { fen: fen, moves: moves, hasStartFen: !!this.startFen };
};

/* ---------- searchMain(depth, millis) ----------
 *  兼容 board.js 的调用方式
 *  board.js 调用: board.search.searchMain(LIMIT_DEPTH, board.millis)
 *  返回 bestmove 对应的 xqwlight move 整数
 *  注意：由于是异步操作，实际通过 Promise 解析，board.js 需要适配
 *  此处采用回调方式
 */
PikafishUciSearch.prototype.searchMain = function(depth, millis, callback) {
  var self = this;

  // 获取当前局面 FEN
  var posData = self._getFenWithMoves();

  // 执行 UCI 搜索
  self.searchUci(posData.fen, posData.moves, millis, posData.hasStartFen).then(function(xqwMove) {
    if (callback) {
      callback(xqwMove);
    }
  }).catch(function(err) {
    // 被新搜索主动取代的旧搜索（用户改设置 / 重新开始 / 悔棋触发的下一次搜索），
    // 这是预期行为，不向用户报告"搜索失败"
    if (err && err.message === '__superseded__') {
      if (callback) callback(0);
      return;
    }
    if (self.onUciStderr) {
      self.onUciStderr('[错误] 搜索失败: ' + err.message);
    }
    if (callback) {
      callback(0);
    }
  });
};