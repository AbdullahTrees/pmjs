#include "prepared_page.hpp"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <source_location>
#include <stdexcept>
#include <unistd.h>
#include <zlib.h>
#include <lz4.h>

namespace {
void require(bool value, const std::source_location& location = std::source_location::current()) {
  if (!value) throw std::runtime_error("LZ4 page fixture failed at " + std::to_string(location.line()));
}
void put(std::vector<std::uint8_t>& bytes, std::size_t offset, std::uint32_t value) {
  for (int i = 0; i < 4; ++i) bytes[offset + i] = static_cast<std::uint8_t>(value >> (8 * i));
}
void headerChecksum(std::vector<std::uint8_t>& bytes) { put(bytes, 28, crc32(0, bytes.data(), 28)); }
}
int main() {
  const auto root = std::filesystem::temp_directory_path() / ("pmjs-lz4-test-" + std::to_string(getpid()));
  std::filesystem::create_directories(root);
  try {
    const std::vector<std::uint8_t> artifact{'P','M','C','O','L','1',0,0,1,2,3,4,5,6,7,8};
    auto packedArtifact = pmjs::compressLz4Artifact(artifact);
    require(pmjs::decompressLz4Artifact(packedArtifact, artifact.size()) == artifact);
    require(!pmjs::decompressLz4Artifact(packedArtifact, artifact.size() - 1));
    auto brokenArtifact = packedArtifact; brokenArtifact.back() ^= 0x80;
    require(!pmjs::decompressLz4Artifact(brokenArtifact, artifact.size()));
    brokenArtifact = packedArtifact; brokenArtifact.push_back(0);
    require(!pmjs::decompressLz4Artifact(brokenArtifact, artifact.size()));
    bool refusedArtifact = false;
    try { pmjs::compressLz4Artifact({}); }
    catch (const std::runtime_error&) { refusedArtifact = true; }
    require(refusedArtifact);
    for (const auto [width, height] : {std::pair{1,1}, {37,19}, {2048,3}, {2048,2048}}) {
      std::vector<std::uint8_t> rgba(static_cast<std::size_t>(width) * height * 4);
      std::uint32_t state = 0x12345678;
      for (auto& byte : rgba) { state = state * 1664525U + 1013904223U; byte = state >> 24; }
      // Keep colored transparent pixels in the lossless contract.
      for (std::size_t i = 3; i < rgba.size(); i += 28) rgba[i] = 0;
      const auto file = root / "page.pml4";
      pmjs::writeLz4Page(file, width, height, rgba);
      std::ifstream input(file, std::ios::binary);
      const std::vector<std::uint8_t> encoded(std::istreambuf_iterator<char>(input), {});
      const auto decoded = pmjs::readLz4Page(encoded, rgba.size());
      require(decoded && decoded->width == width && decoded->height == height && decoded->rgba == rgba);
      require(!pmjs::readLz4Page(encoded, rgba.size() - 1));
      for (const auto offset : {0U,4U,8U,12U,16U,20U,24U,28U}) {
        auto damaged = encoded; damaged[offset] ^= 1;
        require(!pmjs::readLz4Page(damaged, rgba.size()));
      }
      for (const auto [offset, value] : {std::pair{4U,2U}, {8U,0U}, {8U,2049U}, {12U,0xffffffffU},
             {16U,0xffffffffU}, {20U,0U}, {20U,0xffffffffU}, {24U,0U}}) {
        auto damaged = encoded; put(damaged, offset, value); headerChecksum(damaged);
        require(!pmjs::readLz4Page(damaged, rgba.size()));
      }
      auto extra = encoded; extra.push_back(0); require(!pmjs::readLz4Page(extra, rgba.size()));
      if (width == 37) {
        for (std::size_t length = 0; length < encoded.size(); ++length)
          require(!pmjs::readLz4Page(std::span(encoded).first(length), rgba.size()));
        for (std::size_t i = 32; i < encoded.size(); i += 11) {
          auto damaged = encoded; damaged[i] ^= 0x80;
          const auto checked = pmjs::readLz4Page(damaged, rgba.size());
          require(!checked || checked->rgba == rgba);
        }
      }
    }
    for (const auto [width, height] : {std::pair{257,259}, {512,512}}) {
      std::vector<std::uint8_t> rgba(std::size_t(width) * height * 4);
      std::size_t rarePixels = 0;
      for (std::size_t i = 0; i < rgba.size() / 4; ++i) {
        const bool rare = i % 31 == 0;
        rgba[i * 4] = i & 255; rgba[i * 4 + 1] = rare ? (i >> 8) & 255 : 97;
        rgba[i * 4 + 2] = rare ? 137 : 51; rgba[i * 4 + 3] = rare ? i % 255 : 255;
        rarePixels += rare;
      }
      const auto sparse = pmjs::makeSparsePalettePage(width, height, rgba);
      require(sparse && sparse->pixels().rgba == rgba && sparse->residual.size() / 2 > rarePixels);
      const auto denseBytes = rgba.size() / 2 + ((sparse->colors.size() + 1023) / 1024) * 1024;
      require(sparse->gpuBytes() * 100 <= denseBytes * 85);
      const auto file = root / "sparse.pml4";
      pmjs::writeLz4Page(file, width, height, rgba, true);
      std::ifstream input(file, std::ios::binary);
      const std::vector<std::uint8_t> encoded(std::istreambuf_iterator<char>(input), {});
      require(encoded[4] == 2);
      const auto parsed = pmjs::readSparsePalettePage(encoded, rgba.size());
      require(parsed && parsed->pixels().rgba == rgba && parsed->gpuBytes() == sparse->gpuBytes());
      const auto ordinary = pmjs::readLz4Page(encoded, rgba.size());
      require(ordinary && ordinary->rgba == rgba);
      require(!pmjs::readSparsePalettePage(encoded, rgba.size() - 1));
      for (const auto at : {0U, 4U, 16U, 24U, 28U, unsigned(encoded.size() - 1)}) {
        auto broken = encoded; broken[at] ^= 128;
        require(!pmjs::readSparsePalettePage(broken, rgba.size()));
      }
      std::vector<std::uint8_t> packed(encoded[16] | (unsigned(encoded[17]) << 8) | (unsigned(encoded[18]) << 16));
      require(LZ4_decompress_safe(reinterpret_cast<const char*>(encoded.data() + 32),
        reinterpret_cast<char*>(packed.data()), encoded.size() - 32, packed.size()) == int(packed.size()));
      const auto badPacked = [&](std::size_t at, std::uint32_t value) {
        auto bytes = packed; put(bytes, at, value);
        std::vector<std::uint8_t> broken(32 + LZ4_compressBound(bytes.size()));
        std::copy_n(encoded.begin(), 32, broken.begin());
        const auto length = LZ4_compress_default(reinterpret_cast<const char*>(bytes.data()),
          reinterpret_cast<char*>(broken.data() + 32), bytes.size(), broken.size() - 32);
        require(length > 0); broken.resize(32 + length);
        put(broken, 20, length); put(broken, 24, crc32(0, bytes.data(), bytes.size())); headerChecksum(broken);
        require(!pmjs::readSparsePalettePage(broken, rgba.size()));
      };
      const auto base = 8 + sparse->colors.size(), blocks = base + sparse->base.size();
      badPacked(0, 65537); badPacked(4, rgba.size());
      badPacked(base, 0); // The first source pixel is exceptional.
      badPacked(blocks + 8, 1); // The first block must start at residual zero.
      badPacked(blocks + sparse->blocks.size() * 12, 0xffffffffU);
      std::cout << "sparse palette " << width << 'x' << height << ": dense=" << denseBytes
        << " sparse=" << sparse->gpuBytes() << " exceptions=" << sparse->residual.size() / 2 << '\n';
    }
    for (const unsigned count : {256U, 512U, 65537U}) {
      std::vector<std::uint8_t> rgba(512 * 512 * 4);
      for (std::size_t i = 0; i < rgba.size() / 4; ++i) {
        const auto color = i % count;
        rgba[i * 4] = color & 255; rgba[i * 4 + 1] = (color >> 8) & 255;
        rgba[i * 4 + 2] = color >> 16; rgba[i * 4 + 3] = 255;
      }
      require(!pmjs::makeSparsePalettePage(512, 512, rgba));
    }
    bool refused = false;
    try { pmjs::writeLz4Page(root / "invalid", 2049, 1, {}); }
    catch (const std::runtime_error&) { refused = true; }
    require(refused);
    refused = false;
    try { pmjs::writeLz4Page(root / "missing" / "page", 1, 1, std::vector<std::uint8_t>(4)); }
    catch (const std::runtime_error&) { refused = true; }
    require(refused);
    std::filesystem::remove_all(root);
  } catch (const std::exception& error) {
    std::filesystem::remove_all(root); std::cerr << error.what() << '\n'; return 1;
  }
}
