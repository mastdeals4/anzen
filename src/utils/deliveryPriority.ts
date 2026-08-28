export type DeliveryQueuePriority = 'overdue' | 'today' | 'tomorrow' | 'upcoming';

export function getWarehouseDeliveryPriority(expectedDeliveryDate: string, today = new Date()): DeliveryQueuePriority {
  const startOfToday = new Date(today);
  startOfToday.setHours(0, 0, 0, 0);
  const dueDate = new Date(`${expectedDeliveryDate}T00:00:00`);
  const daysUntilDue = Math.ceil((dueDate.getTime() - startOfToday.getTime()) / 86400000);
  return daysUntilDue < 0 ? 'overdue' : daysUntilDue === 0 ? 'today' : daysUntilDue === 1 ? 'tomorrow' : 'upcoming';
}
