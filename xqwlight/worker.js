/* ======================================================================
 *  Pikafish WASM Engine Worker — 持久引擎模式
 *
 *  引擎只初始化一次，后续搜索复用同一个引擎实例。
 *  NNUE 权重(50MB)只加载一次，置换表(TT)在多次搜索间持续累积。
 *
 *  Host → Worker:
 *    { type: 'init',   wasmBinary, engineJs, nnueData }
 *    { type: 'search', commands: [...] }
 *    { type: 'quit' }
 *
 *  Worker → Host:
 *    { type: 'stdout', text: string }
 *    { type: 'stderr', text: string }
 *    { type: 'debug',  text: string }
 *    { type: 'ready' }
 *    { type: 'done',   code: number }
 *    { type: 'error',  text: string }
 * ====================================================================== */

"use strict";

function postMsg(msg) {
  try { self.postMessage(msg); } catch (e) {}
}
function debug(text)  { postMsg({ type: 'debug',  text: String(text) }); }
function stdout(text) { postMsg({ type: 'stdout', text: String(text) }); }
function stderr(text) { postMsg({ type: 'stderr', text: String(text) }); }

/* ---------- 持久引擎状态 ---------- */
let engineReady = false;
let cmdBuffer = "";
let cmdPos = 0;

/* ---------- stdin：每次 _wasm_uci_execute 调用前由 feedCommand 设置 ---------- */
function stdinByte() {
  if (cmdPos >= cmdBuffer.length) return null;
  return cmdBuffer.charCodeAt(cmdPos++);
}

/* 向引擎发送一条 UCI 命令（通过 _wasm_uci_execute） */
function feedCommand(cmd) {
  cmdBuffer = cmd + "\n";
  cmdPos = 0;
  try {
    Module._wasm_uci_execute();
  } catch (e) {
    if (e.name !== 'ExitStatus') {
      debug("_wasm_uci_execute 异常: " + e.message);
    }
  }
  cmdBuffer = "";
}

/* ---------- 消息处理 ---------- */
self.onmessage = function(ev) {
  var m = ev.data;
  if (!m) return;

  switch (m.type) {
    case 'init':
      initEngine(m.wasmBinary, m.engineJs, m.nnueData);
      break;

    case 'search':
      if (!engineReady) {
        postMsg({ type: 'error', text: "引擎未就绪" });
        return;
      }
      processSearch(m.commands);
      break;

    case 'quit':
      if (engineReady) {
        try { feedCommand("quit"); } catch(e) {}
      }
      engineReady = false;
      postMsg({ type: 'done', code: 0 });
      break;
  }
};

/* ---------- 引擎初始化（只执行一次）---------- */
function initEngine(wasmBinary, engineJs, nnueData) {
  if (engineReady) {
    postMsg({ type: 'ready' });
    return;
  }

  try {
    self.Module = {
      noInitialRun: true,
      noExitRuntime: true,
      arguments: [],
      print: function(line) { stdout(line); },
      printErr: function(line) { stderr(line); },
    };

    /* NNUE 权重写入虚拟文件系统 */
    if (nnueData) {
      self.Module["preRun"] = [function() {
        FS.writeFile('/pikafish.nnue', new Uint8Array(nnueData));
        debug("NNUE 已写入 (" + (nnueData.byteLength / 1024 / 1024).toFixed(2) + " MB)");
      }];
    }

    /* 接管 WASM 实例化：使用主线程传入的 wasmBinary */
    self.Module["instantiateWasm"] = function(info, receiveInstance) {
      WebAssembly.instantiate(wasmBinary, info).then(function(output) {
        receiveInstance(output.instance, output.module);
      }).catch(function(err) {
        postMsg({ type: 'error', text: "WASM: " + err.message });
      });
      return {};
    };

    self.Module["stdin"]  = stdinByte;
    self.Module["stdout"] = null;
    self.Module["stderr"] = null;

    self.Module["onRuntimeInitialized"] = function() {
      debug("运行时已初始化，启动持久引擎");
      // 发送 uci + isready 初始化引擎（只执行一次，后续搜索复用）
      feedCommand("uci");
      feedCommand("isready");
      engineReady = true;
      postMsg({ type: 'ready' });
    };

    self.Module["onAbort"] = function(what) {
      postMsg({ type: 'error', text: "onAbort: " + String(what) });
    };

    /* 加载引擎 JS */
    var jsBlob = new Blob([engineJs], { type: "application/javascript" });
    var jsUrl = URL.createObjectURL(jsBlob);
    importScripts(jsUrl);
    URL.revokeObjectURL(jsUrl);
    debug("pikafish.js 已加载，等待 WASM 实例化…");
  } catch (e) {
    postMsg({ type: 'error', text: "初始化失败: " + e.message });
  }
}

/* ---------- 处理搜索命令 ---------- */
function processSearch(commands) {
  if (!Array.isArray(commands)) {
    postMsg({ type: 'done', code: 0 });
    return;
  }

  debug("持久引擎处理 " + commands.length + " 条命令");
  for (var i = 0; i < commands.length; i++) {
    feedCommand(commands[i]);
  }
  postMsg({ type: 'done', code: 0 });
}

debug("worker.js 持久引擎模式已就绪");