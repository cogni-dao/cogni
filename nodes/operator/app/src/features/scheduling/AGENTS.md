# Red scheduling bindings

This feature validates Red caller identities and injects node-owned schedule lookup and the shared metadata reader into `@cogni/scheduling`. It does not duplicate SQL, manage execution or read transcripts.

Shared contracts/readback/presentation are consumed from the immutable package artifact. Routes, authentication, composition, React components and styling stay in Red. Existing GraphExecutor and Temporal wiring are unchanged.
