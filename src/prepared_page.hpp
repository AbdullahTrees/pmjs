#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <span>
#include <vector>

namespace pmjs {
struct PreparedPagePixels {
  int width = 0, height = 0;
  std::vector<std::uint8_t> rgba;
};
void writeLz4Page(const std::filesystem::path& path, int width, int height,
                  std::span<const std::uint8_t> rgba);
std::optional<PreparedPagePixels> readLz4Page(std::span<const std::uint8_t> encoded,
                                           std::size_t maxDecodedBytes);
}
