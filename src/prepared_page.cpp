#include "prepared_page.hpp"

#include <array>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <lz4.h>
#include <zlib.h>

namespace pmjs {
namespace {
constexpr std::size_t headerBytes = 32;
constexpr std::uint32_t maximumExtent = 2048;
std::uint32_t checksum(std::span<const std::uint8_t> bytes) {
  return static_cast<std::uint32_t>(crc32(0, bytes.data(), static_cast<uInt>(bytes.size())));
}
void put(std::span<std::uint8_t> bytes, std::size_t offset, std::uint32_t value) {
  for (int i = 0; i < 4; ++i) bytes[offset + i] = static_cast<std::uint8_t>(value >> (8 * i));
}
std::uint32_t get(std::span<const std::uint8_t> bytes, std::size_t offset) {
  std::uint32_t value = 0;
  for (int i = 0; i < 4; ++i) value |= static_cast<std::uint32_t>(bytes[offset + i]) << (8 * i);
  return value;
}
}
void writeLz4Page(const std::filesystem::path& path, int width, int height,
                  std::span<const std::uint8_t> rgba) {
  if (width <= 0 || height <= 0 || width > static_cast<int>(maximumExtent) ||
      height > static_cast<int>(maximumExtent) || rgba.size() != static_cast<std::size_t>(width) * height * 4)
    throw std::runtime_error("invalid LZ4 page extent");
  std::vector<char> compressed(static_cast<std::size_t>(LZ4_compressBound(static_cast<int>(rgba.size()))));
  const int length = LZ4_compress_default(reinterpret_cast<const char*>(rgba.data()), compressed.data(),
    static_cast<int>(rgba.size()), static_cast<int>(compressed.size()));
  if (length <= 0) throw std::runtime_error("cannot compress LZ4 page");
  std::array<std::uint8_t, headerBytes> header{};
  std::memcpy(header.data(), "PML4", 4);
  put(header, 4, 1); put(header, 8, width); put(header, 12, height);
  put(header, 16, rgba.size()); put(header, 20, length);
  put(header, 24, checksum(rgba)); put(header, 28, checksum(std::span(header).first(28)));
  std::ofstream file(path, std::ios::binary | std::ios::trunc);
  file.write(reinterpret_cast<const char*>(header.data()), header.size());
  file.write(compressed.data(), length);
  file.close();
  if (!file) throw std::runtime_error("cannot write LZ4 page");
}
std::optional<PreparedPagePixels> readLz4Page(std::span<const std::uint8_t> encoded,
                                           std::size_t maxDecodedBytes) {
  if (encoded.size() < headerBytes || std::memcmp(encoded.data(), "PML4", 4) || get(encoded, 4) != 1 ||
      get(encoded, 28) != checksum(encoded.first(28))) return std::nullopt;
  const auto width = get(encoded, 8), height = get(encoded, 12);
  const auto decoded = get(encoded, 16), length = get(encoded, 20);
  if (!width || !height || width > maximumExtent || height > maximumExtent ||
      decoded != width * height * 4 || decoded > maxDecodedBytes || !length ||
      length > static_cast<unsigned>(LZ4_compressBound(static_cast<int>(decoded))) ||
      encoded.size() != headerBytes + static_cast<std::size_t>(length)) return std::nullopt;
  PreparedPagePixels pixels{static_cast<int>(width), static_cast<int>(height), std::vector<std::uint8_t>(decoded)};
  if (LZ4_decompress_safe(reinterpret_cast<const char*>(encoded.data() + headerBytes),
        reinterpret_cast<char*>(pixels.rgba.data()), static_cast<int>(length), static_cast<int>(decoded)) !=
        static_cast<int>(decoded) || checksum(pixels.rgba) != get(encoded, 24)) return std::nullopt;
  return pixels;
}
}
