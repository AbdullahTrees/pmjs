#include <GLES3/gl3.h>
#include <atomic>
#include <cerrno>
#include <dlfcn.h>
#include <pthread.h>

namespace {
std::atomic<bool> failThread{false};
std::atomic<bool> failed{false};
}

extern "C" {
void glTexImage2D(GLenum target, GLint level, GLint format, GLsizei width,
    GLsizei height, GLint border, GLenum inputFormat, GLenum type, const void* pixels) {
  using Upload = void (*)(GLenum, GLint, GLint, GLsizei, GLsizei, GLint, GLenum, GLenum, const void*);
  static const auto upload = reinterpret_cast<Upload>(
    dlsym(dlopen("libGLESv2.so.2", RTLD_LAZY), "glTexImage2D"));
  upload(target, level, format, width, height, border, inputFormat, type, pixels);
  // The fixture's first texture is allocated immediately before its video worker.
  if (width == 32 && height == 24 && !failed) failThread = true;
}

int pthread_create(pthread_t* thread, const pthread_attr_t* attributes,
                   void* (*start)(void*), void* argument) {
  if (failThread.exchange(false)) {
    failed = true;
    return EAGAIN;
  }
  using Create = int (*)(pthread_t*, const pthread_attr_t*, void* (*)(void*), void*);
  static const auto create = reinterpret_cast<Create>(dlsym(RTLD_NEXT, "pthread_create"));
  return create(thread, attributes, start, argument);
}
}
