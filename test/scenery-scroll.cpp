#include "../src/scenery_window.hpp"
#include <array>
#include <cassert>
#include <cstdint>
#include <random>
#include <vector>

using pmjs::SceneryWindowRect;
using pmjs::sceneryScrollPlan;

int main() {
  std::mt19937 random(379151);
  std::uint64_t cases = 0;
  for (const bool wrap : {false, true}) {
    for (int iteration = 0; iteration < 30000; ++iteration) {
      const int width = 4 + static_cast<int>(random() % 49);
      const int height = 4 + static_cast<int>(random() % 43);
      const int x = wrap ? static_cast<int>(random() % 100) - 50 :
        static_cast<int>(random() % 100);
      const int y = wrap ? static_cast<int>(random() % 100) - 50 :
        static_cast<int>(random() % 100);
      const SceneryWindowRect previous{x, y, width, height};
      const SceneryWindowRect next{
        x + static_cast<int>(random() % (width * 2)) - width,
        y + static_cast<int>(random() % (height * 2)) - height,
        width, height};
      const auto plan = sceneryScrollPlan(previous, next);
      constexpr int sourceWidth = 103, sourceHeight = 107;
      const auto pixel = [=](int px, int py) {
        if (wrap) {
          px = (px % sourceWidth + sourceWidth) % sourceWidth;
          py = (py % sourceHeight + sourceHeight) % sourceHeight;
        }
        const std::uint32_t mixed = static_cast<std::uint32_t>(
          px * 0x9e37U + py * 0x1f7bU);
        return std::array<std::uint8_t, 4>{std::uint8_t(mixed),
          std::uint8_t(mixed >> 8), std::uint8_t(mixed >> 16),
          std::uint8_t(mixed >> 24)};
      };
      std::vector<std::array<std::uint8_t, 4>> source(
        static_cast<std::size_t>(width) * height);
      std::vector<std::array<std::uint8_t, 4>> stitched(source.size());
      for (int row = 0; row < height; ++row)
        for (int column = 0; column < width; ++column)
          source[static_cast<std::size_t>(row) * width + column] =
            pixel(previous.x + column, previous.y + row);
      if (!plan) continue;
      const auto& overlap = plan->overlap;
      for (int row = overlap.y; row < overlap.y + overlap.height; ++row)
        for (int column = overlap.x; column < overlap.x + overlap.width; ++column)
          stitched[static_cast<std::size_t>(row - next.y) * width + column - next.x] =
            source[static_cast<std::size_t>(row - previous.y) * width + column - previous.x];
      std::uint64_t uploadedPixels = 0;
      for (int i = 0; i < plan->uncoveredCount; ++i) {
        const auto& band = plan->uncovered[i];
        for (int row = band.y; row < band.y + band.height; ++row)
          for (int column = band.x; column < band.x + band.width; ++column) {
            stitched[static_cast<std::size_t>(row) * width + column] =
              pixel(next.x + column, next.y + row);
            ++uploadedPixels;
          }
      }
      assert(uploadedPixels + plan->reusedPixels ==
        static_cast<std::uint64_t>(width) * height);
      for (int row = 0; row < height; ++row)
        for (int column = 0; column < width; ++column)
          assert(stitched[static_cast<std::size_t>(row) * width + column] ==
            pixel(next.x + column, next.y + row));
      ++cases;
    }
  }
  const auto horizontal = sceneryScrollPlan({0, 0, 1536, 1536},
    {128, 0, 1536, 1536});
  assert(horizontal && horizontal->reusedPixels ==
    static_cast<std::uint64_t>(1408) * 1536);
  assert(horizontal->uncoveredCount == 1 &&
    horizontal->uncovered[0].width == 128 &&
    horizontal->uncovered[0].height == 1536);
  const auto diagonal = sceneryScrollPlan({0, 0, 1536, 1536},
    {128, 128, 1536, 1536});
  assert(diagonal && diagonal->uncoveredCount == 2);
  assert(!sceneryScrollPlan({0, 0, 1536, 1536}, {5000, 0, 1536, 1536}));
  assert(cases > 0);
}
