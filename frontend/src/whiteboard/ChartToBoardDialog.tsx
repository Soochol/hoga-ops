import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { createBoard, listBoards, type WhiteboardSummary } from '../api/whiteboards';
import { ModalShell } from '../ui/ModalShell';
import { stageChartTransfer } from './chartTransfer';

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
  const [target, setTarget] = useState('new');
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
      const id = target === 'new' ? (await createBoard(`${code} 차트 노트`)).id : target;
      // The live route only promises the subject, not a saved historical range.
      const source = {
        code,
        timeframe,
        captured_at_ms: Date.now(),
        url: `/live?code=${encodeURIComponent(code)}`,
      };
      const transfer = stageChartTransfer({ blob, source });
      navigate(`/whiteboard?board=${id}&transfer=${transfer}`);
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : '차트를 보드로 보내지 못했습니다');
    } finally {
      setBusy(false);
    }
  }
  return (
    <ModalShell
      ariaLabel="차트를 보드에 추가"
      title="차트를 보드에 추가"
      width="w-[440px]"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="flex flex-col gap-md p-lg">
        <p className="text-sm text-fg-dim">현재 보이는 차트와 보조지표를 이미지로 추가합니다.</p>
        <label className="flex flex-col gap-xs text-sm">
          추가할 보드
          <select
            className="bg-bg-input text-fg rounded-md p-sm"
            value={target}
            disabled={busy}
            onChange={(event) => setTarget(event.target.value)}
          >
            <option value="new">새 보드 만들기</option>
            {boards.map((board) => (
              <option key={board.id} value={board.id}>
                {board.name}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <p className="text-sm text-error" role="alert">
            {error}
          </p>
        )}
        <button
          type="button"
          className="bg-accent text-accent-fg rounded-lg p-sm text-sm disabled:opacity-50"
          disabled={busy}
          onClick={() => void send()}
        >
          {busy ? '차트 이미지를 만드는 중…' : '보드에 추가'}
        </button>
      </div>
    </ModalShell>
  );
}
