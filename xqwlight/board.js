/*
board.js - Source Code for XiangQi Wizard Light, Part IV

XiangQi Wizard Light - a Chinese Chess Program for JavaScript
Designed by Morning Yellow, Version: 1.0, Last Modified: Sep. 2012
Copyright (C) 2004-2012 www.xqbase.com

This program is free software; you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation; either version 2 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License along
with this program; if not, write to the Free Software Foundation, Inc.,
51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA.
*/

"use strict";

var RESULT_UNKNOWN = 0;
var RESULT_WIN = 1;
var RESULT_DRAW = 2;
var RESULT_LOSS = 3;

var BOARD_WIDTH = 521;
var BOARD_HEIGHT = 577;
var SQUARE_SIZE = 57;
var SQUARE_LEFT = (BOARD_WIDTH - SQUARE_SIZE * 9) >> 1;
var SQUARE_TOP = (BOARD_HEIGHT - SQUARE_SIZE * 10) >> 1;
var THINKING_SIZE = 32;
var THINKING_LEFT = (BOARD_WIDTH - THINKING_SIZE) >> 1;
var THINKING_TOP = (BOARD_HEIGHT - THINKING_SIZE) >> 1;

function Board_layout(board, scale) {
  var bLeft = SQUARE_LEFT * scale;
  var bTop = SQUARE_TOP * scale;
  var sqSize = SQUARE_SIZE * scale;
  for (var sq = 0; sq < 256; sq++) {
    if (!IN_BOARD(sq)) continue;
    var img = board.imgSquares[sq];
    if (!img) continue;
    var style = img.style;
    style.left = Math.round(bLeft + (FILE_X(sq) - 3) * sqSize) + "px";
    style.top  = Math.round(bTop  + (RANK_Y(sq) - 3) * sqSize) + "px";
    style.width  = Math.round(sqSize) + "px";
    style.height = Math.round(sqSize) + "px";
    // 选中框（mask, oos.gif）以 backgroundImage 渲染，需显式声明
    // backgroundSize，否则缩放后遮罩仍是原图 57x57 的尺寸
    style.backgroundSize = "100% 100%";
    style.backgroundRepeat = "no-repeat";
  }
  var tSize = Math.round(THINKING_SIZE * scale);
  var tLeft = Math.round((board.container.offsetWidth  - tSize) / 2);
  var tTop  = Math.round((board.container.offsetHeight - tSize) / 2);
  board.thinking.style.width  = tSize + "px";
  board.thinking.style.height = tSize + "px";
  board.thinking.style.left   = tLeft + "px";
  board.thinking.style.top    = tTop  + "px";
}

function Board_computeScale(board) {
  var w = board.container.offsetWidth;
  return w > 0 ? w / BOARD_WIDTH : 1;
}
var MAX_STEP = 8;
var PIECE_NAME = [
  "oo", null, null, null, null, null, null, null,
  "rk", "ra", "rb", "rn", "rr", "rc", "rp", null,
  "bk", "ba", "bb", "bn", "br", "bc", "bp", null,
];

function SQ_X(sq) {
  return SQUARE_LEFT + (FILE_X(sq) - 3) * SQUARE_SIZE;
}

function SQ_Y(sq) {
  return SQUARE_TOP + (RANK_Y(sq) - 3) * SQUARE_SIZE;
}

function MOVE_PX(src, dst, step) {
  return Math.floor((src * step + dst * (MAX_STEP - step)) / MAX_STEP + .5) + "px";
}

function alertDelay(message) {
  setTimeout(function() {
    alert(message);
  }, 250);
}

