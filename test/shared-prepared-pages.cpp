#include "platform.hpp"
#include "resources.hpp"

#include <algorithm>
#include <array>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <thread>
#include <vector>
#include <unistd.h>
#include <png.h>
#include <GLES3/gl3.h>

namespace {
void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}
void write(const std::filesystem::path& path, int width, int height,
           const std::vector<std::uint8_t>& pixels) {
  png_image image{}; image.version = PNG_IMAGE_VERSION;
  image.width = width; image.height = height; image.format = PNG_FORMAT_RGBA;
  require(png_image_write_to_file(&image, path.c_str(), 0, pixels.data(), 0, nullptr), "fixture PNG write failed");
}
struct Fixture {
  std::filesystem::path source, directory;
  pmjs::PreparedImageDescriptor descriptor;
  std::vector<std::uint8_t> pixels;
};
Fixture fixture(const std::filesystem::path& root, const char* name, int cropX = 9, int fill = 241,
                int width = 49, int height = 37, int pageFill = 241) {
  Fixture result;
  result.source = root / (std::string(name) + ".png");
  result.directory = root / name;
  std::filesystem::create_directory(result.directory);
  auto& d = result.descriptor;
  d.width = width; d.height = height; d.halo = 3;
  d.pages = {{"page-0.png",29,27}};
  d.cells = {{{0,0,width,height},{cropX,7,23,21},{3,3,23,21},
    {static_cast<std::uint8_t>(fill),static_cast<std::uint8_t>(fill),static_cast<std::uint8_t>(fill),0},0}};
  result.pixels.resize(width * height * 4);
  std::vector<std::uint8_t> page(29 * 27 * 4);
  for (std::size_t i = 0; i < result.pixels.size(); i += 4) {
    result.pixels[i] = result.pixels[i+1] = result.pixels[i+2] = static_cast<std::uint8_t>(fill);
  }
  // Page payloads remain identical even when logical placement or fill differs.
  for (std::size_t i = 0; i < page.size(); i += 4)
    page[i] = page[i+1] = page[i+2] = static_cast<std::uint8_t>(pageFill);
  for (int y = 0; y < 21; ++y) for (int x = 0; x < 23; ++x) {
    const auto gray = static_cast<std::uint8_t>((x * 13 + y * 17) % 256);
    const auto alpha = static_cast<std::uint8_t>((x * 19 + y * 7) % 256);
    const std::array<std::uint8_t,4> color{gray,gray,gray,alpha};
    std::copy(color.begin(),color.end(),page.begin() + ((y+3)*29+x+3)*4);
    std::copy(color.begin(),color.end(),result.pixels.begin() + ((y+7)*width+x+cropX)*4);
  }
  write(result.source,width,height,result.pixels);
  write(result.directory / "page-0.png",29,27,page);
  return result;
}
void install(pmjs::ImageStore& images, const Fixture& value) {
  require(images.installPrepared(value.source,value.directory,value.descriptor), "prepared fixture installation failed");
}
void pixels(pmjs::ImageStore& images, pmjs::ImageHandle image, const std::vector<std::uint8_t>& expected) {
  const auto info = images.inspect(image);
  require(info.has_value(),"logical image unavailable");
  const auto actual = images.readPixelsRegion(image,0,0,info->width,info->height);
  require(actual && actual->rgba == expected, "logical RGBA changed, including hidden RGB");
}
}

