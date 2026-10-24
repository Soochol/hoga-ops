import { Component, type ReactNode } from 'react';

export class BoardEditorBoundary extends Component<
  { children: ReactNode; backup: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="wb-empty" role="alert">
        <h1>편집기를 다시 열어 주세요</h1>
        <p>저장된 보드와 마지막 편집 초안은 유지됩니다.</p>
        <button
          type="button"
          className="wb-action wb-primary"
          onClick={() => this.setState({ failed: false })}
        >
          편집기 다시 열기
        </button>
        <button type="button" className="wb-action" onClick={this.props.backup}>
          현재 편집 파일 백업
        </button>
      </div>
    );
  }
}
