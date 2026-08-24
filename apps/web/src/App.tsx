import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import AppShell from './components/AppShell';
import { desktopBridge, type PublicDesktopConfig } from './desktop';
import ArchivePage from './pages/ArchivePage';
import CalendarPage from './pages/CalendarPage';
import CandidatesPage from './pages/CandidatesPage';
import DashboardPage from './pages/DashboardPage';
import SettingsPage from './pages/SettingsPage';
import LogsPage from './pages/LogsPage';
import SetupPage from './pages/SetupPage';
import TasksPage from './pages/TasksPage';

export default function App() {
  const desktop = desktopBridge();
  const [desktopConfig, setDesktopConfig] = useState<PublicDesktopConfig | null>(null);
  const [startupError, setStartupError] = useState('');

  useEffect(() => {
    if (!desktop) return;
    desktop.config.get().then(setDesktopConfig).catch((reason: Error) => setStartupError(reason.message));
  }, [desktop]);

  if (desktop && startupError) {
    return <main className="setup-page"><div className="error-banner">无法读取本地安全配置：{startupError}</div></main>;
  }
  if (desktop && !desktopConfig) {
    return <main className="setup-page"><div className="loading-state">正在打开 TooManyTasks…</div></main>;
  }
  if (desktopConfig && !desktopConfig.setupComplete) {
    return <SetupPage initial={desktopConfig} />;
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="candidates" element={<CandidatesPage />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="calendar" element={<CalendarPage />} />
        <Route path="archive" element={<ArchivePage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
