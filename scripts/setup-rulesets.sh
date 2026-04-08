#!/usr/bin/env bash
set -euo pipefail

REPO="revolut-engineering/revolut-x-api"

echo "Creating branch ruleset for master..."
BRANCH_ID=$(gh api --method POST "/repos/$REPO/rulesets" \
  --input - <<'EOF' | jq -r '.id'
{
  "name": "Protect master",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/master"],
      "exclude": []
    }
  },
  "bypass_actors": [
    {
      "actor_id": 5,
      "actor_type": "RepositoryRole",
      "bypass_mode": "always"
    }
  ],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    },
    { "type": "required_status_checks", "parameters": {
        "strict_status_checks_policy": true,
        "required_status_checks": [
          { "context": "Test API" },
          { "context": "Test CLI" },
          { "context": "Test MCP" },
          { "context": "Lint & Format" }
        ]
      }
    }
  ]
}
EOF
)
echo "Branch ruleset created (id: $BRANCH_ID)"

echo "Creating tag ruleset..."
TAG_ID=$(gh api --method POST "/repos/$REPO/rulesets" \
  --input - <<'EOF' | jq -r '.id'
{
  "name": "Protect release tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/tags/*"],
      "exclude": []
    }
  },
  "bypass_actors": [
    {
      "actor_id": 5,
      "actor_type": "RepositoryRole",
      "bypass_mode": "always"
    }
  ],
  "rules": [
    { "type": "creation" },
    { "type": "update" },
    { "type": "deletion" }
  ]
}
EOF
)
echo "Tag ruleset created (id: $TAG_ID)"

echo ""
echo "Done. Verify:"
echo "  gh api /repos/$REPO/rulesets --jq '.[] | \"\(.name): \(.enforcement)\"'"
