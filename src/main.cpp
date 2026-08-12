/*
  Pikafish, a UCI chess playing engine derived from Stockfish
  Copyright (C) 2004-2026 The Pikafish developers (see AUTHORS file)

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

#include <iostream>
#include <memory>
#include <utility>

#include "attacks.h"
#include "misc.h"
#include "position.h"
#include "tune.h"
#include "uci.h"

#ifdef WASM_SINGLE_THREAD
    #include <emscripten.h>
#endif

using namespace Stockfish;

#ifdef UNIVERSAL_BINARY
namespace Stockfish {

int main(int argc, char* argv[]);  // silence 'no previous declaration'

__attribute__((used))  // keep main alive
#endif

int main(int argc, char* argv[]) {
    std::cout << engine_info() << std::endl;

#ifdef WASM_SINGLE_THREAD
    std::cout << "info string WASM engine initializing..." << std::endl;
#endif

    Attacks::init();

#ifdef WASM_SINGLE_THREAD
    std::cout << "info string Attacks init done" << std::endl;
#endif

    Position::init();

#ifdef WASM_SINGLE_THREAD
    std::cout << "info string Position init done" << std::endl;
#endif

    auto cli = CommandLine(argc, argv);
    auto uci = std::make_unique<UCIEngine>(std::move(cli));

    Tune::init(uci->engine_options());

#ifdef WASM_SINGLE_THREAD
    std::cout << "info string Entering UCI loop..." << std::endl;
#endif

    uci->loop();

    return 0;
}

#ifdef WASM_SINGLE_THREAD
extern "C" {
EMSCRIPTEN_KEEPALIVE
void wasm_uci_execute() {
    static auto cli = CommandLine(0, nullptr);
    static auto uci = std::make_unique<UCIEngine>(std::move(cli));

    Tune::init(uci->engine_options());

    uci->loop();
}
}
#endif

#ifdef UNIVERSAL_BINARY
}  // namespace Stockfish

    #ifdef UNIVERSAL_NEEDS_MAIN_SHIM
int main(int argc, char* argv[]) { return Stockfish::main(argc, argv); }
    #endif
#endif
