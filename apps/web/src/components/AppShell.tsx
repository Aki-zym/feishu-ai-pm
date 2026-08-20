import { useEffect, useState } from 'react';
import {
  Archive,
  Bot,
  CalendarDays,
  CheckSquare2,
  Inbox,
  LayoutDashboard,
  Menu,
  ScrollText,
  Settings,
  X,
} from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import TaskDrawer from './TaskDrawer';
import { desktopBridge } from '../desktop';
import { externalLinkFeedbackMessage } from '../external-links';

const navigation = [
  { to: '/', label: '工作台', icon: LayoutDashboard, end: true },
  { to: '/candidates', label: '候选收件箱', icon: Inbox },
  { to: '/tasks', label: '全部任务', icon: CheckSquare2 },
  { to: '/calendar', label: '排期日历', icon: CalendarDays },
  { to: '/archive', label: '归档与回收站', icon: Archive },
  { to: '/settings', label: '集成设置', icon: Settings },
  { to: '/logs', label: '日志与纠错', icon: ScrollText },
];

export default function AppShell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [externalLinkNotice, setExternalLinkNotice] = useState<{ error: boolean; message: string } | null>(null);
  useEffect(() => desktopBridge()?.externalLinks?.onResult((result) => {
    setExternalLinkNotice({ error: !result.opened, message: externalLinkFeedbackMessage(result) });
  }), []);
  return (
    <div className="app-shell">
      <header className="mobile-header">
        <button className="icon-button" aria-label="打开导航" onClick={() => setMenuOpen(true)}>
          <Menu size={20} />
        </button>
        <div className="brand brand-mobile">
          <span className="brand-mark"><Bot size={18} /></span>
          <span>数据 PM</span>
        </div>
      </header>

      <aside className={'sidebar ' + (menuOpen ? 'sidebar-open' : '')}>
        <div className="sidebar-top">
          <div className="brand">
            <span className="brand-mark"><Bot size={19} /></span>
            <span>数据 PM</span>
          </div>
          <button className="icon-button mobile-close" aria-label="关闭导航" onClick={() => setMenuOpen(false)}>
            <X size={20} />
          </button>
        </div>
        <nav className="primary-nav" aria-label="主要导航">
          {navigation.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={() => setMenuOpen(false)}
              className={({ isActive }) => 'nav-item ' + (isActive ? 'nav-item-active' : '')}
            >
              <Icon size={18} strokeWidth={1.8} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="status-dot status-dot-safe" />
          <span>本地 PM · 外部连接按设置启用</span>
        </div>
        <div className="profile-row">
          <span className="avatar">我</span>
          <div>
            <strong>系统主人</strong>
            <small>私人工作台</small>
          </div>
        </div>
      </aside>

      {menuOpen && <button className="sidebar-backdrop" aria-label="关闭导航" onClick={() => setMenuOpen(false)} />}
      {externalLinkNotice && <div className={`external-link-notice ${externalLinkNotice.error ? 'external-link-notice-error' : ''}`} role={externalLinkNotice.error ? 'alert' : 'status'}>
        <span>{externalLinkNotice.message}</span>
        <button type="button" aria-label="关闭链接提示" onClick={() => setExternalLinkNotice(null)}><X size={15} /></button>
      </div>}
      <main className="main-content"><Outlet /></main>
      <TaskDrawer />
    </div>
  );
}
