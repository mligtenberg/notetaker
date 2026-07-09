# Chat research runs in disposable recursive Delegates

The in-meeting chat runs on a local language model in the browser with a small context window (~8K tokens) under an app-wide Memory Budget, while a 1-hour transcript alone is ~12K tokens. Answering a question requires foraging the transcript (search, read windows, read more), and every tool result the main chat reads accumulates in its history and KV-cache permanently — main-chat context cannot be un-read. We therefore run research tasks in a Delegate: a recursive agent on the same model that forages with read-only tools (`meeting_status`, `search_transcript`, `read_transcript`) inside its own transient context. Only its distilled answer is injected into the main Thread; its full working log is flushed to OPFS and its memory reclaimed. The main chat stays a lean orchestrator holding mostly question→answer pairs.

Delegates stay budget-friendly only because they are bounded: depth 1 (a Delegate cannot spawn Delegates), read-only tools (never `write_artifact` — the main chat keeps sole authoring authority), a step cap on tool calls per run, a capped answer size, and strictly sequential execution (one Delegate at a time). Peak memory during a run is comparable to the main chat foraging directly, but Delegate memory is reclaimable where main-chat memory is not.

## Considered Options

- **Main chat forages directly**: fewest moving parts, but every search hit and transcript window read stays in the Thread's context forever; a few research questions exhaust the window and the KV-cache, and truncating history throws away the user's conversation rather than disposable research residue.
- **Dumb delegate, main chat orchestrates map-reduce** (`delegate(task, range)` with the range injected inline, no tools): memory-predictable, but the orchestration turns (choosing ranges, combining partials) themselves accumulate in the main context, and the main chat must understand the transcript's shape before it can even split the work.
- **Smart delegate that chunks internally**: one opaque call hides many inference rounds on a slow local model — no progress visibility and unbounded wall-clock time.

## Consequences

- A subagent's result is delivered as an Artifact (`research-…`/`scan-…`) rather than returned inline; the main chat receives only a pointer plus a short preview and reads the full artifact with `read_artifact` when it needs the detail. This keeps even a large result out of the main context until it is actually used, and leaves the output inspectable and reusable. (Subagents cannot invoke the write_artifact tool themselves — the orchestrator writes the delivered output; arbitrary authoring stays a main-chat action.)
- Research cost is visible as Delegate runs; the UI can show them and their logs are inspectable in the meeting folder.
- Whole-meeting tasks (e.g. "summarize everything") may need several sequential Delegate runs; latency scales with meeting length.
- The Thread history stays small enough that truncating oldest turns (our overflow policy) rarely triggers and loses little when it does — durable facts live in the transcript and in Artifacts, not in chat history.
