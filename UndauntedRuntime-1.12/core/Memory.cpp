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

#include "core/Memory.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"

static std::string SafeGetFullNameOf(UObject* );
static bool SafeWriteFloat(uintptr_t base, uintptr_t offset, float value);

bool IsReadablePointer(const void* Ptr, size_t Size ) {
    if (!Ptr || ((uintptr_t)Ptr & 0x7) != 0) {
        return false;
    }

    MEMORY_BASIC_INFORMATION Info{};
    if (!VirtualQuery(Ptr, &Info, sizeof(Info))) {
        return false;
    }

    if (Info.State != MEM_COMMIT || (Info.Protect & (PAGE_GUARD | PAGE_NOACCESS))) {
        return false;
    }

    uintptr_t Start = reinterpret_cast<uintptr_t>(Ptr);
    uintptr_t End = Start + Size;
    uintptr_t RegionEnd = reinterpret_cast<uintptr_t>(Info.BaseAddress) + Info.RegionSize;
    return End >= Start && End <= RegionEnd;
}

bool IsRegisteredLiveObject(const void* Ptr) {
    if (!Ptr) return false;
    __try {

        const int32_t Index = reinterpret_cast<const UObject*>(Ptr)->Index;
        return reinterpret_cast<const void*>(UObject::GObjects->GetByIndex(Index)) == Ptr;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

bool IsSanePointerArray(void* Data, int32_t Num, int32_t Max, int32_t Limit) {
    if (Num < 0 || Max < 0 || Num > Max || Num > Limit) {
        return false;
    }

    if (Num == 0) {
        return true;
    }

    return IsReadablePointer(Data, static_cast<size_t>(Num) * sizeof(void*));
}

void* EngineRealloc(void* Ptr, size_t NewSize) {

    uintptr_t Base = Globals::BaseAddress ? Globals::BaseAddress : reinterpret_cast<uintptr_t>(GetModuleHandleA(nullptr));
    using ReallocFn = void* (*)(void*, size_t, uint32_t);
    void* Result = reinterpret_cast<ReallocFn>(Base + Native112::EngineRealloc)(Ptr, NewSize, 0);

    return Result;
}

uint8_t SafeReadByte(uintptr_t base, uintptr_t offset, uint8_t fallback) {
    __try {
        return *reinterpret_cast<uint8_t*>(base + offset);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return fallback;
    }
}

bool SafeWriteByte(uintptr_t base, uintptr_t offset, uint8_t value) {
    __try {
        *reinterpret_cast<uint8_t*>(base + offset) = value;
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

float SafeReadFloat(void* addr, float fallback) {
    __try {
        return *reinterpret_cast<float*>(addr);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return fallback;
    }
}

uintptr_t SafeReadPtr(uintptr_t base, uintptr_t offset) {
    __try {
        return *reinterpret_cast<uintptr_t*>(base + offset);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return 0;
    }
}

int SafeReadU8At(uintptr_t base, uintptr_t offset) {
    __try {
        return static_cast<int>(*reinterpret_cast<uint8_t*>(base + offset));
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return -1;
    }
}

int32_t SafeReadI32At(uintptr_t base, uintptr_t offset) {
    __try {
        return *reinterpret_cast<int32_t*>(base + offset);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return -1;
    }
}

static std::string SafeGetFullNameOf(UObject* ) {

    return "";
}

static bool SafeWriteFloat(uintptr_t base, uintptr_t offset, float value) {
    __try {
        *reinterpret_cast<float*>(base + offset) = value;
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

std::string CoreCapFString(void* fstr) {
    if (!IsReadablePointer(fstr, 0x0C)) return "";
    wchar_t* Data = *reinterpret_cast<wchar_t**>(fstr);
    int32_t Num = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(fstr) + 0x8);
    if (!Data || Num <= 0 || Num > 1024 || !IsReadablePointer(Data, 2)) return "";
    std::string Out;
    Out.reserve(Num);
    for (int i = 0; i < Num && Data[i] != L'\0'; ++i) Out += static_cast<char>(Data[i] & 0xFF);
    return Out;
}
