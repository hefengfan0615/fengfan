/* ======================================================================
 *  Pikafish WASM Engine Worker — 常驻模式
 *
 *  数据流：主线程 (test.html) → SharedArrayBuffer (SAB) → 本 Worker
 *  stdinByte() 从 SAB 读，空则 Atomics.wait 挂起，永不返回 null (EOF)
 *  这样引擎 (callMain) 会一直运行，随时接收新命令。
 *
 *  备用模式（sabAvailable=false）：
 *    退回到"命令流"模式 — commands 参数中包含所有 UCI 命令，
 *    读完返回 null，引擎会退出。每次点击会重新创建 Worker。
 *
 *  通信协议（Engine → Host）：
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

/* ---------- SAB 共享环形缓冲区 ---------- */
let sabInt32 = null;   // [readPos, writePos]
let sabBytes  = null;   // 数据区
let sabDataBytes = 65536;
let sabAvailable = false;

/* ---------- 备用模式：命令流 ---------- */
let commandStream = "";
let commandPos = 0;

/* ---------- stdinByte：两个模式统一入口 ---------- */
function stdinByte() {
  if (sabAvailable) {
    // 常驻模式：从 SAB 读，空则等待
    // 读取 writePos 的值，然后循环直到有新数据
    // 使用 Atomics.wait 挂起等待，直到主线程 notify
    while (true) {
      const r = Atomics.load(sabInt32, 0);
      const w = Atomics.load(sabInt32, 1);
      if (r < w) {
        // 有数据
        const byte = sabBytes[r % sabDataBytes];
        Atomics.store(sabInt32, 0, r + 1);
        return byte;
      }
      // 没有数据 — 阻塞等待 writePos 变化
      Atomics.wait(sabInt32, 1, w);
    }
  } else {
    // 备用模式：从命令流读，返回 null = EOF
    if (commandPos >= commandStream.length) return null;
    return commandStream.charCodeAt(commandPos++);
  }
}

/* ---------- 消息接收与主流程 ---------- */
self.onmessage = function(ev) {
  var m = ev.data;
  if (!m || m.type !== 'init') return;

  var wasmBinary = m.wasmBinary;
  var engineJs   = m.engineJs;
  var cmds       = Array.isArray(m.commands) ? m.commands.slice() : [];
  sabAvailable   = !!m.sabAvailable;

  if (sabAvailable) {
    // 常驻模式：设置 SAB 视图
    try {
      sabInt32 = new Int32Array(m.sab, 0, 2);
      sabBytes  = new Uint8Array(m.sab, 8);
      sabDataBytes = sabBytes.length;
      debug("SAB 常驻模式：数据区 " + sabDataBytes + " 字节");
    } catch (e) {
      debug("SAB 视图创建失败，回退到命令流模式：" + e.message);
      sabAvailable = false;
    }
  }

  if (!sabAvailable) {
    // 备用模式：构造命令文本
    commandStream = cmds.map(function(s) { return s + "\n"; }).join("");
    commandPos = 0;
    debug("备用模式：" + cmds.length + " 条命令 / " + commandStream.length + " 字节");
  }

  /* 步骤 1: 构建 self.Module */
  try {
    self.Module = {
      noInitialRun: true,       // onRuntimeInitialized 中手动 callMain
      noExitRuntime: sabAvailable,  // 常驻模式：不要退出运行时
      arguments: [],
      wasmBinary: wasmBinary,
      print: function(line) { stdout(line); },
      printErr: function(line) { stderr(line); },
    };
    self.Module["stdin"]  = stdinByte;
    self.Module["stdout"] = null;
    self.Module["stderr"] = null;
    self.Module["onRuntimeInitialized"] = function() {
      debug("onRuntimeInitialized: runtime 已初始化，启动 callMain");
      postMsg({ type: 'ready' });
      // 在 onRuntimeInitialized 中调用 callMain，保证 WASM 已就绪
      try {
        if (typeof callMain === 'function') {
          callMain([]);
        } else if (self.Module && typeof self.Module.callMain === 'function') {
          self.Module.callMain([]);
        } else if (typeof _main === 'function') {
          _main(0, 0);
        } else {
          postMsg({ type: 'error', text: "无法找到 callMain / _main 函数" });
          return;
        }
        debug("callMain() 返回 — 引擎执行完毕");
        // 备用模式下：引擎读到 EOF 后退出
        // 常驻模式下：引擎永不退出（stdinByte 永不返回 null）
      } catch (e) {
        debug("callMain 异常: " + e.message);
        postMsg({ type: 'error', text: "callMain 失败: " + e.message });
      }
    };
    self.Module["onExit"] = function(code) {
      debug("onExit: code=" + code);
      postMsg({ type: 'done', code: code });
    };
    self.Module["onAbort"] = function(what) {
      debug("onAbort: " + what);
      postMsg({ type: 'error', text: "onAbort: " + String(what) });
    };
    debug("Module 已构建（" + (sabAvailable ? "SAB 常驻" : "备用命令流") + "模式）");
  } catch (e) {
    postMsg({ type: 'error', text: "构建 Module 失败: " + e.message });
    return;
  }

  /* 步骤 2: importScripts 加载 pikafish.js */
  try {
    var jsBlob = new Blob([engineJs], { type: "application/javascript" });
    var jsUrl = URL.createObjectURL(jsBlob);
    debug("开始 importScripts 加载 pikafish.js");
    importScripts(jsUrl);
    URL.revokeObjectURL(jsUrl);
    debug("pikafish.js 执行完毕，等待 WASM 实例化…");
  } catch (e) {
    postMsg({ type: 'error', text: "pikafish.js 加载失败: " + e.message });
    return;
  }
};

debug("worker.js 加载完成，等待宿主端 init 消息...");
