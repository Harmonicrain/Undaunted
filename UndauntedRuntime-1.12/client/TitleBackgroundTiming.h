/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#pragma once
#include <algorithm>
#include <cmath>
#include <cstddef>

namespace TitleBackgroundTiming {
inline constexpr double HoldSeconds = 10;
inline constexpr double FadeSeconds = 2;
inline constexpr double CycleSeconds = HoldSeconds + FadeSeconds;
struct Frame {
    std::size_t Current = 0, Next = 0;
    float CurrentOpacity = 1, NextOpacity = 0;
    float CurrentScale = 1.01f, NextScale = 1.01f;
};

inline Frame Sample(double Seconds, std::size_t Count) {
    Frame Result;
    if (Count < 2 || !std::isfinite(Seconds) || Seconds < 0) return Result;
    const auto Cycle = std::floor(Seconds / CycleSeconds);
    Result.Current = static_cast<std::size_t>(std::fmod(Cycle, static_cast<double>(Count)));
    Result.Next = (Result.Current + 1) % Count;
    const double Age = std::fmod(Seconds, CycleSeconds);
    const double Fade = std::clamp((Age - HoldSeconds) / FadeSeconds, 0.0, 1.0);
    const float Blend = static_cast<float>(Fade * Fade * (3 - 2 * Fade));
    Result.CurrentScale += static_cast<float>(0.03 * Age / CycleSeconds);
    // Overlay layers are drawn in index order. Keep the lower layer opaque
    // and fade only the upper one, including the last-to-first transition.
    // Fading both layers simultaneously would reveal black behind the artwork.
    if (Result.Next > Result.Current) Result.NextOpacity = Blend;
    else { Result.CurrentOpacity = 1 - Blend; Result.NextOpacity = 1; }
    return Result;
}
}
