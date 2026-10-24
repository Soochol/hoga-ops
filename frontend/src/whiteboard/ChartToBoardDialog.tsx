import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { openDailyNote, listBoards, type WhiteboardSummary } from '../api/whiteboards';
import { ModalShell } from '../ui/ModalShell';
import { stageChartTransfer } from './chartTransfer';
import { todayKst, sortedNotes } from './review';

export default function ChartToBoardDialog({
  capture,
  code,
  timeframe,
  onClose,
}: {
  capture: () => Promise<Blob>;
  code: string;
  timeframe: string;
  onClose: () => void;
}) {
  const [boards, setBoards] = useState<WhiteboardSummary[]>([]);
  const [target, setTarget] = useState('daily');
  const [date, setDate] = useState(todayKst);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const navigate = useNavigate();
  useEffect(() => {
    let alive = true;
    void listBoards()
      .then((result) => {
        if (alive) setBoards(result.boards);
      })
      .catch((error) => {
        if (alive) setError(error.message);
      });
    return () => {
      alive = false;
    };
  }, []);
  async function send() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const blob = await capture();
      const id = target === 'daily' ? (await openDailyNote(date)).id : target;
      // The live route only promises the subject, not a saved historical range.
      const source = {
        code,
        timeframe,
        captured_at_ms: Date.now(),
        url: `/live?code=${encodeURIComponent(code)}`,
      };
      const transfer = stageChartTransfer({ blob, source });
      navigate(`/whiteboard?board=${id}&transfer=${transfer}&mode=edit`);
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : '차트를 노트로 보내지 못했습니다');
    } finally {
      setBusy(false);
    }
  }
  return (
    <ModalShell
      ariaLabel="복기 노트에 차트 추가"
      title="복기 노트에 차트 추가"
      width="w-[440px]"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="flex flex-col gap-md p-lg">
        <p className="text-sm text-fg-dim">현재 보이는 차트와 보조지표를 이미지로 추가합니다.</p>
        <label className="flex flex-col gap-xs text-sm">
          추가할 노트
          <select
            aria-label="추가할 노트"
            className="bg-bg-input text-fg rounded-md p-sm"
            value={target}
            disabled={busy}
            onChange={(event) => setTarget(event.target.value)}
          >
            <option value="daily">선택일 복기 노트에 추가 / 없으면 작성</option>
            {sortedNotes(boards).map((board) => (
              <option key={board.id} value={board.id}>
                {board.review!.date} · {board.name}
              </option>
            ))}
            <optgroup label="기존 보드">{boards.filter(board => !board.review).map(board => <option key={board.id} value={board.id}>{board.name}</option>)}</optgroup>
          </select>
        </label>
        {target === 'daily' && <label className="flex flex-col gap-xs text-sm">복기 대상일<input type="date" aria-label="복기 대상일" value={date} onChange={event => setDate(event.target.value)} className="bg-bg-input text-fg rounded-md p-sm" /></label>}
        {error && (
          <p className="text-sm text-error" role="alert">
            {error}
          </p>
        )}
        <button
          type="button"
          className="bg-accent text-accent-fg rounded-lg p-sm text-sm disabled:opacity-50"
          disabled={busy || (target === 'daily' && !date)}
          onClick={() => void send()}
        >
          {busy ? '차트 이미지를 만드는 중…' : '차트 첨부하고 작성하기'}
        </button>
      </div>
    </ModalShell>
  );
}
