export default function Capture() {
  return (
    <div className="p-8 max-w-2xl space-y-3 text-sm">
      <h2 className="text-md font-semibold">Capture <span className="text-fg-dim font-normal">(v1+1 예정)</span></h2>
      <p className="text-fg-dim">지금은 외부 콜렉터 CLI 사용:</p>
      <pre className="bg-bg-card border rounded p-3 font-mono text-xs">
$ hoga capture --code 005930 --date 20260520
      </pre>
      <p className="text-fg-dim mt-3">
        캡처 완료 후 자동으로 좌측 nav의 Inventory에 반영됩니다.
      </p>
    </div>
  );
}
