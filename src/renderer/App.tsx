// Kök bileşen (03/01): köprüyü başlatır, kabuğu panellerle doldurur.
import { useEffect } from 'react';
import { DetailPanel } from './components/detail/DetailPanel';
import { Header } from './components/Header';
import { SessionLogPanel } from './components/log/SessionLogPanel';
import { MapView } from './components/MapView';
import { Shell } from './components/Shell';
import { SettingsPanel } from './components/SettingsPanel';
import { TerminalDock, TerminalPeek } from './components/terminal/TerminalDock';
import { ToastHost } from './components/ToastHost';
import { WorkersPanel } from './components/WorkersPanel';
import { initBoardBridge } from './state/bridge';
import { initSettingsBridge } from './state/settings';
import { initTerminalBridge } from './state/terminals';

export function App() {
  useEffect(() => initBoardBridge(), []);
  useEffect(() => initSettingsBridge(), []);
  useEffect(() => initTerminalBridge(), []);
  return (
    <>
      <Shell
        header={<Header />}
        detail={<DetailPanel />}
        workers={<WorkersPanel />}
        map={<MapView />}
        log={<SessionLogPanel />}
        dock={<TerminalDock />}
      />
      <TerminalPeek />
      <SettingsPanel />
      <ToastHost />
    </>
  );
}
