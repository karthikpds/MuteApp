cmake_minimum_required(VERSION 3.16)
project(AppMuteAudioController CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(AudioController AudioController.cpp)

# WASAPI / COM live in ole32; Psapi for process image names; user32 for the
# `windows` command (EnumWindows).
target_link_libraries(AudioController PRIVATE ole32 user32 psapi)

if(MSVC)
  target_compile_definitions(AudioController PRIVATE UNICODE _UNICODE)
endif()
