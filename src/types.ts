export type TaskStatus = 'Done' | 'In Progress' | 'Not Started';
export type BugStatus = 'Fixed' | 'Open' | 'Retest';

export interface QAMember {
  id: string;
  name: string;
  initials: string;
  avatar_bg: string;
  team_name?: string;
  
  checklist: CycleTask[];
  bugs: CycleBug[];
  progress: number;
  lastActive?: Date;
}

export interface CycleTask {
  id: string;
  cycle_id: string;
  member_id: string;
  task_name: string;
  status: TaskStatus;
  updated_at?: string;
}

export interface CycleBug {
  id: string;
  cycle_id: string;
  member_id: string;
  title: string;
  jira_key: string | null;
  status: BugStatus;
  created_at?: string;
}

export interface RegressionCycle {
  id: string;
  start_date: string;
  end_date: string;
  is_active: boolean;
}
