# Copies the launcher's artwork, fonts and icon out of a Dauntless 1.12.0
# installation into src/art/. Nothing it writes is committed: the art belongs
# to the game, so each build takes it from the builder's own copy.
#
#   python scripts/extract-art.py --game <Dauntless 1.12.0 folder> --oodle <oo2core_*_win64.dll>
#
# Needs Python 3 and Pillow 9.1 or later (BC7 decoding). The paks are Oodle
# compressed; the game links Oodle statically, so point --oodle (or the
# OODLE_DLL environment variable) at an oo2core_*_win64.dll from any other
# Unreal game. The paks are only read.
import argparse, ctypes, io, mmap, os, re, struct, zlib
from PIL import Image

PAK_MAGIC = 0x5A6F12E1
UI = 'Archon/Content/UI/'
HUNT_PASS = UI + 'Textures/HuntpassRewards/'

# Season login screens, shown one per launch.
BACKGROUNDS = [
    HUNT_PASS + '2019_Season08a/ui_background_hp08a_loginscreen',
    HUNT_PASS + '2020_Season09b/ui_background_hp09b_commando_loginscreen',
    HUNT_PASS + '2021_Season16a/ui_hp_login_marauder_16A',
    HUNT_PASS + '2022_Season17a/ui_hp_login_terramane_17a',
    HUNT_PASS + '2021_Season14a/ui_hp_ranger_background_login',
]
MENUS = UI + 'Textures/Menus/'
TEXTURES = {
    'logo.png': UI + 'Textures/Logo/ArchonLogo',
    'button-gold.png': UI + 'Textures/Buttons/ui_button_gold_rectangular_default',
    'button-gold-focus.png': UI + 'Textures/Buttons/ui_button_gold_rectangular_focus',
    'button-metal.png': UI + 'Textures/Buttons/ui_help_button_2_normal',
    'button-metal-hover.png': UI + 'Textures/Buttons/ui_help_button_2_hover',
    'divider.png': UI + 'Textures/Buttons/DoubleLine',
    # The title screen's w_loginbutton and patch_notes_preview_bpw.
    'play-face.png': MENUS + 'ui_store_button_neutral',
    'play-buckle.png': MENUS + 'ui_decor_buckle_lg',
    'play-sparkle.png': MENUS + 'ui_sparkle_add',
    'news-frame.png': MENUS + 'ui_metal_frame',
    # The update-notes popup (UI/PatchNotes/patch_notes_popup_bpw and its parts).
    'popup-top.png': MENUS + 'ui_metal_frame_top',
    'popup-belt.png': MENUS + 'ui_decor_belt',
    'popup-line.png': MENUS + 'ui_metal_frame_sm',
    'tab.png': MENUS + 'Social/ContextMenuButton_Normal',
    'tab-hover.png': MENUS + 'Social/ContextMenuButton_Hover',
    'tab-selected.png': MENUS + 'Social/ContextMenuButton_Press',
    'button-blue.png': UI + 'Textures/Buttons/ui_help_button_2_highlight',      # w_button_confirm
    'button-blue-hover.png': UI + 'Textures/Buttons/ui_help_button_2_highlight_hover',
    'bullet.png': MENUS + 'ui_decor_stud',
    'scroll-thumb.png': UI + 'Textures/Buttons/ui_metal_scrollbar',             # archon_scrollbox_bpw
    'scroll-track.png': UI + 'Textures/Buttons/ui_metal_scrollbar_back',
    # The options screen (UI/Options/w_options_toggle, w_options_button_option).
    'row.png': UI + 'Textures/Options/ui_options_table_row_default',
    'row-hover.png': UI + 'Textures/Options/ui_options_table_row_hover',
    'toggle-off.png': UI + 'Textures/Options/ui_toggle_2_off',
    'toggle-on.png': UI + 'Textures/Options/ui_toggle_2_on',
    'toggle-on-hover.png': UI + 'Textures/Options/ui_toggle_2_on_hover',
    'chevron-left.png': MENUS + 'ui_cheveron_arrow_left',
    'chevron-right.png': MENUS + 'ui_cheveron_arrow',
    # The options screen's bottom bar buttons (UI/Buttons/w_button_legend_hint).
    'button-legend.png': UI + 'Textures/Buttons/ui_help_button_1_normal',
    'button-legend-hover.png': UI + 'Textures/Buttons/ui_help_button_1_hover',
}
# Textures larger than the launcher shows them; the rest are copied at full size.
MAX_WIDTH = { 'row.png': 1024, 'row-hover.png': 1024, 'bullet.png': 48, 'chevron-left.png': 64, 'chevron-right.png': 64 }
FONTS = {
    'Goldenbook-Bold.ttf': UI + 'Globals/Fonts/Goldenbook_Bold.ufont',
    'Goldenbook-Regular.ttf': UI + 'Globals/Fonts/Goldenbook_Reg.ufont',
    'RobotoCondensed-Light.ttf': UI + 'Globals/Fonts/RobotoCondensed-Light.ufont',
    'RobotoCondensed-Regular.ttf': UI + 'Globals/Fonts/RobotoCondensed-Regular.ufont',
    'RobotoCondensed-Bold.ttf': UI + 'Globals/Fonts/RobotoCondensed-Bold.ufont',
}

