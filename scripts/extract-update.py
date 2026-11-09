#!/usr/bin/env python3
"""Extract a verified release into an empty staging folder without links or devices."""
import pathlib
import sys
import tarfile

archive, destination, root = sys.argv[1:]
with tarfile.open(archive, 'r:gz') as source:
    members = []
    names = set()
    total = 0
    for member in source:
        name = pathlib.PurePosixPath(member.name)
        if (name.is_absolute() or '..' in name.parts or not name.parts
                or name.parts[0] != root or '\\' in member.name
                or not (member.isfile() or member.isdir())
                or member.name in names):
            raise ValueError('Unsafe path or entry in update archive')
        names.add(member.name)
        total += member.size
        if len(names) > 5000 or total > 100 * 1024 * 1024:
            raise ValueError('Update archive is too large')
        members.append(member)
    for member in members:
        target = pathlib.Path(destination, member.name)
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(member) as src, target.open('xb') as out:
                while chunk := src.read(1024 * 1024):
                    out.write(chunk)
            target.chmod(0o755 if member.mode & 0o111 else 0o644)
