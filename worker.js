/* ======================================================================
 *  Pikafish WASM Engine Worker
 *
 *  关键思路：
 *    在宿主端 test.html 中下载 WASM 和 JS，通过 postMessage 将
 *    ArrayBuffer 和 JS 源码、以及 UCI 命令数组发送到本 Worker。
 *
 *  本 Worker 的执行流程：
 *    1. 构建 self.Module，包含：
 *         - wasmBinary       : WASM 二进制（ArrayBuffer）
 *         - stdin            : 每次读一个字节的回调
 *         - stdout / stderr  : 不设置（保留 FS 层的默认流）
 *         - print / printErr : 每行回调（引擎真正调用的输出）
 *         - noInitialRun=true: 让 pikafish.js 初始化完不立即 callMain
 *         - onRuntimeInitialized, onExit, onAbort
 *       【不设置 setStatus】—— 这样 doRun 同步执行，
 *       initRuntime / FS.init / onRuntimeInitialized 都会在
 *       importScripts 返回前被调用。
 *
 *    2. importScripts(jsUrl) → 同步执行 pikafish.js
 *         - createWasm()     ：实例化 WASM（wasmBinary 已存在，同步）
 *         - run() / doRun()  ：initRuntime() → FS.init 使用 Module.stdin
 *                              → onRuntimeInitialized
 *                              → noInitialRun=true，跳过 callMain
 *
 *    3. importScripts 返回，我们手动调用 callMain()
 *         → _main → UCI 循环 → FS 读取 /dev/stdin → createDevice 的
 *           read 方法 → 调用 stdinByte() → 返回命令行字节 ✓
 *         → print("uciok")  → 我们的 stdout 回调
 *         → 读到 "quit\n" → main 返回 → exitJS → onExit(code)
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
            noInitialRun:  true,    // ★★ 关键：暂不 callMain
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
            debug("onRuntimeInitialized: runtime 已初始化");
            postMsg({ type: 'ready' });
        };
        self.Module["onExit"] = function(code) {
            debug("onExit: code=" + code);
            postMsg({ type: 'done', code: code });
        };
        self.Module["onAbort"] = function(what) {
            debug("onAbort: " + what);
            postMsg({ type: 'error', text: "onAbort: " + String(what) });
        };
        // 注意：【不设置 Module["setStatus"]】，否则 doRun 会通过 setTimeout
        // 异步执行，导致 initRuntime 不在 importScripts 中完成。
        debug("Module 已构建（noInitialRun=true，不设置 setStatus）");
    } catch (e) {
        postMsg({ type: 'error', text: "构建 Module 失败: " + e.message });
        return;
    }

    /* 步骤 2: 同步加载并执行 pikafish.js */
    try {
        var jsBlob = new Blob([engineJs], { type: "application/javascript" });
        var jsUrl  = URL.createObjectURL(jsBlob);
        debug("开始 importScripts 加载 pikafish.js (Blob URL)");
        importScripts(jsUrl);
        URL.revokeObjectURL(jsUrl);
        debug("pikafish.js 执行完毕（已跳过自动 callMain）");
    } catch (e) {
        postMsg({ type: 'error', text: "pikafish.js 加载失败: " + e.message });
        return;
    }

    /* 步骤 3: 手动调用 callMain —— 引擎开始执行 C++ 主循环 */
    try {
        if (typeof callMain === 'function') {
            debug("调用 callMain() 启动引擎…");
            callMain([]);
            debug("callMain() 返回");
        } else if (self.Module && typeof self.Module.callMain === 'function') {
            debug("通过 Module.callMain() 启动引擎");
            self.Module.callMain([]);
        } else if (typeof _main === 'function') {
            debug("通过 _main() 启动引擎");
            _main(0, 0);
        } else {
            postMsg({ type: 'error',
                      text: "无法找到 callMain / _main 函数" });
            return;
        }
    } catch (e) {
        debug("callMain 异常: " + e.message);
        postMsg({ type: 'error', text: "callMain 失败: " + e.message });
    }

    debug("Worker 执行完成");
};

debug("worker.js 加载完成，等待宿主端 init 消息...");
