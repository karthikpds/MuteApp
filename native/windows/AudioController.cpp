// AudioController.cpp — AppMute Windows audio helper.
//
// True per-application mute via WASAPI audio sessions. No third-party
// dependencies; links only against the Windows SDK (ole32, user32, psapi).
//
// Usage:
//   AudioController.exe list
//   AudioController.exe windows
//   AudioController.exe mute   --pid 1234 | --process chrome.exe
//   AudioController.exe unmute --pid 1234 | --process chrome.exe
//   AudioController.exe toggle --pid 1234 | --process chrome.exe
//   AudioController.exe status --pid 1234 | --process chrome.exe
//
// --pid targets one process; --process (no --pid) targets EVERY session
// whose process name matches, e.g. all chrome.exe renderers at once.
//
// Every command prints exactly one JSON object to stdout:
//   { "ok": true, ... }  or  { "ok": false, "error": "..." }
//
// Build (x64 Native Tools prompt for VS):
//   cl /EHsc /std:c++17 /O2 AudioController.cpp /link ole32.lib
// Or with CMake (see CMakeLists.txt in this folder).

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <endpointvolume.h>
#include <mmdeviceapi.h>
#include <psapi.h>

#include <cstdio>
#include <cwctype>
#include <cstdlib>
#include <functional>
#include <string>
#include <vector>

namespace {

std::string WideToUtf8(const std::wstring& w) {
    if (w.empty()) return "";
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, nullptr, 0, nullptr, nullptr);
    if (n <= 0) return "";
    std::string out(static_cast<size_t>(n) - 1, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, out.data(), n, nullptr, nullptr);
    return out;
}

std::string JsonEscape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if ((unsigned char)c < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += c;
                }
        }
    }
    return out;
}

std::wstring Lower(std::wstring s) {
    for (auto& c : s) c = (wchar_t)towlower(c);
    return s;
}

std::wstring BaseName(const std::wstring& p) {
    size_t i = p.find_last_of(L"\\/");
    return i == std::wstring::npos ? p : p.substr(i + 1);
}

// Compare process names ignoring case, path, and a trailing ".exe" so that
// "chrome", "chrome.exe" and "C:\...\chrome.exe" all match "chrome.exe".
bool MatchesProcess(const std::wstring& have, const std::wstring& want) {
    auto strip = [](std::wstring s) {
        s = Lower(BaseName(s));
        if (s.size() > 4 && s.compare(s.size() - 4, 4, L".exe") == 0) s.resize(s.size() - 4);
        return s;
    };
    if (want.empty()) return false;
    return strip(have) == strip(want);
}

std::wstring ExePathForPid(DWORD pid) {
    std::wstring out;
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) return out;
    wchar_t buf[MAX_PATH * 2] = {0};
    DWORD size = (DWORD)(sizeof(buf) / sizeof(buf[0]));
    if (QueryFullProcessImageNameW(h, 0, buf, &size)) out = buf;
    CloseHandle(h);
    return out;
}

struct Session {
    DWORD pid = 0;
    std::wstring processName;
    std::wstring exePath;
    std::wstring displayName;
    bool muted = false;
    float volume = 1.0f;
};

class ComInit {
public:
    ComInit() : hr_(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED)) {}
    ~ComInit() { if (SUCCEEDED(hr_)) CoUninitialize(); }
    HRESULT status() const { return hr_; }
private:
    HRESULT hr_;
};

template <typename T>
void SafeRelease(T*& p) { if (p) { p->Release(); p = nullptr; } }