# ---- pak v11 (UE 4.26) -------------------------------------------------------

class Reader:
    def __init__(self, data, pos=0): self.data, self.pos = data, pos
    def take(self, fmt):
        values = struct.unpack_from(fmt, self.data, self.pos)
        self.pos += struct.calcsize(fmt)
        return values if len(values) > 1 else values[0]
    def fstring(self):
        n = self.take('<i')
        if n == 0: return ''
        if n < 0:
            raw = bytes(self.data[self.pos:self.pos - n * 2]); self.pos -= n * 2
            return raw.decode('utf-16le').rstrip('\0')
        raw = bytes(self.data[self.pos:self.pos + n]); self.pos += n
        return raw.decode('latin-1').rstrip('\0')

def decode_entry(encoded, pos):
    r = Reader(encoded, pos)
    bits = r.take('<I')
    if (bits & 0x3f) == 0x3f: r.take('<I')
    method = (bits >> 23) & 0x3f
    offset = r.take('<I') if bits & (1 << 31) else r.take('<Q')
    size = r.take('<I') if bits & (1 << 30) else r.take('<Q')
    if method: r.take('<I') if bits & (1 << 29) else r.take('<Q')
    return offset, size

class Pak:
    def __init__(self, path):
        self.file = open(path, 'rb')
        self.map = mmap.mmap(self.file.fileno(), 0, access=mmap.ACCESS_READ)
        tail = self.map[len(self.map) - 2048:]
        at = tail.rfind(struct.pack('<I', PAK_MAGIC))
        if at < 0 or tail[at - 1]: raise SystemExit(f'{path}: not a readable pak')
        _, index_at, index_size = struct.unpack_from('<iqq', tail, at + 4)
        names = tail[at + 44:at + 44 + 160]
        self.methods = [names[k * 32:(k + 1) * 32].split(b'\0')[0].decode() for k in range(5)]
        r = Reader(self.map[index_at:index_at + index_size])
        mount = r.fstring(); r.take('<i'); r.take('<Q')
        if r.take('<i'): r.pos += 36
        self.entries = {}
        if not r.take('<i'): return
        dir_at, dir_size = r.take('<q'), r.take('<q'); r.pos += 20
        encoded_size = r.take('<i')
        encoded = bytes(r.data[r.pos:r.pos + encoded_size])
        d = Reader(self.map[dir_at:dir_at + dir_size])
        for _ in range(d.take('<i')):
            directory = d.fstring()
            for _ in range(d.take('<i')):
                name, loc = d.fstring(), d.take('<i')
                if loc >= 0:
                    self.entries[(mount + directory + name).replace('../../../', '')] = decode_entry(encoded, loc)

    def read(self, name, oodle):
        offset, size = self.entries[name]
        h = Reader(self.map, offset); h.take('<q'); stored = h.take('<q'); size = h.take('<q')
        method = h.take('<I'); h.pos += 20
        blocks = [(h.take('<q'), h.take('<q')) for _ in range(h.take('<i'))] if method else []
        h.take('<B'); block_size = h.take('<I')
        if not method: return bytes(self.map[h.pos:h.pos + stored])
        out = bytearray()
        for start, end in blocks:
            chunk = bytes(self.map[offset + start:offset + end])
            if self.methods[method - 1] == 'Zlib':
                out += zlib.decompress(chunk); continue
            want = min(size - len(out), block_size or size)
            buffer = ctypes.create_string_buffer(want)
            got = oodle.OodleLZ_Decompress(chunk, len(chunk), buffer, want, 0, 0, 0, None, 0, None, None, None, 0, 3)
            if got <= 0: raise SystemExit(f'Oodle could not decompress {name}')
            out += buffer.raw[:got]
        return bytes(out[:size])

# ---- cooked Texture2D ----------------------------------------------------------

FORMATS = {'PF_DXT1': (71, 8), 'PF_DXT5': (77, 16), 'PF_BC5': (83, 16), 'PF_BC7': (98, 16), 'PF_B8G8R8A8': (None, 4)}

