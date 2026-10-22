# Release versions

The user explicitly selected 1.0.8 for the current release package. During ordinary development, keep the current extension version unchanged. Update the version only when the user explicitly requests a release; use their specified version when provided. Keep package.json, the root package-lock.json version fields, installation instructions, and the latest changelog entry consistent. Do not change third-party dependency versions when updating the extension version. Do not move or overwrite an existing remote tag without explicit authorization.

The user asked to keep their pending edits uncommitted until they request a combined commit. Packaging and Marketplace publishing do not implicitly authorize a Git commit or push.
