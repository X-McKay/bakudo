import type { TaskMode } from "../protocol.js";
import {
  blue,
  bold,
  dim,
  gray,
  mergeColumns,
  overviewPanelLines,
  renderApprovalChip,
  renderBox,
  renderModeChip,
  stripAnsi,
} from "./ansi.js";
import { getBaseStdout } from "./io.js";

const runtimeProcess = (
  globalThis as unknown as {
    process?: {
      stdout?: { isTTY?: boolean; columns?: number };
      env?: Record<string, string | undefined>;
    };
  }
).process;

export type InteractiveShellState = {
  currentMode: TaskMode;
  autoApprove: boolean;
  lastSessionId?: string;
  lastTaskId?: string;
};

export class InteractiveDashboard {
  public constructor(private readonly getState: () => InteractiveShellState) {}

  private panelTitle = "Overview";
  private panelLines: string[] = overviewPanelLines();
  private activityLines: string[] = [];

  public setPanel(title: string, lines: string[]): void {
    this.panelTitle = title;
    this.panelLines = lines.length > 0 ? lines : [dim("No details available.")];
  }

  public appendActivity(line: string): void {
    const trimmed = line.replace(/\r/g, "").trimEnd();
    if (trimmed.length === 0) {
      return;
    }
    this.activityLines.push(trimmed);
    this.activityLines = this.activityLines.slice(-12);
  }

  public note(line: string): void {
    this.appendActivity(line);
  }

  public snapshotActivity(): string[] {
    return [...this.activityLines];
  }

  public restoreActivity(lines: string[]): void {
    this.activityLines = [...lines].slice(-12);
  }

  public render(): void {
    if (runtimeProcess?.stdout?.isTTY !== true) {
      return;
    }

    const state = this.getState();
    const focusSession = state.lastSessionId ?? "no session";
    const focusTask = state.lastTaskId ?? "no task";
    const terminalWidth = runtimeProcess?.stdout?.columns ?? 100;
    const panelContent = this.panelLines.length > 0 ? this.panelLines : [dim("No panel content.")];
    const activityContent =
      this.activityLines.length > 0 ? this.activityLines : [dim("No recent activity yet.")];
    const summaryLines = [
      `Mode: ${stripAnsi(renderModeChip(state.currentMode))}`,
      `Approval: ${stripAnsi(renderApprovalChip(state.autoApprove))}`,
      `Session: ${focusSession}`,
      `Task: ${focusTask}`,
    ];

    let body: string[];
    if (terminalWidth >= 110) {
      const leftWidth = Math.max(42, Math.floor((terminalWidth - 2) * 0.42));
      const rightWidth = Math.max(42, terminalWidth - leftWidth - 2);
      const leftBox = renderBox(this.panelTitle, [...summaryLines, "", ...panelContent], leftWidth);
      const rightBox = renderBox("Recent Activity", activityContent, rightWidth);
      body = mergeColumns(leftBox, rightBox);
    } else {
      body = [
        ...renderBox(
          this.panelTitle,
          [...summaryLines, "", ...panelContent],
          Math.max(40, terminalWidth),
        ),
        "",
        ...renderBox("Recent Activity", activityContent, Math.max(40, terminalWidth)),
      ];
    }

    const lines = [
      bold(blue("Bakudo")),
      dim("abox host control plane"),
      `${renderModeChip(state.currentMode)} ${renderApprovalChip(state.autoApprove)} ${gray(focusSession)}`,
      "",
      ...body,
      "",
      dim("Commands: /plan /build /status /review /sandbox /clear /exit"),
      "",
    ];
    void getBaseStdout().write("\x1Bc");
    void getBaseStdout().write(`${lines.join("\n")}\n`);
  }
}
