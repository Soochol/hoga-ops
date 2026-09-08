from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api.heatmap import load_document, save_document
from hoga.api.heatmap_routes import build_router
from hoga.api.models import HeatmapDocument, HeatmapEntry, WatchlistFolder

A, B, C = 'f_0000000a', 'f_0000000b', 'f_0000000c'


@pytest.fixture
def client(tmp_path: Path):
    save_document(tmp_path, HeatmapDocument(
        folders=[WatchlistFolder(id=f, name=f, order=i) for i, f in enumerate([A, B, C])],
        entries=[HeatmapEntry(code=c, name=c, folder_id=f, order=i)
                 for f, codes in [(A, ['005930', '000660']), (B, ['035420', '005930']), (C, ['000660'])]
                 for i, c in enumerate(codes)],
        capture_markers={'005930': '20260907'},
    ))
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    with TestClient(app) as client:
        yield client


def changes(copy=False):
    return [
        {'folder_id': A, 'before': ['005930', '000660'], 'after': ['005930', '000660'] if copy else []},
        {'folder_id': B, 'before': ['035420', '005930'], 'after': ['005930', '000660', '035420']},
    ]


def inverse(items):
    return [{'folder_id': c['folder_id'], 'before': c['after'], 'after': c['before']} for c in items]


def send(client, items):
    return client.put('/api/heatmap/entries/transaction', json={'changes': items})


@pytest.mark.parametrize('copy', [False, True])
def test_move_copy_and_undo_preserve_other_memberships_and_capture_markers(client, tmp_path, copy):
    before = load_document(tmp_path).model_dump()
    request = changes(copy)
    assert send(client, request).status_code == 204
    body = client.get('/api/heatmap').json()
    assert [e['code'] for e in body['entries'] if e['folder_id'] == B] == ['005930', '000660', '035420']
    assert [e['code'] for e in body['entries'] if e['folder_id'] == C] == ['000660']
    assert body['capture_markers'] == {'005930': '20260907'}
    assert send(client, inverse(request)).status_code == 204
    after = load_document(tmp_path).model_dump()
    # Storage array order is not display order: membership.order is authoritative.
    for doc in [before, after]:
        doc['entries'].sort(key=lambda e: (e['folder_id'], e['order']))
    assert after == before


@pytest.mark.parametrize('fault', ['stale', 'duplicate_code', 'duplicate_folder', 'unknown', 'loss', 'folder'])
def test_invalid_transaction_never_partially_writes(client, tmp_path, fault):
    before = load_document(tmp_path).model_dump()
    request = changes()
    if fault == 'stale':
        request[1]['before'].reverse()
    elif fault == 'duplicate_code':
        request[1]['after'].append('005930')
    elif fault == 'duplicate_folder':
        request.append(request[0])
    elif fault == 'unknown':
        request[1]['after'].append('123456')
    elif fault == 'loss':
        request[1]['after'].remove('000660')
    else:
        request[1]['folder_id'] = 'f_99999999'
    assert send(client, request).status_code in (404, 409)
    assert load_document(tmp_path).model_dump() == before


def test_undo_conflict_preserves_later_edit(client, tmp_path):
    request = changes()
    assert send(client, request).status_code == 204
    assert client.put('/api/heatmap/reorder', json={
        'folder_id': B, 'ordered_codes': ['035420', '000660', '005930'],
    }).status_code == 204
    before = load_document(tmp_path).model_dump()
    assert send(client, inverse(request)).status_code == 409
    assert load_document(tmp_path).model_dump() == before
