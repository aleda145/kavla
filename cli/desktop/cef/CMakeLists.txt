cmake_minimum_required(VERSION 3.21)
project(kavla_cef LANGUAGES C CXX)

if(NOT CMAKE_SYSTEM_NAME STREQUAL "Linux")
  message(FATAL_ERROR "The Kavla CEF prototype currently supports Linux only")
endif()
if(NOT IS_DIRECTORY "${CEF_ROOT}")
  message(FATAL_ERROR "Set CEF_ROOT to an extracted CEF binary distribution")
endif()

list(APPEND CMAKE_MODULE_PATH "${CEF_ROOT}/cmake")
find_package(CEF REQUIRED)
list(REMOVE_ITEM CEF_LINKER_FLAGS "-Wl,-rpath,.")
add_subdirectory("${CEF_LIBCEF_DLL_WRAPPER_PATH}" libcef_dll_wrapper)
ADD_LOGICAL_TARGET(libcef_lib "${CEF_LIB_DEBUG}" "${CEF_LIB_RELEASE}")

add_executable(kavla-cef main.cc)
SET_EXECUTABLE_TARGET_PROPERTIES(kavla-cef)
target_link_libraries(kavla-cef libcef_lib libcef_dll_wrapper ${CEF_STANDARD_LIBS})
set_target_properties(kavla-cef PROPERTIES
  INSTALL_RPATH "$ORIGIN"
  BUILD_WITH_INSTALL_RPATH TRUE
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/Release"
)
