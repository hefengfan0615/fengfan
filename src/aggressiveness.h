/*
  Pikafish, a UCI Xiangqi engine derived from Stockfish
  Copyright (C) 2026 The Pikafish developers (see AUTHORS file)

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

#ifndef AGGRESSIVENESS_H_INCLUDED
#define AGGRESSIVENESS_H_INCLUDED

#include "position.h"
#include "types.h"

namespace Stockfish {

// Per-thread cached values for the Duffish-style "Aggressiveness" family of
// UCI options. They bias evaluation and search towards sharp, sacrificial,
// uncompromising play (see the Duffish Xiangqi engine, XEAS concept).
struct AggressivenessParams {
    Color rootColor           = COLOR_NB;
    int   rootMaterialBalance = 0;
    int   rootNonPawnMatDiff  = 0;

    int aggressiveness    = 165;
    int drawValue         = -39;
    int dynamicComp       = 63;
    int sacBonus          = 45;
    int advisorBreakBonus = 35;
    int bishopBreakBonus  = 16;
    int matScale          = 10;
    int sacDetect         = 12;
    int drawMatBias       = 25;
    int evalDecay         = 35;
};

// Material sums (in PieceValue units) used to measure the root side's material
// situation and how much it has sacrificed during the game.
int xiangqi_material(const Position& pos, Color c);
int xiangqi_material_balance(const Position& pos, Color root);
int xiangqi_total_material(const Position& pos);
int xiangqi_non_pawn_material(const Position& pos, Color c);

// Duffish Aggressiveness principle: reshape a side-to-move evaluation from the
// root side's perspective, rewarding attack pressure, palace threats and
// compensation for sacrificed material.
Value apply_duffish_eval_shaping(const Position& pos, Value v, const AggressivenessParams& p);

}  // namespace Stockfish

#endif  // #ifndef AGGRESSIVENESS_H_INCLUDED