def texture(uasset, uexp, ubulk):
    found = re.search(rb'(?s).{4}(PF_[A-Z0-9]+)\x00', uexp)
    if not found: raise ValueError('no pixel format')
    at = found.start(1)
    n = struct.unpack_from('<i', uexp, at - 4)[0]
    fmt = uexp[at:at + n - 1].decode()
    if fmt not in FORMATS: raise ValueError('unsupported ' + fmt)
    packed = struct.unpack_from('<i', uexp, at - 8)[0]
    p = at + n + (8 if packed & (1 << 30) else 0)
    _, mips = struct.unpack_from('<ii', uexp, p); p += 8
    for _ in range(mips):
        flags = struct.unpack_from('<I', uexp, p + 4)[0]; p += 8
        if flags & 0x2000: _, stored = struct.unpack_from('<qq', uexp, p); p += 16
        else: _, stored = struct.unpack_from('<ii', uexp, p); p += 8
        offset = struct.unpack_from('<q', uexp, p)[0]; p += 8
        data = None
        if flags & 0x20: pass
        elif flags & 0x100: data = ubulk[offset:offset + stored] if ubulk else None
        elif flags & 0x1: data = uexp[offset - len(uasset):offset - len(uasset) + stored]
        else: data = uexp[p:p + stored]; p += stored
        w, h, _ = struct.unpack_from('<iii', uexp, p); p += 12
        dxgi, unit = FORMATS[fmt]
        need = w * h * unit if dxgi is None else ((w + 3) // 4) * ((h + 3) // 4) * unit
        if not data or len(data) < need: continue
        if dxgi is None: return Image.frombytes('RGBA', (w, h), data[:need], 'raw', 'BGRA')
        header = bytearray(128)
        struct.pack_into('<4sIIIIIII', header, 0, b'DDS ', 124, 0x81007, h, w, need, 0, 1)
        struct.pack_into('<II4s', header, 76, 32, 4, b'DX10')
        struct.pack_into('<I', header, 108, 0x1000)
        dds = bytes(header) + struct.pack('<IIIII', dxgi, 3, 0, 1, 0) + data[:need]
        return Image.open(io.BytesIO(dds)).convert('RGBA')
    raise ValueError('no mip with data')

# ---- the game's icon ----------------------------------------------------------

def game_icon(exe):
    """The first icon group in exe as .ico bytes, read through the Win32 resource API."""
    k32 = ctypes.WinDLL('kernel32', use_last_error=True)
    k32.LoadLibraryExW.restype = ctypes.c_void_p
    k32.LoadLibraryExW.argtypes = [ctypes.c_wchar_p, ctypes.c_void_p, ctypes.c_uint32]
    for fn, res in (('FindResourceW', ctypes.c_void_p), ('LoadResource', ctypes.c_void_p),
                    ('LockResource', ctypes.c_void_p), ('SizeofResource', ctypes.c_uint32)):
        getattr(k32, fn).restype = res
    k32.FindResourceW.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
    k32.LoadResource.argtypes = k32.SizeofResource.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    k32.LockResource.argtypes = [ctypes.c_void_p]
    k32.FreeLibrary.argtypes = [ctypes.c_void_p]
    module = k32.LoadLibraryExW(exe, None, 0x2 | 0x20)  # as a data file and image resource
    if not module: raise SystemExit(f'Could not read resources from {exe}')
    try:
        def resource(kind, name):
            found = k32.FindResourceW(module, name, ctypes.c_void_p(kind))
            if not found: return None
            return ctypes.string_at(k32.LockResource(k32.LoadResource(module, found)), k32.SizeofResource(module, found))
        groups = []
        Callback = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p)
        # A name is a small integer id or a string that only lives during the callback.
        keep = Callback(lambda module, kind, name, param: groups.append(name if name < 0x10000 else ctypes.wstring_at(name)) or False)
        k32.EnumResourceNamesW(ctypes.c_void_p(module), ctypes.c_void_p(14), keep, None)
        if not groups: raise SystemExit(f'{exe} has no icon')
        name = groups[0]
        group = resource(14, ctypes.cast(ctypes.c_wchar_p(name), ctypes.c_void_p) if isinstance(name, str) else ctypes.c_void_p(name))
        count = struct.unpack_from('<H', group, 4)[0]
        entries, images = [], []
        for index in range(count):
            fields = struct.unpack_from('<BBBBHHIH', group, 6 + index * 14)
            image = resource(3, ctypes.c_void_p(fields[7]))
            entries.append(fields[:7]); images.append(image)
        offset = 6 + 16 * count
        out = bytearray(struct.pack('<HHH', 0, 1, count))
        for fields, image in zip(entries, images):
            out += struct.pack('<BBBBHHII', *fields[:6], len(image), offset)
            offset += len(image)
        for image in images: out += image
        return bytes(out)
    finally:
        k32.FreeLibrary(module)

# ---- installer sidebar -------------------------------------------------------

