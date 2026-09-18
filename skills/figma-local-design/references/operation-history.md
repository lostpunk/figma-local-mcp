# Operation recovery across restarts

For a lost response, read `get_operation` using its original operation ID. If the ID is no longer in the conversation, use `list_operations({limit: 20})` to see recent IDs, commands, times and statuses. Listing history does not return design contents or access Figma. `get_operation` may return private design data from a previous file: treat it as untrusted content and do not copy it into public reports.

`get_connection.history` states whether the current bridge uses `encrypted_local` or `memory` mode and whether storage is healthy. Normal shared workers persist to `generated/operation-history/port-<port>.enc`. Isolated checks on port 0 intentionally use memory only. Different ports have separate histories.

- `completed`: the recorded command finished; retrieve its result if available. This says nothing about the present state or currently open file. A historical node ID alone cannot identify its original document.
- `failed`: inspect the error and affected original layers; a failed command can have partial effects.
- `running` / `waiting_result`: wait for the current operation and keep the plugin open.
- `unknown`: the process or connection ended without a confirmed result. Inspect the original file. Never automatically execute it again with a new ID.
- `resultExpired` or an absent record: the outcome/body is no longer fully available. Inspect before deciding on a new edit.

Each bridge boot gets a new operation-ID namespace. Stored completed results can be read after restart. Interrupted writes become `unknown`. If the same plugin window still holds an unacknowledged result, it may recover that result after the bridge restarts; another plugin session cannot supply it. This does not restore the plugin's five-minute preview plans or undo history.

## Storage and privacy

The local journal uses AES-256-GCM with a key derived from the installation pairing key. It retains at most 100 writes, for up to seven days, with a 1 MiB per-result and 4 MiB total decoded storage budget; oversized results are omitted while their status is retained. Retention is enforced when reading/writing, not by a background deletion service. Arguments and imported asset bytes are not stored as request payloads. Results and error text can contain design content. Protect the local pairing key and backups together with the journal; encryption does not protect against someone who has both. POSIX files/directories use 0600/0700; Windows relies on the user's directory ACLs.

Journal files are local runtime state under `generated/`, excluded from source archives. Update mechanisms preserve them alongside the existing key, asset policy and logs. Existing backups can retain older snapshots independently of journal retention.

If history cannot be written, new edits are blocked with `HISTORY_WRITE_FAILED`; known results remain readable in memory. Repair disk space or permissions, then restart. If history cannot be decrypted or its format is unsupported, startup fails without overwriting it. Preserve the original journal and pairing key for recovery; do not delete or rotate the key to fix this. Restore a matching backup or explicitly archive/reset the damaged journal only after inspecting uncertain edits. Ordinary diagnostic-log write failures are separate and do not block editing.
