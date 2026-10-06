# Windows integration checkpoints

The reviewed Windows dispatch and bounded ACL fixture patches were applied after
native Windows project sandbox acceptance passed at
`f320881505103f5a641b9e8ce559e3b0dbe32627` (run 37401255803,
job 112068711515). Application sandbox source matched
`5e8020442f917b10eb3ef4e75c094fabffafdc1f`; only CI ordering differed.

The pending proposals remain available in Git history at
`f6107189a5f647d3dc54b731e0b125e3417ba307`.

Integration still requires the actual-daemon Windows approval fixture and full
exact-head Ubuntu and Windows CI before project commands are reported available.
No host execution fallback is permitted. The daemon fixture uses scripted inference
and actual native execution, not paid providers or real desktop input. It does not
prove interruption of an already-running project script; existing approval-generation
and native JobObject descendant/cancellation tests remain required.

Accepted primary testing build: `fbd3b11429ce21e10a0c4450215c0873dd132dad`.
