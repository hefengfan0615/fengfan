/* ======================================================================
 *  Pikafish WASM Engine Worker
 *
 *  关键发现：
 *    WebAssembly.instantiate(arrayBuffer, imports) 返回 Promise，
 *    因此 WASM 的实例化是**异步**的。importScripts 返回时，
 *    WASM 还没有 ready，__emscripten_stack_alloc / callMain / _main
 *    等 WASM 导出函数还不可用。
 *
 *  Emscripten 的异步初始化流程：
 *    createWasm()                  : 启动异步实例化
 *    run()                         : 发现 runDependencies>0，暂存自己
 *    → importScripts 返回
 *    (等待浏览器)
 *    WASM 实例化完成               : runDependencies-- → dependenciesFulfilled()
 *    → doRun()                     : initRuntime → preMain
 *                                  → onRuntimeInitialized ★
 *                                  → 若 noInitialRun=false 则 callMain
 *                                  → postRun
 *
 *  正确做法：把 callMain 放到 onRuntimeInitialized 里执行。
 *
 *  stdin 路径：
 *    Module["stdin"] = stdinByte   : 非 null
 *    → FS.createStandardStreams() 走 FS.createDevice("/dev","stdin",input)
 *    → registerDevice({ open, close, read, write })
 *    → read 循环：调用 input() 即 stdinByte() 一个字节一个字节返回
 *    → EOF：return null
 * ====================================================================== */

"use strict";

function postMsg(msg) {
    try { self.postMessage(msg); } catch (e) {}
}
function debug(text)  { postMsg({ type: 'debug',  text: String(text) }); }
function stdout(text) { postMsg({ type: 'stdout', text: String(text) }); }
function stderr(text) { postMsg({ type: 'stderr', text: String(text) }); }

/* ---------- UCI 命令流（stdin） ---------- */
var commandStream = "";
var commandPos    = 0;

function stdinByte() {
    // 返回一个字节（0-255 的整数），EOF 返回 null
    if (commandPos >= commandStream.length) return null;
    return commandStream.charCodeAt(commandPos++);
}

/* ---------- 消息接收与主流程 ---------- */
self.onmessage = function(ev) {
    var m = ev.data;
    if (!m || m.type !== 'init') return;

    var wasmBinary = m.wasmBinary;
    var engineJs   = m.engineJs;
    var cmds       = Array.isArray(m.commands) ? m.commands.slice() : [];

    // 构造 UCI 命令文本（每行一条 + 换行）
    commandStream = cmds.map(function(s) { return s + "\n"; }).join("");
    commandPos    = 0;

    debug("收到 init 消息: " + cmds.length + " 条命令 / " +
          commandStream.length + " 字节 stdin");

    /* 步骤 1: 构建 self.Module */
    try {
        self.Module = {
            noInitialRun:  true,     // ★ doRun 中不自动 callMain
            noExitRuntime: false,
            arguments:     [],
            wasmBinary:    wasmBinary,
            print:         function(line) { stdout(line); },
            printErr:      function(line) { stderr(line); },
        };
        self.Module["stdin"]  = stdinByte;
        self.Module["stdout"] = null;
        self.Module["stderr"] = null;
        self.Module["onRuntimeInitialized"] = function() {
            debug("onRuntimeInitialized: runtime 已初始化，启动 callMain");
            postMsg({ type: 'ready' });
            // ★★ 在 onRuntimeInitialized 中调用 callMain
            try {
                if (typeof callMain === 'function') {
                    callMain([]);
                } else if (self.Module && typeof self.Module.callMain === 'function') {
                    self.Module.callMain([]);
                } else if (typeof _main === 'function') {
                    _main(0, 0);
                } else {
                    postMsg({ type: 'error',
                              text: "无法找到 callMain / _main 函数" });
                    return;
                }
                debug("callMain() 返回 —— 引擎执行完毕");
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
        // 不设置 Module["setStatus"]，让 doRun 在同步路径中尽量被调度
        debug("Module 已构建（noInitialRun=true，callMain 在 onRuntimeInitialized 中）");
    } catch (e) {
        postMsg({ type: 'error', text: "构建 Module 失败: " + e.message });
        return;
    }

    /* 步骤 2: importScripts 加载 pikafish.js —— 同步执行脚本主体，
     * 但 createWasm 的 WASM 实例化是异步的。onRuntimeInitialized 会
     * 在稍后（WASM ready 后）被触发。
     */
    try {
        var jsBlob = new Blob([engineJs], { type: "application/javascript" });
        var jsUrl  = URL.createObjectURL(jsBlob);
        debug("开始 importScripts 加载 pikafish.js (Blob URL)");
        importScripts(jsUrl);
        URL.revokeObjectURL(jsUrl);
        debug("pikafish.js 脚本主体执行完毕，等待 WASM 异步实例化…");
    } catch (e) {
        postMsg({ type: 'error', text: "pikafish.js 加载失败: " + e.message });
        return;
    }
};

debug("worker.js 加载完成，等待宿主端 init 消息...");
