#include "platform.hpp"
#include "resources.hpp"

#include <algorithm>
#include <array>
#include <cstdio>
#include <cstdlib>
#include <stdexcept>
#include <string>
#include <utility>
#include <unistd.h>

#include <GLES3/gl3.h>
#include <png.h>

int main() {
  pmjs::Platform platform(16, 16, "Image capability test");
  {
    const char* sparseEnvironment = std::getenv("PMJS_SPARSE_TILING");
    const std::optional<std::string> previousSparse = sparseEnvironment ?
        std::optional<std::string>(sparseEnvironment) : std::nullopt;
    constexpr int width = 193, height = 159;
    std::vector<std::uint8_t> rgba(width * height * 4);
    const std::array<std::array<int, 2>, 2> visible = {{{32, 64}, {width - 1, height - 1}}};
    for (const auto& point : visible) rgba[(point[1] * width + point[0]) * 4 + 3] = 39;
    setenv("PMJS_SPARSE_TILING", "0", 1);
    {
      pmjs::ImageStore disabled;
      const auto image = disabled.createRgba(width, height, rgba.data());
      if (!image || disabled.sparseRegions(image->handle) || disabled.cpuBytes())
        throw std::runtime_error("disabled sparse image analysis retained metadata");
    }
    setenv("PMJS_SPARSE_TILING", "1", 1);
    pmjs::ImageStore sparse;
    const auto image = sparse.createRgba(width, height, rgba.data());
    if (!image) throw std::runtime_error("sparse image allocation failed");
    const auto* regions = sparse.sparseRegions(image->handle);
    if (!regions || regions->empty() || regions->size() > 64)
      throw std::runtime_error("sparse image coverage was unavailable");
    std::vector<bool> covered(width * height);
    for (const auto& rect : *regions) {
      if (rect[0] < 0 || rect[1] < 0 || rect[2] <= 0 || rect[3] <= 0 ||
          rect[0] + rect[2] > width || rect[1] + rect[3] > height)
        throw std::runtime_error("sparse coverage escaped source dimensions");
      for (int y = rect[1]; y < rect[1] + rect[3]; ++y) {
        for (int x = rect[0]; x < rect[0] + rect[2]; ++x) {
          if (covered[y * width + x]) throw std::runtime_error("sparse image regions overlap");
          covered[y * width + x] = true;
        }
      }
    }
    for (const auto& point : visible) {
      for (int dy = -1; dy <= 1; ++dy) {
        for (int dx = -1; dx <= 1; ++dx) {
          const int x = (point[0] + dx + width) % width;
          const int y = (point[1] + dy + height) % height;
          if (!covered[y * width + x]) throw std::runtime_error("sparse periodic filtering halo was lost");
        }
      }
    }
    const auto metadataBytes = regions->capacity() * sizeof(std::array<int, 4>);
    if (sparse.cpuBytes() != metadataBytes || sparse.memoryEntries()[0].cpuBytes != metadataBytes)
      throw std::runtime_error("sparse image metadata was missing from resource accounting");
    for (int frame = 0; frame < 65; ++frame) sparse.update();
    if (!sparse.sparseRegions(image->handle) || sparse.cpuBytes() != metadataBytes)
      throw std::runtime_error("CPU pixel eviction discarded sparse image metadata");
    const auto revision = sparse.contentRevision(image->handle);
    const std::array<std::uint8_t, 4> replacement = {0, 0, 0, 255};
    if (!sparse.updateRgbaRegion(image->handle, 100, 100, 1, 1, replacement.data(), 1) ||
        sparse.sparseRegions(image->handle) || sparse.cpuBytes() ||
        sparse.contentRevision(image->handle) == revision)
      throw std::runtime_error("region mutation retained stale sparse image coverage");
    sparse.release(image->handle);
    if (sparse.sparseRegions(image->handle) || sparse.cpuBytes())
      throw std::runtime_error("released image retained sparse metadata");

    std::fill(rgba.begin(), rgba.end(), 255);
    const auto dense = sparse.createRgba(width, height, rgba.data());
    if (!dense || dense->handle == image->handle || sparse.sparseRegions(dense->handle))
      throw std::runtime_error("slot reuse or dense coverage admitted stale sparse regions");
    sparse.release(dense->handle);
    std::fill(rgba.begin(), rgba.end(), 0);
    for (std::size_t i = 0; i < rgba.size(); i += 4) rgba[i] = 255;
    const auto additive = sparse.createRgba(width, height, rgba.data(), true);
    const auto transparent = sparse.createRgba(width, height, rgba.data());
    if (!additive || sparse.sparseRegions(additive->handle) || !transparent ||
        !sparse.sparseRegions(transparent->handle) || !sparse.sparseRegions(transparent->handle)->empty())
      throw std::runtime_error("sparse coverage confused straight alpha and additive color");
    if (!sparse.updateRgba(transparent->handle, rgba.data()) || sparse.sparseRegions(transparent->handle))
      throw std::runtime_error("full mutation retained stale sparse image coverage");
    const auto target = sparse.createRenderTarget(width, height);
    const auto gpuOnly = sparse.createRgba(width, height, nullptr);
    if (!target || !gpuOnly || sparse.sparseRegions(target->handle) || sparse.sparseRegions(gpuOnly->handle))
      throw std::runtime_error("untracked GPU writes acquired sparse image coverage");

    std::vector<std::uint8_t> fragmented(1024 * 1024 * 4);
    for (int y = 16; y < 1024; y += 96)
      for (int x = 16; x < 1024; x += 96) fragmented[(y * 1024 + x) * 4 + 3] = 255;
    const auto complex = sparse.createRgba(1024, 1024, fragmented.data());
    if (!complex || sparse.sparseRegions(complex->handle))
      throw std::runtime_error("fragmented coverage exceeded its rectangle budget");
    if (previousSparse) setenv("PMJS_SPARSE_TILING", previousSparse->c_str(), 1);
    else unsetenv("PMJS_SPARSE_TILING");
  }
  {
    pmjs::ImageStore emptyImages;
    char emptyPath[] = "/tmp/pmjs-empty-image-XXXXXX";
    const int emptyDescriptor = mkstemp(emptyPath);
    if (emptyDescriptor < 0) throw std::runtime_error("temporary image allocation failed");
    close(emptyDescriptor);
    const std::array<std::uint8_t, 16> zeros{};
    png_image emptyPng{};
    emptyPng.version = PNG_IMAGE_VERSION;
    emptyPng.width = emptyPng.height = 2;
    emptyPng.format = PNG_FORMAT_RGBA;
    if (!png_image_write_to_file(&emptyPng, emptyPath, 0, zeros.data(), 0, nullptr)) {
      std::remove(emptyPath);
      throw std::runtime_error("temporary image encoding failed");
    }
    const auto empty = emptyImages.loadPng(emptyPath);
    std::remove(emptyPath);
    if (!empty || !empty->knownAllZero || !emptyImages.readPixels(empty->handle)) {
      throw std::runtime_error("empty image upload or lazy readback failed");
    }
    for (int frame = 0; frame < 65; ++frame) emptyImages.update();
    if (emptyImages.cpuBytes() != 0 || !emptyImages.lookup(empty->handle)->knownAllZero) {
      throw std::runtime_error("CPU eviction invalidated live texture content proof");
    }
    emptyImages.setWarmBudgetBytes(0);
    if (!emptyImages.beginUse(empty->handle) || !emptyImages.release(empty->handle)) {
      throw std::runtime_error("empty image ownership failed");
    }
    emptyImages.update();
    if (!emptyImages.lookup(empty->handle)) {
      throw std::runtime_error("empty image released while in flight");
    }
    emptyImages.endUse(empty->handle);
    emptyImages.update();
    if (emptyImages.lookup(empty->handle)) {
      throw std::runtime_error("unowned image escaped cache eviction");
    }
  }
  pmjs::ImageStore images;
  const auto sampled = images.createRgba(4, 4, nullptr);
  const auto target = images.createRenderTarget(4, 4);
  if (!sampled || !target) throw std::runtime_error("image allocation failed");
  if (images.isRenderTarget(sampled->handle)) {
    throw std::runtime_error("GPU-only sampled storage acquired render-target capability");
  }
  if (!images.isRenderTarget(target->handle)) {
    throw std::runtime_error("render target lost its mutation capability");
  }
  images.release(sampled->handle);
  images.release(target->handle);
  if (images.isRenderTarget(target->handle)) {
    throw std::runtime_error("released image retained render-target capability");
  }

  const std::array<std::uint8_t, 16> rgba = {
    255, 0, 0, 255, 0, 255, 0, 128,
    0, 0, 255, 64, 127, 63, 31, 0
  };
  char path[] = "/tmp/pmjs-image-readback-XXXXXX";
  const int descriptor = mkstemp(path);
  if (descriptor < 0) throw std::runtime_error("temporary image allocation failed");
  close(descriptor);
  png_image png{};
  png.version = PNG_IMAGE_VERSION;
  png.width = 2;
  png.height = 2;
  png.format = PNG_FORMAT_RGBA;
  if (!png_image_write_to_file(&png, path, 0, rgba.data(), 0, nullptr)) {
    std::remove(path);
    throw std::runtime_error("temporary image encoding failed");
  }
  const auto image = images.loadPng(path);
  std::remove(path);
  if (!image) throw std::runtime_error("temporary image loading failed");

  GLuint readFramebuffer = 0, drawFramebuffer = 0, packBuffer = 0;
  glGenFramebuffers(1, &readFramebuffer);
  glGenFramebuffers(1, &drawFramebuffer);
  glGenBuffers(1, &packBuffer);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, readFramebuffer);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, drawFramebuffer);
  glBindBuffer(GL_PIXEL_PACK_BUFFER, packBuffer);
  glPixelStorei(GL_PACK_ALIGNMENT, 8);
  glPixelStorei(GL_PACK_ROW_LENGTH, 7);
  glPixelStorei(GL_PACK_SKIP_PIXELS, 2);
  glPixelStorei(GL_PACK_SKIP_ROWS, 3);
  const auto pixels = images.readPixels(image->handle);
  if (!pixels || pixels->rgba != std::vector<std::uint8_t>(rgba.begin(), rgba.end())) {
    throw std::runtime_error("lazy image pixels changed row order or straight alpha");
  }
  const std::array<std::pair<GLenum, GLint>, 7> expected = {{
    {GL_READ_FRAMEBUFFER_BINDING, static_cast<GLint>(readFramebuffer)},
    {GL_DRAW_FRAMEBUFFER_BINDING, static_cast<GLint>(drawFramebuffer)},
    {GL_PIXEL_PACK_BUFFER_BINDING, static_cast<GLint>(packBuffer)},
    {GL_PACK_ALIGNMENT, 8}, {GL_PACK_ROW_LENGTH, 7},
    {GL_PACK_SKIP_PIXELS, 2}, {GL_PACK_SKIP_ROWS, 3}
  }};
  for (const auto& [parameter, value] : expected) {
    GLint actual = 0;
    glGetIntegerv(parameter, &actual);
    if (actual != value) throw std::runtime_error("lazy image readback changed GL state");
  }
  images.release(image->handle);
  glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
  glDeleteBuffers(1, &packBuffer);
  glDeleteFramebuffers(1, &readFramebuffer);
  glDeleteFramebuffers(1, &drawFramebuffer);

  const auto view = images.lookupPremultiplied(image->handle);
  if (!view || !view->premultiplied || view->texture == image->texture ||
      images.gpuBytes() != 32) {
    throw std::runtime_error("premultiplied rendering view allocation is incorrect");
  }
  const auto repeated = images.lookupPremultiplied(image->handle);
  if (!repeated || repeated->texture != view->texture || images.gpuBytes() != 32) {
    throw std::runtime_error("rendering view was not reused");
  }
  auto checkView = [&](const pmjs::ImageInfo& info,
                       const std::array<std::uint8_t, 16>& expectedPixels) {
    GLuint framebuffer = 0;
    glGenFramebuffers(1, &framebuffer);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, framebuffer);
    glFramebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
      GL_TEXTURE_2D, info.texture, 0);
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
    glPixelStorei(GL_PACK_ROW_LENGTH, 0);
    glPixelStorei(GL_PACK_SKIP_PIXELS, 0);
    glPixelStorei(GL_PACK_SKIP_ROWS, 0);
    std::array<std::uint8_t, 16> actual{};
    glReadPixels(0, 0, 2, 2, GL_RGBA, GL_UNSIGNED_BYTE, actual.data());
    glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
    glDeleteFramebuffers(1, &framebuffer);
    if (actual != expectedPixels) throw std::runtime_error("rendering view pixels are incorrect");
  };
  checkView(*view, {255, 0, 0, 255, 0, 128, 0, 128,
                   0, 0, 64, 64, 0, 0, 0, 0});
  for (int frame = 0; frame < 65; ++frame) images.update();
  const auto straight = images.readPixels(image->handle);
  if (!straight || straight->rgba != std::vector<std::uint8_t>(rgba.begin(), rgba.end())) {
    throw std::runtime_error("rendering view damaged the lazy straight image snapshot");
  }
  const std::array<std::uint8_t, 16> replacement = {
    200, 100, 50, 128, 200, 100, 50, 128,
    200, 100, 50, 128, 200, 100, 50, 128
  };
  if (!images.updateRgba(image->handle, replacement.data()) || images.gpuBytes() != 16) {
    throw std::runtime_error("image mutation did not discard its rendering view");
  }
  const auto changed = images.lookupPremultiplied(image->handle);
  if (!changed) throw std::runtime_error("mutated image view allocation failed");
  checkView(*changed, {100, 50, 25, 128, 100, 50, 25, 128,
                       100, 50, 25, 128, 100, 50, 25, 128});
  if (!images.updateRgbaRegion(image->handle, 0, 0, 2, 2, rgba.data(), 2) ||
      images.gpuBytes() != 16) {
    throw std::runtime_error("region mutation did not discard its rendering view");
  }
  const auto regionChanged = images.lookupPremultiplied(image->handle);
  if (!regionChanged) throw std::runtime_error("region image view allocation failed");
  checkView(*regionChanged, {255, 0, 0, 255, 0, 128, 0, 128,
                            0, 0, 64, 64, 0, 0, 0, 0});
  images.setWarmBudgetBytes(0);
  // The earlier release leaves the file image in the warm cache.
  images.update();
  if (images.gpuBytes() != 0 || images.lookupPremultiplied(image->handle)) {
    throw std::runtime_error("image eviction retained its rendering view");
  }
  GLuint ownedTexture = 0, ownedView = 0;
  {
    pmjs::ImageStore owner;
    const auto owned = owner.createRgba(2, 2, rgba.data());
    if (!owned) throw std::runtime_error("owned image allocation failed");
    const auto ownedPremultiplied = owner.lookupPremultiplied(owned->handle);
    if (!ownedPremultiplied) throw std::runtime_error("owned view allocation failed");
    ownedTexture = owned->texture;
    ownedView = ownedPremultiplied->texture;
    const std::array<std::uint8_t, 4> opaque = {12, 34, 56, 255};
    const auto opaqueImage = owner.createRgba(1, 1, opaque.data());
    if (!opaqueImage) throw std::runtime_error("opaque image allocation failed");
    if (owner.isOpaque(opaqueImage->handle) != true || owner.isOpaque(owned->handle) != false)
      throw std::runtime_error("image opacity inspection lost source alpha");
    const auto opaqueView = owner.lookupPremultiplied(opaqueImage->handle);
    if (!opaqueView || opaqueView->texture != opaqueImage->texture || owner.gpuBytes() != 36) {
      throw std::runtime_error("opaque image unnecessarily duplicated texture storage");
    }
    const std::array<std::uint8_t, 4> transparent = {12, 34, 56, 0};
    if (!owner.updateRgba(opaqueImage->handle, transparent.data()) || owner.isOpaque(opaqueImage->handle) != false ||
        !owner.updateRgbaRegion(opaqueImage->handle, 0, 0, 1, 1, opaque.data(), 1) || owner.isOpaque(opaqueImage->handle) != true)
      throw std::runtime_error("image opacity cache survived a source mutation");
  }
  if (glIsTexture(ownedTexture) || glIsTexture(ownedView)) {
    throw std::runtime_error("image store teardown leaked rendering textures");
  }
}
