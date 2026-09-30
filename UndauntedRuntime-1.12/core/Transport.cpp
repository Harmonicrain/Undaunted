/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Further modified in September 2026 for the Undaunted fork (Harmonicrain/Undaunted):
 * the backend address comes from the command line and requests go to the
 * Undaunted metagame over plain HTTP/WebSocket; the PlayerController
 * pre-channel guard reads ReplicateSingleActor's arguments in the executable's
 * order; the client skips the legendary-ability HUD's weapon update until a
 * weapon is equipped; the seasonal event feature flags the metagame lists are
 * forced on; world servers answer event schedule checks from the metagame's
 * seasonal event schedule; validated archive passes can be shown by the native
 * Hunt Pass selector. Not an official release of
 * Mystic Paradox or Undaunted.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "core/RuntimeHooks.h"
#include "core/Transport.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "core/Logging.h"
#include "core/Memory.h"

enum EFunctionCallspace : uint32_t
{

    Absorbed = 0x0,

    Remote = 0x1,

    Local = 0x2
};

static bool MpIsRedirectHost(const std::wstring& Host);
static bool MpSplitUrl(const std::wstring& Url, std::wstring& OutHost, std::wstring& OutTail);
static std::wstring MpBuildRedirectUrl(const std::wstring& Host, const std::wstring& Tail);
static bool MpUrlRewriteEnabled();
static bool MpUrlLogEnabled();
static uint64_t MpUrlKeyHash(const std::wstring& Host, const std::wstring& Path);
static void MpLogUrlObservation(const std::wstring& Host, const std::wstring& Tail, bool WillRewrite);
void SetURLHook(void* Request, FString* Url);
static bool MpXmppTraceEnabled();
static bool MpXmppRedirectEnabled();
static bool MpWContainsCI(const std::wstring& Haystack, const wchar_t* Needle);
static bool MpIsXmppServerAddr(const std::wstring& Section, const std::wstring& Key);
static bool MpIsXmppInterestingConfig(const std::wstring& Section, const std::wstring& Key);
static void MpLogXmppConfigObservation(const std::wstring& Section, const std::wstring& Key, bool Found, bool WillRewrite);
bool GetConfigStringHook(void* This, const wchar_t* Section, const wchar_t* Key, void* Value, const void* Filename);

void* OrigProcessRequest = nullptr;

char ProcessRequest(void* Request) {
    FString APIHeader(L"x-undaunted-gameserver-apikey");
    FString APIKey(Globals::ServerAPIKey);

    {
        using SetHeaderFn = void(*)(void*, FString*, FString*);
        void* setHeader = (*reinterpret_cast<void***>(Request))[16];
        reinterpret_cast<SetHeaderFn>(setHeader)(Request, &APIHeader, &APIKey);
    }

    return reinterpret_cast<char(*)(void*)>(OrigProcessRequest)(Request);
}

void* OrigSetURL = nullptr;

static bool MpIsRedirectHost(const std::wstring& Host) {
    static const wchar_t* kApexHosts[] = {
        L"steelyard.ca",
        L"steelyard.online",
        L"ol.epicgames.com",
        L"api.epicgames.dev",
    };
    for (const wchar_t* Apex : kApexHosts) {
        const size_t Alen = wcslen(Apex);
        if (Host.size() < Alen) continue;
        if (Host.size() == Alen) {
            if (_wcsicmp(Host.c_str(), Apex) == 0) return true;
            continue;
        }

        if (Host[Host.size() - Alen - 1] != L'.') continue;
        if (_wcsicmp(Host.c_str() + (Host.size() - Alen), Apex) == 0) return true;
    }
    return false;
}

static bool MpSplitUrl(const std::wstring& Url, std::wstring& OutHost, std::wstring& OutTail) {
    const size_t SchemeEnd = Url.find(L"://");
    if (SchemeEnd == std::wstring::npos) return false;
    const std::wstring Scheme = Url.substr(0, SchemeEnd);
    if (_wcsicmp(Scheme.c_str(), L"http") != 0 && _wcsicmp(Scheme.c_str(), L"https") != 0) return false;

    const size_t AuthStart = SchemeEnd + 3;

    const size_t AuthEnd = Url.find_first_of(L"/?#", AuthStart);
    std::wstring Authority = (AuthEnd == std::wstring::npos)
        ? Url.substr(AuthStart) : Url.substr(AuthStart, AuthEnd - AuthStart);

    if (AuthEnd == std::wstring::npos)  OutTail = L"/";
    else if (Url[AuthEnd] == L'/')      OutTail = Url.substr(AuthEnd);
    else                                OutTail = L"/" + Url.substr(AuthEnd);

    const size_t At = Authority.find(L'@');
    if (At != std::wstring::npos) Authority = Authority.substr(At + 1);
    const size_t Colon = Authority.find(L':');
    if (Colon != std::wstring::npos) Authority = Authority.substr(0, Colon);

    OutHost = Authority;
    return !OutHost.empty();
}

