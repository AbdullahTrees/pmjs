#include "../src/scenery_window.hpp"
#include <limits>
#include <random>
#include <stdexcept>
#include <string>

namespace {
int checkNumber = 0;
void check(bool value) {
  ++checkNumber;
  if (!value) throw std::runtime_error("scenery window bounds failed at check " +
    std::to_string(checkNumber));
}
}

int main() {
  using pmjs::chooseSceneryWindow;
  check(!chooseSceneryWindow(3240, 3240, -1, 0, 100, 100));
  check(!chooseSceneryWindow(3240, 3240, 0, 0, 5000, 100));
  check(!chooseSceneryWindow(3240, 3240, 0, 0, 1535, 1535));
  for (int x : {0, 128, 255, 256, 1100, 2280}) {
    for (int y : {0, 128, 520, 2400}) {
      if (x + 960 > 3240 || y + 720 > 3240) continue;
      const auto box = chooseSceneryWindow(3240, 3240, x, y, 960, 720);
      check(box.has_value());
      check(box->x >= 0 && box->y >= 0);
      check(box->width <= 1536 && box->height <= 1536);
      check(x >= box->x && y >= box->y);
      check(x + 960 <= box->x + box->width);
      check(y + 720 <= box->y + box->height);
    }
  }
  for (int x : {0, 1, 2, 2278, 2279, 2280}) {
    const auto box = chooseSceneryWindow(3240, 3240, x, 1000, 960, 720);
    check(box.has_value());
    check(box->x <= std::max(0, x - 2));
    check(box->x + box->width >= std::min(3240, x + 962));
  }
  const auto first = chooseSceneryWindow(3240, 3240, 600, 600, 960, 720);
  const auto second = chooseSceneryWindow(3240, 3240, 601, 600, 960, 720);
  const auto beforeShift = chooseSceneryWindow(3240, 3240, 1086, 600, 960, 720);
  const auto afterShift = chooseSceneryWindow(3240, 3240, 1087, 600, 960, 720);
  check(first.has_value() && second.has_value() && beforeShift.has_value() &&
    afterShift.has_value());
  check(first->x == second->x && first->x == beforeShift->x && first->y == second->y);
  check(afterShift->x != beforeShift->x);
  check(chooseSceneryWindow(1056, 1056, 0, 0, 1056, 1056).has_value());
  const auto wrapped = chooseSceneryWindow(3240, 3240, -16, 0, 640, 360, 1536, true);
  check(wrapped.has_value());
  check(wrapped->x < 0 && wrapped->y < 0);
  check(wrapped->width == 1536 && wrapped->height == 1536);
  check(-16 >= wrapped->x && 624 < wrapped->x + wrapped->width);
  check(0 >= wrapped->y && 360 < wrapped->y + wrapped->height);
  for (const int extent : {1409, 1500, 1532}) {
    const auto box = chooseSceneryWindow(3240, 3240, 3130, -17,
      extent, 700, 1536, true);
    check(box.has_value());
    check(box->x <= 3128 && box->x + box->width >= 3130 + extent + 2);
    check(box->y <= -19 && box->y + box->height >= 685);
  }
  check(!chooseSceneryWindow(3240, 3240, 0, 0, 1533, 100, 1536, true));
  check(!chooseSceneryWindow(3240, 3240, std::numeric_limits<int>::min(), 0,
    1, 1, 1536, true));
  check(!chooseSceneryWindow(3240, 3240, std::numeric_limits<int>::max(), 0,
    1, 1, 1536, true));
  std::mt19937 random(0x219AC);
  std::uniform_int_distribution<int> coordinate(-4000, 4000);
  std::uniform_int_distribution<int> extent(1, 1536);
  for (int index = 0; index < 100000; ++index) {
    const int x = coordinate(random), y = coordinate(random);
    const int width = extent(random), height = extent(random);
    const bool wrap = (index & 1) == 0;
    const auto box = chooseSceneryWindow(3240, 3240, x, y, width, height, 1536, wrap);
    if (!box) continue;
    check(sceneryWindowCovers(*box, x, y, width, height));
    if (!wrap) {
      check(box->x >= 0 && box->y >= 0);
      check(std::int64_t(box->x) + box->width <= 3240);
      check(std::int64_t(box->y) + box->height <= 3240);
    }
  }
}