function Board(container, images, sounds) {
  this.images = images;
  this.sounds = sounds;
  this.pos = new Position();
  this.pos.fromFen("rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1");
  this.animated = true;
  this.sound = true;
  this.search = null;
  this.imgSquares = [];
  this.sqSelected = 0;
  this.mvLast = 0;
  this.millis = 0;
  this.computer = -1;
  this.result = RESULT_UNKNOWN;
  this.busy = false;
  this.container = container;

  var style = container.style;
  style.position = "relative";
  style.background = "url(" + images + "board.jpg)";
  style.backgroundRepeat = "no-repeat";
  style.backgroundPosition = "center center";
  style.backgroundSize = "100% 100%";
  var this_ = this;
  for (var sq = 0; sq < 256; sq ++) {
    if (!IN_BOARD(sq)) {
      this.imgSquares.push(null);
      continue;
    }
    var img = document.createElement("img");
    var style = img.style;
    style.position = "absolute";
    style.zIndex = 0;
    img.onmousedown = function(sq_) {
      return function() {
        this_.clickSquare(sq_);
      }
    } (sq);
    container.appendChild(img);
    this.imgSquares.push(img);
  }

  this.thinking = document.createElement("img");
  this.thinking.src = images + "thinking.gif";
  style = this.thinking.style;
  style.visibility = "hidden";
  style.position = "absolute";
  container.appendChild(this.thinking);

  this.dummy = document.createElement("div");
  this.dummy.style.position = "absolute";
  container.appendChild(this.dummy);

  // SVG overlay for arrows (thinking arrows, hint arrows)
  this._arrowSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  var as = this._arrowSvg;
  as.setAttribute("viewBox", "0 0 " + BOARD_WIDTH + " " + BOARD_HEIGHT);
  as.setAttribute("preserveAspectRatio", "xMidYMid meet");
  as.style.position = "absolute";
  as.style.top = "0";
  as.style.left = "0";
  as.style.width = "100%";
  as.style.height = "100%";
  as.style.pointerEvents = "none";
  as.style.zIndex = "300";
  container.appendChild(as);

  // 布局
  this.relayout = function() {
    var scale = Board_computeScale(this_);
    this_._scale = scale;
    Board_layout(this_, scale);
  };
  this.relayout();
  if (typeof window !== "undefined") {
    var resizeTimer = null;
    window.addEventListener("resize", function() {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function() { this_.relayout(); }, 50);
    });
  }

  this.flushBoard();
}

Board.prototype.playSound = function(soundFile) {
  if (!this.sound) {
    return;
  }
  try {
    new Audio(this.sounds + soundFile + ".wav").play().catch(function(e) {
      // 静默忽略音频加载失败（如文件不存在、格式不支持）
    });
  } catch (e) {
    this.dummy.innerHTML= "<embed src=\"" + this.sounds + soundFile +
        ".wav\" hidden=\"true\" autostart=\"true\" loop=\"false\" />";
  }
}

Board.prototype.setSearch = function(hashLevel) {
  this.search = hashLevel == 0 ? null : new Search(this.pos, hashLevel);
}

Board.prototype.flipped = function(sq) {
  return this.computer == 0 ? SQUARE_FLIP(sq) : sq;
}

Board.prototype.computerMove = function() {
  return this.pos.sdPlayer == this.computer;
}

Board.prototype.computerLastMove = function() {
  return 1 - this.pos.sdPlayer == this.computer;
}

Board.prototype.addMove = function(mv, computerMove) {
  if (!this.pos.legalMove(mv)) {
    return;
  }
  if (!this.pos.makeMove(mv)) {
    this.playSound("illegal");
    return;
  }
  this.busy = true;
  if (!this.animated) {
    this.postAddMove(mv, computerMove);
    return;
  }

  var scale = this._scale || 1;
  var sqSrc = this.flipped(SRC(mv));
  var xSrc = Math.round((SQUARE_LEFT + (FILE_X(sqSrc) - 3) * SQUARE_SIZE) * scale);
  var ySrc = Math.round((SQUARE_TOP  + (RANK_Y(sqSrc) - 3) * SQUARE_SIZE) * scale);
  var sqDst = this.flipped(DST(mv));
  var xDst = Math.round((SQUARE_LEFT + (FILE_X(sqDst) - 3) * SQUARE_SIZE) * scale);
  var yDst = Math.round((SQUARE_TOP  + (RANK_Y(sqDst) - 3) * SQUARE_SIZE) * scale);
  var style = this.imgSquares[sqSrc].style;
  style.zIndex = 256;
  var step = MAX_STEP - 1;
  var this_ = this;
  var timer = setInterval(function() {
    if (step == 0) {
      clearInterval(timer);
      style.left = xSrc + "px";
      style.top = ySrc + "px";
      style.zIndex = 0;
      this_.postAddMove(mv, computerMove);
    } else {
      style.left = MOVE_PX(xSrc, xDst, step);
      style.top = MOVE_PX(ySrc, yDst, step);
      step --;
    }
  }, 16);
}

