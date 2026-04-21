/**
 * Sidebar — Collapsible right panel for the Cognitive Meta-Orchestrator TUI.
 *
 * Design principles (inspired by Claude Code, Codex, Open Code):
 * - GitHub-dark color palette: bg #161b22, border #30363d, text #c9d1d9
 * - Minimal borders, generous whitespace, hierarchy from spacing + color
 * - Indented detail lines for campaign tree and agent status
 * - Width: 38 columns when visible, 0 when hidden (controlled by store)
 *
 * Sections (in priority order):
 * 1. Active Objective — goal text (truncated) + status badge
 * 2. Campaign Tree — list with status icons
 * 3. Git Mutex — locked / unlocked indicator
 * 4. Last Verdict — Critic/Synthesizer one-liner
 *
 * Toggle: Tab key in Composer dispatches `toggle_sidebar`.
 */

import React from "react";
import { Box, Text } from "ink";
import type { Objective } from "../../orchestration/objectiveState.js";
import { useAppState } from "./hooks/useAppState.js";

// ---------------------------------------------------------------------------
// GitHub-dark palette constants
// ---------------------------------------------------------------------------

/** Ink supports named colors and hex strings. */
const GH = {
  border: "#30363d",
  text: "#c9d1d9",
  dim: "#8b949e",
  green: "#3fb950",
  red: "#f85149",
  yellow: "#d29922",
  blue: "#58a6ff",
  purple: "#bc8cff",
  orange: "#e3b341",
} as const;

// ---------------------------------------------------------------------------
// Status icons and colors
// ---------------------------------------------------------------------------

type CampaignStatus = "pending" | "running" | "completed" | "failed" | string;

const campaignIcon = (status: CampaignStatus): { symbol: string; color: string } => {
  switch (status) {
    case "pending":
      return { symbol: "⏳", color: GH.dim };
    case "running":
      return { symbol: "▶", color: GH.blue };
    case "completed":
      return { symbol: "✓", color: GH.green };
    case "failed":
      return { symbol: "✗", color: GH.red };
    default:
      return { symbol: "·", color: GH.dim };
  }
};

const objectiveStatusColor = (status: string): string => {
  switch (status) {
    case "active":
      return GH.blue;
    case "completed":
      return GH.green;
    case "failed":
      return GH.red;
    case "paused":
      return GH.yellow;
    default:
      return GH.dim;
  }
};

// ---------------------------------------------------------------------------
// Truncation helper
// ---------------------------------------------------------------------------

const truncate = (text: string, maxLen: number): string => {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Horizontal divider line using the GitHub-dark border color. */
const Divider = () => (
  <Box>
    <Text color={GH.border}>{"─".repeat(36)}</Text>
  </Box>
);

/** Section header with dim label. */
const SectionHeader = ({ label }: { label: string }) => (
  <Box>
    <Text color={GH.dim} bold>
      {label.toUpperCase()}
    </Text>
  </Box>
);

/** Renders a single Objective with its status badge. */
const ObjectiveRow = ({ objective }: { objective: Objective }) => {
  const statusColor = objectiveStatusColor(objective.status);
  const goalText = truncate(objective.goal, 30);
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text color={statusColor} bold>
          {"●"}
        </Text>
        <Text color={GH.text}>{goalText}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text color={statusColor}>{objective.status}</Text>
        <Text color={GH.dim}>{`  ${objective.campaigns.length} campaign${objective.campaigns.length !== 1 ? "s" : ""}`}</Text>
      </Box>
    </Box>
  );
};

/** Renders the campaign tree for a single Objective. */
const CampaignTree = ({ objective }: { objective: Objective }) => {
  if (objective.campaigns.length === 0) {
    return (
      <Box marginLeft={2}>
        <Text color={GH.dim}>{"(decomposing…)"}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {objective.campaigns.map((campaign) => {
        const { symbol, color } = campaignIcon(campaign.status);
        const label = truncate(campaign.description, 28);
        return (
          <Box key={campaign.campaignId} flexDirection="column">
            <Box flexDirection="row" gap={1} marginLeft={1}>
              <Text color={color}>{symbol}</Text>
              <Text color={GH.text}>{label}</Text>
            </Box>
            {campaign.needsManualReview === true && (
              <Box marginLeft={4}>
                <Text color={GH.orange}>{"⚠ manual review required"}</Text>
              </Box>
            )}
            {campaign.winnerCandidateId !== undefined && campaign.status === "completed" && (
              <Box marginLeft={4}>
                <Text color={GH.dim}>{`winner: ${truncate(campaign.winnerCandidateId, 20)}`}</Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
};

/** Git mutex indicator. */
const GitMutexRow = ({ locked }: { locked: boolean }) => (
  <Box flexDirection="row" gap={1}>
    <Text color={locked ? GH.yellow : GH.green}>{locked ? "⚿" : "○"}</Text>
    <Text color={GH.dim}>{locked ? "git mutex locked" : "git mutex free"}</Text>
  </Box>
);

/** Last Critic/Synthesizer verdict. */
const VerdictRow = ({ verdict }: { verdict: string }) => (
  <Box flexDirection="column">
    <Box marginLeft={1}>
      <Text color={GH.purple}>{truncate(verdict, 34)}</Text>
    </Box>
  </Box>
);

// ---------------------------------------------------------------------------
// Main Sidebar component
// ---------------------------------------------------------------------------

/**
 * Collapsible sidebar showing the Cognitive Meta-Orchestrator live state.
 * Width is 38 columns when visible, 0 when hidden.
 */
export const Sidebar = () => {
  const orchestrator = useAppState((s) => s.orchestrator);

  if (!orchestrator.sidebarVisible) {
    return null;
  }

  // Find the active objective (the one currently being driven).
  const activeObjective = orchestrator.activeCampaignId
    ? orchestrator.objectives.find((o) => o.objectiveId === orchestrator.activeCampaignId)
    : orchestrator.objectives[0];

  return (
    <Box
      flexDirection="column"
      width={38}
      borderStyle="single"
      borderColor={GH.border}
      paddingX={1}
      paddingY={0}
    >
      {/* Header */}
      <Box>
        <Text color={GH.blue} bold>
          {"Orchestrator"}
        </Text>
      </Box>

      <Divider />

      {/* Section 1: Active Objective */}
      <SectionHeader label="Objective" />
      {activeObjective !== undefined ? (
        <ObjectiveRow objective={activeObjective} />
      ) : (
        <Box marginLeft={2}>
          <Text color={GH.dim}>{"(no active objective)"}</Text>
        </Box>
      )}

      <Box height={1} />

      {/* Section 2: Campaign Tree */}
      {activeObjective !== undefined && (
        <>
          <SectionHeader label="Campaigns" />
          <CampaignTree objective={activeObjective} />
          <Box height={1} />
        </>
      )}

      {/* Section 3: Git Mutex */}
      <SectionHeader label="Git Mutex" />
      <GitMutexRow locked={orchestrator.gitMutexLocked} />

      <Box height={1} />

      {/* Section 4: Last Verdict */}
      {orchestrator.lastVerdict !== undefined && (
        <>
          <SectionHeader label="Last Verdict" />
          <VerdictRow verdict={orchestrator.lastVerdict} />
          <Box height={1} />
        </>
      )}

      {/* Footer hint */}
      <Divider />
      <Box>
        <Text color={GH.dim}>{"[Tab] toggle sidebar"}</Text>
      </Box>
    </Box>
  );
};
