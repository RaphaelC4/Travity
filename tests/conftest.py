"""Windows compatibility for genlayer-test Direct Mode.

genlayer-test 0.29.2's `_inject_message_to_fd0()` unlinks its stdin tempfile
while fd 0 still holds it open. POSIX allows deleting an open file; Windows
raises PermissionError (WinError 32). This conftest defers those deletions
until after the original function returns, keeping upstream logic intact.
"""

import os

import gltest.direct.loader as _loader

_original_inject = _loader._inject_message_to_fd0


def _inject_message_to_fd0_windows_safe(vm):
    if os.name != "nt":
        return _original_inject(vm)

    deferred = []
    real_unlink = os.unlink

    def safe_unlink(path, *args, **kwargs):
        try:
            real_unlink(path, *args, **kwargs)
        except PermissionError:
            deferred.append(path)  # still referenced by fd 0; delete later

    os.unlink = safe_unlink
    try:
        return _original_inject(vm)
    finally:
        os.unlink = real_unlink
        for path in deferred:
            try:
                real_unlink(path)
            except OSError:
                pass  # OS temp cleaner will reclaim it


_loader._inject_message_to_fd0 = _inject_message_to_fd0_windows_safe
