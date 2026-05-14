import { google, tasks_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { GroupedTasks, Task, TaskListGroup } from "./types.js";

function tasksApi(auth: OAuth2Client): tasks_v1.Tasks {
  return google.tasks({ version: "v1", auth });
}

export async function listTaskLists(auth: OAuth2Client): Promise<{ id: string; title: string; updated?: string }[]> {
  const api = tasksApi(auth);
  const out: { id: string; title: string; updated?: string }[] = [];
  let pageToken: string | undefined;
  do {
    const res = await api.tasklists.list({ maxResults: 100, pageToken });
    for (const item of res.data.items ?? []) {
      if (!item.id || !item.title) continue;
      out.push({ id: item.id, title: item.title, updated: item.updated ?? undefined });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

async function listAllTasksInList(
  auth: OAuth2Client,
  tasklistId: string,
  includeCompleted: boolean,
): Promise<tasks_v1.Schema$Task[]> {
  const api = tasksApi(auth);
  const out: tasks_v1.Schema$Task[] = [];
  let pageToken: string | undefined;
  do {
    const res = await api.tasks.list({
      tasklist: tasklistId,
      maxResults: 100,
      showCompleted: includeCompleted,
      showHidden: includeCompleted,
      pageToken,
    });
    out.push(...(res.data.items ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

function buildHierarchy(flat: tasks_v1.Schema$Task[]): Task[] {
  const byId = new Map<string, Task>();
  for (const t of flat) {
    if (!t.id || !t.title) continue;
    byId.set(t.id, {
      id: t.id,
      title: t.title,
      notes: t.notes ?? undefined,
      due: t.due ?? undefined,
      status: (t.status === "completed" ? "completed" : "needsAction") as Task["status"],
      completed: t.completed ?? undefined,
      parent: t.parent ?? undefined,
      position: t.position ?? "",
      children: [],
    });
  }
  const roots: Task[] = [];
  for (const task of byId.values()) {
    if (task.parent && byId.has(task.parent)) {
      byId.get(task.parent)!.children.push(task);
    } else {
      roots.push(task);
    }
  }
  const sortRec = (arr: Task[]) => {
    arr.sort((a, b) => a.position.localeCompare(b.position));
    for (const t of arr) sortRec(t.children);
  };
  sortRec(roots);
  return roots;
}

export async function getTasksInList(
  auth: OAuth2Client,
  tasklistId: string,
  includeCompleted = false,
): Promise<Task[]> {
  const flat = await listAllTasksInList(auth, tasklistId, includeCompleted);
  return buildHierarchy(flat);
}

export async function getGroupedTasks(
  auth: OAuth2Client,
  includeCompleted = false,
): Promise<GroupedTasks> {
  const lists = await listTaskLists(auth);
  const groups = await Promise.all(
    lists.map(async (l): Promise<TaskListGroup> => {
      const tasks = await getTasksInList(auth, l.id, includeCompleted);
      return { id: l.id, title: l.title, updated: l.updated, tasks };
    }),
  );
  return { fetchedAt: new Date().toISOString(), lists: groups };
}

function formatDue(due: string | undefined): string {
  if (!due) return "";
  const d = due.slice(0, 10);
  return ` (due ${d})`;
}

function renderTask(t: Task, depth: number): string {
  const indent = "  ".repeat(depth);
  const box = t.status === "completed" ? "[x]" : "[ ]";
  let line = `${indent}- ${box} ${t.title}${formatDue(t.due)}`;
  if (t.notes) {
    const noteIndent = "  ".repeat(depth + 1);
    const notes = t.notes
      .split("\n")
      .map((n) => `${noteIndent}_${n}_`)
      .join("\n");
    line += `\n${notes}`;
  }
  for (const c of t.children) line += `\n${renderTask(c, depth + 1)}`;
  return line;
}

export function formatGroupedTasksMarkdown(grouped: GroupedTasks): string {
  if (grouped.lists.length === 0) return "_No task lists found._";
  const sections = grouped.lists.map((list) => {
    const header = `## ${list.title}`;
    if (list.tasks.length === 0) return `${header}\n_(empty)_`;
    const body = list.tasks.map((t) => renderTask(t, 0)).join("\n");
    return `${header}\n${body}`;
  });
  return sections.join("\n\n");
}
