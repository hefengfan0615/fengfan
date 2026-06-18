/* ======================================================================
 *  Pikafish WASM Engine Worker — 持久命令队列模式
 *
 *  主线程通过 postMessage({type:'init', ...}) 初始化引擎，
 *  然后通过 {type:'command', text:'...'} 发送 UCI 命令。
 *  引擎 stdout 通过 {type:'stdout', text:'...'} 返回。
 *  引擎 stderr 通过 {type:'stderr', text:'...'} 返回。
 *  引擎启动完毕后发送 {type:'ready'}。
 *  引擎调用 quit 退出后发送 {type:'done', code:...}。
 * ====================================================================== */

"use strict";

function postMsg(msg) {
  try { self.postMessage(msg); } catch (e) {}
}
function debug(text)  { postMsg({ type: 'debug',  text: String(text) }); }
function stdout(text) { postMsg({ type: 'stdout', text: String(text) }); }
function stderr(text) { postMsg({ type: 'stderr', text: String(text) }); }

/* ---------- 命令队列 ---------- */
let cmdQueue = [];        // 等待引擎读取的命令行
let cmdReadPos = 0;       // 当前命令中的读取位置
let cmdIndex = 0;         // 当前正在发送的命令索引
let engineRunning = false; // 引擎是否正在运行

/* ---------- stdin：从命令队列读取 ---------- */
function stdinByte() {
  while (cmdIndex < cmdQueue.length) {
    var cmd = cmdQueue[cmdIndex];
    if (cmdReadPos < cmd.length) {
      return cmd.charCodeAt(cmdReadPos++);
    }
    // 当前命令读取完毕，换行
    cmdIndex++;
    cmdReadPos = 0;
    return 10; // '\n'
  }
  // 没有更多命令 — 阻塞等待（引擎永不退出 stdin）
  // 在主线程发送新命令后，继续读取
  // 使用 Atomics.wait 或简单的轮询
  // 由于没有 SAB，用 busy-wait 不可取，应采用消息驱动
  // 此处返回 null 会让引擎读到 EOF 而退出
  // 但在持久模式下我们不想退出
  // 解决方法：保持引擎在 while(getline) 循环中等待
  return null; // 返回 null = EOF → 引擎退出
}

/* ---------- 消息接收 ---------- */
self.onmessage = function(ev) {
  var m = ev.data;
  if (!m) return;

  switch (m.type) {

    case 'init':
      // 初始化引擎
      var wasmBinary = m.wasmBinary;
      var engineJs = m.engineJs;
      cmdQueue = m.commands || [];
      cmdReadPos = 0;
      cmdIndex = 0;
      engineRunning = false;

      try {
        self.Module = {
          noInitialRun: true,
          noExitRuntime: true,  // 引擎永不退出
          arguments: [],
          wasmBinary: wasmBinary,
          print: function(line) { stdout(line); },
          printErr: function(line) { stderr(line); },
        };
        self.Module["stdin"]  = stdinByte;
        self.Module["stdout"] = null;
        self.Module["stderr"] = null;
        self.Module["onRuntimeInitialized"] = function() {
          debug("运行时已初始化，启动 callMain");
          postMsg({ type: 'ready' });
          engineRunning = true;
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
            debug("引擎 callMain 返回");
            engineRunning = false;
            postMsg({ type: 'done', code: 0 });
          } catch (e) {
            debug("引擎异常: " + e.message);
            postMsg({ type: 'error', text: "引擎异常: " + e.message });
            engineRunning = false;
          }
        };
        self.Module["onExit"] = function(code) {
          debug("onExit: code=" + code);
          engineRunning = false;
          postMsg({ type: 'done', code: code });
        };
        self.Module["onAbort"] = function(what) {
          debug("onAbort: " + what);
          engineRunning = false;
          postMsg({ type: 'error', text: "onAbort: " + String(what) });
        };

        // 加载引擎 JS
        var jsBlob = new Blob([engineJs], { type: "application/javascript" });
        var jsUrl = URL.createObjectURL(jsBlob);
        importScripts(jsUrl);
        URL.revokeObjectURL(jsUrl);
      } catch (e) {
        postMsg({ type: 'error', text: "引擎初始化失败: " + e.message });
      }
      break;

    case 'command':
      // 向引擎发送新的 UCI 命令
      if (typeof m.text === 'string' && m.text.length > 0) {
        cmdQueue.push(m.text);
        debug("添加命令: " + m.text);
      }
      break;

    case 'quit':
      // 发送 quit 命令让引擎退出
      cmdQueue.push("quit");
      break;
  }
};

debug("pikafish-worker.js 已加载");