// Enumerate render sessions on the default multimedia endpoint.
bool EnumerateSessions(std::vector<Session>& out, std::string& error) {
    ComInit com;
    if (FAILED(com.status())) { error = "CoInitializeEx failed."; return false; }

    IMMDeviceEnumerator* enumerator = nullptr;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                 __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
    if (FAILED(hr) || !enumerator) { error = "Could not access audio devices."; return false; }

    IMMDevice* device = nullptr;
    hr = enumerator->GetDefaultAudioEndpoint(eRender, eMultimedia, &device);
    SafeRelease(enumerator);
    if (FAILED(hr) || !device) { error = "No default audio output device found."; return false; }

    IAudioSessionManager2* manager = nullptr;
    hr = device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)&manager);
    SafeRelease(device);
    if (FAILED(hr) || !manager) { error = "Could not access audio session manager."; return false; }

    IAudioSessionEnumerator* list = nullptr;
    hr = manager->GetSessionEnumerator(&list);
    SafeRelease(manager);
    if (FAILED(hr) || !list) { error = "Could not enumerate audio sessions."; return false; }

    int count = 0;
    if (FAILED(list->GetCount(&count))) { SafeRelease(list); error = "Could not count audio sessions."; return false; }

    for (int i = 0; i < count; ++i) {
        IAudioSessionControl* ctl = nullptr;
        if (FAILED(list->GetSession(i, &ctl)) || !ctl) continue;

        IAudioSessionControl2* ctl2 = nullptr;
        ISimpleAudioVolume* vol = nullptr;
        ctl->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&ctl2);
        ctl->QueryInterface(__uuidof(ISimpleAudioVolume), (void**)&vol);

        Session s;
        if (ctl2) {
            DWORD pid = 0;
            if (SUCCEEDED(ctl2->GetProcessId(&pid))) s.pid = pid;
        }
        if (s.pid == 0) { SafeRelease(ctl2); SafeRelease(vol); SafeRelease(ctl); continue; } // system sounds session

        LPWSTR name = nullptr;
        if (SUCCEEDED(ctl->GetDisplayName(&name)) && name) {
            s.displayName = name;
            CoTaskMemFree(name);
        }
        s.exePath = ExePathForPid(s.pid);
        s.processName = BaseName(s.exePath);
        if (vol) {
            BOOL m = FALSE;
            if (SUCCEEDED(vol->GetMute(&m))) s.muted = m ? true : false;
            float v = 1.0f;
            if (SUCCEEDED(vol->GetMasterVolume(&v))) s.volume = v;
        }
        out.push_back(s);
        SafeRelease(ctl2); SafeRelease(vol); SafeRelease(ctl);
    }
    SafeRelease(list);
    return true;
}

// Apply fn to every session matching pid (a process may own several).
bool ForEachPidSession(DWORD pid, const std::function<bool(ISimpleAudioVolume*)>& fn, std::string& error) {
    ComInit com;
    if (FAILED(com.status())) { error = "CoInitializeEx failed."; return false; }
    IMMDeviceEnumerator* enumerator = nullptr;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                __uuidof(IMMDeviceEnumerator), (void**)&enumerator)) || !enumerator) {
        error = "Could not access audio devices."; return false;
    }
    IMMDevice* device = nullptr;
    HRESULT hr = enumerator->GetDefaultAudioEndpoint(eRender, eMultimedia, &device);
    SafeRelease(enumerator);
    if (FAILED(hr) || !device) { error = "No default audio output device found."; return false; }
    IAudioSessionManager2* manager = nullptr;
    hr = device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)&manager);
    SafeRelease(device);
    if (FAILED(hr) || !manager) { error = "Could not access audio session manager."; return false; }
    IAudioSessionEnumerator* list = nullptr;
    hr = manager->GetSessionEnumerator(&list);
    SafeRelease(manager);
    if (FAILED(hr) || !list) { error = "Could not enumerate audio sessions."; return false; }

    int count = 0;
    list->GetCount(&count);
    bool matched = false;
    for (int i = 0; i < count; ++i) {
        IAudioSessionControl* ctl = nullptr;
        if (FAILED(list->GetSession(i, &ctl)) || !ctl) continue;
        IAudioSessionControl2* ctl2 = nullptr;
        ISimpleAudioVolume* vol = nullptr;
        ctl->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&ctl2);
        ctl->QueryInterface(__uuidof(ISimpleAudioVolume), (void**)&vol);
        DWORD spid = 0;
        if (ctl2) ctl2->GetProcessId(&spid);
        if (spid == pid && vol) {
            matched = true;
            fn(vol);
        }
        SafeRelease(ctl2); SafeRelease(vol); SafeRelease(ctl);
    }
    SafeRelease(list);
    if (!matched) error = "Process has no active audio session. It may not be producing audio right now.";
    return matched;
}

bool ResolvePid(DWORD& pid, const std::wstring& processFilter, std::string& error) {
    if (pid != 0) return true;
    if (processFilter.empty()) { error = "Missing --pid or --process."; return false; }
    std::vector<Session> sessions;
    if (!EnumerateSessions(sessions, error)) return false;
    for (const auto& s : sessions) {
        if (MatchesProcess(s.processName, processFilter)) { pid = s.pid; return true; }
    }
    error = "Process is not currently running or has no audio session.";
    return false;
}