static std::wstring MpBuildRedirectUrl(const std::wstring& Host, const std::wstring& Tail) {
    (void)Host;
    return L"http://" + Globals::MetagameAddress + Tail;
}

static bool MpUrlRewriteEnabled() {
    static int Logged = 0;
    if (!Logged) {
        Logged = 1;
        MpLog(Globals::MetagameAddress.empty()
            ? std::string("[UrlRedirect] no metagame address given; requests are NOT redirected")
            : "[UrlRedirect] rewrite ENABLED (allowlisted hosts -> http://" + MpNarrow(Globals::MetagameAddress) + ")");
    }
    return !Globals::MetagameAddress.empty();
}

static bool MpUrlLogEnabled() {
    static int Cached = -1;
    if (Cached < 0) {
        Cached = (MpWorkingDirectoryFlagPresent(L".\\debug\\URL_LOG.flag")) ? 1 : 0;
    }
    return Cached == 1;
}

static constexpr int kUrlObsMax = 512;

static volatile LONG g_UrlObsSpin = 0;

static uint64_t g_UrlObsSeen[kUrlObsMax];

static int g_UrlObsCount = 0;

static uint64_t MpUrlKeyHash(const std::wstring& Host, const std::wstring& Path) {
    uint64_t H = 1469598103934665603ULL;
    auto Mix = [&H](const std::wstring& S) {
        for (wchar_t C : S) { H ^= static_cast<uint16_t>(C); H *= 1099511628211ULL; }
        H ^= static_cast<uint8_t>('|'); H *= 1099511628211ULL;
    };
    Mix(Host); Mix(Path);
    return H;
}

static void MpLogUrlObservation(const std::wstring& Host, const std::wstring& Tail, bool WillRewrite) {
    auto Narrow = [](const std::wstring& W) {
        std::string S; S.reserve(W.size());
        for (wchar_t C : W) S += (C >= 0x20 && C < 0x7f) ? static_cast<char>(C) : '?';
        return S;
    };
    std::wstring Path = Tail;
    const size_t Q = Path.find(L'?');
    const bool HadQuery = (Q != std::wstring::npos);
    if (HadQuery) Path.resize(Q);

    const uint64_t Key = MpUrlKeyHash(Host, Path);
    bool LogLine = false;
    bool LogBudgetNotice = false;

    while (InterlockedCompareExchange(&g_UrlObsSpin, 1, 0) != 0) { YieldProcessor(); }
    if (g_UrlObsCount < kUrlObsMax) {
        bool Seen = false;
        for (int i = 0; i < g_UrlObsCount; ++i) { if (g_UrlObsSeen[i] == Key) { Seen = true; break; } }
        if (!Seen) {
            g_UrlObsSeen[g_UrlObsCount++] = Key;
            LogLine = true;
            if (g_UrlObsCount == kUrlObsMax) LogBudgetNotice = true;
        }
    }
    InterlockedExchange(&g_UrlObsSpin, 0);

    if (LogLine) {
        MpLog(std::string("[UrlRedirect] host=") + Narrow(Host) + " path=" + Narrow(Path)
            + (HadQuery ? " ?<redacted>" : "") + (WillRewrite ? "  => REWRITE" : "  (observe)"));
    }
    if (LogBudgetNotice) {
        MpLog("[UrlRedirect] observation budget reached (512 distinct host+path); further observations suppressed");
    }
}

void SetURLHook(void* Request, FString* Url) {
    if (Url != nullptr) {
        std::wstring Incoming = Url->ToWString();
        if (!Incoming.empty()) {
            std::wstring Host, Tail;
            if (MpSplitUrl(Incoming, Host, Tail) && MpIsRedirectHost(Host)) {
                const bool Rewrite = MpUrlRewriteEnabled();
                if (MpUrlLogEnabled()) MpLogUrlObservation(Host, Tail, Rewrite);
                if (Rewrite) {
                    std::wstring NewUrl = MpBuildRedirectUrl(Host, Tail);
                    FString Replacement(NewUrl.c_str());
                    reinterpret_cast<void(*)(void*, FString*)>(OrigSetURL)(Request, &Replacement);
                    return;
                }
            }
        }
    }
    reinterpret_cast<void(*)(void*, FString*)>(OrigSetURL)(Request, Url);
}

