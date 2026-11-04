# Cloud development sessions

Cloud sessions need a supported Google Cloud CLI installation and an explicitly selected project. Prefer workload identity or an attached service account. If your environment supplies a service-account key through `ACRES_GCP_SA_KEY_B64`, `scripts/cloud-session-setup.sh` writes it with owner-only permissions and uses the explicitly configured `ACRES_GCP_PROJECT`.

Never commit credential files or copy production authentication into a shared development workspace. A working sign-in does not grant deployment authority. Use least-privilege roles for the selected project and keep release configuration in private operator storage.

Run local checks before using the generic deployment helpers described in [deployment](arosa-deployment.md).
