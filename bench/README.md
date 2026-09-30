# Historical RTX 3090 measurements

These measurements describe the local NInfer experiments from September 16–17, 2026. They do not establish the performance of plugin version 1.1.1. See [release verification](../VERIFICATION.md) for the current evidence.

`campaign.py` starts a local NInfer process with explicit arguments, waits for `/health`, sends comparable requests and records JSONL containing timing, memory and queue counters. The script depends on the original machine's NInfer paths, GPU tools and backup manifest. It is not a portable release test. Its launch and restore actions stop matching local NInfer processes before starting a candidate.

## Recorded results

- The baseline (`max-context 8192`, `kv-capacity 16384`, `max-concurrency 6`) returned three short Chat Completions with time to first token of 1.87/1.23/1.24 seconds and total durations of 3.20/2.33/2.41 seconds.
- The candidate using `max-context 65536`, `kv-capacity 65536`, INT8 KV, two active requests, eight host slots and 8 GiB host KV started with 1.85 GiB GPU memory free.
- A Responses API continuation using `previous_response_id` reported `private_turn_closure`, 1,133 cached input tokens and time to first token of 0.36 seconds. This confirms reuse within the measured sequence; it does not establish recovery after a restart.
- With roughly 4K input tokens, the same candidate took 5.09 seconds to first token for the initial request and 0.285 seconds for its continuation, which reported 4,787 cached input tokens.
- `kv-capacity 81920` with 8 GiB host KV left 1.28 GiB GPU memory free. The 16 GiB host KV variant also started and was selected for another test.
- `kv-capacity 98304` left 799 MiB, below the target 0.8–1.5 GiB reserve. The `114688` variant left 166 MiB and was rejected as unsafe for that experiment.
- Six parallel HTTP requests through `kv80-host16` completed. NInfer served at most two at a time; other requests waited, with a maximum recorded wait of about 10.27 seconds.

## Measurement limits

These were local startup and queue checks. They were not an hour-long mixed workload or a complete quality comparison. Restart recovery, separate 16/32/48/56K context cases, 24 GiB RAM cache and the complete browser orchestration scenario remained separate checks. Unmeasured values must not be replaced with estimates.

KV is the model's cached attention state; its placement and reuse are server behavior. The plugin's request estimates do not measure this state or reserve GPU memory.
