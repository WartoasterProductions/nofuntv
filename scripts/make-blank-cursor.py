#!/usr/bin/env python3
"""Create a minimal 1×1 transparent XCursor theme on the Pi."""
import struct, pathlib

XCURSOR_MAGIC = 0x72756358   # 'Xcur' little-endian
XCURSOR_VER   = 0x00010000
IMAGE_TYPE    = 0xfffd0002
IMAGE_VER     = 0x00010000

FILE_HDR_LEN  = 4 * 4   # magic, header_len, version, ntoc
TOC_ENTRY_LEN = 4 * 3   # type, subtype, position
IMAGE_HDR_LEN = 9 * 4   # header, type, subtype, ver, w, h, xhot, yhot, delay

pixel_data = struct.pack('<I', 0x00000000)  # 1×1 transparent ARGB

def p(*args):
    return struct.pack('<' + 'I' * len(args), *args)

chunk_pos = FILE_HDR_LEN + TOC_ENTRY_LEN

data  = p(XCURSOR_MAGIC, FILE_HDR_LEN, XCURSOR_VER, 1)    # file header
data += p(IMAGE_TYPE, 1, chunk_pos)                         # TOC entry
data += p(IMAGE_HDR_LEN, IMAGE_TYPE, 1, IMAGE_VER,         # image chunk header
          1, 1, 0, 0, 50)                                   # w, h, xhot, yhot, delay_ms
data += pixel_data

base    = pathlib.Path.home() / '.local/share/icons/blank-cursor'
cursors = base / 'cursors'
cursors.mkdir(parents=True, exist_ok=True)

(base / 'cursor.theme').write_text('[Icon Theme]\nName=blank-cursor\n')
(base / 'index.theme').write_text('[Icon Theme]\nName=blank-cursor\n')

primary = cursors / 'left_ptr'
primary.write_bytes(data)

for name in ['default', 'right_ptr', 'crosshair', 'watch', 'xterm',
             'hand1', 'hand2', 'fleur', 'top_left_arrow', 'arrow',
             'pointing_hand', 'text', 'vertical-text', 'all-scroll',
             'col-resize', 'row-resize', 'e-resize', 'w-resize',
             'n-resize', 's-resize', 'ne-resize', 'nw-resize',
             'se-resize', 'sw-resize', 'ew-resize', 'ns-resize',
             'nwse-resize', 'nesw-resize', 'not-allowed', 'grabbing', 'grab']:
    link = cursors / name
    link.unlink(missing_ok=True)
    link.symlink_to('left_ptr')

print('Done —', base)