Board.prototype.postAddMove = function(mv, computerMove) {
  if (this.mvLast > 0) {
    this.drawSquare(SRC(this.mvLast), false);
    this.drawSquare(DST(this.mvLast), false);
  }
  this.drawSquare(SRC(mv), true);
  this.drawSquare(DST(mv), true);
  this.sqSelected = 0;
  this.mvLast = mv;

  if (this.pos.isMate()) {
    this.playSound(computerMove ? "loss" : "win");
    this.result = computerMove ? RESULT_LOSS : RESULT_WIN;

    var pc = SIDE_TAG(this.pos.sdPlayer) + PIECE_KING;
    var sqMate = 0;
    for (var sq = 0; sq < 256; sq ++) {
      if (this.pos.squares[sq] == pc) {
        sqMate = sq;
        break;
      }
    }
    if (!this.animated || sqMate == 0) {
      this.postMate(computerMove);
      return;
    }

    sqMate = this.flipped(sqMate);
    var style = this.imgSquares[sqMate].style;
    style.zIndex = 256;
    var scale = this._scale || 1;
    var xMate = Math.round((SQUARE_LEFT + (FILE_X(sqMate) - 3) * SQUARE_SIZE) * scale);
    var step = MAX_STEP;
    var this_ = this;
    var timer = setInterval(function() {
      if (step == 0) {
        clearInterval(timer);
        style.left = xMate + "px";
        style.zIndex = 0;
        this_.imgSquares[sqMate].src = this_.images +
            (this_.pos.sdPlayer == 0 ? "r" : "b") + "km.gif";
        this_.postMate(computerMove);
      } else {
        style.left = (xMate + ((step & 1) == 0 ? step : -step) * 2) + "px";
        step --;
      }
    }, 50);
    return;
  }

  var vlRep = this.pos.repStatus(3);
  if (vlRep > 0) {
    vlRep = this.pos.repValue(vlRep);
    if (vlRep > -WIN_VALUE && vlRep < WIN_VALUE) {
      this.playSound("draw");
      this.result = RESULT_DRAW;
      alertDelay("双方不变作和，辛苦了！");
    } else if (computerMove == (vlRep < 0)) {
      this.playSound("loss");
      this.result = RESULT_LOSS;
      alertDelay("长打作负，请不要气馁！");
    } else {
      this.playSound("win");
      this.result = RESULT_WIN;
      alertDelay("长打作负，祝贺你取得胜利！");
    }
    this.postAddMove2();
    this.busy = false;
    return;
  }

  if (this.pos.captured()) {
    var hasMaterial = false;
    for (var sq = 0; sq < 256; sq ++) {
      if (IN_BOARD(sq) && (this.pos.squares[sq] & 7) > 2) {
        hasMaterial = true;
        break;
      }
    }
    if (!hasMaterial) {
      this.playSound("draw");
      this.result = RESULT_DRAW;
      alertDelay("双方都没有进攻棋子了，辛苦了！");
      this.postAddMove2();
      this.busy = false;
      return;
    }
  } else if (this.pos.pcList.length > 100) {
    var captured = false;
    for (var i = 2; i <= 100; i ++) {
      if (this.pos.pcList[this.pos.pcList.length - i] > 0) {
        captured = true;
        break;
      }
    }
    if (!captured) {
      this.playSound("draw");
      this.result = RESULT_DRAW;
      alertDelay("超过自然限着作和，辛苦了！");
      this.postAddMove2();
      this.busy = false;
      return;
    }
  }

  if (this.pos.inCheck()) {
    this.playSound(computerMove ? "check2" : "check");
  } else if (this.pos.captured()) {
    this.playSound(computerMove ? "capture2" : "capture");
  } else {
    this.playSound(computerMove ? "move2" : "move");
  }

  this.postAddMove2();
  this.response();
}

Board.prototype.postAddMove2 = function() {
  if (typeof this.onAddMove == "function") {
    this.onAddMove();
  }
}

Board.prototype.postMate = function(computerMove) {
  alertDelay(computerMove ? "请再接再厉！" : "祝贺你取得胜利！");
  this.postAddMove2();
  this.busy = false;
}

Board.prototype.response = function() {
  if (this.search == null || !this.computerMove()) {
    this.busy = false;
    return;
  }
  this.thinking.style.visibility = "visible";
  var this_ = this;
  this.busy = true;
  setTimeout(function() {
    this_.addMove(board.search.searchMain(LIMIT_DEPTH, board.millis), true);
    this_.thinking.style.visibility = "hidden";
  }, 250);
}

