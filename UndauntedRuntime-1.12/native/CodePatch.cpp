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
 * Hunt Pass selector. In October 2026 the instruction patches moved here from
 * core/PlayerRoles.cpp. Not an official release of Mystic Paradox or Undaunted.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "native/CodePatch.h"
#include "core/RuntimeState.h"
#include "core/Logging.h"

namespace {
uint8_t* At(uintptr_t Rva) { return reinterpret_cast<uint8_t*>(Globals::BaseAddress + Rva); }

int32_t Displacement(const uint8_t* p) {
    return static_cast<int32_t>(static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8)
        | (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24));
}

std::string Bytes(const uint8_t* p, size_t Size) {
    std::string Out;
    char Hex[4];
    for (size_t i = 0; i < Size; ++i) {
        sprintf_s(Hex, "%02X", p[i]);
        if (i) Out += ' ';
        Out += Hex;
    }
    return Out;
}

bool Write(const char* Name, uint8_t* p, const uint8_t* Replacement, size_t Size, const char* What) {
    DWORD Old = 0;
    if (!VirtualProtect(p, Size, PAGE_EXECUTE_READWRITE, &Old)) {
        MpLog(std::string("[CodePatch] ") + Name + " not patched: VirtualProtect failed");
        return false;
    }
    memcpy(p, Replacement, Size);
    DWORD Ignored = 0;
    VirtualProtect(p, Size, Old, &Ignored);
    FlushInstructionCache(GetCurrentProcess(), p, Size);
    MpLog(std::string("[CodePatch] ") + Name + " " + What);
    return true;
}

bool Refuse(const char* Name, const uint8_t* p, size_t Size) {
    MpLog(std::string("[CodePatch] ") + Name + " not patched: unexpected bytes " + Bytes(p, Size));
    return false;
}
}

bool PatchBytes(const char* Name, uintptr_t Rva, const uint8_t* Expected, const uint8_t* Replacement, size_t Size) {
    uint8_t* p = At(Rva);
    if (memcmp(p, Expected, Size) != 0) return Refuse(Name, p, Size);
    return Write(Name, p, Replacement, Size, ("-> " + Bytes(Replacement, Size)).c_str());
}

bool PatchStoreImmediate(const char* Name, uintptr_t Rva, uintptr_t Target, uint8_t ExpectImm, uint8_t NewImm) {
    uint8_t* p = At(Rva);
    // C6 05 disp32 imm8: mov byte ptr [rip+disp32], imm8
    if (p[0] != 0xC6 || p[1] != 0x05 || p + 7 + Displacement(p + 2) != At(Target) || p[6] != ExpectImm) return Refuse(Name, p, 7);
    uint8_t Replacement[7];
    memcpy(Replacement, p, 7);
    Replacement[6] = NewImm;
    return Write(Name, p, Replacement, 7, ("immediate " + std::to_string(ExpectImm) + " -> " + std::to_string(NewImm)).c_str());
}

bool PatchStoreR12ToZero(const char* Name, uintptr_t Rva, uintptr_t Target) {
    uint8_t* p = At(Rva);
    // 44 88 25 disp32: mov byte ptr [rip+disp32], r12b. The 7-byte replacement
    // C6 05 disp32 00 ends at the same address, so the displacement still holds.
    if (p[0] != 0x44 || p[1] != 0x88 || p[2] != 0x25 || p + 7 + Displacement(p + 3) != At(Target)) return Refuse(Name, p, 7);
    const uint8_t Replacement[7] = { 0xC6, 0x05, p[3], p[4], p[5], p[6], 0x00 };
    return Write(Name, p, Replacement, 7, "mov [..], r12b -> mov [..], 0");
}

bool RemoveStoreAl(const char* Name, uintptr_t Rva, uintptr_t Target) {
    uint8_t* p = At(Rva);
    // 88 05 disp32: mov byte ptr [rip+disp32], al
    if (p[0] != 0x88 || p[1] != 0x05 || p + 6 + Displacement(p + 2) != At(Target)) return Refuse(Name, p, 6);
    const uint8_t Replacement[6] = { 0x90, 0x90, 0x90, 0x90, 0x90, 0x90 };
    return Write(Name, p, Replacement, 6, "mov [..], al -> nop x6");
}

bool PatchCallToTrue(const char* Name, uintptr_t Rva, uintptr_t CallTarget) {
    uint8_t* p = At(Rva);
    // E8 rel32: call rel32
    if (p[0] != 0xE8 || p + 5 + Displacement(p + 1) != At(CallTarget)) return Refuse(Name, p, 5);
    const uint8_t Replacement[5] = { 0xB0, 0x01, 0x90, 0x90, 0x90 };
    return Write(Name, p, Replacement, 5, "call -> mov al, 1");
}
