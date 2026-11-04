# Arosa contributor setup

Clone the public launch repository or reuse your existing checkout:

```sh
git clone https://github.com/Hyatus-Living/arosa-hackathon-launch.git
cd arosa-hackathon-launch
```

Follow the [README](../README.md) for the locked Node dependencies, frontend build, synthetic UI previews, Python planning environment and verification commands. Use your own GitHub identity for contributions.

## Development workflow

Create a branch for a focused change, run the relevant checks and open a pull request. Keep source changes separate from local configuration and generated output. Preserve the independent Modeling and Underwriting workflows and the source/geometry provenance contracts.

The local previews use synthetic projects and require no access to Arosa production. Live research and rendering require your own provider credentials, data stores and worker installation. Configure credentials outside tracked files and keep `.env` ignored.

## Hosting

The repository includes GCP-oriented deployment recipes as reference configurations. A self-hosted installation must supply its own project, services, authentication, secrets and databases. Review all hostnames, project IDs and resource paths before using a recipe.

Repository access does not grant access to Arosa production. Do not reuse another contributor's credentials or assume the reference infrastructure is available to you. This repository has no automatic deployment configured.

## Attribution

Preserve [MIT](../LICENSE), [third-party notices](../LICENSES.md) and the [source provenance record](../CONTRIBUTIONS.md) when redistributing or contributing code and assets.
