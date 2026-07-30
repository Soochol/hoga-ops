import { create } from 'zustand';

/** 장부에 누적될 수 있는 보류 종목 표시 상한 — 병리적 재시도 루프에서도 유계로 둔다. */
export const MAX_TRACKED_PENDING_CODES = 20;

interface Store {
  /** 만석으로 등록이 보류된 종목들(중복 없음, 도착 순서 유지). */
  pendingCodes: string[];
  /** 사용자가 토스트를 닫았는가. 새 종목이 보고되면 다시 열린다. */
  toastDismissed: boolean;
  notifyFullHouse: (code: string) => void;
  dismissToast: () => void;
  /** WS 재연결 시 호출 — 재구독으로 백엔드가 다시 판정하므로 stale 보류 목록을 버린다. */
  clear: () => void;
}

export const useKiwoomFullHouseStore = create<Store>((set, get) => ({
  pendingCodes: [],
  toastDismissed: false,

  notifyFullHouse: (code: string) => {
    const { pendingCodes } = get();
    if (pendingCodes.includes(code)) {
      // 같은 종목의 반복 보고(재연결 재구독 등)는 새 사실이 아니다 — 닫은 토스트를
      // 다시 열지 않는다. 열려 있으면 그대로 유지된다.
      return;
    }
    set({
      pendingCodes: [...pendingCodes, code].slice(-MAX_TRACKED_PENDING_CODES),
      // 새 종목은 새 사실이므로 닫혀 있었어도 다시 알린다.
      toastDismissed: false,
    });
  },

  dismissToast: () => set({ toastDismissed: true }),

  clear: () => set({ pendingCodes: [], toastDismissed: false }),
}));