// Mute/unmute/toggle across EVERY session whose process matches `filter`
// (e.g. all chrome.exe renderers). Returns false when nothing matched.
bool ForEachProcessSession(const std::wstring& filter,
                           const std::function<bool(ISimpleAudioVolume*)>& fn,
                           std::string& error, int& matchedProcesses) {
    std::vector<Session> sessions;
    if (!EnumerateSessions(sessions, error)) return false;
    std::vector<DWORD> pids;
    for (const auto& s : sessions) {
        if (!MatchesProcess(s.processName, filter)) continue;
        bool dup = false;
        for (DWORD p : pids) if (p == s.pid) { dup = true; break; }
        if (!dup) pids.push_back(s.pid);
    }
    if (pids.empty()) {
        error = "Process is not currently running or has no audio session.";
        return false;
    }
    matchedProcesses = 0;
    std::string lastError;
    for (DWORD p : pids) {
        std::string perPidError;
        if (ForEachPidSession(p, fn, perPidError)) matchedProcesses++;
        else lastError = perPidError;
    }
    if (matchedProcesses == 0) { error = lastError; return false; }
    return true;
}

struct TopWindow {
    DWORD pid = 0;
    std::wstring title;
};

static BOOL CALLBACK EnumWindowsProc(HWND hwnd, LPARAM lParam) {
    auto* out = reinterpret_cast<std::vector<TopWindow>*>(lParam);
    if (!IsWindowVisible(hwnd)) return TRUE;
    // Skip non-application windows (tooltips, menus) via extended styles.
    LONG_PTR ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    if (ex & WS_EX_TOOLWINDOW) return TRUE;
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == 0) return TRUE;
    int len = GetWindowTextLengthW(hwnd);
    if (len <= 0) return TRUE;
    if (len > 200) len = 200; // picker identification only; keeps JSON buffers bounded
    std::wstring title(static_cast<size_t>(len) + 1, L'\0');
    GetWindowTextW(hwnd, title.data(), len + 1);
    title.resize(static_cast<size_t>(len));
    if (title.empty()) return TRUE;
    out->push_back({ pid, title });
    return TRUE;
}

void PrintOk(const std::string& extra) {
    if (extra.empty()) printf("{\"ok\":true}\n");
    else printf("{\"ok\":true,%s}\n", extra.c_str());
}
void PrintErr(const std::string& msg) {
    printf("{\"ok\":false,\"error\":\"%s\"}\n", JsonEscape(msg).c_str());
}

} // namespace

