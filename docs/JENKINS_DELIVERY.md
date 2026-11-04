# Jenkins delivery

[Open automation-acres-builder-pr](https://jenkins.gptguest.com/job/automation-acres-builder-pr/).

The job checks `builder/*` heads every five minutes and opens
`review/builder/*` pull requests for new changes. The first enrollment records
existing branch heads without replaying historical reviews. Builder branches are
treated only as patch data; their code and package hooks are never executed by
this automation. The scoped Hyatus Jenkins Delivery App signs the resulting
commits, and branch protection still requires review/checks before merge.
The job never merges a pull request or deploys the research service.

The pipelines live in `Hyatus-Living/hyatus-platform` under
`platform/jenkins/delivery` and `scripts/delivery`. Jenkins uses the protected
`main` head, checks it again before release, and serializes releases. Operators
use the authenticated Jenkins UI or the canonical `hyatus-service-delivery`
skill; both call the same Jenkins API and require the same permissions.

For a manual run, provide a concrete `REASON`, inspect the queue and final build,
and read `release/deployment.json` plus `release/runtime.json`. A successful
checkout or image build alone is not proof of a successful deployment. Jenkins
retains build logs for 14 days and receipts for seven days. Keep provider secrets
in the configured Jenkins credential store; never include their values in source,
arguments, receipts or chat.
