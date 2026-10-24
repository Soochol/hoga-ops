import { useEffect, useRef, useState } from 'react';
import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  convertToExcalidrawElements,
  newElementWith,
  viewportCoordsToSceneCoords,
} from '@excalidraw/excalidraw';
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
import type { BoardSession } from './session';
import { readLocal, writeLocal, type BoardView } from './drafts';
import { fromDataURL, imageFile } from './images';
import { useThemePrefsStore } from '../state/themePrefs';

Object.assign(window, { EXCALIDRAW_ASSET_PATH: '/whiteboard/' });

export interface BoardEditorHandle {
  api: ExcalidrawImperativeAPI;
  addNote: () => void;
  addImages: (files: Blob[], source?: Record<string, unknown>) => Promise<void>;
  cancelImages: () => void;
}

export function BoardEditor({
  session,
  onReady,
  onError,
}: {
  session: BoardSession;
  onReady: (handle: BoardEditorHandle | null) => void;
  onError: (message: string) => void;
}) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [grid, setGrid] = useState(false);
  const preference = useThemePrefsStore((s) => s.themePreference);
  const dark = ['obsidian', 'obsidian-pro', 'toss-dark', 'trading-desk'].includes(preference);
  const viewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const handleRef = useRef<BoardEditorHandle | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const readyRef = useRef(onReady);
  const errorRef = useRef(onError);
  useEffect(() => {
    readyRef.current = onReady;
    errorRef.current = onError;
  }, [onReady, onError]);
  const [initial] = useState(() => ({
    elements: session.elements,
    files: session.files,
    appState: {
      ...session.appState,
      viewBackgroundColor: 'transparent',
      currentItemRoughness: 0,
      currentItemFontFamily: 2,
      currentItemFontSize: 20,
    },
    scrollToContent: false,
  }));

  useEffect(() => {
    if (!api) return;
    let mounted = true,
      imageEpoch = 0;
    const center = () => {
      const state = api.getAppState();
      return viewportCoordsToSceneCoords(
        { clientX: state.offsetLeft + state.width / 2, clientY: state.offsetTop + state.height / 2 },
        state,
      );
    };
    const addNote = () => {
      const { x, y } = center();
      const elements = convertToExcalidrawElements([
        {
          type: 'rectangle',
          x: x - 130,
          y: y - 85,
          width: 260,
          height: 170,
          backgroundColor: '#e9edcf',
          strokeColor: '#c5c9af',
          fillStyle: 'solid',
          roughness: 0,
          roundness: { type: 3, value: 6 },
          label: {
            text: '새 메모\n\n여기에 내용을 적어보세요',
            fontSize: 20,
            fontFamily: 2,
            strokeColor: '#1e1e1e',
            textAlign: 'left',
            verticalAlign: 'top',
          },
          customData: { kind: 'note' },
        },
      ]);
      api.updateScene({
        elements: [...api.getSceneElementsIncludingDeleted(), ...elements],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        appState: { selectedElementIds: { [elements[0].id]: true } },
      });
      api.setActiveTool({ type: 'selection' });
    };
    const addImages = async (blobs: Blob[], source?: Record<string, unknown>) => {
      const epoch = ++imageEpoch;
      const errors: string[] = [];
      for (let index = 0; index < blobs.length; index++) {
        try {
          const image = await imageFile(blobs[index]);
          if (epoch !== imageEpoch) break;
          const { x, y } = center();
          const width = Math.min(560, image.width),
            height = (image.height * width) / image.width;
          const elements = convertToExcalidrawElements([
            {
              type: 'image',
              x: x - width / 2 + index * 24,
              y: y - height / 2 + index * 24,
              width,
              height,
              fileId: image.file.id,
              status: 'saved',
              scale: [1, 1],
              customData: source ? { chartSource: source } : undefined,
              link: typeof source?.url === 'string' ? source.url : null,
            },
          ]);
          if (mounted) {
            api.addFiles([image.file]);
            api.updateScene({
              elements: [...api.getSceneElementsIncludingDeleted(), ...elements],
              captureUpdate: CaptureUpdateAction.IMMEDIATELY,
              appState: { selectedElementIds: { [elements[0].id]: true } },
            });
          } else {
            session.change([...session.elements, ...elements], api.getAppState() as AppState, {
              ...session.files,
              [image.file.id]: image.file,
            });
            void session.persistDraft();
          }
        } catch (error) {
          errors.push(`${index + 1}번 이미지: ${error instanceof Error ? error.message : '불러오기 실패'}`);
        }
      }
      if (mounted) api.setActiveTool({ type: 'selection' });
      if (errors.length) errorRef.current(errors.join(' · '));
    };
    handleRef.current = {
      api,
      addNote,
      addImages,
      cancelImages: () => {
        imageEpoch++;
      },
    };
    readyRef.current(handleRef.current);
    const observer = new ResizeObserver(() => api.refresh());
    if (surfaceRef.current) observer.observe(surfaceRef.current);
    void readLocal<BoardView>(session.key + ':view')
      .then((view) => {
        if (
          mounted &&
          view &&
          typeof view.scrollX === 'number' &&
          typeof view.scrollY === 'number' &&
          typeof view.zoom?.value === 'number'
        ) {
          api.updateScene({ appState: view, captureUpdate: CaptureUpdateAction.NEVER });
        }
      })
      .catch(() => {});
    return () => {
      observer.disconnect();
      mounted = false;
      handleRef.current = null;
      readyRef.current(null);
    };
  }, [api, session]);

  useEffect(
    () => () => {
      clearTimeout(viewTimer.current);
      void session.persistDraft();
      void session.flush();
    },
    [session],
  );

  return (
    <div
      ref={surfaceRef}
      className="wb-editor"
      data-prevent-shortcuts
      data-testid="whiteboard-editor"
      data-board-id={session.document.id}
      onKeyDownCapture={(event) => {
        if (!api || !['Delete', 'Backspace'].includes(event.key)) return;
        const target = event.target as HTMLElement;
        if (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
        const state = api.getAppState(), elements = api.getSceneElementsIncludingDeleted();
        const selected = elements.filter(el => state.selectedElementIds[el.id]
          || el.groupIds.some(id => state.selectedGroupIds[id])
          || (el.type === 'text' && el.containerId && state.selectedElementIds[el.containerId]));
        if (!selected.some(el => el.locked)) return;
        event.preventDefault(); event.stopPropagation();
        const deletable = new Set(selected.filter(el => !el.locked).map(el => el.id));
        if (!deletable.size) return;
        api.updateScene({ elements: elements.map(el => deletable.has(el.id) ? newElementWith(el, { isDeleted: true }) : el), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      }}
      onKeyDown={(event) => {
        if (event.key === '?' || event.key === '/' || event.key === 'Delete' || event.key === 'Backspace')
          event.stopPropagation();
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDropCapture={(event) => {
        const files = [...event.dataTransfer.files];
        if (!files.length) return;
        event.preventDefault();
        event.stopPropagation();
        void handleRef.current?.addImages(files);
      }}
    >
      <Excalidraw
        key={session.document.id}
        excalidrawAPI={setApi}
        initialData={initial}
        langCode="ko-KR"
        theme={dark ? 'dark' : 'light'}
        name={session.state.name}
        gridModeEnabled={grid}
        handleKeyboardGlobally={false}
        aiEnabled={false}
        validateEmbeddable={false}
        generateIdForFile={(file) => imageFile(file).then(image => image.file.id)}
        UIOptions={{
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            export: false,
            saveAsImage: false,
            toggleTheme: false,
            clearCanvas: false,
            changeViewBackgroundColor: false,
          },
        }}
        onChange={(elements, state, files) => session.change(elements, state, files)}
        onScrollChange={(scrollX, scrollY, zoom) => {
          const surface = surfaceRef.current;
          if (surface) {
            const size = 20 * zoom.value;
            surface.style.backgroundSize = `${size}px ${size}px`;
            surface.style.backgroundPosition = `${scrollX * zoom.value}px ${scrollY * zoom.value}px`;
          }
          clearTimeout(viewTimer.current);
          viewTimer.current = setTimeout(() => {
            void writeLocal(session.key + ':view', { scrollX, scrollY, zoom }).catch(() => {});
          }, 300);
        }}
        onPaste={async (data, event) => {
          if (event?.clipboardData?.files.length) {
            void handleRef.current?.addImages([...event.clipboardData.files]);
            return false;
          }
          if (!data.files) return true;
          try {
            await Promise.all(Object.values(data.files).map((file) => imageFile(fromDataURL(file.dataURL))));
            return true;
          } catch (error) {
            errorRef.current(error instanceof Error ? error.message : '이미지를 붙여넣지 못했습니다');
            return false;
          }
        }}
      >
        <MainMenu>
          <MainMenu.Item onSelect={() => api?.scrollToContent(undefined, { fitToContent: true })}>
            전체 보기
          </MainMenu.Item>
          <MainMenu.Item onSelect={() => setGrid((value) => !value)}>
            {grid ? '격자 숨기기' : '격자 보기'}
          </MainMenu.Item>
          <MainMenu.DefaultItems.Help />
        </MainMenu>
      </Excalidraw>
    </div>
  );
}
