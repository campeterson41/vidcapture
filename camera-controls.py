"""Run a camera profile's UVC extension unit commands. Nothing is saved to flash.

Usage: camera-controls.py /dev/videoN < profile-extension-unit.json

The profile names the extension unit by GUID, its control size, the selectors
used to send a command and read the reply, a status command, and rules: when a
byte of the status reply does not equal the wanted value, send that rule's
command. The status is read again afterwards and every rule must then hold.
"""
import ctypes
import fcntl
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid

UVC_SET_CUR = 0x01
UVC_GET_CUR = 0x81
UVC_GET_LEN = 0x85


def run(device, unit_profile):
    if not re.fullmatch(r"/dev/video\d+", device):
        raise ValueError("Invalid camera device")
    node = (Path('/sys/class/video4linux') / Path(device).name / 'device').resolve(strict=True)
    usb = next((p for p in [node, *node.parents] if (p / 'idVendor').exists()), None)
    if usb is None:
        raise RuntimeError('The camera is not a USB camera')
    size = int(unit_profile['size'])
    descriptors = (usb / 'descriptors').read_bytes()
    guid = uuid.UUID(unit_profile['guid']).bytes_le
    position = descriptors.find(guid)
    # In a UVC extension unit descriptor, bUnitID sits just before the GUID.
    unit = descriptors[position - 1] if position >= 1 else 0
    if unit < 1:
        raise RuntimeError('The camera control interface has changed')

    class Query(ctypes.Structure):
        _fields_ = [('unit', ctypes.c_uint8), ('selector', ctypes.c_uint8),
                    ('query', ctypes.c_uint8), ('size', ctypes.c_uint16), ('data', ctypes.c_void_p)]

    request = (3 << 30) | (ctypes.sizeof(Query) << 16) | (ord('u') << 8) | 0x21
    fd = os.open(device, os.O_RDWR)
    try:
        def query(selector, operation, data):
            buf = ctypes.create_string_buffer(data, len(data))
            item = Query(unit, selector, operation, len(data), ctypes.addressof(buf))
            fcntl.ioctl(fd, request, item)
            return buf.raw

        setter, getter = int(unit_profile['setSelector']), int(unit_profile['getSelector'])
        for selector in (setter, getter):
            if int.from_bytes(query(selector, UVC_GET_LEN, bytes(2)), 'little') != size:
                raise RuntimeError('Unexpected camera control size')

        def command(value):
            query(setter, UVC_SET_CUR, bytes.fromhex(value))
            time.sleep(0.05)
            reply = query(getter, UVC_GET_CUR, bytes(size))
            if reply[0] != 0:
                raise RuntimeError(unit_profile.get('error') or 'The camera rejected a command')
            return reply

        rules = unit_profile['ensure']
        before = command(unit_profile['status'])
        for rule in rules:
            if before[rule['byte']] != rule['equals']:
                command(rule['send'])
        after = command(unit_profile['status'])
        if any(after[rule['byte']] != rule['equals'] for rule in rules):
            raise RuntimeError(unit_profile.get('error') or 'The camera did not accept its profile')
        return {'before': before.hex(), 'after': after.hex()}
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        print(json.dumps(run(sys.argv[1], json.load(sys.stdin))))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
