import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAuthedClient, NotAuthenticatedError } from "./auth.js";
import {
  formatGroupedTasksMarkdown,
  getGroupedTasks,
  getTasksInList,
  listTaskLists,
} from "./tasks.js";

type ToolContent = { type: "text"; text: string };
type ToolResult = { content: ToolContent[]; isError?: boolean };

function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

function errorResult(err: unknown): ToolResult {
  if (err instanceof NotAuthenticatedError) {
    return {
      isError: true,
      content: [
        textBlock(
          `Server is not linked to Google yet. Open ${err.authUrl} in a browser and complete the one-time consent, then retry.`,
        ),
      ],
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [textBlock(`Error: ${message}`)] };
}

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "gtasks-mcp", version: "0.1.0" },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
      instructions:
        "Read-only access to the user's Google Tasks. Use `list_tasks` for everything grouped by list, `list_task_lists` for just the list metadata, or `get_tasks_in_list` for a single list's tasks.",
    },
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List all Google Tasks grouped by list",
      description:
        "Returns every task in every Google Tasks list owned by the authenticated user, grouped by list and with subtasks nested under their parent. Returns both a markdown rendering and a JSON payload.",
      inputSchema: {
        include_completed: z
          .boolean()
          .optional()
          .describe("If true, include completed/hidden tasks. Defaults to false."),
      },
    },
    async ({ include_completed }): Promise<ToolResult> => {
      try {
        const auth = await getAuthedClient();
        const grouped = await getGroupedTasks(auth, include_completed ?? false);
        return {
          content: [
            textBlock(formatGroupedTasksMarkdown(grouped)),
            textBlock(JSON.stringify(grouped, null, 2)),
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_task_lists",
    {
      title: "List Google Tasks lists",
      description: "Returns metadata (id, title, updated) for every Google Tasks list.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      try {
        const auth = await getAuthedClient();
        const lists = await listTaskLists(auth);
        return { content: [textBlock(JSON.stringify(lists, null, 2))] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_tasks_in_list",
    {
      title: "Get tasks in a single Google Tasks list",
      description: "Returns the tasks (with subtasks nested) in a single list by id.",
      inputSchema: {
        list_id: z.string().describe("The id of the task list (from list_task_lists)."),
        include_completed: z
          .boolean()
          .optional()
          .describe("If true, include completed/hidden tasks. Defaults to false."),
      },
    },
    async ({ list_id, include_completed }): Promise<ToolResult> => {
      try {
        const auth = await getAuthedClient();
        const tasks = await getTasksInList(auth, list_id, include_completed ?? false);
        return { content: [textBlock(JSON.stringify(tasks, null, 2))] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerResource(
    "task-lists",
    "gtasks://lists",
    { title: "Google Tasks lists", mimeType: "application/json" },
    async (uri) => {
      const auth = await getAuthedClient();
      const lists = await listTaskLists(auth);
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify(lists, null, 2) },
        ],
      };
    },
  );

  server.registerResource(
    "tasks-in-list",
    new ResourceTemplate("gtasks://lists/{listId}/tasks", { list: undefined }),
    { title: "Tasks within a single list", mimeType: "application/json" },
    async (uri, variables) => {
      const auth = await getAuthedClient();
      const listId = String(variables.listId);
      const tasks = await getTasksInList(auth, listId, false);
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify(tasks, null, 2) },
        ],
      };
    },
  );

  return server;
}