Board.prototype.clickSquare = function(sq_) {
  if (this.busy || this.result != RESULT_UNKNOWN) {
    return;
  }
  var sq = this.flipped(sq_);
  var pc = this.pos.squares[sq];
  if ((pc & SIDE_TAG(this.pos.sdPlayer)) != 0) {
    this.playSound("click");
    if (this.mvLast != 0) {
      this.drawSquare(SRC(this.mvLast), false);
      this.drawSquare(DST(this.mvLast), false);
    }
    if (this.sqSelected) {
      this.drawSquare(this.sqSelected, false);
    }
    this.drawSquare(sq, true);
    this.sqSelected = sq;
  } else if (this.sqSelected > 0) {
    this.addMove(MOVE(this.sqSelected, sq), false);
  }
}

Board.prototype.drawSquare = function(sq, selected) {
  var img = this.imgSquares[this.flipped(sq)];
  img.src = this.images + PIECE_NAME[this.pos.squares[sq]] + ".gif";
  img.style.backgroundImage = selected ? "url(" + this.images + "oos.gif)" : "";
}

Board.prototype.flushBoard = function() {
  this.clearArrows();
  this.mvLast = this.pos.mvList[this.pos.mvList.length - 1];
  for (var sq = 0; sq < 256; sq ++) {
    if (IN_BOARD(sq)) {
      this.drawSquare(sq, sq == SRC(this.mvLast) || sq == DST(this.mvLast));
    }
  }
}

Board.prototype.restart = function(fen) {
  if (this.busy) {
    return;
  }
  this.result = RESULT_UNKNOWN;
  this.pos.fromFen(fen);
  // 保存开局 FEN 到 Board 对象和引擎搜索对象
  this.startFen = fen;
  if (this.search && typeof this.search.setStartFen === 'function') {
    this.search.setStartFen(fen);
  }
  this.flushBoard();
  this.playSound("newgame");
  this.response();
}

Board.prototype.retract = function() {
  if (this.busy) {
    return;
  }
  this.result = RESULT_UNKNOWN;
  if (this.pos.mvList.length > 1) {
    this.pos.undoMakeMove();
  }
  if (this.pos.mvList.length > 1 && this.computerMove()) {
    this.pos.undoMakeMove();
  }
  this.flushBoard();
  this.response();
}

Board.prototype.setSound = function(sound) {
  this.sound = sound;
  if (sound) {
    this.playSound("click");
  }
}

/* ---------- 箭头绘制（思考箭头 / 提示箭头） ---------- */

/**
 * 在棋盘上绘制一个箭头，从着法起点指向终点
 * @param {number} mv - xqwlight 内部 move（SRC/DST 编码）
 * @param {string} color - 'red' 或 'black'
 */
Board.prototype.drawArrow = function(mv, color) {
  var sqSrc = this.flipped(SRC(mv));
  var sqDst = this.flipped(DST(mv));
  var cx1 = SQ_X(sqSrc) + SQUARE_SIZE / 2;
  var cy1 = SQ_Y(sqSrc) + SQUARE_SIZE / 2;
  var cx2 = SQ_X(sqDst) + SQUARE_SIZE / 2;
  var cy2 = SQ_Y(sqDst) + SQUARE_SIZE / 2;
  var strokeColor = color === 'red' ? '#e74c3c' : '#2c3e50';
  var g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  // 箭杆
  var line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", cx1);
  line.setAttribute("y1", cy1);
  line.setAttribute("x2", cx2);
  line.setAttribute("y2", cy2);
  line.setAttribute("stroke", strokeColor);
  line.setAttribute("stroke-width", "3.5");
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("opacity", "0.85");
  g.appendChild(line);
  // 箭头三角
  var angle = Math.atan2(cy2 - cy1, cx2 - cx1);
  var headLen = 14;
  var spread = Math.PI / 7;
  var poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  var pts = [
    cx2 + "," + cy2,
    (cx2 - headLen * Math.cos(angle - spread)) + "," + (cy2 - headLen * Math.sin(angle - spread)),
    (cx2 - headLen * Math.cos(angle + spread)) + "," + (cy2 - headLen * Math.sin(angle + spread))
  ].join(" ");
  poly.setAttribute("points", pts);
  poly.setAttribute("fill", strokeColor);
  poly.setAttribute("opacity", "0.85");
  g.appendChild(poly);
  this._arrowSvg.appendChild(g);
};

/** 清空所有箭头 */
Board.prototype.clearArrows = function() {
  while (this._arrowSvg.firstChild) {
    this._arrowSvg.removeChild(this._arrowSvg.firstChild);
  }
};

