export interface DashboardObservation {
  time: number;
  parents: number;
  children: number;
  gap: boolean;
}

export interface DashboardHistoryPoint extends DashboardObservation {
  /** More than one stored observation falls in this display bucket. */
  summarized: boolean;
  /** At least one unobserved interval intersects this display bucket. */
  containsGap: boolean;
}

export interface DashboardHistoryView {
  first: number | null;
  last: number | null;
  closedCount: number;
  points: DashboardHistoryPoint[];
}

export interface DashboardHistoryCursor { time: number; id: number }
export interface DashboardHistoryPage {
  observations: (DashboardObservation & { id: number })[];
  next: DashboardHistoryCursor | null;
}
