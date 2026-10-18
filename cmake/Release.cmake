find_package(Python3 REQUIRED COMPONENTS Interpreter)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set_property(TARGET pmjs_native pmjs_runtime Effekseer EffekseerRendererGL PROPERTY EXPORT_COMPILE_COMMANDS ON)
if(NOT CMAKE_GENERATOR STREQUAL "Ninja")
  message(FATAL_ERROR "Release provenance requires Ninja; use a release preset")
endif()
set(pmjs_link_inputs)
if(PMJS_LINUX_ARM64_BUILD)
  list(APPEND pmjs_link_inputs "${PMJS_SDK_ROOT}/zig/zig")
endif()
list(JOIN pmjs_link_inputs "\n" pmjs_input_paths)
file(CONFIGURE OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/build-inputs.txt" CONTENT "${pmjs_input_paths}\n" @ONLY)
add_custom_target(pmjs_build_provenance
  COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/release.py"
    provenance --source "${CMAKE_CURRENT_SOURCE_DIR}" --build "${CMAKE_CURRENT_BINARY_DIR}"
  BYPRODUCTS "${CMAKE_CURRENT_BINARY_DIR}/build-source.json" VERBATIM)
add_dependencies(pmjs_native pmjs_build_provenance)
if(PMJS_ENABLE_SKIA65)
  add_dependencies(pmjs_build_provenance pmjs_skia65_component)
endif()
set_property(TARGET pmjs_native APPEND PROPERTY LINK_DEPENDS "${CMAKE_CURRENT_BINARY_DIR}/build-source.json")
add_custom_command(TARGET pmjs_native POST_BUILD
  COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/release.py" built
    --source "${CMAKE_CURRENT_SOURCE_DIR}" --build "${CMAKE_CURRENT_BINARY_DIR}"
    --addon "$<TARGET_FILE:pmjs_native>" VERBATIM)