void InstallSetUrlRedirectHook(const char* Mode) {
    MH_STATUS Create = RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_03102740)), SetURLHook, &OrigSetURL);
    MH_STATUS Enable = (Create == MH_OK) ? RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_03102740))) : Create;
    MpLog(std::string("[UrlRedirect] (") + Mode + ") SetURL hook create=" + MH_StatusToString(Create)
        + " enable=" + MH_StatusToString(Enable) + " target=+" + MpHex(0x03102740));
}

static bool MpXmppTraceEnabled() {
    static int Cached = -1;
    if (Cached < 0) {
        Cached = (MpWorkingDirectoryFlagPresent(L".\\debug\\XMPP_TRACE.flag")) ? 1 : 0;
    }
    return Cached == 1;
}

static bool MpXmppRedirectEnabled() {
    return !Globals::MetagameAddress.empty();
}

static bool MpWContainsCI(const std::wstring& Haystack, const wchar_t* Needle) {
    const size_t NLen = wcslen(Needle);
    if (NLen == 0) return true;
    if (Haystack.size() < NLen) return false;
    for (size_t i = 0; i + NLen <= Haystack.size(); ++i) {
        if (_wcsnicmp(Haystack.c_str() + i, Needle, NLen) == 0) return true;
    }
    return false;
}

static bool MpIsXmppServerAddr(const std::wstring& Section, const std::wstring& Key) {
    const bool KeyIsServerAddr =
        (_wcsicmp(Key.c_str(), L"ServerAddr") == 0) || MpWContainsCI(Key, L"serveraddr");
    if (!KeyIsServerAddr) return false;
    return MpWContainsCI(Section, L"xmpp") || MpWContainsCI(Key, L"xmpp");
}

static bool MpIsXmppInterestingConfig(const std::wstring& Section, const std::wstring& Key) {
    static const wchar_t* kNeedles[] = {
        L"xmpp", L"messaging", L"serveraddr", L"onlinesubsystem", L"mcp",
        L"presence", L"jabber", L"notification", L"stomp", L"epicgames", L"steelyard",
    };
    for (const wchar_t* N : kNeedles) {
        if (MpWContainsCI(Section, N) || MpWContainsCI(Key, N)) return true;
    }
    return false;
}

static constexpr int kXmppObsMax = 512;

static volatile LONG g_XmppObsSpin = 0;

static uint64_t g_XmppObsSeen[kXmppObsMax];

static int g_XmppObsCount = 0;

static void MpLogXmppConfigObservation(const std::wstring& Section, const std::wstring& Key, bool Found, bool WillRewrite) {
    uint64_t H = 1469598103934665603ULL;
    auto AsciiFold = [](wchar_t c) -> uint16_t { return (c >= L'A' && c <= L'Z') ? static_cast<uint16_t>(c + 32) : static_cast<uint16_t>(c); };
    auto Mix = [&H, &AsciiFold](const std::wstring& S) {
        for (wchar_t C : S) { H ^= AsciiFold(C); H *= 1099511628211ULL; }
        H ^= static_cast<uint8_t>('|'); H *= 1099511628211ULL;
    };
    Mix(Section); Mix(Key);

    bool LogLine = false;
    while (InterlockedCompareExchange(&g_XmppObsSpin, 1, 0) != 0) { YieldProcessor(); }
    if (g_XmppObsCount < kXmppObsMax) {
        bool Seen = false;
        for (int i = 0; i < g_XmppObsCount; ++i) { if (g_XmppObsSeen[i] == H) { Seen = true; break; } }
        if (!Seen) { g_XmppObsSeen[g_XmppObsCount++] = H; LogLine = true; }
    }
    InterlockedExchange(&g_XmppObsSpin, 0);

    if (LogLine) {
        MpLog(std::string("[XmppConfig] section=") + MpNarrow(Section) + " key=" + MpNarrow(Key)
            + " found=" + (Found ? "1" : "0") + (WillRewrite ? "  => REWRITE ServerAddr" : ""));
    }
}

void* OrigGetConfigString = nullptr;