int main() {
  pmjs::Platform platform(16,16,"Shared prepared resources");
  const auto temporaryRoot = std::filesystem::current_path() / ".cache/tests";
  std::filesystem::create_directories(temporaryRoot);
  const auto pattern = (temporaryRoot / "shared-prepared-XXXXXX").string();
  std::vector<char> temporary(pattern.begin(),pattern.end()); temporary.push_back('\0');
  const auto* directory = mkdtemp(temporary.data()); require(directory,"temporary fixture failed");
  const std::filesystem::path root(directory);
  try {
    const auto a = fixture(root,"first"), b = fixture(root,"second");
    const auto shifted = fixture(root,"shifted",10), hidden = fixture(root,"hidden",9,242);
    const auto potA = fixture(root,"pot-first",9,241,64,64), potB = fixture(root,"pot-second",9,241,64,64);
    const auto spriteA = fixture(root,"sprite-first",9,0,64,64,0), spriteB = fixture(root,"sprite-second",9,0,64,64,0);
    {
      pmjs::ImageStore images;
      images.setWarmBudgetBytes(0);
      images.setPreparedFrameCacheBudget(0);
      install(images,a); install(images,b);
      auto sourceA = pmjs::ImageStore::openFile(a.source), sourceB = pmjs::ImageStore::openFile(b.source);
      require(sourceA && sourceB && sourceA->key() != sourceB->key(),"distinct sources must retain independent identities");
      auto pendingA = images.capturePrepared(*sourceA), pendingB = images.capturePrepared(*sourceB);
      require(pendingA && pendingB,"worker snapshots unavailable");
      bool validA = false, validB = false;
      std::thread left([&] { validA = pmjs::ImageStore::validatePrepared(*pendingA); });
      std::thread right([&] { validB = pmjs::ImageStore::validatePrepared(*pendingB); });
      left.join(); right.join();
      require(validA && validB,"concurrent page validation failed");
      auto first = images.installPreparedLoad(*sourceA,std::move(pendingA),false);
      auto second = images.installPreparedLoad(*sourceB,std::move(pendingB),false);
      require(first && second && first->handle != second->handle,"sharing must preserve independent logical handles");
      constexpr std::size_t pageBytes = 29 * 27 * 4;
      require(images.preparedPageDecodes() == 1,"concurrent identical pages decoded more than once");
      require(images.cpuBytes() == pageBytes,"shared CPU page counted or stored twice");
      for (int tick = 0; tick < 40; ++tick) images.update();
      require(images.cpuBytes() == pageBytes,"multiple owners aged the shared page more than once per update");
      for (int tick = 40; tick < 61; ++tick) images.update();
      require(images.cpuBytes() == 0,"idle shared page did not expire");
      const auto decodes = images.preparedPageDecodes();
      pixels(images,first->handle,a.pixels); pixels(images,second->handle,b.pixels);
      require(images.preparedPageDecodes() == decodes+1,"expired shared page was decoded separately for each owner");
      const auto firstStraight = images.lookup(first->handle);
      const auto creates = images.textureCreates(), uploads = images.textureUploadBytes();
      const auto secondStraight = images.lookup(second->handle);
      require(firstStraight && secondStraight && firstStraight->texture == secondStraight->texture,
        "identical NPOT full materializations did not share a texture");
      require(images.textureCreates() == creates && images.textureUploadBytes() == uploads,
        "second full materialization uploaded identical pixels again");
      const auto firstPremultiplied = images.lookupPremultiplied(first->handle);
      const auto premultipliedUploads = images.textureUploadBytes();
      const auto secondPremultiplied = images.lookupPremultiplied(second->handle);
      require(firstPremultiplied && secondPremultiplied && firstPremultiplied->texture == secondPremultiplied->texture &&
        images.textureUploadBytes() == premultipliedUploads,"premultiplied materializations did not share");
      const auto deferred = images.deferPixelRead(first->handle,0,0,49,37);
      auto changed = a.pixels;
      const std::array<std::uint8_t,4> patch{31,67,149,255};
      std::copy(patch.begin(),patch.end(),changed.begin()+(8*49+10)*4);
      require(images.updateRgbaRegion(first->handle,10,8,1,1,patch.data(),1),"shared region mutation failed");
      require(deferred && deferred->pixels && deferred->pixels->rgba == a.pixels,"mutation lost the deferred original snapshot");
      pixels(images,first->handle,changed); pixels(images,second->handle,b.pixels);
      require(images.lookup(second->handle)->texture == secondStraight->texture &&
        images.lookup(first->handle)->texture != secondStraight->texture,"region mutation did not detach its texture");
      require(images.lookupPremultiplied(second->handle)->texture == secondPremultiplied->texture,
        "mutation invalidated another owner's premultiplied texture");
      require(images.release(first->handle),"first owner release failed"); images.update();
      require(glIsTexture(secondStraight->texture) && glIsTexture(secondPremultiplied->texture),
        "releasing one owner deleted another owner's textures");
      pixels(images,second->handle,b.pixels);
      require(images.release(second->handle),"last owner release failed"); images.update();
      require(images.gpuBytes() == 0 && images.cpuBytes() == 0,"shared pools retained resources after the last owner left");
    }
    {
      pmjs::ImageStore images; images.setWarmBudgetBytes(1024*1024);
      install(images,a); install(images,b);
      const auto first = images.loadPng(a.source), second = images.loadPng(b.source);
      require(first && second,"warm alias fixtures failed to load");
      require(images.lookup(first->handle) && images.lookup(second->handle) &&
        images.lookupPremultiplied(first->handle) && images.lookupPremultiplied(second->handle),
        "warm alias textures unavailable");
      const auto physicalBytes = images.cpuBytes()+images.gpuBytes();
      require(images.release(first->handle) && images.release(second->handle),"warm alias release failed");
      images.update();
      require(images.warmCount() == 2 && images.warmBytes() == physicalBytes,
        "two warm aliases counted shared physical CPU or GPU storage twice");
      images.setWarmBudgetBytes(0); images.update();
      require(images.warmBytes() == 0 && images.warmCount() == 0 &&
        images.cpuBytes() == 0 && images.gpuBytes() == 0,"zero budget failed to reclaim both warm aliases");
    }
    {
      pmjs::ImageStore images;
      images.setWarmBudgetBytes(0); images.setPreparedFrameCacheBudget(0);
      install(images,a); install(images,b); install(images,shifted); install(images,hidden);
      install(images,potA); install(images,potB);
      const auto first = images.loadPng(a.source), second = images.loadPng(b.source);
      const auto placement = images.loadPng(shifted.source), invisible = images.loadPng(hidden.source);
      const auto mipmapFirst = images.loadPng(potA.source), mipmapSecond = images.loadPng(potB.source);
      require(first && second && placement && invisible && mipmapFirst && mipmapSecond,"negative-control loads failed");
      require(images.preparedPageDecodes() == 1 && images.cpuBytes() == 29*27*4,
        "identical encoded pages failed to share across different logical descriptors");
      pixels(images,placement->handle,shifted.pixels); pixels(images,invisible->handle,hidden.pixels);
      const auto firstTexture = images.lookup(first->handle)->texture;
      require(images.lookup(placement->handle)->texture != firstTexture,"different logical placement reused the wrong full texture");
      require(images.lookup(invisible->handle)->texture != firstTexture,"different hidden fill RGB reused the wrong full texture");
      require(images.lookup(second->handle)->texture == firstTexture,"exact source copy failed to share in negative-control batch");
      const auto potTexture = images.lookup(mipmapFirst->handle)->texture;
      require(potTexture != firstTexture,"different logical dimensions reused the wrong full texture");
      require(images.lookup(mipmapSecond->handle)->texture == potTexture,"identical POT full textures failed to share");
      require(images.ensureMipmaps(mipmapFirst->handle,false),"shared POT mipmaps unavailable");
      const auto mipmapBytes = images.gpuBytes();
      require(images.ensureMipmaps(mipmapSecond->handle,false) && images.gpuBytes() == mipmapBytes,
        "second owner duplicated shared mipmap accounting");
      auto changed = a.pixels; changed[0] = 17; changed[1] = 29; changed[2] = 41; changed[3] = 255;
      require(images.updateRgba(first->handle,changed.data()),"full shared-image mutation failed");
      pixels(images,first->handle,changed); pixels(images,second->handle,b.pixels);
      for (const auto image : {*first,*second,*placement,*invisible,*mipmapFirst,*mipmapSecond})
        require(images.release(image.handle),"fixture release failed");
      images.update();
      require(images.gpuBytes() == 0 && images.cpuBytes() == 0,"negative-control resources survived last release");
    }
    {
      pmjs::ImageStore images; images.setWarmBudgetBytes(0);
      install(images,spriteA); install(images,spriteB);
      const auto first = images.loadPng(spriteA.source), second = images.loadPng(spriteB.source);
      require(first && second,"prepared-page sharing fixtures failed to load");
      for (const bool premultiplied : {false,true}) {
        const auto region = images.resolveSpriteRegion(first->handle,0,0,64,64,premultiplied);
        const auto uploads = images.textureUploadBytes();
        const auto alias = images.resolveSpriteRegion(second->handle,0,0,64,64,premultiplied);
        require(region && alias && region->image.texture == alias->image.texture &&
          images.textureUploadBytes() == uploads,"identical sprite pages did not share physical storage");
      }
      require(images.gpuBytes() == 2U*29*27*2,"sprite-page GPU accounting duplicated shared alpha representations");
      pixels(images,first->handle,spriteA.pixels); pixels(images,second->handle,spriteB.pixels);
      const auto surviving = images.resolveSpriteRegion(second->handle,0,0,64,64,false)->image.texture;
      require(images.release(first->handle),"sprite-page owner release failed"); images.update();
      require(glIsTexture(surviving),"one owner release deleted the shared sprite page");
      require(images.release(second->handle),"last sprite-page owner release failed"); images.update();
      require(images.gpuBytes() == 0 && images.cpuBytes() == 0,"sprite-page resources survived their last owner");
    }
    {
      const auto blockFixture = [&](const char* name) {
        Fixture value; value.source = root/(std::string(name)+".png"); value.directory = root/name;
        std::filesystem::create_directory(value.directory);
        auto& d = value.descriptor; d.width = 128; d.height = 64; d.halo = 3;
        d.blockGrid = std::array<int,3>{64,64,64}; d.pages = {{"page-0.png",70,70}};
        d.cells = {{{0,0,64,64},{0,0,64,64},{3,3,64,64},{0,0,0,0},0},
          {{64,0,64,64},{0,0,64,64},{3,3,64,64},{0,0,0,0},0}};
        value.pixels.resize(128*64*4); std::vector<std::uint8_t> page(70*70*4);
        for (int y = 4; y < 60; ++y) for (int x = 4; x < 60; ++x) {
          const auto gray = static_cast<std::uint8_t>((x*13+y*17)%256);
          const std::array<std::uint8_t,4> color{gray,gray,gray,static_cast<std::uint8_t>((x*19+y*7)%256)};
          std::copy(color.begin(),color.end(),page.begin()+((y+3)*70+x+3)*4);
          for (const int frame : {0,1}) std::copy(color.begin(),color.end(),value.pixels.begin()+(y*128+x+frame*64)*4);
        }
        write(value.source,128,64,value.pixels); write(value.directory/"page-0.png",70,70,page);
        return value;
      };
      const auto blockA = blockFixture("block-first"), blockB = blockFixture("block-second");
      pmjs::ImageStore images; images.setWarmBudgetBytes(0);
      install(images,blockA); install(images,blockB);
      const auto first = images.loadPng(blockA.source), second = images.loadPng(blockB.source);
      require(first && second,"block sharing fixtures failed to load");
      const auto region = images.resolveBlockRegion(first->handle,false);
      const auto creates = images.textureCreates(), uploads = images.textureUploadBytes();
      const auto alias = images.resolveBlockRegion(second->handle,false);
      require(region && alias && region->image.texture == alias->image.texture && region->table != alias->table,
        "block owners must share the atlas and retain separate lookup tables");
      require(images.textureCreates() == creates+1 && images.textureUploadBytes() == uploads+8,
        "second block owner uploaded more than its private two-entry table");
      require(images.gpuBytes() == 70U*70*2+2*8,"shared block atlas GPU accounting is incorrect");
      const auto spriteRegion = images.resolveSpriteRegion(first->handle,0,0,64,64,false);
      require(spriteRegion && spriteRegion->image.texture == region->image.texture,
        "block and sprite consumers did not reuse the same physical page");
      const auto entries = images.memoryEntries();
      const auto owner = std::find_if(entries.begin(),entries.end(),[&](const auto& entry) { return entry.handle == first->handle; });
      require(owner != entries.end() && owner->gpuBytes == 70U*70*2+8,
        "one logical owner counted its shared page and block atlas twice");
      pixels(images,first->handle,blockA.pixels); pixels(images,second->handle,blockB.pixels);
      require(images.release(first->handle),"first block owner release failed"); images.update();
      require(glIsTexture(alias->image.texture) && glIsTexture(alias->table),"first release invalidated the surviving block owner");
      require(images.gpuBytes() == 70U*70*2+8,"first block release did not reclaim only its private table");
      require(images.release(second->handle),"last block owner release failed"); images.update();
      require(images.gpuBytes() == 0 && images.cpuBytes() == 0,"block resources survived their last owner");
    }
    std::filesystem::remove_all(root);
    std::cout << "shared prepared pages: concurrent decoding, physical accounting, full textures, aging and mutation isolation passed\n";
  } catch (...) { std::filesystem::remove_all(root); throw; }
}
