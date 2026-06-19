"use strict";

/* ---------- 中文棋谱转换 -------------------------------
 *
 * move2Iccs(mv, pos)  将 xqwlight 内部着法转为中文棋谱
 *
 * 格式示例：
 *   单一棋子：炮二平五、马8进7、车一进一
 *   同列相同棋子（前/后）：前炮退一、后车平4
 *
 * 行棋方红方（sd=1）使用汉字数字：一二三四五六七八九
 * 行棋方黑方（sd=2）使用全角数字：１２３４５６７８９
 * ---------------------------------------------------- */

/* 棋子名称映射（与 pikafish.html 中的 CN_PIECE_R/CN_PIECE_B 一致） */
var CN_PIECE = {
  1: ['帅', '仕', '相', '马', '车', '炮', '兵'],  // 红方 sd=1
  2: ['将', '士', '象', '马', '车', '炮', '卒']   // 黑方 sd=2
};

/* 列号/步数数字 */
var CN_NUM_R = ['一','二','三','四','五','六','七','八','九'];  // 红方
var CN_NUM_B = ['１','２','３','４','５','６','７','８','９'];  // 黑方

function move2Iccs(mv, pos) {
  if (!mv || mv <= 0) return "";
  // 如果没有传入 pos 对象，回退到坐标格式（向下兼容）
  if (!pos || !pos.squares) {
    var sqSrc = SRC(mv);
    var sqDst = DST(mv);
    return CHR(ASC("A") + FILE_X(sqSrc) - FILE_LEFT) +
        CHR(ASC("9") - RANK_Y(sqSrc) + RANK_TOP) + "-" +
        CHR(ASC("A") + FILE_X(sqDst) - FILE_LEFT) +
        CHR(ASC("9") - RANK_Y(sqDst) + RANK_TOP);
  }

  var sqSrc = SRC(mv);
  var sqDst = DST(mv);
  var pc = pos.squares[sqSrc];
  if (!pc) return "?";

  var sd = pc >> 3;        // 1=红, 2=黑
  var pt = pc & 7;         // 0=帅/将, 1=仕/士, 2=相/象, 3=马, 4=车, 5=炮, 6=兵/卒
  var isRed = (sd === 1);
  var names = CN_PIECE[sd];
  var nums = isRed ? CN_NUM_R : CN_NUM_B;

  var pieceName = names[pt];
  var srcFile = FILE_X(sqSrc);  // 3..11
  var dstFile = FILE_X(sqDst);
  var srcRank = RANK_Y(sqSrc);  // 3..12
  var dstRank = RANK_Y(sqDst);

  // 从行棋方视角的列号（右→左 1..9）
  var srcCol, dstCol;
  if (isRed) {
    srcCol = 12 - srcFile;   // file 11→1, file 3→9
    dstCol = 12 - dstFile;
  } else {
    srcCol = srcFile - 2;    // file 3→1, file 11→9
    dstCol = dstFile - 2;
  }

  /* ---- 检测同一列是否存在相同棋子（用于前/后） ---- */
  var sameCount = 0;
  var sameSq = -1;
  for (var sq = 0; sq < 256; sq++) {
    if (IN_BOARD(sq) && pos.squares[sq] === pc && FILE_X(sq) === srcFile && sq !== sqSrc) {
      sameCount++;
      sameSq = sq;
      break; // 只需要知道是否有同列相同棋子
    }
  }

  /* ---- 生成方向 ---- */
  var dir;
  if (srcRank === dstRank) {
    dir = '平';
  } else if (isRed) {
    dir = (dstRank < srcRank) ? '进' : '退';  // 红方向上走（rank 减小）为进
  } else {
    dir = (dstRank > srcRank) ? '进' : '退';  // 黑方向下走（rank 增大）为进
  }

  /* ---- 生成目标部分 ---- */
  var rankDist = Math.abs(dstRank - srcRank);
  var target;
  if (dir === '平') {
    target = nums[dstCol - 1];
  } else if (pt === PIECE_KNIGHT || pt === PIECE_ADVISOR || pt === PIECE_BISHOP) {
    // 跳走棋子（马、士、象/相）：目标显示列号
    target = nums[dstCol - 1];
  } else {
    // 直线棋子（车、炮、兵/卒、帅/将）：目标显示步数
    target = nums[Math.min(rankDist - 1, 8)];
  }

  /* ---- 组装 ---- */
  var result;
  if (sameCount > 0) {
    // 同一列有两个相同棋子，使用前/后
    var isFront;
    if (isRed) {
      isFront = (srcRank < RANK_Y(sameSq));
    } else {
      isFront = (srcRank > RANK_Y(sameSq));
    }
    result = (isFront ? '前' : '后') + pieceName + dir + target;
  } else {
    result = pieceName + nums[srcCol - 1] + dir + target;
  }

  return result;
}