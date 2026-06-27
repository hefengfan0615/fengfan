/* ======================================================================
 *  Pikafish WASM Engine Worker — 命令流模式
 *
 *  主线程通过 postMessage({type:'init', commands:[...]}) 传入 UCI 命令，
 *  stdinByte() 从命令流读取，读完返回 null (EOF)，引擎自动退出。
 *  每次搜索会创建新的 Worker。
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

/* ---------- 命令流 ---------- */
let commandStream = "";
let commandPos = 0;

/* ---------- stdin：从命令流读取，返回 null = EOF ---------- */
function stdinByte() {
  if (commandPos >= commandStream.length) return null;
  return commandStream.charCodeAt(commandPos++);
}

/* ---------- 消息接收与主流程 ---------- */
self.onmessage = function(ev) {
  var m = ev.data;
  if (!m || m.type !== 'init') return;

  var wasmBinary = m.wasmBinary;
  var engineJs   = m.engineJs;
  var nnueData   = m.nnueData;
  var cmds       = Array.isArray(m.commands) ? m.commands.slice() : [];

  commandStream = cmds.map(function(s) { return s + "\n"; }).join("");
  commandPos = 0;
  debug("命令流模式：" + cmds.length + " 条命令 / " + commandStream.length + " 字节");

  /* 构建 self.Module */
  try {
    self.Module = {
      noInitialRun: true,
      arguments: [],
      wasmBinary: wasmBinary,
      print: function(line) { stdout(line); },
      printErr: function(line) { stderr(line); },
    };
    // 将 NNUE 权重写入虚拟文件系统，引擎启动时自动读取
    if (nnueData) {
      self.Module["preRun"] = [function() {
        FS.writeFile('/pikafish.nnue', new Uint8Array(nnueData));
        debug("NNUE 权重已写入虚拟文件系统 (" + (nnueData.byteLength / 1024 / 1024).toFixed(2) + " MB)");
      }];
      debug("已注册 NNUE preRun 钩子");
    }
    /* 接管 WASM 实例化：使用主线程传进来的 wasmBinary，避免 worker 内部
     * 按相对路径 fetch pikafish.wasm（在 xqwlight/ 或 Blob URL 场景下会 404） */
    self.Module["instantiateWasm"] = function(info, receiveInstance) {
      debug("instantiateWasm: 使用主线程传入的 wasmBinary");
      WebAssembly.instantiate(wasmBinary, info).then(function(output) {
        receiveInstance(output.instance, output.module);
      }).catch(function(err) {
        debug("WASM instantiate 失败: " + err.message);
        postMsg({ type: 'error', text: "WASM instantiate 失败: " + err.message });
      });
      return {};
    };
    self.Module["stdin"]  = stdinByte;
    self.Module["stdout"] = null;
    self.Module["stderr"] = null;
    self.Module["onRuntimeInitialized"] = function() {
      debug("onRuntimeInitialized: runtime 已初始化，启动 callMain");
      postMsg({ type: 'ready' });
      var exitCode = 0;
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
      } catch (e) {
        // ExitStatus 是 Emscripten 正常退出方式（throw ExitStatus 是正常的，不是错误）
        if (e.name === 'ExitStatus') {
          exitCode = typeof e.status === 'number' ? e.status : 0;
          debug("callMain 正常退出 (ExitStatus), code=" + exitCode);
        } else {
          exitCode = -1;
          debug("callMain 异常: " + e.message);
          if (e.message && e.message.indexOf('ExitStatus') >= 0) {
            // 某些 Emscripten 版本 ExitStatus 的 name 不是 ExitStatus
            debug("（识别为正常退出）");
            exitCode = 0;
          } else {
            postMsg({ type: 'error', text: "callMain 失败: " + e.message });
          }
        }
      }
      // 命令流模式：引擎已执行完毕，发送 done
      postMsg({ type: 'done', code: exitCode });
    };
    self.Module["onExit"] = function(code) {
      debug("onExit: code=" + code);
      postMsg({ type: 'done', code: code });
    };
    self.Module["onAbort"] = function(what) {
      debug("onAbort: " + what);
      postMsg({ type: 'error', text: "onAbort: " + String(what) });
    };
    debug("Module 已构建（命令流模式）");
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
