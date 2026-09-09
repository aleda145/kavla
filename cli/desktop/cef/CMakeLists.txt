cmake_minimum_required(VERSION 3.21)
project(kavla_cef LANGUAGES C CXX)

if(NOT CMAKE_SYSTEM_NAME MATCHES "^(Linux|Darwin)$")
  message(FATAL_ERROR "Kavla CEF supports Linux and macOS")
endif()
if(NOT IS_DIRECTORY "${CEF_ROOT}")
  message(FATAL_ERROR "Set CEF_ROOT to an extracted CEF binary distribution")
endif()

list(APPEND CMAKE_MODULE_PATH "${CEF_ROOT}/cmake")
find_package(CEF REQUIRED)
list(REMOVE_ITEM CEF_LINKER_FLAGS "-Wl,-rpath,.")
add_subdirectory("${CEF_LIBCEF_DLL_WRAPPER_PATH}" libcef_dll_wrapper)
if(OS_LINUX)
  ADD_LOGICAL_TARGET(libcef_lib "${CEF_LIB_DEBUG}" "${CEF_LIB_RELEASE}")
  add_executable(kavla-desktop main.cc)
  SET_EXECUTABLE_TARGET_PROPERTIES(kavla-desktop)
  target_link_libraries(kavla-desktop libcef_lib libcef_dll_wrapper ${CEF_STANDARD_LIBS})
  set_target_properties(kavla-desktop PROPERTIES
    INSTALL_RPATH "$ORIGIN"
    BUILD_WITH_INSTALL_RPATH TRUE
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/Release"
  )
elseif(OS_MAC)
  set(KAVLA_BUNDLE_VERSION "0.0.0" CACHE STRING "macOS bundle version")
  set(app_path "${CMAKE_BINARY_DIR}/Release/Kavla.app")
  add_executable(kavla-desktop MACOSX_BUNDLE main.cc main_mac.mm)
  SET_EXECUTABLE_TARGET_PROPERTIES(kavla-desktop)
  set_source_files_properties(main_mac.mm PROPERTIES COMPILE_OPTIONS "-fobjc-arc")
  target_link_libraries(kavla-desktop libcef_dll_wrapper ${CEF_STANDARD_LIBS})
  set_target_properties(kavla-desktop PROPERTIES
    OUTPUT_NAME "Kavla"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/Release"
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/mac/Info.plist.in"
  )
  COPY_MAC_FRAMEWORK(kavla-desktop "${CEF_BINARY_DIR}" "${app_path}")

  foreach(suffix ${CEF_HELPER_APP_SUFFIXES})
    string(REPLACE ":" ";" parts "${suffix}")
    list(GET parts 0 name_suffix)
    list(GET parts 1 target_suffix)
    list(GET parts 2 bundle_suffix)
    set(helper_name "Kavla Helper${name_suffix}")
    set(helper_target "kavla-desktop-helper${target_suffix}")
    set(helper_plist "${CMAKE_CURRENT_BINARY_DIR}/helper${target_suffix}.plist")
    configure_file(mac/helper-Info.plist.in "${helper_plist}" @ONLY)
    add_executable(${helper_target} MACOSX_BUNDLE helper_mac.cc)
    SET_EXECUTABLE_TARGET_PROPERTIES(${helper_target})
    target_link_libraries(${helper_target} libcef_dll_wrapper ${CEF_STANDARD_LIBS})
    set_target_properties(${helper_target} PROPERTIES
      OUTPUT_NAME "${helper_name}"
      RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/Release"
      MACOSX_BUNDLE_INFO_PLIST "${helper_plist}"
    )
    add_dependencies(kavla-desktop ${helper_target})
    add_custom_command(TARGET kavla-desktop POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_directory
        "${CMAKE_BINARY_DIR}/Release/${helper_name}.app"
        "${app_path}/Contents/Frameworks/${helper_name}.app"
      VERBATIM
    )
  endforeach()
endif()
