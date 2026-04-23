use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyDecision {
    #[default]
    Allow,
    Prompt,
    Forbid,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ExecutionPolicyRule {
    pub provider: String,
    pub decision: PolicyDecision,
    #[serde(default)]
    pub allow_all_tools: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionPolicy {
    #[serde(default)]
    pub default_decision: PolicyDecision,
    #[serde(default = "default_allow_all_tools")]
    pub default_allow_all_tools: bool,
    #[serde(default)]
    pub rules: Vec<ExecutionPolicyRule>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExecutionDecision {
    pub decision: PolicyDecision,
    pub allow_all_tools: bool,
}

const fn default_allow_all_tools() -> bool {
    true
}

impl Default for ExecutionPolicy {
    fn default() -> Self {
        Self {
            default_decision: PolicyDecision::Allow,
            default_allow_all_tools: true,
            rules: Vec::new(),
        }
    }
}

impl ExecutionPolicy {
    pub fn evaluate(&self, provider: &str) -> ExecutionDecision {
        let mut decision = ExecutionDecision {
            decision: self.default_decision,
            allow_all_tools: self.default_allow_all_tools,
        };

        for rule in &self.rules {
            if rule.provider == provider {
                decision.decision = rule.decision;
                if let Some(allow_all_tools) = rule.allow_all_tools {
                    decision.allow_all_tools = allow_all_tools;
                }
            }
        }

        decision
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evaluation_uses_defaults_without_rules() {
        let policy = ExecutionPolicy::default();
        let decision = policy.evaluate("codex");
        assert_eq!(decision.decision, PolicyDecision::Allow);
        assert!(decision.allow_all_tools);
    }

    #[test]
    fn evaluation_applies_matching_rule() {
        let policy = ExecutionPolicy {
            default_decision: PolicyDecision::Allow,
            default_allow_all_tools: true,
            rules: vec![ExecutionPolicyRule {
                provider: "codex".to_string(),
                decision: PolicyDecision::Prompt,
                allow_all_tools: Some(false),
            }],
        };

        let decision = policy.evaluate("codex");
        assert_eq!(decision.decision, PolicyDecision::Prompt);
        assert!(!decision.allow_all_tools);
    }
}
