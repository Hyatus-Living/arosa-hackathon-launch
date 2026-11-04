# CI delivery

Use your own protected release pipeline and credential store. Run repository checks and tests before merging, and deploy only the reviewed source revision. Treat untrusted branches as source data; do not execute their hooks with release credentials.

Serialize releases that share state. Keep build and runtime receipts with the source revision, target project, service and health result in private operator storage. A successful build does not establish that a release is serving traffic. Verify the installed revision, authenticated workflows and account isolation after activation.

See [deployment configuration](arosa-deployment.md) for the generic Google Cloud helpers.
