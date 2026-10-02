# Replaces a Windows executable's icon with an .ico file, through the Win32
# resource-update API. Used by after-pack.cjs on the packaged launcher, because
# electron-builder's own executable editing is switched off (it would download
# extra signing tools).
#
#   python scripts/set-exe-icon.py <exe> <ico>
import ctypes, struct, sys
from ctypes import wintypes

RT_ICON, RT_GROUP_ICON = 3, 14
LANGUAGE = 1033

def main(exe, ico):
    data = open(ico, 'rb').read()
    reserved, kind, count = struct.unpack_from('<HHH', data, 0)
    if reserved != 0 or kind != 1 or count == 0: raise SystemExit(f'{ico} is not an icon file')
    entries = [struct.unpack_from('<BBBBHHII', data, 6 + index * 16) for index in range(count)]

    k32 = ctypes.WinDLL('kernel32', use_last_error=True)
    k32.BeginUpdateResourceW.restype = wintypes.HANDLE
    k32.BeginUpdateResourceW.argtypes = [wintypes.LPCWSTR, wintypes.BOOL]
    k32.UpdateResourceW.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, wintypes.WORD, ctypes.c_void_p, wintypes.DWORD]
    k32.EndUpdateResourceW.argtypes = [wintypes.HANDLE, wintypes.BOOL]

    handle = k32.BeginUpdateResourceW(exe, False)
    if not handle: raise SystemExit(f'Cannot open {exe} for resource updates (error {ctypes.get_last_error()})')
    ok = True
    try:
        group = bytearray(struct.pack('<HHH', 0, 1, count))
        # Electron's icon group is id 1 with icons 1-4; the new icons take ids
        # 1..count and the group keeps id 1, so Explorer and the taskbar use it.
        for index, (width, height, colors, zero, planes, bits, size, offset) in enumerate(entries, 1):
            image = data[offset:offset + size]
            buffer = ctypes.create_string_buffer(image, len(image))
            ok &= bool(k32.UpdateResourceW(handle, ctypes.c_void_p(RT_ICON), ctypes.c_void_p(index), LANGUAGE, buffer, len(image)))
            group += struct.pack('<BBBBHHIH', width, height, colors, zero, planes, bits, size, index)
        buffer = ctypes.create_string_buffer(bytes(group), len(group))
        ok &= bool(k32.UpdateResourceW(handle, ctypes.c_void_p(RT_GROUP_ICON), ctypes.c_void_p(1), LANGUAGE, buffer, len(group)))
    finally:
        if not k32.EndUpdateResourceW(handle, not ok) or not ok:
            raise SystemExit(f'Could not write the icon into {exe} (error {ctypes.get_last_error()})')
    print(f'Set the icon of {exe} ({count} sizes)')

if __name__ == '__main__':
    if len(sys.argv) != 3: raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2])
