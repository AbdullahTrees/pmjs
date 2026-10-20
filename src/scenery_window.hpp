#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <optional>

namespace pmjs {
struct SceneryWindowRect { int x, y, width, height; };

struct SceneryWindowScroll {
  SceneryWindowRect overlap{};
  std::array<SceneryWindowRect, 4> uncovered{};
  int uncoveredCount = 0;
  std::uint64_t reusedPixels = 0;
};

inline std::optional<SceneryWindowScroll> sceneryScrollPlan(
    const SceneryWindowRect& previous, const SceneryWindowRect& next) {
  if (previous.width != next.width || previous.height != next.height ||
      next.width <= 0 || next.height <= 0) return std::nullopt;
  const auto left = std::max(std::int64_t(previous.x), std::int64_t(next.x));
  const auto top = std::max(std::int64_t(previous.y), std::int64_t(next.y));
  const auto right = std::min(std::int64_t(previous.x) + previous.width,
                              std::int64_t(next.x) + next.width);
  const auto bottom = std::min(std::int64_t(previous.y) + previous.height,
                               std::int64_t(next.y) + next.height);
  if (left >= right || top >= bottom) return std::nullopt;
  SceneryWindowScroll plan;
  plan.overlap = {static_cast<int>(left), static_cast<int>(top),
      static_cast<int>(right - left), static_cast<int>(bottom - top)};
  plan.reusedPixels = std::uint64_t(right - left) * std::uint64_t(bottom - top);
  const int x0 = static_cast<int>(left - next.x);
  const int x1 = static_cast<int>(right - next.x);
  const int y0 = static_cast<int>(top - next.y);
  const int y1 = static_cast<int>(bottom - next.y);
  const auto add = [&](int x, int y, int width, int height) {
    if (width > 0 && height > 0)
      plan.uncovered[plan.uncoveredCount++] = {x, y, width, height};
  };
  add(0, 0, next.width, y0);
  add(0, y1, next.width, next.height - y1);
  add(0, y0, x0, y1 - y0);
  add(x1, y0, next.width - x1, y1 - y0);
  return plan;
}

inline bool sceneryWindowCovers(const SceneryWindowRect& view,
    std::int64_t x, std::int64_t y, std::int64_t width, std::int64_t height) {
  if (width <= 0 || height <= 0 || view.width <= 0 || view.height <= 0)
    return false;
  return x >= view.x && y >= view.y &&
    x + width <= std::int64_t(view.x) + view.width &&
    y + height <= std::int64_t(view.y) + view.height;
}

// Keep a scenery window stable through ordinary camera movement; the 1536px
// window still has enough overlap for a 960x720 viewport plus its sampling halo.
constexpr int sceneryWindowOriginQuantum = 512;

inline std::optional<SceneryWindowRect> chooseSceneryWindow(int sourceWidth, int sourceHeight,
    int x, int y, int width, int height, int limit = 1536, bool wrap = false) {
  if (sourceWidth <= 0 || sourceHeight <= 0 || limit < 8 ||
      width <= 0 || height <= 0) return std::nullopt;
  const int viewWidth = std::min(sourceWidth, limit);
  const int viewHeight = std::min(sourceHeight, limit);
  if (width > viewWidth || height > viewHeight) return std::nullopt;
  constexpr int halo = 2;
  const auto select = [wrap, halo](int source, int roiStart, int roiWidth, int extent)
      -> std::optional<int> {
    constexpr int quantum = sceneryWindowOriginQuantum;
    std::int64_t low = 0;
    std::int64_t high = 0;
    if (wrap) {
      if (std::int64_t(roiWidth) + 2 * halo > extent) return std::nullopt;
      low = std::int64_t(roiStart) + roiWidth + halo - extent;
      high = std::int64_t(roiStart) - halo;
    } else {
      if (roiStart < 0 || roiStart >= source || roiWidth > source - roiStart)
        return std::nullopt;
      const int leftPad = std::min(halo, roiStart);
      const int rightPad = std::min(halo, source - (roiStart + roiWidth));
      low = std::max<std::int64_t>(0,
        std::int64_t(roiStart) + roiWidth + rightPad - extent);
      high = std::min<std::int64_t>(std::int64_t(source) - extent,
        std::int64_t(roiStart) - leftPad);
    }
    if (high < low) return std::nullopt;
    const std::int64_t centered = std::int64_t(roiStart) - (extent - roiWidth) / 2;
    const std::int64_t remainder = centered % quantum;
    const std::int64_t rounded =
      (centered / quantum - (remainder < 0 ? 1 : 0)) * quantum;
    std::int64_t lowUnits = low / quantum;
    if (low % quantum > 0) ++lowUnits;
    std::int64_t highUnits = high / quantum;
    if (high % quantum < 0) --highUnits;
    const std::int64_t alignedLow = lowUnits * quantum;
    const std::int64_t alignedHigh = highUnits * quantum;
    const std::int64_t origin = alignedLow <= alignedHigh
      ? std::clamp(rounded, alignedLow, alignedHigh)
      : std::clamp(rounded, low, high);
    const std::int64_t leftPad = wrap ? halo : std::min(halo, roiStart);
    const std::int64_t rightPad = wrap ? halo :
      std::min(halo, source - (roiStart + roiWidth));
    if (origin < std::numeric_limits<int>::min() ||
        origin > std::numeric_limits<int>::max() - extent ||
        origin > std::int64_t(roiStart) - leftPad ||
        origin + extent < std::int64_t(roiStart) + roiWidth + rightPad)
      return std::nullopt;
    return static_cast<int>(origin);
  };
  if (wrap) {
    const auto left = select(sourceWidth, x, width, viewWidth);
    const auto top = select(sourceHeight, y, height, viewHeight);
    if (!left || !top) return std::nullopt;
    const SceneryWindowRect result{*left, *top, viewWidth, viewHeight};
    return sceneryWindowCovers(result, x, y, width, height)
      ? std::optional<SceneryWindowRect>(result) : std::nullopt;
  }
  if (x < 0 || y < 0 || x >= sourceWidth || y >= sourceHeight ||
      width > sourceWidth - x || height > sourceHeight - y) return std::nullopt;
  const auto left = select(sourceWidth, x, width, viewWidth);
  const auto top = select(sourceHeight, y, height, viewHeight);
  if (!left || !top) return std::nullopt;
  const SceneryWindowRect result{*left, *top, viewWidth, viewHeight};
  return sceneryWindowCovers(result, x, y, width, height)
    ? std::optional<SceneryWindowRect>(result) : std::nullopt;
}
}
