import { Circle, TrendingUp, Clock, CheckCircle, XCircle, PauseCircle } from 'lucide-react';

interface PipelineStatusBadgeProps {
  status: string;
  compact?: boolean;
}

const statusConfig = {
  new: {
    label: 'New',
    color: 'bg-gray-100 text-gray-700 border-gray-300',
    icon: Circle,
  },
  in_progress: {
    label: 'In Progress',
    color: 'bg-blue-100 text-blue-700 border-blue-300',
    icon: TrendingUp,
  },
  follow_up: {
    label: 'Follow Up',
    color: 'bg-purple-100 text-purple-700 border-purple-300',
    icon: Clock,
  },
  won: {
    label: 'Won',
    color: 'bg-green-100 text-green-700 border-green-300',
    icon: CheckCircle,
  },
  lost: {
    label: 'Lost',
    color: 'bg-red-100 text-red-700 border-red-300',
    icon: XCircle,
  },
  on_hold: {
    label: 'On Hold',
    color: 'bg-yellow-100 text-yellow-700 border-yellow-300',
    icon: PauseCircle,
  },
};

export function PipelineStatusBadge({ status, compact = false }: PipelineStatusBadgeProps) {
  const config = statusConfig[status as keyof typeof statusConfig] || statusConfig.new;
  const Icon = config.icon;

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium border ${config.color}`}>
      <Icon className="w-3 h-3" />
      {!compact && config.label}
    </span>
  );
}

export const pipelineStatusOptions = [
  { value: 'new', label: 'New' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'follow_up', label: 'Follow Up' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
  { value: 'on_hold', label: 'On Hold' },
];