bool GetConfigStringHook(void* This, const wchar_t* Section, const wchar_t* Key, void* Value, const void* Filename) {
    using GetStringFn = bool(*)(void*, const wchar_t*, const wchar_t*, void*, const void*);
    const bool Found = reinterpret_cast<GetStringFn>(OrigGetConfigString)(This, Section, Key, Value, Filename);

    const bool Trace = MpXmppTraceEnabled();
    const bool Redirect = MpXmppRedirectEnabled();
    if (!Trace && !Redirect) return Found;

    std::wstring Sec = (Section && IsReadablePointer((void*)Section, sizeof(wchar_t))) ? std::wstring(Section) : std::wstring();
    std::wstring K   = (Key && IsReadablePointer((void*)Key, sizeof(wchar_t))) ? std::wstring(Key) : std::wstring();

    const bool IsServerAddr = MpIsXmppServerAddr(Sec, K);

    if (Trace && (IsServerAddr || MpIsXmppInterestingConfig(Sec, K))) {
        MpLogXmppConfigObservation(Sec, K, Found, Redirect && IsServerAddr);
    }

    if (Redirect && IsServerAddr && Value != nullptr) {

        struct RawFString { wchar_t* Data; int Num; int Max; };
        RawFString* Raw = reinterpret_cast<RawFString*>(Value);
        const std::wstring New = L"ws://" + Globals::MetagameAddress;
        const int Count = static_cast<int>(New.size()) + 1;

        if (Raw->Max < Count || Raw->Data == nullptr) {
            Raw->Data = static_cast<wchar_t*>(EngineRealloc(Raw->Data, static_cast<size_t>(Count) * sizeof(wchar_t)));
        }
        if (Raw->Data != nullptr) {
            wmemcpy(Raw->Data, New.c_str(), static_cast<size_t>(Count));
            Raw->Num = Count;
            if (Raw->Max < Count) Raw->Max = Count;

            static int LoggedOnce = 0;
            if (!LoggedOnce) { LoggedOnce = 1; MpLog(std::string("[XmppConfig] ServerAddr -> ") + MpNarrow(New)); }
            return true;
        }

    }

    return Found;
}

void InstallXmppConfigRedirectHook(const char* Mode) {
    MH_STATUS Create = RUNTIME_CREATE_HOOK((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_0243CAD0)), GetConfigStringHook, &OrigGetConfigString);
    MH_STATUS Enable = (Create == MH_OK) ? RuntimeHooks::Enable((void*)(Native112::At(Globals::BaseAddress, Native112::Rva_0243CAD0))) : Create;
    MpLog(std::string("[XmppConfig] (") + Mode + ") GetString hook create=" + MH_StatusToString(Create)
        + " enable=" + MH_StatusToString(Enable) + " target=+" + MpHex(0x0243CAD0)
        + " trace=" + (MpXmppTraceEnabled() ? "on" : "off") + " redirect=" + (MpXmppRedirectEnabled() ? "on" : "off"));
}

std::string HttpGetFromMetagame(const std::wstring& Path) {
    std::wstring Host = Globals::MetagameAddress;
    INTERNET_PORT Port = INTERNET_DEFAULT_HTTP_PORT;
    const size_t Colon = Host.rfind(L':');
    if (Colon != std::wstring::npos) {
        Port = static_cast<INTERNET_PORT>(_wtoi(Host.c_str() + Colon + 1));
        Host.resize(Colon);
    }
    std::string Body;
    HINTERNET Session = WinHttpOpen(L"UndauntedRuntime/1.12", WINHTTP_ACCESS_TYPE_NO_PROXY,
        WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!Session) return Body;
    WinHttpSetTimeouts(Session, 1500, 1500, 1500, 1500);
    HINTERNET Connect = WinHttpConnect(Session, Host.c_str(), Port, 0);
    HINTERNET Request = Connect ? WinHttpOpenRequest(Connect, L"GET", Path.c_str(), nullptr,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0) : nullptr;
    if (Request
        && WinHttpSendRequest(Request, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0)
        && WinHttpReceiveResponse(Request, nullptr)) {
        DWORD Status = 0, StatusSize = sizeof(Status);
        WinHttpQueryHeaders(Request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            WINHTTP_HEADER_NAME_BY_INDEX, &Status, &StatusSize, WINHTTP_NO_HEADER_INDEX);
        DWORD Available = 0;
        while (Status == 200 && WinHttpQueryDataAvailable(Request, &Available) && Available > 0 && Body.size() < 65536) {
            std::string Chunk(Available, '\0');
            DWORD Read = 0;
            if (!WinHttpReadData(Request, Chunk.data(), Available, &Read) || Read == 0) break;
            Body.append(Chunk.data(), Read);
        }
    }
    if (Request) WinHttpCloseHandle(Request);
    if (Connect) WinHttpCloseHandle(Connect);
    WinHttpCloseHandle(Session);
    return Body;
}
