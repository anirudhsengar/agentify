# Draft runtime deadline and cancellation

`maximum_runtime_ms` creates one absolute application deadline at draft admission. Every model turn and major trusted step checks the same persisted deadline. Model execution receives Pi's abort path; validation commands run in their own process group and receive graceful termination followed by forced termination when needed. Publication checks the deadline before remote operations and cannot begin after cancellation.

The durable run record contains the configured duration, start and deadline timestamps, cancellation request and completion timestamps, the active step, remote-model cancellation acknowledgement when observable, child/process-group termination facts, and whether a remote side effect may remain. Evidence produced before cancellation is retained. The ephemeral checkout remains the local cleanup boundary; an already-pushed owned branch is recorded as an orphan rather than automatically deleted.

The workflow's 60-minute GitHub Actions timeout is only an emergency ceiling. It is not the engagement deadline and an outer workflow timeout is reported separately from application-level runtime cancellation. Providers may not acknowledge remote cancellation, and a request already accepted by a provider may continue or be billed; the run record makes that limitation explicit.
