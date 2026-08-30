/*
  Pikafish, a UCI Xiangqi engine derived from Stockfish
  Copyright (C) 2026 The Pikafish developers (see AUTHORS file)

  This file ports the "Aggressiveness" evaluation principle of the Duffish
  Xiangqi engine (a Fairy-Stockfish derivative, GPLv3) into Pikafish. The core
  idea is to reshape the NNUE evaluation from the root side's perspective:
  attacking pieces closing in on the enemy palace, pressure on the king, damage
  to the enemy's advisor/bishop defensive shell and material sacrificed for an
  ongoing attack are all rewarded, making the engine prefer sharp, sacrificial,
  uncompromising play.

  Pikafish is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  Pikafish is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

#include "aggressiveness.h"

#include <algorithm>

#include "attacks.h"
#include "bitboard.h"
#include "position.h"
#include "types.h"

namespace Stockfish {

namespace {

// Red (WHITE) plays from the bottom of the board, so the relative rank counts
// from the back rank of each side (0 = back rank, 9 = enemy back rank).
int xiangqi_relative_rank(Color c, Square s) {
    return c == WHITE ? int(rank_of(s)) : int(RANK_9) - int(rank_of(s));
}

// The 3x3 "palace zone" around the given side's king.
Bitboard xiangqi_palace_zone(const Position& pos, Color c) {
    if (!pos.count<KING>(c))
        return Bitboard(0);

    Square ksq   = pos.king_square(c);
    int    kFile = int(file_of(ksq));
    Bitboard zone = 0;
    for (int f = std::max(0, kFile - 1); f <= std::min(int(FILE_NB) - 1, kFile + 1); ++f)
        for (int r = 0; r < int(RANK_NB); ++r)
        {
            Square s = make_square(File(f), Rank(r));
            if (xiangqi_relative_rank(c, s) <= 2)
                zone |= s;
        }

    return zone;
}

bool xiangqi_near_enemy_palace(const Position& pos, Color root, Square s) {
    Color  them = ~root;
    if (!pos.count<KING>(them))
        return false;

    Square ksq = pos.king_square(them);
    return (xiangqi_palace_zone(pos, them) & s)
        || (distance<File>(s, ksq) <= 1 && distance<Rank>(s, ksq) <= 3);
}

// Pieces of the given color that are able to attack (rook, cannon, horse, pawn).
Bitboard xiangqi_attackers(const Position& pos, Color c) {
    return pos.pieces(c, ROOK) | pos.pieces(c, CANNON) | pos.pieces(c, KNIGHT)
         | pos.pieces(c, PAWN);
}

// Damage dealt to the enemy's defensive shell (missing advisors and bishops).
int xiangqi_guard_damage(const Position& pos, Color root) {
    Color them = ~root;
    return 40 * std::max(0, 2 - pos.count<ADVISOR>(them))
         + 22 * std::max(0, 2 - pos.count<BISHOP>(them));
}

// How much pressure the root side puts on the enemy king and palace.
int xiangqi_attack_pressure(const Position& pos, Color root) {
    Color them = ~root;
    if (!pos.count<KING>(them))
        return 0;

    Square   ksq       = pos.king_square(them);
    Bitboard palace    = xiangqi_palace_zone(pos, them);
    Bitboard attackers = xiangqi_attackers(pos, root);

    int pressure = xiangqi_guard_damage(pos, root);
    pressure += 42 * popcount(pos.attackers_to(ksq) & attackers);

    Bitboard zone = palace;
    while (zone)
    {
        Square s = pop_lsb(zone);
        pressure += 10 * popcount(pos.attackers_to(s) & attackers);
    }

    Bitboard pieces = attackers;
    while (pieces)
    {
        Square    s  = pop_lsb(pieces);
        PieceType pt = type_of(pos.piece_on(s));
        int       fd = distance<File>(s, ksq);
        int       rd = distance<Rank>(s, ksq);

        if (fd <= 1 && rd <= 3)
            pressure += pt == ROOK ? 34 : pt == CANNON ? 38 : pt == KNIGHT ? 28 : 14;
        else if ((pt == ROOK || pt == CANNON)
                 && (file_of(s) == file_of(ksq) || rank_of(s) == rank_of(ksq)))
            pressure += 16;
    }

    return std::min(360, pressure);
}

// True when the root side has an attacking shape: pieces near the enemy palace,
// heavy pieces on the king's file/rank or advanced soldiers.
bool xiangqi_attack_shape(const Position& pos, Color root) {
    Color them = ~root;
    if (!pos.count<KING>(them))
        return false;

    Square   ksq    = pos.king_square(them);
    Bitboard pieces = xiangqi_attackers(pos, root);
    while (pieces)
    {
        Square    s  = pop_lsb(pieces);
        PieceType pt = type_of(pos.piece_on(s));

        if (xiangqi_near_enemy_palace(pos, root, s))
            return true;

        if ((pt == ROOK || pt == CANNON)
            && (file_of(s) == file_of(ksq) || rank_of(s) == rank_of(ksq)))
            return true;

        if (pt == PAWN && xiangqi_relative_rank(root, s) >= 5 && distance<File>(s, ksq) <= 2)
            return true;
    }

    return false;
}

// The minimum sacrifice quality needed to consider a given material loss as
// compensated by an ongoing attack.
int xiangqi_required_sacrifice_quality(int materialLoss) {
    return 70 + std::min(materialLoss, 1200) / 12;
}

// Attack mask of a piece of the given type/color standing on square s.
Bitboard xiangqi_attacks_from(const Position& pos, Color c, PieceType pt, Square s) {
    if (pt == PAWN)
        return Attacks::attacks_bb<PAWN>(s, c);
    return Attacks::attacks_bb(pt, s, pos.pieces());
}

// Quality of the root side's compensation for the given material loss.
int xiangqi_sacrifice_quality(const Position& pos, Color root, int materialLoss, int pressure) {
    if (materialLoss <= 0 || !pos.count<KING>(~root))
        return 0;

    Color    them      = ~root;
    Square   ksq       = pos.king_square(them);
    Bitboard attackers = xiangqi_attackers(pos, root);
    int      guardDamage    = xiangqi_guard_damage(pos, root);
    int      directKing     = popcount(pos.attackers_to(ksq) & attackers);
    int      nearPalace     = 0;
    int      kingLines      = 0;
    int      advancedSoldiers = 0;
    int      guardThreats   = 0;

    Bitboard pieces = attackers;
    while (pieces)
    {
        Square    s  = pop_lsb(pieces);
        PieceType pt = type_of(pos.piece_on(s));

        if (xiangqi_near_enemy_palace(pos, root, s))
            nearPalace++;

        if ((pt == ROOK || pt == CANNON)
            && (file_of(s) == file_of(ksq) || rank_of(s) == rank_of(ksq)))
            kingLines++;

        if (pt == PAWN && xiangqi_relative_rank(root, s) >= 5 && distance<File>(s, ksq) <= 2)
            advancedSoldiers++;

        if (xiangqi_attacks_from(pos, root, pt, s)
            & (pos.pieces(them, ADVISOR) | pos.pieces(them, BISHOP)))
            guardThreats++;
    }

    int quality = pressure + guardDamage / 2 + 34 * directKing + 18 * nearPalace
                + 18 * kingLines + 14 * advancedSoldiers + 16 * guardThreats;

    if (materialLoss >= 600 && directKing == 0 && nearPalace < 2 && pressure < 115)
        quality -= 70;

    if (pressure < 65 && guardDamage < 40 && directKing == 0)
        quality /= 3;

    return std::clamp(quality, 0, 512);
}

// Threat level against the enemy king's palace.
int xiangqi_palace_threat(const Position& pos, Color root, int pressure) {
    Color them = ~root;
    if (!pos.count<KING>(them))
        return 0;

    Square   ksq       = pos.king_square(them);
    Bitboard palace    = xiangqi_palace_zone(pos, them);
    Bitboard attackers = xiangqi_attackers(pos, root);
    Bitboard defenders = pos.pieces(them);
    int      score           = pressure / 3 + xiangqi_guard_damage(pos, root) / 2;
    int      forcingPoints   = 0;

    int direct = popcount(pos.attackers_to(ksq) & attackers);
    if (direct)
    {
        score += 46 * direct;
        forcingPoints += 1 + direct;
    }

    Bitboard zone = palace;
    while (zone)
    {
        Square s = pop_lsb(zone);
        int    a = popcount(pos.attackers_to(s) & attackers);
        int    d = popcount(pos.attackers_to(s) & defenders);

        if (!a)
            continue;

        score += 9 * a;
        if (a > d)
        {
            score += 18 * (a - d);
            forcingPoints++;
        }
        if (a >= 2)
            forcingPoints++;
    }

    Bitboard guards = pos.pieces(them, ADVISOR) | pos.pieces(them, BISHOP);
    while (guards)
    {
        Square s = pop_lsb(guards);
        int    a = popcount(pos.attackers_to(s) & attackers);
        int    d = popcount(pos.attackers_to(s) & defenders);

        if (!a)
            continue;

        score += 18 * a + 12 * std::max(0, a - d);
        if (a > d)
            forcingPoints++;
    }

    if (forcingPoints >= 4 && score >= 135)
        score += 70;
    else if (forcingPoints >= 3 && score >= 115)
        score += 40;
    else if (forcingPoints < 2)
        score /= 2;

    return std::clamp(score, 0, 320);
}

}  // namespace


int xiangqi_material(const Position& pos, Color c) {
    return int(PieceValue[make_piece(c, ROOK)]) * pos.count<ROOK>(c)
         + int(PieceValue[make_piece(c, CANNON)]) * pos.count<CANNON>(c)
         + int(PieceValue[make_piece(c, KNIGHT)]) * pos.count<KNIGHT>(c)
         + int(PieceValue[make_piece(c, ADVISOR)]) * pos.count<ADVISOR>(c)
         + int(PieceValue[make_piece(c, BISHOP)]) * pos.count<BISHOP>(c)
         + int(PieceValue[make_piece(c, PAWN)]) * pos.count<PAWN>(c);
}

int xiangqi_material_balance(const Position& pos, Color root) {
    return xiangqi_material(pos, root) - xiangqi_material(pos, ~root);
}

int xiangqi_total_material(const Position& pos) {
    return xiangqi_material(pos, WHITE) + xiangqi_material(pos, BLACK);
}

int xiangqi_non_pawn_material(const Position& pos, Color c) {
    return int(PieceValue[make_piece(c, ROOK)]) * pos.count<ROOK>(c)
         + int(PieceValue[make_piece(c, CANNON)]) * pos.count<CANNON>(c)
         + int(PieceValue[make_piece(c, KNIGHT)]) * pos.count<KNIGHT>(c)
         + int(PieceValue[make_piece(c, ADVISOR)]) * pos.count<ADVISOR>(c)
         + int(PieceValue[make_piece(c, BISHOP)]) * pos.count<BISHOP>(c);
}


// Duffish Aggressiveness principle: reshape a side-to-move evaluation from the
// root side's perspective (see Duffish's apply_duffish_eval_shaping()).
Value apply_duffish_eval_shaping(const Position& pos, Value v, const AggressivenessParams& p) {

    int evalDecay = p.evalDecay;
    if (evalDecay > 0 && v != VALUE_ZERO)
    {
        int halfmoves = pos.rule60_count();
        if (halfmoves > 0)
        {
            int decayFactor = 1024 - evalDecay * halfmoves / 50;
            decayFactor     = std::max(decayFactor, 512);
            v               = Value(int(v) * decayFactor / 1024);
        }
    }

    int aggressiveness = p.aggressiveness;
    if (aggressiveness == 100 && p.sacBonus == 0 && p.sacDetect == 0)
        return v;

    Color root     = p.rootColor < COLOR_NB ? p.rootColor : pos.side_to_move();
    int   rootSign = pos.side_to_move() == root ? 1 : -1;
    int   rootEval = rootSign * int(v);
    int   styleScale = std::clamp(aggressiveness, 0, 300);
    auto  style_bonus = [styleScale](int bonus) { return bonus * styleScale / 100; };

    int currentBalance = xiangqi_material_balance(pos, root);
    int startBalance   = p.rootColor < COLOR_NB ? p.rootMaterialBalance : currentBalance;
    int rootMaterialLoss = std::max(0, startBalance - currentBalance);

    int  attackPressure   = -1;
    int  palaceThreat     = -1;
    bool attackContextKnown = false;
    bool attackContext    = false;
    auto getAttackPressure = [&]() {
        if (attackPressure < 0)
            attackPressure = xiangqi_attack_pressure(pos, root);
        return attackPressure;
    };
    auto hasAttackContext = [&]() {
        if (!attackContextKnown)
        {
            attackContext = rootMaterialLoss > 0 || xiangqi_guard_damage(pos, root) >= 40
                         || xiangqi_attack_shape(pos, root);
            attackContextKnown = true;
        }
        return attackContext;
    };
    auto getPalaceThreat = [&]() {
        if (palaceThreat < 0)
            palaceThreat = hasAttackContext() && getAttackPressure() >= 80
                         ? xiangqi_palace_threat(pos, root, getAttackPressure())
                         : 0;
        return palaceThreat;
    };

    // Bonus for the root side having sacrificed material with enough attacking
    // compensation (SacBonus option).
    int sacBonus = p.sacBonus;
    if (sacBonus > 0 && rootMaterialLoss > 0)
    {
        int cappedLoss = std::min(rootMaterialLoss, 1200);
        int pressure   = getAttackPressure();
        int quality    = xiangqi_sacrifice_quality(pos, root, rootMaterialLoss, pressure);
        int required   = xiangqi_required_sacrifice_quality(rootMaterialLoss);
        int bonus      = sacBonus * cappedLoss / 260;
        if (quality < required)
        {
            bonus = bonus * std::max(quality, 1) / required;
            if (quality < required / 2)
                bonus /= 2;
        }
        else
        {
            bonus += sacBonus * std::min(quality - required, 240) / 380;
            bonus += p.dynamicComp * std::min(quality, 360) / 760;
            if (quality >= required + 90)
                bonus += sacBonus / 3;
        }
        if (rootEval > 500)
            bonus = bonus * 3 / 2;
        else if (rootEval < -250)
            bonus /= 2;
        rootEval += style_bonus(bonus);
    }

    // Sacrifice-detection bonus, applied on top of SacBonus (SacDetect option).
    // In Duffish this is computed during the search; here it is folded into the
    // evaluation shaping using the same material-loss / attack-quality logic.
    int sacDetect = p.sacDetect;
    if (sacDetect > 0 && rootMaterialLoss > 0)
    {
        int cappedLoss = std::min(rootMaterialLoss, 1200);
        int pressure   = getAttackPressure();
        int quality    = xiangqi_sacrifice_quality(pos, root, rootMaterialLoss, pressure);
        int required   = xiangqi_required_sacrifice_quality(rootMaterialLoss);
        int bonus      = sacDetect * cappedLoss / 260;
        int trace      = std::min(160, rootMaterialLoss / 6) + quality / 2;
        bonus += sacDetect * std::min(trace, 360) / 520;
        bonus += p.dynamicComp * std::min(quality, 420) / 900;
        if (quality < required)
        {
            bonus = bonus * std::max(quality, 1) / required;
            if (quality < required / 2)
                bonus /= 2;
        }
        else
            bonus += sacDetect * std::min(quality - required, 240) / 420;

        if (rootEval > 500)
            bonus *= 2;
        else if (rootEval < -250)
            bonus /= 2;
        rootEval += style_bonus(bonus);
    }

    if (aggressiveness > 100)
    {
        int pressure = getAttackPressure();
        if (pressure >= (rootMaterialLoss > 0 ? 70 : 95))
        {
            int pressureBonus = std::min(165, (pressure - 45) / 2);
            if (rootMaterialLoss > 0)
                pressureBonus += std::min(
                  55, xiangqi_sacrifice_quality(pos, root, rootMaterialLoss, pressure) / 9);
            if (rootEval < -350)
                pressureBonus /= 2;
            rootEval += style_bonus(pressureBonus);
        }

        if (pressure >= 80)
        {
            int threat = getPalaceThreat();
            if (threat >= 105)
                rootEval += style_bonus(std::min(100, 12 + threat / 5));
        }
    }

    int materialOutperformance = rootEval - currentBalance;
    if (rootEval > 0 && materialOutperformance > 180)
        rootEval += style_bonus(std::min(90, 15 + (materialOutperformance - 180) / 12));

    int matScale = p.matScale;
    if (matScale > 0 && rootEval > 0)
    {
        int totalMat   = xiangqi_total_material(pos);
        int multiplier = 1024 + matScale * std::min(totalMat, 6400) / 4800;
        if (rootMaterialLoss > 0)
            multiplier += matScale * std::min(rootMaterialLoss, 800) / 400;
        rootEval = rootEval * multiplier / 1024;
    }

    if (aggressiveness != 100)
        rootEval += (aggressiveness - 100) * rootEval / 500;

    {
        Color them = ~root;
        int   advisorBreakBonus = p.advisorBreakBonus;
        int   bishopBreakBonus  = p.bishopBreakBonus;

        if (advisorBreakBonus > 0)
            rootEval += style_bonus(advisorBreakBonus * std::max(0, 2 - pos.count<ADVISOR>(them)));

        if (bishopBreakBonus > 0)
            rootEval += style_bonus(bishopBreakBonus * std::max(0, 2 - pos.count<BISHOP>(them)));
    }

    rootEval = std::clamp(rootEval, int(VALUE_MATED_IN_MAX_PLY) + 1,
                          int(VALUE_MATE_IN_MAX_PLY) - 1);
    return Value(rootSign * rootEval);
}

}  // namespace Stockfish