def installer_sidebar(background, logo):
    """The NSIS wizard's 164x314 sidebar: a tall slice of a login screen, darkened
    towards the bottom, with the Dauntless logo there."""
    width, height = 164, 314
    # Terramane's login screen: the slice around the behemoth's raised head.
    slice_width = round(background.height * width / height)
    left = round(background.width * 0.6) - slice_width // 2
    art = background.convert('RGB').crop((left, 0, left + slice_width, background.height)).resize((width, height), Image.LANCZOS)
    shade = Image.new('L', (1, height))
    for y in range(height):
        shade.putpixel((0, y), min(235, max(0, round((y - 150) * 1.9))))
    art = Image.composite(Image.new('RGB', (width, height), (7, 11, 17)), art, shade.resize((width, height)))
    mark = logo.resize((124, round(logo.height * 124 / logo.width)), Image.LANCZOS)
    canvas = art.convert('RGBA')
    canvas.alpha_composite(mark, ((width - mark.width) // 2, height - mark.height - 24))
    return canvas.convert('RGB')

# ---- main ---------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game', required=True, help='Dauntless 1.12.0 folder (or its Paks folder)')
    parser.add_argument('--oodle', default=os.environ.get('OODLE_DLL'), help='oo2core_*_win64.dll')
    parser.add_argument('--out', default=os.path.join(os.path.dirname(__file__), '..', 'src', 'art'))
    args = parser.parse_args()
    if not args.oodle or not os.path.exists(args.oodle):
        raise SystemExit('Pass --oodle (or set OODLE_DLL) to an oo2core_*_win64.dll.')
    paks_dir = args.game
    for candidate in (args.game, os.path.join(args.game, 'Dauntless', 'Archon', 'Content', 'Paks')):
        if os.path.isdir(candidate) and any(f.endswith('.pak') for f in os.listdir(candidate)): paks_dir = candidate
    paks = [Pak(os.path.join(paks_dir, f)) for f in sorted(os.listdir(paks_dir)) if f.endswith('.pak')]
    if not paks: raise SystemExit(f'No .pak files under {args.game}.')
    oodle = ctypes.WinDLL(args.oodle)

    def read(name, optional=False):
        for pak in paks:
            if name in pak.entries: return pak.read(name, oodle)
        if optional: return None
        raise SystemExit(f'{name} is not in these paks; is this the 1.12.0 client?')

    def load(asset):
        return texture(read(asset + '.uasset'), read(asset + '.uexp'), read(asset + '.ubulk', optional=True))

    out = os.path.abspath(args.out)
    os.makedirs(os.path.join(out, 'fonts'), exist_ok=True)
    for index, asset in enumerate(BACKGROUNDS, 1):
        load(asset).convert('RGB').save(os.path.join(out, f'background-{index}.jpg'), quality=86, optimize=True, progressive=True)
        print(f'background-{index}.jpg  {asset.rsplit("/", 1)[-1]}')
    for name, asset in TEXTURES.items():
        image = load(asset)
        if name == 'logo.png':
            image = image.crop(image.getchannel('A').getbbox())
            image = image.resize((480, round(image.height * 480 / image.width)), Image.LANCZOS)
        elif name in MAX_WIDTH and image.width > MAX_WIDTH[name]:
            width = MAX_WIDTH[name]
            image = image.resize((width, max(1, round(image.height * width / image.width))), Image.LANCZOS)
        image.save(os.path.join(out, name), optimize=True)
        print(f'{name:22} {asset.rsplit("/", 1)[-1]}')
    for name, asset in FONTS.items():
        data = read(asset)
        if data[:4] not in (b'\0\1\0\0', b'OTTO'): raise SystemExit(f'{asset} is not a font file')
        open(os.path.join(out, 'fonts', name), 'wb').write(data)
        print(f'fonts/{name}')
    root = os.path.abspath(os.path.join(paks_dir, '..', '..', '..', '..'))
    exe = next((path for path in (os.path.join(root, 'Dauntless', 'Dauntless.exe'),
                                  os.path.join(root, 'Dauntless', 'Archon', 'Binaries', 'Win64', 'Dauntless-Win64-Shipping.exe'))
                if os.path.exists(path)), None)
    if exe is None: raise SystemExit(f'No Dauntless executable next to {paks_dir}')
    open(os.path.join(out, 'icon.ico'), 'wb').write(game_icon(exe))
    print(f'icon.ico               {os.path.basename(exe)}')
    sidebar = installer_sidebar(Image.open(os.path.join(out, 'background-4.jpg')), Image.open(os.path.join(out, 'logo.png')).convert('RGBA'))
    sidebar.save(os.path.join(out, 'installer-sidebar.bmp'))
    print('installer-sidebar.bmp  background-4.jpg and logo.png')
    print(f'Wrote the launcher art to {out}')

if __name__ == '__main__':
    main()
