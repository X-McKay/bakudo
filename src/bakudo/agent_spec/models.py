"""Pydantic models mirroring ``schemas/agent-spec.schema.json``.

The models give us ergonomic, typed access in Python; the JSON Schema remains
the cross-language source of truth. :func:`bakudo.agent_spec.loader.parse_spec`
validates against the schema *and* parses into these models.
"""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class RoleType(str, Enum):
    explore = "explore"
    add_feature = "add-feature"
    qa = "qa"
    critic = "critic"
    eval_author = "eval-author"
    skill_curator = "skill-curator"
    memory_curator = "memory-curator"
    release_manager = "release-manager"
    optimize_scout = "optimize-scout"
    optimize_attempt = "optimize-attempt"


class SpecStatus(str, Enum):
    candidate = "candidate"
    canary = "canary"
    active = "active"
    archived = "archived"


class NetworkMode(str, Enum):
    none = "none"
    scoped = "scoped"
    open = "open"


class Metadata(_Strict):
    name: str
    version: int = Field(ge=1)
    status: SpecStatus
    owner: str = "meta-agent"
    parent_version: int | None = Field(default=None, alias="parentVersion", ge=1)
    created_at: str | None = Field(default=None, alias="createdAt")


class Role(_Strict):
    type: RoleType
    description: str = ""


class ModelConfig(_Strict):
    provider: str
    model_id: str = Field(alias="modelId")
    base_url_ref: str | None = Field(default=None, alias="baseUrlRef")
    temperature: float = Field(default=0.2, ge=0.0, le=2.0)
    max_tokens: int = Field(default=8192, alias="maxTokens", ge=1)
    # None = server default. False turns off the thinking stream for hybrid
    # reasoning models (Qwen `chat_template_kwargs.enable_thinking`) — used by
    # structured-output roles whose deliberation otherwise eats the budget.
    enable_thinking: bool | None = Field(default=None, alias="enableThinking")


class SandboxConfig(_Strict):
    provider: str = "abox"
    profile: str
    base_ref: str = Field(default="main", alias="baseRef")
    network_mode: NetworkMode = Field(default=NetworkMode.scoped, alias="networkMode")
    network_bundles: list[str] = Field(default_factory=list, alias="networkBundles")
    # Upper bound keeps spec timeout + the abox setup/kill headroom inside the
    # run_sandbox activity's start_to_close_timeout (workflows._SANDBOX) — an
    # unbounded spec would let Temporal kill the activity mid-run with no
    # result while the microVM keeps executing.
    timeout_seconds: int = Field(
        default=3600, alias="timeoutSeconds", ge=1, le=10_800
    )
    ephemeral: bool = False
    max_changed_files: int | None = Field(default=None, alias="maxChangedFiles", ge=0)
    max_diff_bytes: int | None = Field(default=None, alias="maxDiffBytes", ge=0)
    can_merge: bool = Field(default=False, alias="canMerge")


class Prompt(_Strict):
    system: str
    fragments: list[str] = Field(default_factory=list)


class ToolRef(_Strict):
    name: str
    policy: str | None = None


class McpServer(_Strict):
    name: str
    transport: str
    command: str | None = None
    args: list[str] = Field(default_factory=list)
    url_ref: str | None = Field(default=None, alias="urlRef")
    allowed_tools: list[str] = Field(default_factory=list, alias="allowedTools")


class SpecBudget(_Strict):
    """Per-role run budget (issue #27): hard ceilings enforced by the tool
    layer; ``maxToolCalls`` force-transitions the run into the report phase."""

    max_tool_calls: int | None = Field(default=None, alias="maxToolCalls", ge=1)
    max_tokens: int | None = Field(default=None, alias="maxTokens", ge=1)
    max_usd: float | None = Field(default=None, alias="maxUsd", ge=0)


class OutputContract(_Strict):
    required_files: list[str] = Field(alias="requiredFiles", min_length=1)
    result_schema: dict[str, Any] | None = Field(default=None, alias="resultSchema")


class AgentSpec(_Strict):
    api_version: str = Field(default="meta-agent.ai/v1alpha1", alias="apiVersion")
    kind: str = "AgentSpec"
    metadata: Metadata
    role: Role
    model: ModelConfig
    sandbox: SandboxConfig
    prompt: Prompt
    tools: list[ToolRef] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    mcp_servers: list[McpServer] = Field(default_factory=list, alias="mcpServers")
    budget: SpecBudget | None = None
    output_contract: OutputContract = Field(alias="outputContract")

    @property
    def ref(self) -> str:
        """The canonical ``name@version`` reference, e.g. ``add-feature@12``."""
        return f"{self.metadata.name}@{self.metadata.version}"

    def tool_names(self) -> set[str]:
        return {t.name for t in self.tools}

    def to_dict(self) -> dict[str, Any]:
        """Serialise back to the schema-shaped (camelCase) document."""
        return self.model_dump(by_alias=True, exclude_none=True, mode="json")
