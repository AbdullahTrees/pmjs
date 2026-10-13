#include "canvas.hpp"
#include <GLES3/gl3.h>
#include <algorithm>
#include <cassert>
#include <iostream>
#include <vector>

namespace {
std::vector<uint8_t> texture;
int textureWidth, textureHeight, rowLength, fullUploads, regionUploads;
GLenum pendingError = GL_NO_ERROR;
bool failUpload = false;
bool failRead = false;
}
// Capture the actual GLES transfer boundary without a window or driver.
extern "C" {
void glGenTextures(GLsizei count, GLuint* names) { for(int i=0;i<count;++i) names[i]=i+1; }
void glDeleteTextures(GLsizei, const GLuint*) {}
void glBindTexture(GLenum, GLuint) {}
void glTexParameteri(GLenum, GLenum, GLint) {}
void glPixelStorei(GLenum parameter, GLint value) { if(parameter==GL_UNPACK_ROW_LENGTH) rowLength=value; }
GLenum glGetError() { const auto error=pendingError; pendingError=GL_NO_ERROR; return error; }
void glTexImage2D(GLenum, GLint, GLint, GLsizei width, GLsizei height, GLint,
                  GLenum format, GLenum type, const void* data) {
  assert(format==GL_RGBA && type==GL_UNSIGNED_BYTE);
  textureWidth=width;textureHeight=height;
  const auto* bytes=static_cast<const uint8_t*>(data);
  texture.assign(static_cast<size_t>(width)*height*4, 0);
  if(bytes) std::copy_n(bytes,texture.size(),texture.begin());
  ++fullUploads;
}
void glTexSubImage2D(GLenum, GLint, GLint x, GLint y, GLsizei width, GLsizei height,
                     GLenum format, GLenum type, const void* data) {
  assert(format==GL_RGBA && type==GL_UNSIGNED_BYTE);
  if(failUpload) { pendingError=GL_OUT_OF_MEMORY; return; }
  assert(x>=0 && y>=0 && x+width<=textureWidth && y+height<=textureHeight);
  const auto* bytes=static_cast<const uint8_t*>(data);
  const int stride=rowLength?rowLength:width;
  for(int row=0;row<height;++row)
    std::copy_n(bytes+static_cast<size_t>(row)*stride*4,width*4,
      texture.data()+(static_cast<size_t>(y+row)*textureWidth+x)*4);
  ++regionUploads;
}
void glGenerateMipmap(GLenum) {}
void glGetIntegerv(GLenum, GLint* value) { *value=0; }
void glGenFramebuffers(GLsizei count, GLuint* names) { for (int i=0;i<count;i++) names[i]=i+1; }
void glBindFramebuffer(GLenum, GLuint) {}
void glFramebufferTexture2D(GLenum, GLenum, GLenum, GLuint, GLint) {}
GLenum glCheckFramebufferStatus(GLenum) { return GL_FRAMEBUFFER_COMPLETE; }
void glBindBuffer(GLenum, GLuint) {}
void glReadPixels(GLint x, GLint y, GLsizei width, GLsizei height, GLenum format, GLenum type, void* pixels) {
  assert(x==0 && y==0 && width==textureWidth && height==textureHeight && format==GL_RGBA && type==GL_UNSIGNED_BYTE);
  if (failRead) { pendingError=GL_INVALID_OPERATION; return; }
  std::copy(texture.begin(),texture.end(),static_cast<uint8_t*>(pixels));
}
void glDeleteFramebuffers(GLsizei, const GLuint*) {}
}
int main() {
  pmjs::ImageStore images;
  pmjs::CanvasStore canvases(images);
  const auto canvas=canvases.create(5,3); assert(canvas);
  assert(canvases.writePixels(canvas->handle,0,0,1,1,{37,67,103,157}));
  auto image=canvases.prepareImage(canvas->handle); assert(image);
  assert(images.lookup(*image)->premultiplied);
  assert((std::vector<uint8_t>(texture.begin(),texture.begin()+4)==std::vector<uint8_t>{23,41,63,157}));
  const auto before=texture;
  const std::vector<uint8_t> raw={255,127,0,0,128,0,0,127};
  assert(canvases.writePixels(canvas->handle,2,1,2,1,raw,pmjs::PixelEncoding::PremultipliedRGBA8));
  failUpload=true;
  assert(!canvases.prepareImage(canvas->handle));
  assert(texture==before);
  failUpload=false;
  assert(canvases.prepareImage(canvas->handle));
  assert(regionUploads==1 && fullUploads==1 && rowLength==0);
  for(int pixel=0;pixel<15;++pixel) {
    const auto* expected = pixel==7 ? raw.data() : pixel==8 ? raw.data()+4 : before.data()+pixel*4;
    assert(std::equal(texture.data()+pixel*4,texture.data()+pixel*4+4,expected));
  }
  const auto stats=canvases.textBackendStats();
  assert(stats.scratchBytes==0);

  const std::vector<uint8_t> zeros(2*2*4,0);
  const auto empty=images.createRgba(2,2,zeros.data(),true); assert(empty);
  assert(images.lookup(empty->handle)->knownAllZero);
  const std::vector<uint8_t> strided={0,0,0,0, 255,255,255,255,
                                     0,0,0,0, 255,255,255,255};
  assert(images.updateRgbaRegion(empty->handle,0,0,1,2,strided.data(),2));
  assert(images.lookup(empty->handle)->knownAllZero);
  const std::vector<uint8_t> hiddenRgb={37,0,0,0};
  assert(images.updateRgbaRegion(empty->handle,0,0,1,1,hiddenRgb.data(),1));
  assert(!images.lookup(empty->handle)->knownAllZero);
  assert(images.updateRgbaRegion(empty->handle,0,0,1,1,zeros.data(),1));
  assert(!images.lookup(empty->handle)->knownAllZero);
  const std::vector<uint8_t> fullStrided={0,0,0,0, 0,0,0,0, 255,255,255,255,
                                         0,0,0,0, 0,0,0,0, 255,255,255,255};
  assert(images.updateRgbaRegion(empty->handle,0,0,2,2,fullStrided.data(),3));
  assert(images.lookup(empty->handle)->knownAllZero);
  failUpload=true;
  assert(!images.updateRgbaRegion(empty->handle,0,0,1,1,hiddenRgb.data(),1));
  assert(!images.lookup(empty->handle)->knownAllZero);
  failUpload=false;
  assert(images.updateRgba(empty->handle,zeros.data()));
  assert(images.lookup(empty->handle)->knownAllZero);
  failUpload=true;
  assert(!images.updateRgba(empty->handle,zeros.data()));
  assert(!images.lookup(empty->handle)->knownAllZero);
  failUpload=false;
  assert(images.updateRgba(empty->handle,zeros.data()));
  assert(images.release(empty->handle));
  assert(!images.lookup(empty->handle));

  const auto reused=images.createRgba(1,1,hiddenRgb.data(),true); assert(reused);
  assert((reused->handle & 0xffffU)==(empty->handle & 0xffffU));
  assert(!images.lookup(reused->handle)->knownAllZero);
  assert(!images.lookup(empty->handle));
  assert(images.release(reused->handle));
  for(const bool target : {false,true}) {
    const auto gpu=target ? images.createRenderTarget(2,2,true) : images.createRgba(2,2,nullptr,true);
    assert(gpu && !images.lookup(gpu->handle)->knownAllZero);
    assert(images.updateRgba(gpu->handle,zeros.data()));
    assert(!images.lookup(gpu->handle)->knownAllZero);
    assert(images.updateRgbaRegion(gpu->handle,0,0,2,2,zeros.data(),2));
    assert(!images.lookup(gpu->handle)->knownAllZero);
    assert(images.release(gpu->handle));
  }
  for (const bool gpu : {false,true}) for (const bool immediate : {false,true}) for (const bool region : {false,true}) {
    const std::vector<uint8_t> blue={0,0,255,128};
    const std::vector<uint8_t> original={128,0,0,128};
    const auto source=images.createRgba(1,1,gpu?nullptr:original.data(),true); assert(source);
    if(gpu) assert(images.updateRgba(source->handle,original.data()));
    const auto destination=canvases.create(1,1); assert(destination);
    if(immediate) assert(canvases.readPixels(destination->handle,0,0,1,1));
    assert(canvases.drawImage(destination->handle,source->handle,0,0,1,1,0,0,1,1,1,false));
    assert(region ? images.updateRgbaRegion(source->handle,0,0,1,1,blue.data(),1) : images.updateRgba(source->handle,blue.data()));
    assert(images.release(source->handle));
    const auto captured=canvases.readPixels(destination->handle,0,0,1,1); assert(captured);
    assert((captured->rgba==std::vector<uint8_t>{255,0,0,128}));
    assert(canvases.release(destination->handle));
  }
  const auto unreadable=images.createRenderTarget(1,1,true); assert(unreadable);
  failRead=true;
  assert(!images.readPixelsRegion(unreadable->handle,0,0,1,1));
  const auto retry=canvases.create(1,1); assert(retry);
  assert(canvases.drawImage(retry->handle,unreadable->handle,0,0,1,1,0,0,1,1,1,false));
  const std::vector<uint8_t> opaqueRed={255,0,0,255};
  assert(!images.updateRgba(unreadable->handle,opaqueRed.data()));
  failRead=false;
  assert(images.updateRgba(unreadable->handle,opaqueRed.data()));
  assert((canvases.readPixels(retry->handle,0,0,1,1)->rgba==std::vector<uint8_t>(4,0)));
  assert(canvases.release(retry->handle)); assert(images.release(unreadable->handle));
  std::cout << "[canvas-upload] exact RGBA premultiplied transfers, region bounds and failed-upload retry agree\n";
}
