import { ArrowUpRight } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { formatPlanRange, recordStateText, riskText, statusText } from '../format';
import type { Task } from '../types';

type Props = {
  tasks: Task[];
  emptyText?: string;
  compact?: boolean;
};

export default function TaskTable({ tasks, emptyText = '这里还没有任务。', compact = false }: Props) {
  const [, setSearchParams] = useSearchParams();

  if (!tasks.length) {
    return <div className="empty-state">{emptyText}</div>;
  }

  return (
    <div className={'task-table-wrap ' + (compact ? 'task-table-compact' : '')}>
      <table className="task-table">
        <thead>
          <tr>
            <th>任务</th>
            <th>谁向我提出</th>
            <th>状态</th>
            <th>我的计划</th>
            <th>风险</th>
            <th aria-label="详情" />
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.id} onClick={() => setSearchParams({ task: task.id })} tabIndex={0}>
              <td>
                <strong className="task-title">{task.title}{task.record_state === 'invalidated' && <span className="record-state-badge">{recordStateText.invalidated}</span>}{task.deleted_at && <span className="record-state-badge record-state-deleted">回收站</span>}</strong>
                <span className="task-describe">{task.describe}</span>
              </td>
              <td>{task.proposer_name}</td>
              <td><span className={'status-text status-' + task.status}>{statusText[task.status]}</span></td>
              <td>{formatPlanRange(task.planned_start_at, task.planned_due_at)}</td>
              <td><span className={'risk risk-' + task.risk}><i />{riskText[task.risk]}</span></td>
              <td><ArrowUpRight size={17} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
