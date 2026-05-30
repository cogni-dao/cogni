-- v0 nodes are monorepo-internal: every node shares repo_url = Cogni-DAO/cogni.
-- The repo_url UNIQUE from 0029 (authored when nodes were assumed standalone repos)
-- collides on the second node. Slug is the real unique key. IF EXISTS makes this a
-- no-op on fresh DBs (0029 already dropped it there) and a real drop on DBs that
-- applied the original 0029 (e.g. candidate-a).
ALTER TABLE "nodes" DROP CONSTRAINT IF EXISTS "nodes_repo_url_unique";
