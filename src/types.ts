export interface Task {
  id: string;
  title: string;
  notes?: string;
  due?: string;
  status: "needsAction" | "completed";
  completed?: string;
  parent?: string;
  position: string;
  children: Task[];
}

export interface TaskListGroup {
  id: string;
  title: string;
  updated?: string;
  tasks: Task[];
}

export interface GroupedTasks {
  fetchedAt: string;
  lists: TaskListGroup[];
}
