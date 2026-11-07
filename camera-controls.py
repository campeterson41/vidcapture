"""Apply the verified Kiyo Pro Ultra 4K30 capture profile without saving flash."""
import ctypes
import fcntl
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid


def prepare(device):
    if not re.fullmatch(r"/dev/video\d+", device):
        raise ValueError("Invalid camera device")
    node = (Path('/sys/class/video4linux') / Path(device).name / 'device').resolve(strict=True)
    usb = next((p for p in [node, *node.parents] if (p / 'idVendor').exists()), None)
    if usb is None or (usb / 'idVendor').read_text().strip() != '1532' or (usb / 'idProduct').read_text().strip() != '0e08':
        return {'razerUltra': False}
    descriptors = (usb / 'descriptors').read_bytes()
    guid = uuid.UUID('23e49ed0-1178-4f31-ae52-d2fb8a8d3b48').bytes_le
    position = descriptors.find(guid)
    if position < 1 or descriptors[position - 1] != 6:
        raise RuntimeError('The Razer camera control interface has changed')

    class Query(ctypes.Structure):
        _fields_ = [('unit', ctypes.c_uint8), ('selector', ctypes.c_uint8),
                    ('query', ctypes.c_uint8), ('size', ctypes.c_uint16), ('data', ctypes.c_void_p)]

    request = (3 << 30) | (ctypes.sizeof(Query) << 16) | (ord('u') << 8) | 0x21
    fd = os.open(device, os.O_RDWR)
    try:
        def query(selector, operation, data):
            buf = ctypes.create_string_buffer(data, len(data))
            item = Query(6, selector, operation, len(data), ctypes.addressof(buf))
            fcntl.ioctl(fd, request, item)
            return buf.raw

        for selector in (1, 2):
            if int.from_bytes(query(selector, 0x85, bytes(2)), 'little') != 8:
                raise RuntimeError('Unexpected Razer control size')

        def command(value):
            query(1, 1, bytes.fromhex(value))
            time.sleep(0.05)
            reply = query(2, 0x81, bytes(8))
            if reply[0] != 0:
                raise RuntimeError('The camera rejected the 30 fps profile')
            return reply

        # Verified against Razer's 0E08 middleware and this device. Native HDR and
        # lens correction each reduce actual 4K delivery to 24 fps. Keep other
        # image controls untouched; Capture performs optional correction on GPU.
        before = command('c003110000000000')
        if before[2] != 1:
            command('ff01000300000000')
        if before[3] != 0:
            command('ff02000000000000')
        after = command('c003110000000000')
        if after[2] != 1 or after[3] != 0:
            raise RuntimeError('The Razer camera did not accept the 30 fps profile')
        return {'razerUltra': True, 'hardwareHDR': False, 'hardwareCorrection': False,
                'before': before.hex(), 'after': after.hex()}
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        print(json.dumps(prepare(sys.argv[1])))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
