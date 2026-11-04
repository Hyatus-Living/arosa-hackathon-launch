---
name: workspace-artifact-links
description: Save and share generated diagrams, HTML previews, reports, and other local artifacts in OpenClaw chats. Use before posting a file link, when execution runs in a sandbox, or when the viewer reports an outside-workspace or file-not-found error. Verify workspace scope and sandbox-to-server mapping instead of guessing paths.
---

# Workspace Artifact Links

## 1. Establish the workspace and mapping

Read current session metadata and project instructions. Identify separately:

- The active session's allowed server-side workspace root.
- The shell's sandbox-side workspace/project root.
- The explicit mapping between them, if supplied.

A shell `pwd` shows only the execution path; it does not establish the viewer's server path or permitted root. Do not inspect credentials or authentication configuration to discover paths.

**Done when:** both roots and their mapping have supplied or verified evidence. Missing scope or mapping stays unknown; never invent a replacement prefix.

## 2. Save inside the allowed workspace

Choose an artifact directory inside the workspace, such as repository `docs/`. Resolve the destination and verify containment, including symlink resolution. Preserve existing files and others' work. Never default to a sibling directory such as `/workspace/diagrams` merely because the shell can write there.

Follow the repository's normal branch, checks and review policy for repository-owned source. Do not commit unrelated untracked artifacts.

**Done when:** the artifact exists, is nonempty, and has a known workspace-relative path inside the permitted root.

## 3. Derive the viewer path from evidence

Compute the artifact's relative path under the established sandbox root. Join it to the established server root. Never blindly replace `/workspace` or assume every sandbox directory has the same host mapping.

The supplied Arosa project context establishes this example:

| Coding sandbox project | Server-side project |
| --- | --- |
| `/workspace/acres/` | `/home/openclaw/.openclaw/workspace/acres/` |

Thus `docs/acres-credit-flow.html` maps to `/home/openclaw/.openclaw/workspace/acres/docs/acres-credit-flow.html`. This does not establish another session's mapping or viewer scope. Verify the active context each time.

**Done when:** the candidate server path follows a verified mapping and lies within the active viewer's allowed workspace.

## 4. Verify before sharing

Use the OpenClaw file reader with the exact server-side path. Confirm the intended artifact is returned, not a missing-file or access error. Validate its format when feasible, such as parsing embedded SVG/XML or JSON.

A reader may transparently map paths. Its success verifies file existence, not necessarily browser-preview permission. Do not promise a working preview unless viewer access is also confirmed.

Use a plain Markdown link with the verified absolute server path. Wrap targets containing spaces in angle brackets. Never use `file://`, a sandbox-only path, or a fabricated public URL. Do not publish privately scoped artifacts just to bypass workspace restrictions.

**Done when:** format checks pass and the exact linked path resolves through the file tool. State any remaining viewer-access uncertainty.

## 5. Recover without guessing

Interpret the reported error:

- **Outside workspace:** check viewer scope and server-path mapping. This is not evidence that an API key is missing.
- **File not found:** verify the exact path and the sandbox-to-server mount mapping.
- **Unsupported preview:** use an available attachment/download tool or useful inline content.
- **Scope or mapping still unknown:** explain the missing fact and provide inline content while investigating. Do not offer successive guessed links as fixes.

Do not request credentials, change authentication, modify the sandbox, or bypass access policy for a local-file path problem. Diagnose unrelated authentication errors from their own evidence.

**Done when:** the cause is supported by evidence and the user receives a verified eligible link or usable supported fallback, with unresolved uncertainty explicit.

## Final verification

Before sending, confirm:

1. The file is inside the active workspace, not merely somewhere shell-writable.
2. Sandbox and server paths are distinct; their mapping has evidence.
3. The exact linked server path resolves and the artifact format is valid.
4. No credentials/private data were exposed and no access policy changed.
5. Viewer success is claimed only when confirmed.

Delivery pattern: “Saved in the workspace: [diagram](VERIFIED_SERVER_PATH).” If viewer access is still unverified, state that limitation instead of promising it works.