int wmain(int argc, wchar_t** argv) {
    if (argc < 2) { PrintErr("Usage: AudioController.exe <list|windows|mute|unmute|toggle|status> [--pid N] [--process name]"); return 1; }
    std::wstring cmd = Lower(argv[1]);
    DWORD pid = 0;
    std::wstring processFilter;
    for (int i = 2; i < argc; ++i) {
        std::wstring a = Lower(argv[i]);
        if (a == L"--pid" && i + 1 < argc) pid = (DWORD)_wtol(argv[++i]);
        else if (a == L"--process" && i + 1 < argc) processFilter = argv[++i];
    }

    if (cmd == L"list") {        std::vector<Session> sessions;
        std::string error;
        if (!EnumerateSessions(sessions, error)) { PrintErr(error); return 1; }
        std::string items;
        for (size_t i = 0; i < sessions.size(); ++i) {
            const auto& s = sessions[i];
            char buf[2048];
            snprintf(buf, sizeof(buf),
                     "%s{\"pid\":%lu,\"processName\":\"%s\",\"exePath\":\"%s\",\"displayName\":\"%s\","
                     "\"muted\":%s,\"volume\":%.3f,\"hasAudio\":true}",
                     i ? "," : "", (unsigned long)s.pid,
                     JsonEscape(WideToUtf8(s.processName)).c_str(),
                     JsonEscape(WideToUtf8(s.exePath)).c_str(),
                     JsonEscape(WideToUtf8(s.displayName)).c_str(),
                     s.muted ? "true" : "false", (double)s.volume);
            items += buf;
        }
        PrintOk("\"sessions\":[" + items + "]");
        return 0;
    }

    if (cmd == L"windows") {
        // Top-level visible application windows with owning PID and title.
        // No special permissions required. Browser titles carry the active
        // tab, e.g. "YouTube - Google Chrome".
        std::vector<TopWindow> wins;
        EnumWindows(EnumWindowsProc, reinterpret_cast<LPARAM>(&wins));
        std::string items;
        size_t n = 0;
        for (const auto& w : wins) {
            if (n++ >= 500) break;
            char buf[1400];
            snprintf(buf, sizeof(buf), "%s{\"pid\":%lu,\"title\":\"%s\"}",
                     n > 1 ? "," : "", (unsigned long)w.pid,
                     JsonEscape(WideToUtf8(w.title)).c_str());
            items += buf;
        }
        PrintOk("\"windows\":[" + items + "]");
        return 0;
    }

    if (cmd == L"mute" || cmd == L"unmute" || cmd == L"toggle" || cmd == L"status") {
        std::string error;
        const GUID ctx = GUID_NULL;
        const bool processWide = (pid == 0 && !processFilter.empty());
        if ((cmd == L"mute" || cmd == L"unmute") && processWide) {
            const BOOL target = (cmd == L"mute") ? TRUE : FALSE;
            int matched = 0;
            if (!ForEachProcessSession(processFilter,
                    [&](ISimpleAudioVolume* v) { v->SetMute(target, &ctx); return true; },
                    error, matched)) { PrintErr(error); return 1; }
            char buf[192];
            snprintf(buf, sizeof(buf), "\"matchedProcesses\":%d,\"muted\":%s",
                     matched, target ? "true" : "false");
            PrintOk(buf); return 0;
        }
        if (!ResolvePid(pid, processFilter, error)) { PrintErr(error); return 1; }
        if (cmd == L"toggle" && processWide) {
            // Read state from the first matching session, apply to all.
            bool target = true;
            bool read = false;
            int matched = 0;
            if (!ForEachProcessSession(processFilter,
                    [&](ISimpleAudioVolume* v) {
                        if (!read) { BOOL m = FALSE; if (SUCCEEDED(v->GetMute(&m))) target = !m; read = true; }
                        v->SetMute(target ? TRUE : FALSE, &ctx); return true;
                    }, error, matched)) { PrintErr(error); return 1; }
            char buf[192];
            snprintf(buf, sizeof(buf), "\"matchedProcesses\":%d,\"muted\":%s",
                     matched, target ? "true" : "false");
            PrintOk(buf); return 0;
        }
        if (cmd == L"mute") {
            if (!ForEachPidSession(pid, [&](ISimpleAudioVolume* v) { v->SetMute(TRUE, &ctx); return true; }, error)) { PrintErr(error); return 1; }
            char buf[128]; snprintf(buf, sizeof(buf), "\"pid\":%lu,\"muted\":true", (unsigned long)pid);
            PrintOk(buf); return 0;
        }
        if (cmd == L"unmute") {
            if (!ForEachPidSession(pid, [&](ISimpleAudioVolume* v) { v->SetMute(FALSE, &ctx); return true; }, error)) { PrintErr(error); return 1; }
            char buf[128]; snprintf(buf, sizeof(buf), "\"pid\":%lu,\"muted\":false", (unsigned long)pid);
            PrintOk(buf); return 0;
        }
        if (cmd == L"toggle") {
            bool target = true;
            bool read = false;
            if (!ForEachPidSession(pid, [&](ISimpleAudioVolume* v) {
                    if (!read) { BOOL m = FALSE; if (SUCCEEDED(v->GetMute(&m))) target = !m; read = true; }
                    v->SetMute(target ? TRUE : FALSE, &ctx); return true;
                }, error)) { PrintErr(error); return 1; }
            char buf[128]; snprintf(buf, sizeof(buf), "\"pid\":%lu,\"muted\":%s", (unsigned long)pid, target ? "true" : "false");
            PrintOk(buf); return 0;
        }
        // status
        std::vector<Session> sessions;
        if (!EnumerateSessions(sessions, error)) { PrintErr(error); return 1; }
        for (const auto& s : sessions) {
            if (s.pid == pid) {
                char buf[256];
                snprintf(buf, sizeof(buf), "\"pid\":%lu,\"muted\":%s,\"volume\":%.3f",
                         (unsigned long)pid, s.muted ? "true" : "false", (double)s.volume);
                PrintOk(buf); return 0;
            }
        }
        PrintErr("Process has no active audio session. It may not be producing audio right now.");
        return 1;
    }

    PrintErr("Unknown command. Use list|windows|mute|unmute|toggle|status.");
    return 1;
}
