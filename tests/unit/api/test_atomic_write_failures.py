import errno
from pathlib import Path

import pytest

from hoga.util import atomic_write


@pytest.mark.parametrize('writer,payload', [
    (atomic_write.atomic_write_json, {'next': True}),
    (atomic_write.atomic_write_text, 'next'),
])
@pytest.mark.parametrize('stage', ['fsync', 'replace'])
def test_failed_write_preserves_original_and_removes_temp(tmp_path, monkeypatch, writer, payload, stage):
    target = tmp_path / 'target'
    target.write_text('original')
    error = OSError(errno.ENOSPC, 'synthetic disk failure')

    def fail(*args):
        raise error

    monkeypatch.setattr(atomic_write.os, stage, fail)
    with pytest.raises(OSError) as caught:
        writer(target, payload)
    assert caught.value is error
    assert target.read_text() == 'original'
    assert list(tmp_path.glob('*.tmp')) == []


def test_serialization_failure_removes_temp(tmp_path):
    with pytest.raises(TypeError):
        atomic_write.atomic_write_json(tmp_path / 'target', {'bad': object()})
    assert list(tmp_path.iterdir()) == []


def test_cleanup_failure_does_not_hide_original_write_error(tmp_path, monkeypatch, caplog):
    original = OSError(errno.ENOSPC, 'write failed')

    def fail_replace(*args):
        raise original

    def fail_unlink(*args, **kwargs):
        raise PermissionError('cleanup failed')

    monkeypatch.setattr(atomic_write.os, 'replace', fail_replace)
    monkeypatch.setattr(Path, 'unlink', fail_unlink)
    with pytest.raises(OSError) as caught:
        atomic_write.atomic_write_json(tmp_path / 'target', {})
    assert caught.value is original
    assert 'temporary file cleanup failed' in caplog.text
